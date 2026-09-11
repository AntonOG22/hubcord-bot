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
const os = require('os');
const fs = require('fs');
const { spawn, execFile, execFileSync } = require('child_process');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  entersState,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  StreamType,
} = require('@discordjs/voice');
const { EmbedBuilder, ChannelType } = require('discord.js');
const { makeGuildStore } = require('./guildStore');
const { brandFooter } = require('./brand');
const features = require('./features');

// Downloaded by scripts/download-yt-dlp.js on `npm install` (see that file
// for why it's a plain Node script instead of the yt-dlp-exec package).
const YTDLP_PATH = path.join(__dirname, 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

// Prefer a system `ffmpeg` on PATH — on Railway that's the apt package
// (RAILPACK_DEPLOY_APT_PACKAGES=ffmpeg), a real build for that exact distro/
// kernel. ffmpeg-static's generic prebuilt Linux binary segfaulted (SIGSEGV)
// immediately on Railway's runtime image — every song "played" for an
// instant and produced silence, since the player still entered its Playing
// state via silence-padding before the (empty) real stream ever arrived.
// Falls back to the ffmpeg-static bundled binary when there's no system
// ffmpeg (e.g. local dev on a machine that never installed one).
function resolveFfmpegPath() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return 'ffmpeg';
  } catch {
    return require('ffmpeg-static');
  }
}
const ffmpegPath = resolveFfmpegPath();

// Optional YouTube auth: the android/tv/ios player-client fallback (see
// YTDLP_CLIENT_FALLBACKS below) helps against an intermittent, per-client
// "Sign in to confirm you're not a bot" wall, but YouTube can also block a
// whole datacenter IP (exactly what Railway looks like) across every client
// at once — no client rotation gets past that, only actually authenticating
// does. When YTDLP_COOKIES holds a Netscape-format cookies.txt (exported
// from a real, logged-in browser session via e.g. the "Get cookies.txt
// LOCALLY" extension — Settings > your server on the dashboard has the
// exact steps), every yt-dlp call uses it and is treated as that real
// account instead of an anonymous datacenter request. Entirely optional —
// music still works without it, just more exposed to that wall.
const cookiesPath = (() => {
  const raw = process.env.YTDLP_COOKIES;
  if (!raw || !raw.trim()) {
    console.log('YTDLP_COOKIES not set — music playback has no YouTube auth, more exposed to the anti-bot wall.');
    return null;
  }
  try {
    const file = path.join(os.tmpdir(), 'hubcord-yt-cookies.txt');
    fs.writeFileSync(file, raw);
    // Sanity-check the content instead of assuming a set variable is a
    // usable cookies.txt — the single biggest way this silently does
    // nothing is a paste that's missing lines, wrong format, or just isn't
    // actually a YouTube/Google cookie export. Never logs the cookie
    // values themselves, only shape.
    const cookieLines = raw.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
    const hasYoutubeDomain = /\.?youtube\.com|\.?google\.com/i.test(raw);
    console.log(`YTDLP_COOKIES loaded: ${cookieLines.length} cookie line(s), youtube/google domain present: ${hasYoutubeDomain}.`);
    if (cookieLines.length === 0 || !hasYoutubeDomain) {
      console.error('YTDLP_COOKIES looks malformed (no cookie lines, or no youtube.com/google.com entries) — check the exported file was pasted in full, in Netscape cookies.txt format.');
    }
    return file;
  } catch (err) {
    console.error('Could not write YTDLP_COOKIES to a temp file — continuing without cookies:', err.message);
    return null;
  }
})();
function cookieArgs() {
  return cookiesPath ? ['--cookies', cookiesPath] : [];
}

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
  { key: 'automatic', label: '!automatic', description: 'Starts fully automatic playback matching a mood/genre (e.g. "relaxing") — finds and queues songs on its own. While active, only Administrators can use ANY music command, regardless of role grants, until !automaticstop.', defaultOpen: false },
  { key: 'automaticstop', label: '!automaticstop', description: 'Stops automatic playback mode.', defaultOpen: false },
  { key: 'lyrics', label: '!lyrics', description: 'Shows lyrics for the current song, synced to playback position when available. Can be turned off entirely in Settings below.', defaultOpen: true },
];

