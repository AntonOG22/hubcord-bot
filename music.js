// Voice-channel music: `!musik <name or link>` resolves a YouTube video (via
// yt-dlp, same approach as most self-hosted Discord music bots) and either
// plays it immediately or queues it. Ported from a standalone Python
// prototype (discord.py + yt-dlp + ffmpeg) into this bot's existing
// architecture: per-server settings persisted through guildStore (Supabase-
// backed, survives redeploys), a features.js on/off switch, and — the actual
// point of this port — per-command role permissions configurable from the
// dashboard, the same allow-list shape customCommands.js already uses for
// custom commands (empty = default behavior, Administrator always passes).
//
// Playback state itself (voice connection, audio player, the actual queue)
// is intentionally NOT persisted — it's tied to a live @discordjs/voice
// connection in this process, so surviving a restart would mean reconnecting
// to a channel with no way to actually resume mid-song anyway. A restart
// just means the bot rejoins fresh next time someone runs !musik.
const crypto = require('crypto');
const path = require('path');
const { spawn, execFile } = require('child_process');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  entersState,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  StreamType,
} = require('@discordjs/voice');
const ffmpegPath = require('ffmpeg-static');
const { EmbedBuilder, ChannelType } = require('discord.js');
const { makeGuildStore } = require('./guildStore');
const { brandFooter } = require('./brand');
const features = require('./features');

