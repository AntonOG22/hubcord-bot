// Stream alerts: each server can track any number of Twitch channels (go-live)
// and YouTube channels (new video), each pointing at its own notification
// channel and optional ping role. A background poller checks every tracked
// entry, across every server, on a fixed interval — Discord renders an
// embed's setColor() as a colored stripe down the left side of the message
// automatically, so that's literally the "side stripe" this produces, no
// extra rendering work needed.
//
// Both platforms keep their notification message alive instead of posting
// once and forgetting about it: a live Twitch stream gets its message edited
// with fresh viewer count/duration on every poll and again once it ends
// (rather than just silently going stale), and a YouTube entry whose feed
// info changes for the same still-latest video (e.g. a scheduled premiere's
// placeholder title/thumbnail turning into the real ones once it airs) gets
// its message edited too instead of leaving it out of date.
//
// Twitch needs TWITCH_CLIENT_ID/TWITCH_CLIENT_SECRET env vars (a free
// Twitch Developer app, Client Credentials grant — no per-user OAuth).
// YouTube needs no key at all: it reads the channel's public RSS feed.
// If the Twitch env vars aren't set, Twitch entries are silently skipped
// (logged once) rather than breaking YouTube tracking.
const crypto = require('crypto');
const { EmbedBuilder } = require('discord.js');
const { makeGuildStore } = require('./guildStore');
const { brandFooter } = require('./brand');
const features = require('./features');
const { getEmoji } = require('./emoji');

const POLL_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes — light on both APIs, fast enough to feel live
const TWITCH_COLOR = 0x9146ff;
const TWITCH_ENDED_COLOR = 0x6441a5;
const YOUTUBE_COLOR = 0xff0000;
const MAX_TRACKED_PER_GUILD = 15; // enforced in dashboard.js's POST /api/stream-alerts
const TWITCH_LOGINS_PER_REQUEST = 100; // Helix's own hard cap on user_login params in one call

const store = makeGuildStore('stream-alerts.json', () => ({ tracked: [] }));

let clientRef = null;
let warnedNoTwitchCreds = false;

// ---------- Twitch (app access token, Helix API) ----------

let twitchToken = null; // { value, expiresAt }

async function getTwitchToken() {
  const { TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET } = process.env;
  if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) {
    if (!warnedNoTwitchCreds) {
      console.log('TWITCH_CLIENT_ID/TWITCH_CLIENT_SECRET not set — Twitch live alerts are disabled (YouTube alerts still work).');
      warnedNoTwitchCreds = true;
    }
    return null;
  }
  if (twitchToken && twitchToken.expiresAt > Date.now() + 60_000) return twitchToken.value;

  const res = await fetch(
    `https://id.twitch.tv/oauth2/token?client_id=${encodeURIComponent(TWITCH_CLIENT_ID)}&client_secret=${encodeURIComponent(TWITCH_CLIENT_SECRET)}&grant_type=client_credentials`,
    { method: 'POST' }
  );
  if (!res.ok) throw new Error(`Twitch token request failed: ${res.status}`);
  const data = await res.json();
  twitchToken = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return twitchToken.value;
}