const AUTOMATIC_BATCH_SIZE = 15; // how many candidates to fetch per search
const AUTOMATIC_REFILL_AHEAD = 2; // refill once fewer than this many automatic tracks remain queued
const AUTOMATIC_RETURN_HOME_MS = 30 * 1000; // how long to wait, idle in an away channel, before hopping back

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
  lyricsEnabled: true,
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
  if (s.lyricsEnabled === undefined) s.lyricsEnabled = true;
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
  if (patch && patch.lyricsEnabled !== undefined) {
    s.lyricsEnabled = !!patch.lyricsEnabled;
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

// While automatic mode is running, ONLY real Discord Administrators may
// touch music at all — a role granted !skip or !musik from the dashboard
// does not carry over, by design: automatic mode is meant as a hard "hands
// off, admins only" switch, not just another permission tier.
function assertNotBlockedByAutomatic(guildId, member) {
  const automatic = getState(guildId).automatic;
  if (automatic?.active && !member.permissions.has('Administrator')) {
    throw new Error(`🔒 Automatic mode ("${automatic.mood}") is active — only Administrators can use music commands right now. An admin can stop it with !automaticstop.`);
  }
}

function requirePermission(guildId, key, member) {
  assertNotBlockedByAutomatic(guildId, member);
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
      awaitingRetry: false, // true while playResolvedTrack is retrying a silently-failed stream with a different client — see the player's Idle/error handlers above
      automatic: null, // { active, mood, startedBy, seen: Set<videoId> } while automatic mode is running
      lyricsLive: null, // { message, intervalId } while a !lyrics session is live-updating
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

  // An admin's request from a different voice channel pulled the bot away
  // from a running automatic session (see ensureConnection's rejoin) — once
  // whatever they queued there finishes and it's quiet for a bit, hop back
  // and pick the automatic playlist back up, rather than just idling (or
  // fully disconnecting) in the away channel indefinitely.
  const homeId = state.automatic?.active ? state.automatic.homeChannelId : null;
  if (homeId && state.connection && state.connection.joinConfig.channelId !== homeId) {
    state.idleTimer = setTimeout(() => {
      returnToAutomaticHome(guildId).catch((err) => console.error(`Automatic mode return-home failed for guild ${guildId}:`, err.message));
    }, AUTOMATIC_RETURN_HOME_MS);
    return;
  }

  const seconds = getSettings(guildId).idleDisconnectSeconds;
  state.idleTimer = setTimeout(() => stop(guildId), seconds * 1000);
}

async function returnToAutomaticHome(guildId) {
  const state = getState(guildId);
  if (!state.automatic?.active || !state.connection) return;
  const { homeChannelId, homeTextChannelId } = state.automatic;
  if (!homeChannelId) return;

  if (state.connection.joinConfig.channelId !== homeChannelId) {
    const guild = clientRef?.guilds.cache.get(guildId);
    if (!guild) return;
    try {
      state.connection.rejoin({ channelId: homeChannelId, guildId, selfDeaf: true, adapterCreator: guild.voiceAdapterCreator });
    } catch (err) {
      console.error(`Automatic mode: couldn't rejoin home channel in guild ${guildId}:`, err.message);
      return;
    }
  }

  state.textChannelId = homeTextChannelId || state.textChannelId;
  clearIdleTimer(state);

  // The usual case: ensureConnection paused the automatic track in place
  // before leaving home (see there) — pick it back up from exactly that
  // position rather than treating it as finished and skipping ahead.
  if (state.current?.isAutomatic && state.player?.state.status === AudioPlayerStatus.Paused) {
    resume(guildId);
    return;
  }

  if (!state.current) {
    await refillAutomaticQueue(guildId);
    await playNext(guildId);
  }
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

// Player clients to try, in order, when resolving a track. `null` means
// "don't force one" — let yt-dlp pick from its own (regularly updated)
// default client list.
//
// Cookies used to be attached to every single one of these attempts.
// Turned out that was backwards: a signed-in request makes YouTube offer
// a different (often higher/adaptive-only) format tier that's far more
// likely to be gated behind a PO token yt-dlp has no way to generate here
// — live logs showed EVERY client failing with "Requested format is not
// available" / "The page needs to be reloaded" once cookies were attached,
// for ordinary public videos that resolve fine anonymously. Cookies only
// ever actually fixed one specific failure — the sign-in/bot-check wall —
// so this whole list now runs cookie-FREE first; --cookies only gets
// attached on the small second pass below, and only after every plain
// attempt has failed.
const YTDLP_CLIENT_FALLBACKS = ['android', 'ios', 'tv_embedded', null];

// Second pass, cookie-authenticated, only reached if every plain attempt
// above failed AND the failure was actually the sign-in wall (the one
// thing cookies fix) — not a format/reload error, which cookies make more
// likely, not less, so retrying those specifically with cookies attached
// would just be trading one failure mode for a worse one.
const YTDLP_COOKIE_FALLBACKS = [null, 'web'];

// Last-resort fallback, appended after every client above has been tried:
// yt-dlp's documented workaround for a format list that came back empty
// (or lost every audio format) because YouTube gates it behind a "PO
// token" yt-dlp has no way to generate here. missing_pot tells it to list
// those formats anyway instead of silently filtering them out; they still
// often work fine for a plain audio download even without the token.
const MISSING_POT_ARGS = ['--extractor-args', 'youtube:formats=missing_pot'];

// All of these are "this client didn't work, a different one might" failures
// — not "this video is actually broken" ones — so they're worth burning a
// retry on: a per-client anti-bot wall, a client whose format list doesn't
// line up with the current auth state, and YouTube's own known "reload"
// bug for specific client/cookie combinations.
function isRetryableClientError(message) {
  return /sign in to confirm|requested format is not available|page needs to be reloaded|timed? ?out|econnreset|econnrefused|network|fetch failed|http error 5\d\d|503|502/i.test(message || '');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Every one of isRetryableClientError's cases is documented/reported as
// intermittent, not deterministic — the exact same request (same client,
// same cookies) frequently just succeeds on a second try a moment later.
// A single pass through the client list treated one bad roll of the dice
// per client as "that client is broken" and moved on; retrying each one
// RETRIES_PER_CLIENT times first (with a short pause in between) catches
// the very common case where every client "fails" once but any of them
// would've worked on attempt two.
const RETRIES_PER_CLIENT = 2;
const RETRY_DELAY_MS = 1500;

// Runs one pass through a client list (each tried up to RETRIES_PER_CLIENT
// times, the last one also retried once with missing_pot) and returns
// either the resolved stdout or the last error. Shared by resolveTrack's
// two passes — plain first, cookie-authenticated only as a fallback — so
// the retry/backoff logic itself isn't duplicated between them.
async function tryClientList(target, clientList, useCookies, excludeClients) {
  // Skips whatever's already been tried in an earlier playback attempt for
  // this same track (see playResolvedTrack/retryPlayback below) — retrying
  // a track that produced silence with the exact same client would just
  // reproduce the exact same silence.
  const family = useCookies ? 'cookie' : 'plain';
  const filtered = clientList.filter((c) => !excludeClients.has(`${family}:${c || 'default'}`));
  if (filtered.length === 0) return { stdout: null, err: null, usedClient: null };

  const attempts = [...filtered, filtered[filtered.length - 1]];
  let lastErr;
  clientLoop:
  for (let i = 0; i < attempts.length; i++) {
    const clients = attempts[i];
    const isLastResort = i === attempts.length - 1;
    for (let try_ = 1; try_ <= RETRIES_PER_CLIENT; try_++) {
      try {
        const stdout = await runYtdlp([
          ...(useCookies ? cookieArgs() : []),
          '--dump-single-json',
          '--no-playlist',
          '--no-check-certificates',
          '--no-warnings',
          '--prefer-free-formats',
          // null = no --extractor-args at all, so yt-dlp picks its own
          // client(s); every other entry forces a specific one as a
          // fallback once that default has actually failed.
          ...(clients ? ['--extractor-args', `youtube:player_client=${clients}`] : []),
          ...(isLastResort ? MISSING_POT_ARGS : []),
          '-f', 'bestaudio/best',
          target,
        ]);
        return { stdout, err: null, usedClient: `${family}:${clients || 'default'}` };
      } catch (err) {
        lastErr = err;
        // Per-attempt, not just the final failure — otherwise there's no
        // way to tell "every single client failed the same way" (points at
        // something systemic) apart from "one client failed, a later one
        // would've worked" from the logs alone.
        console.error(`Music: ${useCookies ? 'cookie-pass' : 'plain'} client ${i + 1}/${attempts.length} try ${try_}/${RETRIES_PER_CLIENT} (client=${clients || 'default'}${isLastResort ? '+missing_pot' : ''}) failed for "${target}": ${err.message}`);
        // Only worth retrying (same client again, or a different one) for
        // a failure another attempt could plausibly fix — any other
        // failure (deleted video, no results, region lock) will fail the
        // exact same way every time, so give up on this pass immediately
        // instead of burning through every remaining client.
        if (!isRetryableClientError(err.message)) break clientLoop;
        if (try_ < RETRIES_PER_CLIENT) await sleep(RETRY_DELAY_MS);
      }
    }
  }
  return { stdout: null, err: lastErr, usedClient: null };
}

// Last resort when EVERY YouTube path is exhausted (every client, cookies
// included): SoundCloud. Not a YouTube trick at all — a completely
// different platform, on its own infrastructure, with no exposure to
// YouTube's anti-bot IP-reputation blocking whatsoever. Only attempted for
// a text search (a pasted YouTube URL has no SoundCloud equivalent to look
// up) — and the result can genuinely be a different recording/upload of
// the song, not a bug, just the nature of "YouTube flatly won't give us
// this one, here's the closest thing that will actually play instead of
// nothing."
async function resolveFromSoundCloud(query) {
  const stdout = await runYtdlp([
    '--dump-single-json',
    '--no-playlist',
    '--no-check-certificates',
    '--no-warnings',
    '-f', 'bestaudio/best',
    `scsearch1:${query}`,
  ]);
  const info = JSON.parse(stdout);
  const picked = info && info.entries ? info.entries[0] : info;
  if (!picked || !picked.url) throw new Error(`No SoundCloud results for "${query}" either.`);
  return {
    streamUrl: picked.url,
    httpHeaders: picked.http_headers || null,
    title: picked.title || 'Unknown title',
    webpageUrl: picked.webpage_url || null,
    duration: picked.duration || null,
    thumbnail: picked.thumbnail || null,
    artist: picked.artist || picked.uploader || null,
    track: picked.track || null,
    usedClient: 'soundcloud',
    fromSoundCloud: true,
  };
}

// `excludeClients`: a Set of "family:client" keys (see tryClientList) to
// skip — used by retryPlayback below to force a genuinely different source
// than one that already resolved fine but then produced no actual audio.
async function resolveTrack(query, excludeClients = new Set()) {
  const isUrl = YOUTUBE_REGEX.test(query);
  const target = isUrl ? query : `ytsearch1:${query}`;

  // Plain (cookie-free) pass first — see YTDLP_CLIENT_FALLBACKS above for
  // why. Only falls through to a cookie-authenticated pass if that
  // entirely failed (or was fully excluded) AND cookies are actually
  // configured; cookies rarely help anything the plain pass couldn't
  // already resolve, so there's no reason to spend the extra requests when
  // there's nothing to fall back to anyway.
  let { stdout, err: lastErr, usedClient } = await tryClientList(target, YTDLP_CLIENT_FALLBACKS, false, excludeClients);
  if (!stdout && cookiesPath) {
    ({ stdout, err: lastErr, usedClient } = await tryClientList(target, YTDLP_COOKIE_FALLBACKS, true, excludeClients));
  }

  if (!stdout) {
    if (!isUrl && !excludeClients.has('soundcloud')) {
      try {
        const scTrack = await resolveFromSoundCloud(query);
        console.error(`Music: YouTube exhausted for "${query}" — falling back to SoundCloud ("${scTrack.title}").`);
        return scTrack;
      } catch (scErr) {
        console.error(`Music: SoundCloud fallback also failed for "${query}": ${scErr.message}`);
      }
    }
    throw lastErr || new Error(`No more sources to try for "${query}".`);
  }

  const info = JSON.parse(stdout);
  const picked = info && info.entries ? info.entries[0] : info;
  if (!picked || !picked.url) throw new Error(`No results found for "${query}".`);

  return {
    streamUrl: picked.url,
    // yt-dlp resolves a direct CDN URL that (for YouTube) is only reliably
    // fetchable with the same request headers yt-dlp itself used — handing
    // ffmpeg the bare URL with no headers is a common cause of a silent
    // 403 (the track "plays" but no audio ever arrives).
    httpHeaders: picked.http_headers || null,
    title: picked.title || 'Unknown title',
    webpageUrl: picked.webpage_url || (isUrl ? query : null),
    duration: picked.duration || null,
    thumbnail: picked.thumbnail || null,
    // YouTube Music-tagged uploads carry real artist/track metadata —
    // far more reliable for a lyrics lookup than guessing from the video
    // title (which is often "Artist - Track (Official Video) [4K]" but
    // just as often isn't formatted anything like that).
    artist: picked.artist || picked.uploader || picked.channel || null,
    track: picked.track || null,
    usedClient,
  };
}

// Best-effort "Artist" / "Track" split for a lyrics lookup when yt-dlp
// didn't already give us clean metadata (see resolveTrack). Strips the
// common "(Official Video)", "[HD]", "(Lyrics)" etc. noise first, then
// splits on the first " - " / " – " / " — ", which is how most music
// uploads title themselves.
function parseArtistTrack(rawTitle) {
  const cleaned = rawTitle
    .replace(/[([][^)\]]*\b(official|video|audio|lyrics?|remaster(ed)?|hd|hq|4k|mv|visualizer|explicit|clean)\b[^)\]]*[)\]]/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  const parts = cleaned.split(/\s+[-–—]\s+/);
  if (parts.length >= 2) {
    return { artist: parts[0].trim(), track: parts.slice(1).join(' - ').trim() };
  }
  return { artist: null, track: cleaned || rawTitle };
}