// Downloaded by scripts/download-yt-dlp.js on `npm install` (see that file
// for why it's a plain Node script instead of the yt-dlp-exec package).
const YTDLP_PATH = path.join(__dirname, 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

const YOUTUBE_REGEX = /(https?:\/\/)?(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/|music\.youtube\.com\/watch\?v=)[\w-]+/i;

const NON_ADMIN_COOLDOWN_MS = 60 * 1000; // non-admins: 1 song request per minute
const DEFAULT_MAX_QUEUE_SIZE = 100;

// Every music command the dashboard can grant/restrict per role. `defaultOpen`
// is what applies when a command has no roles configured for it yet: true =
// everyone can use it out of the box, false = Administrator-only until a
// server owner explicitly grants roles to it from the dashboard. Only `stop`
// is admin-only by request — the rest default open but are just as
// configurable, so a server can lock down !skip/!volume/etc to a DJ role too.
const MUSIC_COMMANDS = [
  { key: 'play', label: '!musik', description: 'Play a song or add it to the queue.', defaultOpen: true },
  { key: 'queue', label: '!queue', description: 'View the current queue.', defaultOpen: true },
  { key: 'nowplaying', label: '!nowplaying', description: 'Show what is currently playing.', defaultOpen: true },
  { key: 'skip', label: '!skip', description: 'Skip the current song.', defaultOpen: false },
  { key: 'pause', label: '!pause', description: 'Pause playback.', defaultOpen: false },
  { key: 'resume', label: '!resume', description: 'Resume playback.', defaultOpen: false },
  { key: 'stop', label: '!stop', description: 'Stop playback, clear the queue, and leave the voice channel.', defaultOpen: false },
  { key: 'clear', label: '!musicqueueclear', description: 'Clear the queue without stopping the current song.', defaultOpen: false },
  { key: 'remove', label: '!musicremove', description: 'Remove a specific song from the queue.', defaultOpen: false },
  { key: 'volume', label: '!volume', description: 'Change the playback volume.', defaultOpen: false },
  { key: 'loop', label: '!loop', description: 'Toggle looping the current song.', defaultOpen: false },
];

const DEFAULT_IDLE_DISCONNECT_SECONDS = 180;
const DEFAULT_VOTE_SKIP_THRESHOLD = 50;
const HISTORY_LIMIT = 50;

const settingsStore = makeGuildStore('music-settings.json', () => ({
  commandPermissions: {}, // key -> role ID[]; empty/missing = defaultOpen from MUSIC_COMMANDS
  defaultVolume: 100,
  maxQueueSize: DEFAULT_MAX_QUEUE_SIZE,
  announceNowPlaying: true,
  maxSongDurationSeconds: 0, // 0 = unlimited
  idleDisconnectSeconds: DEFAULT_IDLE_DISCONNECT_SECONDS,
  voteSkipEnabled: true,
  voteSkipThresholdPercent: DEFAULT_VOTE_SKIP_THRESHOLD,
}));

const historyStore = makeGuildStore('music-history.json', () => ({ entries: [] }));

function getSettings(guildId) {
  const s = settingsStore.get(guildId);
  if (!s.commandPermissions) s.commandPermissions = {};
  if (s.maxQueueSize === undefined) s.maxQueueSize = DEFAULT_MAX_QUEUE_SIZE;
  if (s.defaultVolume === undefined) s.defaultVolume = 100;
  if (s.announceNowPlaying === undefined) s.announceNowPlaying = true;
  if (s.maxSongDurationSeconds === undefined) s.maxSongDurationSeconds = 0;
  if (s.idleDisconnectSeconds === undefined) s.idleDisconnectSeconds = DEFAULT_IDLE_DISCONNECT_SECONDS;
  if (s.voteSkipEnabled === undefined) s.voteSkipEnabled = true;
  if (s.voteSkipThresholdPercent === undefined) s.voteSkipThresholdPercent = DEFAULT_VOTE_SKIP_THRESHOLD;
  return s;
}

// Discord gives every voice channel its own attached text chat (the "Chat"
// tab, usable whether or not you're actually connected to the voice side) —
// messageCreate fires for it exactly like a normal text channel, just with
// channel.type === GuildVoice/GuildStageVoice instead of GuildText. Music
// commands are only meant to be typed there, next to the voice channel
// they control, never in a server's regular text channels — this is a fixed
// rule, not a per-server dashboard setting, since "somewhere in voice chat"
// is what makes !skip/!stop unambiguous about which channel they apply to.
function requireVoiceChatChannel(message) {
  const type = message.channel.type;
  if (type !== ChannelType.GuildVoice && type !== ChannelType.GuildStageVoice) {
    throw new Error('Music commands only work in a voice channel\'s own chat, not in regular text channels.');
  }
}

function updateSettings(guildId, patch) {
  const s = getSettings(guildId);
  if (patch && typeof patch.commandPermissions === 'object' && patch.commandPermissions) {
    for (const { key } of MUSIC_COMMANDS) {
      if (!(key in patch.commandPermissions)) continue;
      const roles = patch.commandPermissions[key];
      s.commandPermissions[key] = Array.isArray(roles) ? roles.filter((id) => typeof id === 'string') : [];
    }
  }
  if (patch && patch.defaultVolume !== undefined) {
    s.defaultVolume = Math.max(0, Math.min(150, parseInt(patch.defaultVolume, 10) || 100));
  }
  if (patch && patch.maxQueueSize !== undefined) {
    s.maxQueueSize = Math.max(1, Math.min(300, parseInt(patch.maxQueueSize, 10) || DEFAULT_MAX_QUEUE_SIZE));
  }
  if (patch && patch.announceNowPlaying !== undefined) {
    s.announceNowPlaying = !!patch.announceNowPlaying;
  }
  if (patch && patch.maxSongDurationSeconds !== undefined) {
    // 0 = unlimited; otherwise clamp to 1 min .. 3 hours so a typo can't
    // accidentally lock out every song or effectively disable the limit.
    const val = parseInt(patch.maxSongDurationSeconds, 10) || 0;
    s.maxSongDurationSeconds = val <= 0 ? 0 : Math.max(60, Math.min(10800, val));
  }
  if (patch && patch.idleDisconnectSeconds !== undefined) {
    s.idleDisconnectSeconds = Math.max(30, Math.min(1800, parseInt(patch.idleDisconnectSeconds, 10) || DEFAULT_IDLE_DISCONNECT_SECONDS));
  }
  if (patch && patch.voteSkipEnabled !== undefined) {
    s.voteSkipEnabled = !!patch.voteSkipEnabled;
  }
  if (patch && patch.voteSkipThresholdPercent !== undefined) {
    s.voteSkipThresholdPercent = Math.max(1, Math.min(100, parseInt(patch.voteSkipThresholdPercent, 10) || DEFAULT_VOTE_SKIP_THRESHOLD));
  }
  settingsStore.save();
  return s;
}

function getHistory(guildId) {
  return historyStore.get(guildId).entries;
}

function recordHistory(guildId, track, entry) {
  const h = historyStore.get(guildId);
  h.entries.unshift({
    title: track.title,
    webpageUrl: track.webpageUrl || null,
    requestedBy: entry.requestedBy,
    requestedByTag: entry.requestedByTag || null,
    isAdmin: entry.isAdmin,
    playedAt: Date.now(),
  });
  if (h.entries.length > HISTORY_LIMIT) h.entries.length = HISTORY_LIMIT;
  historyStore.save();
}

function canUseMusicCommand(guildId, key, member) {
  if (member.permissions.has('Administrator')) return true;
  const def = MUSIC_COMMANDS.find((c) => c.key === key);
  const allowed = getSettings(guildId).commandPermissions[key] || [];
  if (allowed.length > 0) return allowed.some((id) => member.roles.cache.has(id));
  return !!(def && def.defaultOpen);
}

function requirePermission(guildId, key, member) {
  if (!canUseMusicCommand(guildId, key, member)) {
    throw new Error("You don't have permission to use this music command.");
  }
}

// ---------- Runtime state (in-memory only, not persisted) ----------

const guildStates = new Map(); // guildId -> state
const lastPlayAt = new Map(); // `${guildId}:${userId}` -> timestamp, non-admin cooldown
let clientRef = null;

function getState(guildId) {
  let state = guildStates.get(guildId);
  if (!state) {
    state = {
      connection: null,
      player: null,
      queue: [],
      current: null,
      volume: null, // null = use the server's configured default
      textChannelId: null,
      looping: false,
      ffmpegProc: null,
      idleTimer: null,
    };
    guildStates.set(guildId, state);
  }
  return state;
}

function isActive(guildId) {
  return !!getState(guildId).connection;
}

function clearIdleTimer(state) {
  if (state.idleTimer) {
    clearTimeout(state.idleTimer);
    state.idleTimer = null;
  }
}

function scheduleIdleDisconnect(guildId) {
  const state = getState(guildId);
  clearIdleTimer(state);
  const seconds = getSettings(guildId).idleDisconnectSeconds;
  state.idleTimer = setTimeout(() => stop(guildId), seconds * 1000);
}

function killFfmpeg(state) {
  if (state.ffmpegProc) {
    try { state.ffmpegProc.kill('SIGKILL'); } catch { /* already dead */ }
    state.ffmpegProc = null;
  }
}

// ---------- yt-dlp / ffmpeg plumbing ----------

function runYtdlp(args) {
  return new Promise((resolve, reject) => {
    execFile(YTDLP_PATH, args, { maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message || '').trim().split('\n').pop() || 'yt-dlp failed'));
      resolve(stdout);
    });
  });
}

