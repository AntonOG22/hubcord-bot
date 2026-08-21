// Twitch chat <-> Discord chat bridge — Discord side. Setup lives entirely
// in this dashboard: an admin picks a Twitch channel (must already have
// Emerald connected there — checked by reading the Twitch bot's own
// `twitch_channels` table directly, since both bots share one Supabase
// project) and that instantly turns on the twitch->discord direction. The
// reverse direction (Discord messages showing up in someone's Twitch chat)
// needs the broadcaster's own sign-off, so this side only ever *requests*
// it — approval happens entirely on the Twitch bot's own dashboard, proven
// by that person's own Twitch login, never something this bot can grant
// on someone else's behalf.
//
// Every cross-bot action goes through the Twitch bot's HTTP API instead of
// writing `chat_bridges` directly from here — one process owns the actual
// business rules (idempotent linking, token minting, permission checks),
// this side just calls it, authenticated with BRIDGE_SECRET (a value only
// the two bots' own backends hold, never sent to a browser).
const { supabase } = require('./guildStore');

function twitchBotUrl(path) {
  const base = process.env.TWITCH_BOT_URL;
  if (!base) throw new Error('TWITCH_BOT_URL is not configured.');
  return `${base}${path}`;
}

async function callTwitchBot(path, body) {
  const secret = process.env.BRIDGE_SECRET;
  if (!secret) throw new Error('BRIDGE_SECRET is not configured.');
  const res = await fetch(twitchBotUrl(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Twitch bot returned ${res.status}`);
  return data;
}

// Reads the Twitch bot's own channel table directly — read-only, no
// business logic lives here, just "is Emerald actually connected to this
// Twitch login". Case-insensitive since Twitch logins are effectively
// case-insensitive to humans typing them into a form.
async function findTwitchChannel(login) {
  if (!supabase) throw new Error('Supabase is not configured.');
  const { data, error } = await supabase.from('twitch_channels').select('id, data').filter('data->>login', 'ilike', login);
  if (error) throw new Error(error.message);
  const row = (data || []).find((r) => r.data?.connected);
  if (!row) return null;
  return { broadcasterId: row.id, login: row.data.login, displayName: row.data.displayName };
}

async function listBridgesForGuild(guildId) {
  if (!supabase) throw new Error('Supabase is not configured.');
  const { data, error } = await supabase.from('chat_bridges').select('*').eq('discord_guild_id', guildId);
  if (error) throw new Error(error.message);
  return data;
}

async function linkBridge({ guildId, guildName, channelId, twitchBroadcasterId, twitchLogin, createdByUserId }) {
  return callTwitchBot('/api/bridge/link', {
    discordGuildId: guildId,
    discordGuildName: guildName,
    discordChannelId: channelId,
    twitchBroadcasterId,
    twitchLogin,
    createdByDiscordUserId: createdByUserId,
  });
}

async function requestApproval(guildId, twitchBroadcasterId) {
  const { url } = await callTwitchBot('/api/bridge/request-approval', { discordGuildId: guildId, twitchBroadcasterId });
  return url;
}

async function unlinkBridge(guildId, twitchBroadcasterId) {
  return callTwitchBot('/api/bridge/unlink', { discordGuildId: guildId, twitchBroadcasterId });
}

// Same read-through-cache idea as the Twitch side — messageCreate fires for
// every single message in every channel the bot can see, so this can't be
// a Supabase round-trip per message. Keyed by Discord channel id, since
// that's what a message handler actually has on hand.
const CACHE_TTL_MS = 30_000;
const cacheByChannel = new Map(); // channelId -> { bridge, at }

async function getCachedBridgeForChannel(channelId) {
  const hit = cacheByChannel.get(channelId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.bridge;
  if (!supabase) return null;
  const { data } = await supabase.from('chat_bridges').select('*').eq('discord_channel_id', channelId).maybeSingle().catch(() => ({ data: null }));
  cacheByChannel.set(channelId, { bridge: data, at: Date.now() });
  return data;
}

async function relayToTwitch(bridge, author, text) {
  try {
    await callTwitchBot('/api/bridge/relay', { twitchBroadcasterId: bridge.twitch_broadcaster_id, author, text: text.slice(0, 480) });
  } catch (err) {
    console.error('[bridge] relay to Twitch failed:', err.message);
  }
}

// Hooked into messageCreate for every guild message — mirrors it out to
// Twitch if this channel has an approved discord->twitch bridge. Ignores
// bots (including this bot's own relayed-from-Twitch messages, which
// would otherwise create a relay loop) and anything without real text
// (embeds-only posts, etc).
function setupBridgeListener(client) {
  client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild || !message.content.trim()) return;
    try {
      const bridge = await getCachedBridgeForChannel(message.channel.id);
      if (bridge?.discord_to_twitch) await relayToTwitch(bridge, message.author.username, message.content);
    } catch (err) {
      console.error('[bridge] listener error:', err.message);
    }
  });
}

module.exports = { findTwitchChannel, listBridgesForGuild, linkBridge, requestApproval, unlinkBridge, relayToTwitch, setupBridgeListener };