// lrclib.net: free, keyless, community-sourced lyrics with optional
// line-synced (LRC) timing — exactly what a "where in the song are we"
// display needs. Never throws: a lookup failure just means "no lyrics",
// not a broken command.
async function fetchLyrics(artist, track) {
  try {
    const params = new URLSearchParams({ track_name: track, artist_name: artist || '' });
    const res = await fetch(`https://lrclib.net/api/search?${params}`, {
      headers: { 'User-Agent': 'hubcord-bot (Discord music lyrics lookup)' },
    });
    if (!res.ok) return null;
    const results = await res.json();
    if (!Array.isArray(results) || results.length === 0) return null;
    // Prefer a result that actually has line-synced timing over a plain-
    // text-only match further down the (relevance-ranked) list.
    const best = results.find((r) => r.syncedLyrics) || results[0];
    if (!best.syncedLyrics && !best.plainLyrics) return null;
    return { syncedLyrics: best.syncedLyrics || null, plainLyrics: best.plainLyrics || null };
  } catch {
    return null;
  }
}

const LRC_LINE_RE = /^\[(\d{2}):(\d{2})(?:\.(\d{1,3}))?\](.*)$/;

function parseSyncedLyrics(lrc) {
  const lines = [];
  for (const raw of lrc.split('\n')) {
    const m = raw.match(LRC_LINE_RE);
    if (!m) continue;
    const ms = m[3] ? parseInt(m[3].padEnd(3, '0'), 10) : 0;
    lines.push({ timeMs: parseInt(m[1], 10) * 60000 + parseInt(m[2], 10) * 1000 + ms, text: m[4].trim() });
  }
  return lines;
}