async function resolveTrack(query) {
  const isUrl = YOUTUBE_REGEX.test(query);
  const target = isUrl ? query : `ytsearch1:${query}`;

  const stdout = await runYtdlp([
    '--dump-single-json',
    '--no-playlist',
    '--no-check-certificates',
    '--no-warnings',
    '--prefer-free-formats',
    '-f', 'bestaudio/best',
    target,
  ]);
  const info = JSON.parse(stdout);
  const picked = info && info.entries ? info.entries[0] : info;
  if (!picked || !picked.url) throw new Error(`No results found for "${query}".`);

  return {
    streamUrl: picked.url,
    title: picked.title || 'Unknown title',
    webpageUrl: picked.webpage_url || (isUrl ? query : null),
    duration: picked.duration || null,
    thumbnail: picked.thumbnail || null,
  };
}

// Spawns ffmpeg to transcode the resolved stream URL to raw PCM on stdout —
// same shape as the Python prototype's discord.FFmpegPCMAudio, just driven
// by hand here so the process can be killed cleanly on skip/stop instead of
// leaking a zombie ffmpeg per song.
function spawnFfmpegPcm(streamUrl) {
  const args = [
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    '-i', streamUrl,
    '-analyzeduration', '0',
    '-loglevel', 'error',
    '-f', 's16le',
    '-ar', '48000',
    '-ac', '2',
    'pipe:1',
  ];
  return spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
}

