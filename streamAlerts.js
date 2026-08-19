// Stream alerts: each server can track any number of Twitch channels (go-live)
// and YouTube channels (new video), each pointing at its own notification
// channel and optional ping role. A background poller checks every tracked
// entry, across every server, on a fixed interval — Discord renders an
// embed's setColor() as a colored stripe down the left side of the message
// automatically, so that's literally the "side stripe" this produces, no
// extra rendering work needed.
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

const POLL_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes — light on both APIs, fast enough to feel live
const TWITCH_COLOR = 0x9146ff;
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

// ---------- Notification sending ----------

// entry.pingRoleId is either a real role snowflake, the fixed sentinel
// "everyone" (not a role ID — @everyone/@here need their own mention syntax
// and allowedMentions.parse, not allowedMentions.roles), or falsy for no ping.
function buildPing(entry) {
  if (!entry.pingRoleId) return { content: undefined, allowedMentions: undefined };
  if (entry.pingRoleId === 'everyone') return { content: '@everyone', allowedMentions: { parse: ['everyone'] } };
  return { content: `<@&${entry.pingRoleId}>`, allowedMentions: { roles: [entry.pingRoleId] } };
}

async function notify(entry, embed) {
  try {
    const channel = await clientRef.channels.fetch(entry.notifyChannelId);
    if (!channel || !channel.isTextBased()) return;
    const { content, allowedMentions } = buildPing(entry);
    await channel.send({ content, embeds: [embed], allowedMentions });
  } catch (err) {
    console.error(`Stream alert notify failed for ${entry.platform}/${entry.identifier}:`, err.message);
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

  for (const { entry } of twitchEntries) {
    const stream = liveMap.get(entry.identifier.toLowerCase());
    entry.state = entry.state || {};

    // Notifies immediately if the channel is already live the moment it's
    // added — matches how most stream-alert bots behave. Only fires once
    // per go-live: state.live stays true until the channel goes offline.
    if (stream) {
      if (!entry.state.live) {
        entry.state.live = true;
        entry.state.lastStreamId = stream.id;
        const embed = new EmbedBuilder()
          .setColor(TWITCH_COLOR)
          .setTitle(`🔴 ${stream.user_name} is now live on Twitch!`)
          .setURL(`https://twitch.tv/${entry.identifier}`)
          .setDescription(stream.title + (stream.game_name ? `\n\nPlaying **${stream.game_name}**` : ''))
          .setFooter(brandFooter(clientRef, 'Live on Twitch'))
          .setTimestamp();
        const thumb = (stream.thumbnail_url || '').replace('{width}', '640').replace('{height}', '360');
        if (thumb) embed.setImage(thumb);
        await notify(entry, embed);
      }
    } else {
      entry.state.live = false;
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

  for (const { entry } of youtubeEntries) {
    const video = videoByChannel.get(entry.identifier);
    if (!video) continue;
    entry.state = entry.state || {};
    if (entry.state.lastVideoId === video.videoId) continue; // already notified about this one

    // The very first check just records the channel's current latest video
    // without notifying — otherwise adding a channel would immediately
    // re-announce whatever it already posted before you tracked it.
    const isFirstCheck = !entry.state.lastVideoId;
    entry.state.lastVideoId = video.videoId;
    if (isFirstCheck) continue;

    // Second safety net on top of the first-check skip above: never announce
    // a video whose own publish timestamp is more than a day old, no matter
    // why it looked "new" to us (a missed poll, a channel re-track, a video
    // that only just went public after being scheduled/premiered weeks ago,
    // etc). The state is still updated above so this video won't be re-
    // evaluated on the next poll either way.
    const MAX_ANNOUNCE_AGE_MS = 24 * 60 * 60 * 1000;
    if (video.publishedAt && Date.now() - video.publishedAt.getTime() > MAX_ANNOUNCE_AGE_MS) {
      console.log(`Skipping stale YouTube alert for ${entry.identifier}: "${video.title}" was published ${video.publishedAt.toISOString()}`);
      continue;
    }

    const embed = new EmbedBuilder()
      .setColor(YOUTUBE_COLOR)
      .setTitle(`📺 New video from ${video.channelName}`)
      .setURL(video.url)
      .setDescription(video.title)
      .setFooter(brandFooter(clientRef, 'New on YouTube'))
      .setTimestamp();
    if (video.thumbnail) embed.setImage(video.thumbnail);
    await notify(entry, embed);
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