// A short window of lines centered on the current playback position, with
// the active line bolded and arrowed — the "karaoke" effect. Falls back to
// the very start if playback position is somehow before the first line.
function buildSyncedLyricsWindow(lines, elapsedMs, radius = 4) {
  let idx = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].timeMs <= elapsedMs) idx = i;
    else break;
  }
  const start = Math.max(0, idx - radius);
  const end = Math.min(lines.length, idx + radius + 1);
  return lines
    .slice(start, end)
    .map((l, i) => {
      const text = l.text || '♪';
      return start + i === idx ? `**▶ ${text}**` : text;
    })
    .join('\n');
}

// Split from buildLyricsEmbed (below) so a live-updating !lyrics session
// (see startLyricsLive) can fetch the lyrics ONCE per song and re-render
// just the moving highlighted-line window on every tick from the already-
// fetched data, instead of hitting lrclib.net again every few seconds for
// a plain-text result that never changes anyway.
async function buildLyricsData(guildId) {
  const state = getState(guildId);
  const entry = state.current;
  if (!entry) return null;

  const settings = getSettings(guildId);
  const displayTitle = entry.title || entry.query;

  if (!settings.lyricsEnabled) return { entry, displayTitle, kind: 'disabled' };

  const guess = parseArtistTrack(displayTitle);
  const artist = entry.artist || guess.artist;
  const track = entry.track || guess.track;
  const lyrics = await fetchLyrics(artist, track);

  if (!lyrics) return { entry, displayTitle, kind: 'unavailable' };
  if (lyrics.syncedLyrics) return { entry, displayTitle, kind: 'synced', lines: parseSyncedLyrics(lyrics.syncedLyrics) };
  return { entry, displayTitle, kind: 'plain', text: lyrics.plainLyrics };
}

function renderLyricsEmbed(guildId, data) {
  const { entry, displayTitle } = data;
  const embed = new EmbedBuilder()
    .setColor(0x3ecf8e)
    .setTitle(`🎤 ${displayTitle}`)
    .setFooter(brandFooter(clientRef, guildId));
  if (entry.thumbnail) embed.setThumbnail(entry.thumbnail);
  if (entry.webpageUrl) embed.setURL(entry.webpageUrl);

  if (data.kind === 'disabled') return embed.setDescription('Lyrics are turned off on this server.');
  if (data.kind === 'unavailable') return embed.setDescription('Lyrics is not available for this song.');

  if (data.kind === 'synced') {
    const elapsedMs = getElapsedMs(getState(guildId));
    return embed
      .setDescription(buildSyncedLyricsWindow(data.lines, elapsedMs))
      .addFields({ name: 'Position', value: buildProgressBar(elapsedMs / 1000, entry.duration) });
  }

  // Plain (unsynced) lyrics — Discord embed descriptions cap at 4096
  // characters; nearly every song fits, but trim safely just in case.
  const plain = data.text.length > 3900 ? data.text.slice(0, 3900) + '\n…' : data.text;
  return embed.setDescription(plain || 'Lyrics is not available for this song.');
}

async function buildLyricsEmbed(guildId) {
  const data = await buildLyricsData(guildId);
  if (!data) return null;
  return renderLyricsEmbed(guildId, data);
}

function buildLyricsEndedEmbed(guildId, title) {
  return new EmbedBuilder()
    .setColor(0x3ecf8e)
    .setTitle(`🎤 ${title}`)
    .setDescription('🎵 This song has ended.')
    .setFooter(brandFooter(clientRef, guildId));
}

// Discord's edit-rate-limit bucket for a single message is generous enough
// for this (discord.js also queues/delays requests transparently if a burst
// ever did hit it, rather than erroring out) — 1s keeps the highlighted
// line visibly in step with the actual audio instead of looking laggy.
const LYRICS_LIVE_UPDATE_MS = 1000;

function stopLyricsLive(guildId) {
  const state = getState(guildId);
  if (state.lyricsLive?.intervalId) clearInterval(state.lyricsLive.intervalId);
  state.lyricsLive = null;
}

// !lyrics / !ly: sends one message, then keeps editing that SAME message
// every few seconds — the highlighted line advancing through the song for
// synced lyrics — until the tracked song stops being state.current (it
// finished, got skipped, or the bot was stopped), at which point it edits
// one last time to say so and stops. Only one live session per guild at a
// time; starting a new one replaces whatever was already running instead
// of leaving two intervals fighting over separate messages.
async function startLyricsLive(message) {
  const guildId = message.guild.id;
  const state = getState(guildId);
  if (!state.current) return null;

  const trackId = state.current.id;
  const title = state.current.title || state.current.query;
  const data = await buildLyricsData(guildId);
  if (!data) return null;

  stopLyricsLive(guildId);

  const sent = await message.channel.send({ embeds: [renderLyricsEmbed(guildId, data)] });

  // Only synced lyrics have anything to actually redraw on a timer — the
  // highlighted line moving with playback position. Plain/unavailable/
  // disabled lyrics don't change while the song plays, so re-fetching from
  // lrclib.net every tick for no visual difference would just be wasted
  // API calls; this still watches for the song ending either way.
  const needsPositionUpdates = data.kind === 'synced';

  const session = { message: sent };
  session.intervalId = setInterval(async () => {
    const s = getState(guildId);
    if (s.lyricsLive !== session) return; // superseded or already stopped
    const stillPlaying = s.current && s.current.id === trackId;
    try {
      if (!stillPlaying) {
        await sent.edit({ embeds: [buildLyricsEndedEmbed(guildId, title)] });
        stopLyricsLive(guildId);
        return;
      }
      if (needsPositionUpdates) {
        await sent.edit({ embeds: [renderLyricsEmbed(guildId, data)] });
      }
    } catch (err) {
      // Message deleted, missing permissions, etc. — stop instead of
      // erroring on this same interval forever.
      console.error(`Live lyrics update failed in guild ${guildId}:`, err.message);
      stopLyricsLive(guildId);
    }
  }, LYRICS_LIVE_UPDATE_MS);

  state.lyricsLive = session;
  return sent;
}

// Spawns ffmpeg to transcode the resolved stream URL to raw PCM on stdout —
// same shape as the Python prototype's discord.FFmpegPCMAudio, just driven
// by hand here so the process can be killed cleanly on skip/stop instead of
// leaking a zombie ffmpeg per song. stderr is captured (not just piped and
// ignored) specifically so a fetch failure against the stream URL — a 403
// from YouTube being the big one — shows up in logs and as a real skip
// instead of silent "now playing" silence.
function spawnFfmpegPcm(streamUrl, httpHeaders) {
  const args = [
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
  ];
  if (httpHeaders && Object.keys(httpHeaders).length > 0) {
    const headerLines = Object.entries(httpHeaders).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n';
    args.push('-headers', headerLines);
  }
  args.push(
    '-i', streamUrl,
    '-analyzeduration', '0',
    '-loglevel', 'error',
    '-f', 's16le',
    '-ar', '48000',
    '-ac', '2',
    'pipe:1',
  );
  return spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
}