// ---------- Playback ----------

async function ensureConnection(message) {
  const state = getState(message.guild.id);
  const voiceChannel = message.member.voice.channel;
  if (!voiceChannel) throw new Error('You need to be in a voice channel for me to play music.');

  if (!state.connection || state.connection.state.status === VoiceConnectionStatus.Destroyed) {
    state.connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: message.guild.id,
      adapterCreator: message.guild.voiceAdapterCreator,
      selfDeaf: true,
    });
    state.player = createAudioPlayer();
    state.connection.subscribe(state.player);

    state.player.on(AudioPlayerStatus.Idle, () => {
      killFfmpeg(state);
      playNext(message.guild.id).catch((err) => console.error(`Music playNext failed in guild ${message.guild.id}:`, err.message));
    });
    state.player.on('error', (err) => {
      console.error(`Music player error in guild ${message.guild.id}:`, err.message);
      killFfmpeg(state);
      playNext(message.guild.id).catch((e) => console.error(`Music playNext failed in guild ${message.guild.id}:`, e.message));
    });

    await entersState(state.connection, VoiceConnectionStatus.Ready, 15_000);
  } else if (state.connection.joinConfig.channelId !== voiceChannel.id) {
    state.connection.rejoin({ channelId: voiceChannel.id, guildId: message.guild.id, selfDeaf: true, adapterCreator: message.guild.voiceAdapterCreator });
  }

  state.textChannelId = message.channel.id;
  clearIdleTimer(state);
  return state;
}

async function playNext(guildId) {
  const state = getState(guildId);
  if (!state.connection || !state.player) return;

  if (state.looping && state.current) {
    state.queue.unshift({ ...state.current, id: crypto.randomUUID() });
  }

  const next = state.queue.shift();
  if (!next) {
    state.current = null;
    scheduleIdleDisconnect(guildId);
    return;
  }
  state.current = next;
  state.voteSkips = new Set(); // fresh vote count for the new song

  try {
    const track = await resolveTrack(next.query);
    next.title = track.title;
    next.thumbnail = track.thumbnail;
    next.duration = track.duration;
    next.webpageUrl = track.webpageUrl;

    const maxDuration = getSettings(guildId).maxSongDurationSeconds;
    if (maxDuration > 0 && track.duration && track.duration > maxDuration) {
      if (state.textChannelId && clientRef) {
        clientRef.channels.fetch(state.textChannelId)
          .then((ch) => ch?.send(`⏭️ Skipping **${track.title}** — longer than the ${Math.round(maxDuration / 60)}-minute limit set for this server.`))
          .catch(() => {});
      }
      return playNext(guildId);
    }

    recordHistory(guildId, track, next);

    killFfmpeg(state);
    const proc = spawnFfmpegPcm(track.streamUrl);
    state.ffmpegProc = proc;
    proc.on('error', (err) => console.error(`ffmpeg failed to start for guild ${guildId}:`, err.message));

    const resource = createAudioResource(proc.stdout, { inputType: StreamType.Raw, inlineVolume: true });
    resource.volume.setVolume((state.volume ?? getSettings(guildId).defaultVolume) / 100);
    state.currentResource = resource;
    state.player.play(resource);

    if (getSettings(guildId).announceNowPlaying && state.textChannelId && clientRef) {
      const channel = await clientRef.channels.fetch(state.textChannelId).catch(() => null);
      if (channel) {
        const embed = new EmbedBuilder()
          .setColor(0x3ecf8e)
          .setTitle('▶️ Now playing')
          .setDescription(`**${track.title}**${next.requestedBy ? `\nRequested by <@${next.requestedBy}>` : ''}`)
          .setFooter(brandFooter(clientRef, guildId));
        if (track.thumbnail) embed.setThumbnail(track.thumbnail);
        if (track.webpageUrl) embed.setURL(track.webpageUrl);
        await channel.send({ embeds: [embed] }).catch(() => {});
      }
    }
  } catch (err) {
    if (state.textChannelId && clientRef) {
      clientRef.channels.fetch(state.textChannelId)
        .then((ch) => ch?.send(`⚠️ Couldn't play "${next.query}": ${err.message} — skipping.`))
        .catch(() => {});
    }
    // Broken track (region-locked, deleted, no results, ...) — move on
    // instead of getting the whole queue stuck on one bad entry.
    playNext(guildId).catch((e) => console.error(`Music playNext failed in guild ${guildId}:`, e.message));
  }
}