async function fetchLiveTwitchStreams(logins) {
  if (logins.length === 0) return new Map();
  const token = await getTwitchToken();
  if (!token) return new Map();

  // Helix rejects a single request over 100 user_login params outright, and
  // this list is the union of every server's tracked Twitch channels sharing
  // this one process — chunking keeps a large combined list from breaking
  // the check for everyone instead of just the servers past the 100th login.
  const map = new Map();
  for (let i = 0; i < logins.length; i += TWITCH_LOGINS_PER_REQUEST) {
    const chunk = logins.slice(i, i + TWITCH_LOGINS_PER_REQUEST);
    const params = chunk.map((l) => `user_login=${encodeURIComponent(l)}`).join('&');
    const res = await fetch(`https://api.twitch.tv/helix/streams?${params}`, {
      headers: { 'Client-Id': process.env.TWITCH_CLIENT_ID, Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Twitch streams request failed: ${res.status}`);
    const data = await res.json();
    for (const stream of data.data || []) map.set(stream.user_login.toLowerCase(), stream);
  }
  return map;
}

// ---------- YouTube (public RSS feed, no API key needed) ----------

function decodeXmlEntities(str) {
  return (str || '')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'");
}

async function fetchLatestYoutubeVideo(channelId) {
  const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`);
  if (!res.ok) throw new Error(`YouTube feed request failed: ${res.status}`);
  const xml = await res.text();

  const entry = xml.split('<entry>')[1];
  if (!entry) return null;

  const videoId = entry.match(/<yt:videoId>(.*?)<\/yt:videoId>/)?.[1];
  if (!videoId) return null;
  const title = entry.match(/<title>(.*?)<\/title>/)?.[1];
  const channelName = xml.match(/<name>(.*?)<\/name>/)?.[1];
  const thumbnail = entry.match(/<media:thumbnail url="(.*?)"/)?.[1];
  const publishedRaw = entry.match(/<published>(.*?)<\/published>/)?.[1];
  const publishedAt = publishedRaw ? new Date(publishedRaw) : null;

  return {
    videoId,
    title: decodeXmlEntities(title) || 'New video',
    channelName: decodeXmlEntities(channelName) || 'YouTube',
    thumbnail: thumbnail || null,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    publishedAt: publishedAt && !isNaN(publishedAt) ? publishedAt : null,
  };
}

// ---------- Embeds ----------

function buildTwitchEmbed(guildId, entry, info, ended) {
  const embed = new EmbedBuilder()
    .setURL(`https://twitch.tv/${entry.identifier}`)
    .setFooter(brandFooter(clientRef, guildId, ended ? 'Twitch stream ended' : 'Live on Twitch'))
    .setTimestamp();

  const fields = [];
  if (info.game) fields.push({ name: 'Game', value: info.game, inline: true });

  if (ended) {
    embed.setColor(TWITCH_ENDED_COLOR).setTitle(`⏹️ ${info.userName || entry.identifier} was live on Twitch`);
    if (info.peakViewers != null) fields.push({ name: 'Peak viewers', value: String(info.peakViewers), inline: true });
    if (info.startedAt) {
      const startedSec = Math.floor(new Date(info.startedAt).getTime() / 1000);
      fields.push({ name: 'Was live', value: `<t:${startedSec}:R> until just now`, inline: true });
    }
  } else {
    embed.setColor(TWITCH_COLOR).setTitle(`${getEmoji(guildId, 'twitch_live', clientRef)} ${info.userName} is live on Twitch!`);
    if (info.viewers != null) fields.push({ name: 'Viewers', value: String(info.viewers), inline: true });
    if (info.startedAt) fields.push({ name: 'Live since', value: `<t:${Math.floor(new Date(info.startedAt).getTime() / 1000)}:R>`, inline: true });
  }

  embed.setDescription(info.title || null).addFields(fields);
  // A query string cache-busts the thumbnail on edit — Twitch serves the same
  // URL pattern the whole time it's live, so without this Discord would just
  // keep showing whatever frame it first cached instead of a fresh one.
  if (info.thumbnail) embed.setImage(`${info.thumbnail}?refresh=${Date.now()}`);
  return embed;
}

function buildYoutubeEmbed(guildId, video) {
  const embed = new EmbedBuilder()
    .setColor(YOUTUBE_COLOR)
    .setTitle(`${getEmoji(guildId, 'youtube', clientRef)} New video from ${video.channelName}`)
    .setURL(video.url)
    .setDescription(video.title)
    .setFooter(brandFooter(clientRef, guildId, 'New on YouTube'))
    .setTimestamp();
  if (video.publishedAt) {
    embed.addFields({ name: 'Published', value: `<t:${Math.floor(video.publishedAt.getTime() / 1000)}:R>`, inline: true });
  }
  if (video.thumbnail) embed.setImage(video.thumbnail);
  return embed;
}

// ---------- Notification sending/editing ----------

// entry.pingRoleId is either a real role snowflake, the fixed sentinel
// "everyone" (not a role ID — @everyone/@here need their own mention syntax
// and allowedMentions.parse, not allowedMentions.roles), or falsy for no ping.
function buildPing(entry) {
  if (!entry.pingRoleId) return { content: undefined, allowedMentions: undefined };
  if (entry.pingRoleId === 'everyone') return { content: '@everyone', allowedMentions: { parse: ['everyone'] } };
  return { content: `<@&${entry.pingRoleId}>`, allowedMentions: { roles: [entry.pingRoleId] } };
}

async function sendNotification(entry, embed) {
  try {
    const channel = await clientRef.channels.fetch(entry.notifyChannelId);
    if (!channel || !channel.isTextBased()) return null;
    const { content, allowedMentions } = buildPing(entry);
    return await channel.send({ content, embeds: [embed], allowedMentions });
  } catch (err) {
    console.error(`Stream alert notify failed for ${entry.platform}/${entry.identifier}:`, err.message);
    return null;
  }
}

// Edits the entry's previously-sent notification in place. Returns false
// (never throws) when there's nothing to edit or the message/channel is
// gone, so callers can fall back to posting a fresh one instead.
async function editNotification(entry, embed) {
  const { messageId, channelId } = entry.state;
  if (!messageId || !channelId) return false;
  try {
    const channel = await clientRef.channels.fetch(channelId);
    if (!channel?.isTextBased()) return false;
    const message = await channel.messages.fetch(messageId).catch(() => null);
    if (!message) return false;
    await message.edit({ embeds: [embed] });
    return true;
  } catch (err) {
    console.error(`Stream alert edit failed for ${entry.platform}/${entry.identifier}:`, err.message);
    return false;
  }
}

// ---------- Poll loop ----------

async function pollTwitch(entriesByGuild) {
  const twitchEntries = entriesByGuild.filter((e) => e.entry.platform === 'twitch');
  if (twitchEntries.length === 0) return;
  const logins = [...new Set(twitchEntries.map((e) => e.entry.identifier.toLowerCase()))];

  let liveMap;
  try {
    liveMap = await fetchLiveTwitchStreams(logins);
  } catch (err) {
    console.error('Twitch stream check failed:', err.message);
    return;
  }

  for (const { guildId, entry } of twitchEntries) {
    const stream = liveMap.get(entry.identifier.toLowerCase());
    entry.state = entry.state || {};

    if (stream) {
      const thumb = (stream.thumbnail_url || '').replace('{width}', '640').replace('{height}', '360');
      const info = {
        userName: stream.user_name,
        title: stream.title,
        game: stream.game_name || null,
        viewers: stream.viewer_count,
        startedAt: stream.started_at,
        thumbnail: thumb || null,
      };
      // Twitch stops returning any info at all the instant a stream goes
      // offline, so the peak viewer count and last-known details are cached
      // here — it's the only way the "stream ended" edit below can still
      // show something meaningful instead of just "it's over now".
      entry.state.lastInfo = { ...info, peakViewers: Math.max(info.viewers || 0, entry.state.lastInfo?.peakViewers || 0) };

      const embed = buildTwitchEmbed(guildId, entry, info, false);
      if (!entry.state.live) {
        // Notifies immediately if the channel is already live the moment
        // it's added — matches how most stream-alert bots behave.
        entry.state.live = true;
        entry.state.lastStreamId = stream.id;
        const message = await sendNotification(entry, embed);
        if (message) {
          entry.state.messageId = message.id;
          entry.state.channelId = message.channelId;
        }
      } else {
        // Still live — refresh the existing message with the current viewer
        // count/duration instead of leaving it stuck at "just went live".
        const edited = await editNotification(entry, embed);
        if (!edited) {
          const message = await sendNotification(entry, embed);
          if (message) {
            entry.state.messageId = message.id;
            entry.state.channelId = message.channelId;
          }
        }
      }
    } else if (entry.state.live) {
      entry.state.live = false;
      const embed = buildTwitchEmbed(guildId, entry, entry.state.lastInfo || {}, true);
      const edited = await editNotification(entry, embed);
      if (!edited) await sendNotification(entry, embed);
    }
  }
}

async function pollYoutube(entriesByGuild) {
  const youtubeEntries = entriesByGuild.filter((e) => e.entry.platform === 'youtube');
  if (youtubeEntries.length === 0) return;

  const videoByChannel = new Map(); // channelId -> video|null, fetched once per unique channel per cycle
  for (const { entry } of youtubeEntries) {
    if (videoByChannel.has(entry.identifier)) continue;
    try {
      videoByChannel.set(entry.identifier, await fetchLatestYoutubeVideo(entry.identifier));
    } catch (err) {
      console.error(`YouTube feed check failed for ${entry.identifier}:`, err.message);
      videoByChannel.set(entry.identifier, null);
    }
  }

  for (const { guildId, entry } of youtubeEntries) {
    const video = videoByChannel.get(entry.identifier);
    if (!video) continue;
    entry.state = entry.state || {};

    const isFirstCheck = !entry.state.lastVideoId;
    const isSameVideo = entry.state.lastVideoId === video.videoId;

    // The very first check just records the channel's current latest video
    // without notifying — otherwise adding a channel would immediately
    // re-announce whatever it already posted before you tracked it.
    if (isFirstCheck) {
      entry.state.lastVideoId = video.videoId;
      entry.state.lastVideoInfo = video;
      continue;
    }

    if (isSameVideo) {
      // Same latest video as last poll — if the feed now shows different
      // info for it (a scheduled premiere's placeholder title/thumbnail
      // turning into the real ones once it airs, a creator editing the
      // title after publishing) keep the notification message in sync
      // instead of leaving it stale.
      const prev = entry.state.lastVideoInfo || {};
      const changed = prev.title !== video.title || prev.thumbnail !== video.thumbnail;
      entry.state.lastVideoInfo = video;
      if (changed && entry.state.messageId) {
        await editNotification(entry, buildYoutubeEmbed(guildId, video));
      }
      continue;
    }

    // A genuinely new video.
    entry.state.lastVideoId = video.videoId;
    entry.state.lastVideoInfo = video;

    // Never announce a video whose own publish timestamp is more than a day
    // old, no matter why it looked "new" to us (a missed poll, a channel
    // re-track, a video that only just went public after being scheduled/
    // premiered weeks ago, etc). The state is still updated above so this
    // video won't be re-evaluated on the next poll either way.
    const MAX_ANNOUNCE_AGE_MS = 24 * 60 * 60 * 1000;
    if (video.publishedAt && Date.now() - video.publishedAt.getTime() > MAX_ANNOUNCE_AGE_MS) {
      console.log(`Skipping stale YouTube alert for ${entry.identifier}: "${video.title}" was published ${video.publishedAt.toISOString()}`);
      continue;
    }

    const message = await sendNotification(entry, buildYoutubeEmbed(guildId, video));
    if (message) {
      entry.state.messageId = message.id;
      entry.state.channelId = message.channelId;
    }
  }
}

async function pollAll() {
  if (!clientRef) return;
  const entriesByGuild = [];
  for (const guildId of store.allGuildIds()) {
    if (!features.isEnabled(guildId, 'streamAlerts')) continue;
    const { tracked } = store.get(guildId);
    for (const entry of tracked) {
      if (!entry.notifyChannelId) continue;
      entriesByGuild.push({ guildId, entry });
    }
  }
  if (entriesByGuild.length === 0) return;

  await pollTwitch(entriesByGuild);
  await pollYoutube(entriesByGuild);
  store.save();
}

function setupStreamAlerts(client) {
  clientRef = client;
  setInterval(() => pollAll().catch((err) => console.error('Stream alert poll failed:', err.message)), POLL_INTERVAL_MS);
  setTimeout(() => pollAll().catch((err) => console.error('Stream alert poll failed:', err.message)), 15_000);
  console.log('Stream alerts active (Twitch live + YouTube new video).');
}

// ---------- CRUD for the dashboard ----------

function listTracked(guildId) {
  return store.get(guildId).tracked;
}

function addTracked(guildId, { platform, identifier, notifyChannelId, pingRoleId }) {
  const config = store.get(guildId);
  const entry = {
    id: crypto.randomUUID(),
    platform,
    identifier: String(identifier).trim(),
    notifyChannelId,
    pingRoleId: pingRoleId || null,
    state: {},
    addedAt: Date.now(),
  };
  config.tracked.push(entry);
  store.save();
  return entry;
}

function removeTracked(guildId, id) {
  const config = store.get(guildId);
  config.tracked = config.tracked.filter((e) => e.id !== id);
  store.save();
}

module.exports = { setupStreamAlerts, listTracked, addTracked, removeTracked, MAX_TRACKED_PER_GUILD };