// ---------- Playback ----------

async function ensureConnection(message) {
  // Captured once, up front, instead of reading message.guild.id from
  // inside the listeners below: those listeners live for as long as the
  // voice connection does (way past this function returning), and
  // message.guild is a live cache lookup that can turn null later (guild
  // cache eviction, a brief gateway outage, etc.) — reading it from an
  // event handler then threw an uncaught TypeError straight out of
  // @discordjs/voice's internals, which isn't inside anyone's try/catch
  // and crashed the entire bot process, not just this guild's playback.
  const guildId = message.guild.id;
  const state = getState(guildId);
  const voiceChannel = message.member.voice.channel;
  if (!voiceChannel) throw new Error('You need to be in a voice channel for me to play music.');

  if (!state.connection || state.connection.state.status === VoiceConnectionStatus.Destroyed) {
    state.connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId,
      adapterCreator: message.guild.voiceAdapterCreator,
      selfDeaf: true,
    });
    state.player = createAudioPlayer();
    const subscription = state.connection.subscribe(state.player);
    if (!subscription) {
      console.error(`Music: connection.subscribe() returned null for guild ${guildId} — the player has no active subscriber, so nothing would ever actually be sent to voice.`);
    }

    // Temporary-but-cheap diagnostics: every status change, on both the
    // connection and the player, logged with guild id. Cheap enough to
    // leave in permanently — this is exactly the kind of "says it's
    // playing but nothing happens" failure that's otherwise invisible.
    state.connection.on('stateChange', (oldState, newState) => {
      console.log(`Music voice connection [${guildId}]: ${oldState.status} -> ${newState.status}`);
    });
    state.player.on('stateChange', (oldState, newState) => {
      console.log(`Music player [${guildId}]: ${oldState.status} -> ${newState.status}`);
    });

    state.player.on(AudioPlayerStatus.Idle, () => {
      // A silent-failure retry (see playResolvedTrack) already has its own
      // exit handler deciding what to do next — the empty/failed resource
      // ending also drives the player to Idle around the same time, which
      // would otherwise race this generic handler into advancing the queue
      // a second time (or ahead of the retry actually finishing).
      if (state.awaitingRetry) return;
      killFfmpeg(state);
      playNext(guildId).catch((err) => console.error(`Music playNext failed in guild ${guildId}:`, err.message));
    });
    state.player.on('error', (err) => {
      if (state.awaitingRetry) return;
      console.error(`Music player error in guild ${guildId}:`, err.message, err.stack || '');
      killFfmpeg(state);
      playNext(guildId).catch((e) => console.error(`Music playNext failed in guild ${guildId}:`, e.message));
    });

    await entersState(state.connection, VoiceConnectionStatus.Ready, 15_000);
  } else if (state.connection.joinConfig.channelId !== voiceChannel.id) {
    // Leaving automatic mode's home channel with something actively
    // playing there — pause it (not skip it, not let it keep streaming
    // into the channel we're moving to) so it picks back up from exactly
    // this position once the bot returns home. See returnToAutomaticHome.
    if (
      state.automatic?.active &&
      state.connection.joinConfig.channelId === state.automatic.homeChannelId &&
      state.current?.isAutomatic &&
      state.player?.state.status === AudioPlayerStatus.Playing
    ) {
      pause(guildId);
    }
    state.connection.rejoin({ channelId: voiceChannel.id, guildId, selfDeaf: true, adapterCreator: message.guild.voiceAdapterCreator });
  }

  state.textChannelId = message.channel.id;
  clearIdleTimer(state);
  return state;
}

// How many different YouTube clients to actually try getting real audio
// bytes from (not just a resolvable URL — see below) before falling all
// the way through to the guaranteed SoundCloud attempt (see retryPlayback).
const MAX_PLAYBACK_ATTEMPTS = 2;
// Safety net for a stream that connects but never actually sends data.
// ffmpeg's own -reconnect flags handle ordinary drops and it exits fast on
// a definitive HTTP error (a 403 doesn't get "reconnected"); this only
// exists for the rarer case of a connection that just hangs open silently.
// Kept short — every second here is a second of dead air for whoever's
// listening, and waiting longer for a YouTube stream that's this likely to
// be blocked isn't worth it when SoundCloud is right behind it.
const AUDIO_START_TIMEOUT_MS = 10000;