async function enqueue(message, query) {
  if (!features.isEnabled(message.guild.id, 'music')) {
    throw new Error('Music is currently disabled on this server.');
  }
  requireVoiceChatChannel(message);
  const settings = getSettings(message.guild.id);

  const isAdmin = message.member.permissions.has('Administrator');
  if (!isAdmin) {
    const key = `${message.guild.id}:${message.author.id}`;
    const last = lastPlayAt.get(key);
    if (last && Date.now() - last < NON_ADMIN_COOLDOWN_MS) {
      const remaining = Math.ceil((NON_ADMIN_COOLDOWN_MS - (Date.now() - last)) / 1000);
      throw new Error(`You can request one song per minute — try again in ${remaining}s.`);
    }
  }

  const state = await ensureConnection(message);
  if (state.queue.length >= settings.maxQueueSize) {
    throw new Error('The queue is full.');
  }

  const entry = {
    id: crypto.randomUUID(),
    query,
    requestedBy: message.author.id,
    requestedByTag: message.author.tag,
    isAdmin,
    addedAt: Date.now(),
  };
  if (!isAdmin) lastPlayAt.set(`${message.guild.id}:${message.author.id}`, Date.now());

  const busy = state.player && (state.player.state.status === AudioPlayerStatus.Playing || state.player.state.status === AudioPlayerStatus.Buffering);

  if (!busy) {
    state.queue.push(entry);
    await playNext(message.guild.id);
    return { entry, position: 0, startingNow: true };
  }

  // Nothing plays right now but something's queued: everyone appends to the
  // back in the order they asked, EXCEPT admin requests, which jump to the
  // front — but behind any admin requests already waiting there, so two
  // admins back-to-back still play in the order they asked, not reversed.
  if (isAdmin) {
    let insertAt = 0;
    while (insertAt < state.queue.length && state.queue[insertAt].isAdmin) insertAt++;
    state.queue.splice(insertAt, 0, entry);
    return { entry, position: insertAt, startingNow: false };
  }

  state.queue.push(entry);
  return { entry, position: state.queue.length - 1, startingNow: false };
}

function skip(guildId) {
  const state = getState(guildId);
  if (!state.player) return false;
  state.player.stop(true); // triggers the Idle handler -> playNext
  return true;
}