// Spawns ffmpeg for one resolved stream and wires up detection for "says
// it's playing but produces zero audio" — a stream URL that resolves fine
// as metadata but then gets silently blocked (a 403, most commonly) when
// ffmpeg actually requests it. "Now playing" and playback-position
// tracking only start once real audio bytes are actually flowing, not at
// spawn time — announcing immediately (the old behavior) is exactly what
// made this failure look like "the bot says it's playing but nothing
// plays": the announcement had already gone out before the silence was
// even detected. If this attempt produces nothing, automatically
// re-resolves with a different client (excluding every client already
// tried for this track) and tries again, up to MAX_PLAYBACK_ATTEMPTS,
// before finally giving up and skipping to the next queue entry.
function playResolvedTrack(guildId, next, track, excludeClients, attemptNumber) {
  const state = getState(guildId);
  // A retry can land here well after an async resolveTrack() call — if the
  // user ran !stop (or the bot got disconnected) in the meantime, there's
  // no player left to hand a resource to; bail out instead of throwing on
  // state.player.play() against a null player.
  if (!state.player || !state.connection) return;
  state.awaitingRetry = false; // actively attempting playback again now, not just waiting on a decision
  killFfmpeg(state);
  const proc = spawnFfmpegPcm(track.streamUrl, track.httpHeaders);
  state.ffmpegProc = proc;

  let stderrTail = '';
  proc.stderr?.on('data', (chunk) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-2000); // keep it bounded, we only need the last error
  });
  proc.on('error', (err) => console.error(`ffmpeg failed to start for guild ${guildId}:`, err.message));

  let gotAudio = false;
  const audioTimeout = setTimeout(() => {
    if (gotAudio || state.ffmpegProc !== proc) return;
    console.error(`Music: attempt ${attemptNumber}/${MAX_PLAYBACK_ATTEMPTS} timed out waiting for audio for "${track.title}" (client ${track.usedClient}) in guild ${guildId} — trying a different source.`);
    try { proc.kill('SIGKILL'); } catch { /* already dead */ } // its 'exit' handler below drives the actual retry
  }, AUDIO_START_TIMEOUT_MS);

  proc.stdout.once('data', () => {
    gotAudio = true;
    clearTimeout(audioTimeout);
    state.awaitingRetry = false; // confirmed real audio — the generic Idle/error handlers can resume handling this song normally

    // Playback-position tracking, for !nowplaying's progress bar and
    // !lyrics' current-line sync. pausedAccumMs/pausedSince (see pause()/
    // resume()) subtract out any time spent paused.
    next.playbackStartedAt = Date.now();
    next.pausedAccumMs = 0;
    state.pausedSince = null;

    if (getSettings(guildId).announceNowPlaying && state.textChannelId && clientRef) {
      clientRef.channels.fetch(state.textChannelId)
        .then((channel) => {
          if (!channel) return;
          const embed = new EmbedBuilder()
            .setColor(0x3ecf8e)
            .setTitle('▶️ Now playing')
            .setDescription(
              `**${track.title}**${next.requestedBy ? `\nRequested by <@${next.requestedBy}>` : ''}` +
              // YouTube flatly refused every client/cookie combo for this
              // one — worth being upfront that this came from SoundCloud
              // instead (and so may be a different recording/upload of the
              // song), not silently passing it off as the YouTube result.
              (track.fromSoundCloud ? `\n*(via SoundCloud — YouTube was unavailable for this one)*` : ''),
            )
            .setFooter(brandFooter(clientRef, guildId));
          if (track.thumbnail) embed.setThumbnail(track.thumbnail);
          if (track.webpageUrl) embed.setURL(track.webpageUrl);
          return channel.send({ embeds: [embed] });
        })
        .catch(() => {});
    }

    // Top the queue back up in the background once it's running low, so
    // playback doesn't visibly stall waiting on a search every single time
    // it happens to run dry — this fires "ahead of time" instead.
    const atHome = !state.automatic?.active || !state.automatic.homeChannelId || state.connection?.joinConfig.channelId === state.automatic.homeChannelId;
    if (state.automatic?.active && atHome) {
      const automaticQueued = state.queue.filter((e) => e.isAutomatic).length;
      if (automaticQueued < AUTOMATIC_REFILL_AHEAD) {
        refillAutomaticQueue(guildId).catch((err) => console.error(`Automatic mode refill failed for guild ${guildId}:`, err.message));
      }
    }
  });

  proc.once('exit', (code, signal) => {
    clearTimeout(audioTimeout);
    // Already succeeded, or superseded by a skip/stop/later retry attempt
    // in the meantime — nothing to do.
    if (gotAudio || state.ffmpegProc !== proc) return;
    console.error(`Music: attempt ${attemptNumber}/${MAX_PLAYBACK_ATTEMPTS} produced no audio for "${track.title}" (client ${track.usedClient}) in guild ${guildId} (exit code=${code} signal=${signal}): ${stderrTail.trim() || '(no stderr output)'}`);
    // Set before retryPlayback (not inside it) — the empty resource ending
    // can drive the player to Idle in this same tick, and that check needs
    // to already see this as true.
    state.awaitingRetry = true;
    retryPlayback(guildId, next, excludeClients, attemptNumber).catch((err) => console.error(`Music: retry failed in guild ${guildId}:`, err.message));
  });

  const resource = createAudioResource(proc.stdout, { inputType: StreamType.Raw, inlineVolume: true });
  resource.volume.setVolume((state.volume ?? getSettings(guildId).defaultVolume) / 100);
  state.currentResource = resource;
  state.player.play(resource);
}

async function retryPlayback(guildId, next, excludeClients, previousAttemptNumber) {
  const state = getState(guildId);

  if (previousAttemptNumber >= MAX_PLAYBACK_ATTEMPTS) {
    // Every YouTube attempt in the budget failed to produce audio — this
    // covers BOTH failure shapes, resolveTrack() itself throwing (every
    // client rejected at the metadata stage) and a resolved stream that
    // silently produced nothing once ffmpeg actually fetched it. Either
    // way, SoundCloud always gets one final, guaranteed shot before
    // actually giving up on the track — not only when resolveTrack's own
    // YouTube ladder happened to be the thing that ran out. Marked
    // excluded up front so this can only ever fire once per track.
    if (!YOUTUBE_REGEX.test(next.query) && !excludeClients.has('soundcloud')) {
      excludeClients.add('soundcloud');
      try {
        const track = await resolveFromSoundCloud(next.query);
        console.error(`Music: YouTube gave up on "${next.query}" in guild ${guildId} — trying SoundCloud as a last resort.`);
        next.title = track.title;
        next.thumbnail = track.thumbnail;
        next.duration = track.duration;
        next.webpageUrl = track.webpageUrl;
        playResolvedTrack(guildId, next, track, excludeClients, previousAttemptNumber + 1);
        return;
      } catch (err) {
        console.error(`Music: SoundCloud last-resort also failed for "${next.query}" in guild ${guildId}:`, err.message);
      }
    }

    console.error(`Music: gave up on "${next.query}" in guild ${guildId} after ${previousAttemptNumber} source(s) with no audio.`);
    // Same "don't flood the channel" reasoning as the resolve-failure catch
    // below — automatic mode just moves on quietly, a real request still
    // gets told.
    if (!next.isAutomatic && state.textChannelId && clientRef) {
      clientRef.channels.fetch(state.textChannelId)
        .then((ch) => ch?.send(`⚠️ Couldn't get any audio for **${next.title || next.query}** after trying multiple sources — skipping.`))
        .catch(() => {});
    }
    state.awaitingRetry = false; // giving up ourselves now — let the normal Idle/error handling apply again from here on
    killFfmpeg(state);
    playNext(guildId).catch((err) => console.error(`Music playNext failed in guild ${guildId}:`, err.message));
    return;
  }

  try {
    const track = await resolveTrack(next.query, excludeClients);
    excludeClients.add(track.usedClient);
    next.title = track.title;
    next.thumbnail = track.thumbnail;
    next.duration = track.duration;
    next.webpageUrl = track.webpageUrl;
    playResolvedTrack(guildId, next, track, excludeClients, previousAttemptNumber + 1);
  } catch (err) {
    // Genuinely nothing left to try (every client excluded, or a real
    // resolve error this time) — same handling as a first-attempt failure.
    console.error(`Music: couldn't resolve a fallback source for "${next.query}" in guild ${guildId}:`, err.message);
    if (!next.isAutomatic && state.textChannelId && clientRef) {
      clientRef.channels.fetch(state.textChannelId)
        .then((ch) => ch?.send(`⚠️ Couldn't play "${next.query}": ${err.message} — skipping.`))
        .catch(() => {});
    }
    state.awaitingRetry = false;
    killFfmpeg(state);
    playNext(guildId).catch((e) => console.error(`Music playNext failed in guild ${guildId}:`, e.message));
  }
}

async function playNext(guildId) {
  const state = getState(guildId);
  if (!state.connection || !state.player) return;

  if (state.looping && state.current) {
    state.queue.unshift({ ...state.current, id: crypto.randomUUID() });
  }

  // Refilling and continuing automatic playback here only makes sense at
  // its home channel — if an admin's request elsewhere pulled the bot away
  // (see ensureConnection's rejoin) and their queue just ran dry, it should
  // wait to see if they're done (scheduleIdleDisconnect handles hopping
  // back home after a short quiet period), not start playing the mood
  // playlist into whatever channel it currently happens to be in.
  const atAutomaticHome = !state.automatic?.active
    || !state.automatic.homeChannelId
    || state.connection?.joinConfig.channelId === state.automatic.homeChannelId;

  // The queue can already contain leftover automatic picks from before an
  // admin's request pulled the bot to a different channel (they were
  // queued while still at home, then never got a turn) — and, since a
  // manually-requested song is pushed to the BACK of the queue rather than
  // in front of those, there can be several of them ahead of the actual
  // request. Away from home, none of them get to play: skip past every one
  // of them (not just the first) to find a real candidate — an earlier
  // version only checked the very first queue entry, so an admin's request
  // sitting behind even one leftover automatic pick silently never played
  // at all, the bot just joined the away channel and sat there doing
  // nothing until the 30s return-home timer fired.
  let next;
  const deferredAutomatic = [];
  while (state.queue.length > 0) {
    const candidate = state.queue.shift();
    if (candidate.isAutomatic && state.automatic?.active && !atAutomaticHome) {
      deferredAutomatic.push(candidate);
      continue;
    }
    next = candidate;
    break;
  }
  // Put them back untouched, in their original order, so they're still
  // next in line once the bot actually returns home.
  if (deferredAutomatic.length > 0) state.queue.unshift(...deferredAutomatic);

  if (!next && state.automatic?.active && atAutomaticHome) {
    await refillAutomaticQueue(guildId);
    next = state.queue.shift();
    if (!next && state.textChannelId && clientRef) {
      // Genuinely found nothing (bad/too-narrow mood, or a transient search
      // failure) — automatic mode can't spin forever with no results, so it
      // switches itself off instead of the bot silently sitting connected
      // and doing nothing forever.
      state.automatic = null;
      clientRef.channels.fetch(state.textChannelId)
        .then((ch) => ch?.send("🔀 Automatic mode stopped — couldn't find any more results."))
        .catch(() => {});
    }
  }
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

    // Automatic mode picks are exempt — mood searches (esp. "relaxing"/
    // "sleep"/"lofi") routinely turn up genuinely long mixes, and skipping
    // those would defeat the entire point of a hands-off session.
    const maxDuration = getSettings(guildId).maxSongDurationSeconds;
    if (!next.isAutomatic && maxDuration > 0 && track.duration && track.duration > maxDuration) {
      if (state.textChannelId && clientRef) {
        clientRef.channels.fetch(state.textChannelId)
          .then((ch) => ch?.send(`⏭️ Skipping **${track.title}** — longer than the ${Math.round(maxDuration / 60)}-minute limit set for this server.`))
          .catch(() => {});
      }
      return playNext(guildId);
    }

    recordHistory(guildId, track, next);

    // Kicks off the actual ffmpeg spawn + audio-detection + retry-with-a-
    // different-client chain (see playResolvedTrack below) — not awaited,
    // it wires up listeners and returns once playback has started, same as
    // the inline code this replaced.
    playResolvedTrack(guildId, next, track, new Set([track.usedClient]), 1);
  } catch (err) {
    // Logged server-side too, not just posted to Discord — the Discord
    // message alone (which is all this used to do) meant a resolve failure
    // like YouTube's anti-bot wall left no trace in Railway's logs at all,
    // making it impossible to tell "hit every client fallback and still got
    // walled" apart from any other failure after the fact.
    console.error(`Music: couldn't resolve "${next.query}" for guild ${guildId}:`, err.message);
    // Automatic mode picks its own candidates and just moves on to the
    // next one when one fails — announcing every single miss flooded the
    // channel during a rough patch (a YouTube anti-bot wall can mean
    // several automatic picks in a row fail within the same minute). A
    // real !musik request the user actually typed still gets told.
    if (!next.isAutomatic && state.textChannelId && clientRef) {
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
  assertNotBlockedByAutomatic(message.guild.id, message.member); // also covers the dashboard's "Play from Dashboard", which calls enqueue() directly, not through requirePermission
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

// ---------- Automatic mode ----------
// !automatic <mood/genre> starts a fully hands-off session: an initial
// batch of matching videos is queued, then topped up automatically as it
// plays (see the two refillAutomaticQueue() call sites in playNext()).
// Entries are tagged isAdmin: false (never isAutomatic ones jump the
// queue), so a real admin manually queuing something via !musik still
// correctly cuts in front of them — automatic mode fills gaps, it doesn't
// override real requests.

async function refillAutomaticQueue(guildId) {
  const state = getState(guildId);
  if (!state.automatic?.active) return;

  const settings = getSettings(guildId);
  if (state.queue.length >= settings.maxQueueSize) return;

  let stdout;
  try {
    // --flat-playlist: a fast, lightweight search (id/title/url only, no
    // per-video format resolution) — the full stream info for each one is
    // only fetched later, lazily, by resolveTrack() when it's actually
    // about to play, same as every other queue entry.
    stdout = await runYtdlp([
      ...cookieArgs(),
      '--dump-single-json',
      '--flat-playlist',
      '--no-warnings',
      '--no-check-certificates',
      `ytsearch${AUTOMATIC_BATCH_SIZE}:${state.automatic.mood} music`,
    ]);
  } catch (err) {
    console.error(`Automatic mode search failed for guild ${guildId}:`, err.message);
    return;
  }

  let info;
  try {
    info = JSON.parse(stdout);
  } catch {
    return;
  }
  const allResults = (info.entries || []).filter((e) => e && e.id && e.url);

  // Genuinely a real, infinite loop: a search for one mood keeps returning
  // roughly the same top results every time, so once everything currently
  // findable has already been queued once, "seen" would otherwise filter
  // the list down to nothing and automatic mode would give up after one
  // batch. Prefer never-played results, but once those run out, recycle
  // the mood's playlist from the top instead of stopping — that's the
  // actual point of "automatic chill music forever" until !automaticstop.
  const fresh = allResults.filter((e) => !state.automatic.seen.has(e.id));
  const candidates = fresh.length > 0 ? fresh : allResults;
  if (fresh.length === 0) state.automatic.seen.clear(); // starting a fresh lap

  // Shuffle (Fisher-Yates) so repeated refills don't always play the same
  // search-ranked order, and so back-to-back automatic sessions don't feel
  // identical for the same mood.
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }

  const room = Math.max(0, settings.maxQueueSize - state.queue.length);
  for (const c of candidates.slice(0, room)) {
    state.automatic.seen.add(c.id);
    state.queue.push({
      id: crypto.randomUUID(),
      query: c.url,
      title: c.title || null, // shown in !queue immediately, refined once actually resolved
      requestedBy: state.automatic.startedBy,
      requestedByTag: `Automatic mode (${state.automatic.mood})`,
      isAdmin: false,
      isAutomatic: true,
      addedAt: Date.now(),
    });
  }
}

async function startAutomatic(message, mood) {
  if (!features.isEnabled(message.guild.id, 'music')) {
    throw new Error('Music is currently disabled on this server.');
  }
  requireVoiceChatChannel(message);
  const state = await ensureConnection(message);
  if (state.automatic?.active) {
    throw new Error(`Automatic mode is already running ("${state.automatic.mood}") — use !automaticstop first to change it.`);
  }

  state.automatic = {
    active: true,
    mood,
    startedBy: message.author.id,
    seen: new Set(),
    // Remembered so the bot can find its way back here — see
    // returnToAutomaticHome() — if an admin's request from a different
    // voice channel pulls it away mid-session.
    homeChannelId: message.member.voice.channel.id,
    homeTextChannelId: message.channel.id,
  };
  await refillAutomaticQueue(message.guild.id);
  if (state.queue.length === 0) {
    state.automatic = null;
    throw new Error(`Couldn't find anything for "${mood}" — try a different mood or genre.`);
  }

  const busy = state.player && (state.player.state.status === AudioPlayerStatus.Playing || state.player.state.status === AudioPlayerStatus.Buffering);
  if (!busy) await playNext(message.guild.id);
  return state.automatic;
}

// Stops the auto-refill and drops any not-yet-played automatic-sourced
// entries (a stale backlog for a mood nobody asked to keep). The currently
// playing track (if it happens to be an automatic one) and anything a real
// admin queued via !musik are left alone.
function stopAutomatic(guildId) {
  const state = getState(guildId);
  if (!state.automatic?.active) return false;
  state.automatic = null;
  state.queue = state.queue.filter((e) => !e.isAutomatic);
  return true;
}

function skip(guildId) {
  const state = getState(guildId);
  if (!state.player) return false;
  if (state.awaitingRetry) {
    // A silent-failure retry is mid-flight for the current track — the
    // Idle handler is deliberately ignoring player-idle events right now
    // (see playResolvedTrack) so it doesn't race that retry, which would
    // otherwise silently swallow this skip too. Abandon the retry and move
    // on immediately instead.
    state.awaitingRetry = false;
    killFfmpeg(state);
    playNext(guildId).catch((err) => console.error(`Music playNext failed in guild ${guildId}:`, err.message));
    return true;
  }
  state.player.stop(true); // triggers the Idle handler -> playNext
  return true;
}

// Lets anyone in the voice channel vote to skip, independent of the `skip`
// command's own role permissions — the point is a democratic fallback when
// skip is locked to admins/DJs and none are around. One vote per user per
// song (state.voteSkips is reset in playNext whenever a new track starts).
function voteSkip(guildId, member, voiceChannelMemberCount) {
  assertNotBlockedByAutomatic(guildId, member); // voteskip deliberately bypasses canUseMusicCommand's role gate, but not this one
  const state = getState(guildId);
  if (!state.current) throw new Error('Nothing is playing.');
  const settings = getSettings(guildId);
  if (!settings.voteSkipEnabled) throw new Error('Vote-skip is turned off on this server — ask someone with permission to use !skip.');
  if (!state.voteSkips) state.voteSkips = new Set();
  const userId = member.id;
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
  const ok = state.player.pause();
  if (ok) state.pausedSince = Date.now();
  return ok;
}

function resume(guildId) {
  const state = getState(guildId);
  if (!state.player || state.player.state.status !== AudioPlayerStatus.Paused) return false;
  const ok = state.player.unpause();
  if (ok && state.pausedSince && state.current) {
    state.current.pausedAccumMs = (state.current.pausedAccumMs || 0) + (Date.now() - state.pausedSince);
    state.pausedSince = null;
  }
  return ok;
}

// Milliseconds into the current track, net of any time spent paused.
function getElapsedMs(state) {
  if (!state.current || !state.current.playbackStartedAt) return 0;
  let elapsed = Date.now() - state.current.playbackStartedAt - (state.current.pausedAccumMs || 0);
  if (state.pausedSince) elapsed -= Date.now() - state.pausedSince;
  return Math.max(0, elapsed);
}

function formatClock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return (h > 0 ? `${h}:` : '') + `${mm}:${String(sec).padStart(2, '0')}`;
}