// Lets anyone in the voice channel vote to skip, independent of the `skip`
// command's own role permissions — the point is a democratic fallback when
// skip is locked to admins/DJs and none are around. One vote per user per
// song (state.voteSkips is reset in playNext whenever a new track starts).
function voteSkip(guildId, userId, voiceChannelMemberCount) {
  const state = getState(guildId);
  if (!state.current) throw new Error('Nothing is playing.');
  const settings = getSettings(guildId);
  if (!settings.voteSkipEnabled) throw new Error('Vote-skip is turned off on this server — ask someone with permission to use !skip.');
  if (!state.voteSkips) state.voteSkips = new Set();
  if (state.voteSkips.has(userId)) throw new Error('You already voted to skip this song.');
  state.voteSkips.add(userId);
  const needed = Math.max(1, Math.ceil((Math.max(1, voiceChannelMemberCount) * settings.voteSkipThresholdPercent) / 100));
  if (state.voteSkips.size >= needed) {
    skip(guildId);
    return { skipped: true, votes: state.voteSkips.size, needed };
  }
  return { skipped: false, votes: state.voteSkips.size, needed };
}

function pause(guildId) {
  const state = getState(guildId);
  if (!state.player || state.player.state.status !== AudioPlayerStatus.Playing) return false;
  return state.player.pause();
}

function resume(guildId) {
  const state = getState(guildId);
  if (!state.player || state.player.state.status !== AudioPlayerStatus.Paused) return false;
  return state.player.unpause();
}

function stop(guildId) {
  const state = getState(guildId);
  state.queue = [];
  state.current = null;
  state.looping = false;
  killFfmpeg(state);
  if (state.player) { try { state.player.stop(true); } catch { /* ignore */ } }
  if (state.connection) { try { state.connection.destroy(); } catch { /* ignore */ } }
  state.connection = null;
  state.player = null;
  state.currentResource = null;
  clearIdleTimer(state);
}

function clearQueue(guildId) {
  const state = getState(guildId);
  const count = state.queue.length;
  state.queue = [];
  return count;
}

// `idOrIndex`: a string queue-entry id (dashboard) or a 0-based number index
// (the `!musicremove <position>` chat command converts its 1-based arg first).
function removeFromQueue(guildId, idOrIndex) {
  const state = getState(guildId);
  const idx = typeof idOrIndex === 'number' ? idOrIndex : state.queue.findIndex((e) => e.id === idOrIndex);
  if (idx < 0 || idx >= state.queue.length) return null;
  return state.queue.splice(idx, 1)[0];
}

function setVolume(guildId, percent) {
  const state = getState(guildId);
  const clamped = Math.max(0, Math.min(150, parseInt(percent, 10)));
  if (Number.isNaN(clamped)) throw new Error('Volume must be a number between 0 and 150.');
  state.volume = clamped;
  if (state.currentResource) state.currentResource.volume.setVolume(clamped / 100);
  return clamped;
}

function toggleLoop(guildId) {
  const state = getState(guildId);
  state.looping = !state.looping;
  return state.looping;
}

function formatEntry(e) {
  return { id: e.id, title: e.title || e.query, requestedBy: e.requestedBy, requestedByTag: e.requestedByTag || null, isAdmin: e.isAdmin };
}

function getStatus(guildId) {
  const state = getState(guildId);
  return {
    connected: !!state.connection,
    voiceChannelId: state.connection ? state.connection.joinConfig.channelId : null,
    playing: !!state.player && state.player.state.status === AudioPlayerStatus.Playing,
    paused: !!state.player && state.player.state.status === AudioPlayerStatus.Paused,
    current: state.current ? formatEntry(state.current) : null,
    queue: state.queue.map(formatEntry),
    volume: state.volume ?? getSettings(guildId).defaultVolume,
    looping: state.looping,
  };
}

function setupMusic(client) {
  clientRef = client;
  console.log('Music system active (!musik <name or link>, per-role command permissions configurable from the dashboard).');
}

module.exports = {
  setupMusic,
  MUSIC_COMMANDS,
  getSettings,
  updateSettings,
  canUseMusicCommand,
  requirePermission,
  requireVoiceChatChannel,
  isActive,
  enqueue,
  skip,
  voteSkip,
  pause,
  resume,
  stop,
  clearQueue,
  removeFromQueue,
  setVolume,
  toggleLoop,
  getStatus,
  getHistory,
};