// A little text progress bar, e.g. "02:14 ▬▬▬▬▬●▬▬▬▬▬▬▬▬ 05:12".
function buildProgressBar(elapsedSeconds, totalSeconds) {
  if (!totalSeconds || totalSeconds <= 0) return `${formatClock(elapsedSeconds)} (live/unknown length)`;
  const barLength = 18;
  const ratio = Math.max(0, Math.min(1, elapsedSeconds / totalSeconds));
  const filled = Math.round(ratio * barLength);
  const bar = '▬'.repeat(filled) + '●' + '▬'.repeat(Math.max(0, barLength - filled));
  return `${formatClock(elapsedSeconds)} ${bar} ${formatClock(totalSeconds)}`;
}

function stop(guildId) {
  const state = getState(guildId);
  state.queue = [];
  state.current = null;
  state.looping = false;
  state.awaitingRetry = false;
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
    current: state.current
      ? { ...formatEntry(state.current), thumbnail: state.current.thumbnail || null, duration: state.current.duration || null, elapsedSeconds: Math.round(getElapsedMs(state) / 1000) }
      : null,
    queue: state.queue.map(formatEntry),
    volume: state.volume ?? getSettings(guildId).defaultVolume,
    looping: state.looping,
    automatic: state.automatic?.active ? { mood: state.automatic.mood, startedBy: state.automatic.startedBy } : null,
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
  startAutomatic,
  stopAutomatic,
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
  buildLyricsEmbed,
  startLyricsLive,
  buildProgressBar,
  getElapsedMs,
};
