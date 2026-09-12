// Central emoji resolver: every place in the bot that wants a "themed"
// emoji (as opposed to an ad-hoc one-off) goes through here instead of
// hardcoding a Unicode character. Two styles, chosen per-server from the
// dashboard's Server tab:
//   - 'standard' (default): the plain Unicode emoji, works everywhere,
//     no setup needed.
//   - 'custom' (experimental): this bot's own uploaded application
//     emojis (Developer Portal > Emojis, or the upload script) — a
//     distinct branded icon set usable in any server the bot is in.
//     Looked up live by name from the bot's own emoji cache, so nothing
//     here needs to know real Discord snowflake IDs; whatever hasn't
//     actually been uploaded yet just quietly falls back to the standard
//     emoji for that one entry instead of breaking.
const guildConfig = require('./guildConfig');

// key -> { std: <Unicode emoji>, name: <application emoji name, see emojis/*.png> }
const EMOJI_MAP = {
  status_success: { std: '✅', name: 'status_success' },
  status_error: { std: '❌', name: 'status_error' },
  status_warning: { std: '⚠️', name: 'status_warning' },
  status_info: { std: 'ℹ️', name: 'status_info' },
  status_locked: { std: '🔒', name: 'status_locked' },
  status_cooldown: { std: '⏳', name: 'status_cooldown' },
  status_search: { std: '🔍', name: 'status_search' },

  music_play: { std: '▶️', name: 'music_play' },
  music_pause: { std: '⏸️', name: 'music_pause' },
  music_skip: { std: '⏭️', name: 'music_skip' },
  music_stop: { std: '⏹️', name: 'music_stop' },
  music_loop: { std: '🔁', name: 'music_loop' },
  music_shuffle: { std: '🔀', name: 'music_shuffle' },
  music_vote: { std: '🗳️', name: 'music_vote' },
  music_volume: { std: '🔊', name: 'music_volume' },
  music_mic: { std: '🎤', name: 'music_mic' },
  music_note: { std: '🎵', name: 'music_note' },
  music_queue: { std: '📜', name: 'music_queue' },
  music_crown: { std: '👑', name: 'music_crown' },

  mod_kick: { std: '👢', name: 'mod_kick' },
  mod_ban: { std: '🔨', name: 'mod_ban' },
  mod_mute: { std: '🔇', name: 'mod_mute' },
  mod_purge: { std: '🧹', name: 'mod_purge' },
  mod_shield: { std: '🛡️', name: 'mod_shield' },
  mod_log: { std: '📋', name: 'mod_log' },

  ticket_open: { std: '🎫', name: 'ticket_open' },
  ticket_claim: { std: '✋', name: 'ticket_claim' },
  ticket_add: { std: '➕', name: 'ticket_add' },
  ticket_remove: { std: '➖', name: 'ticket_remove' },

  giveaway: { std: '🎉', name: 'giveaway' },
  winner: { std: '🏆', name: 'winner' },
  poll_up: { std: '👍', name: 'poll_up' },
  poll_down: { std: '👎', name: 'poll_down' },

  twitch_live: { std: '🔴', name: 'twitch_live' },
  youtube: { std: '📺', name: 'youtube' },

  verify: { std: '🛂', name: 'verify' },
  raid_alert: { std: '🚨', name: 'raid_alert' },

  ai_bot: { std: '🤖', name: 'ai_bot' },
  auto_response: { std: '💬', name: 'auto_response' },

  count_broken: { std: '💥', name: 'count_broken' },

  reminder: { std: '⏰', name: 'reminder' },
  announcement: { std: '📢', name: 'announcement' },
};

// Returns the emoji for `key` as a ready-to-send string — either a plain
// Unicode character, or `<:name:id>` for a live custom application emoji.
// `client` is optional; without one (or with 'standard' selected, or the
// custom emoji not actually uploaded yet) this always returns the
// Unicode fallback, so callers never need their own null-check.
function getEmoji(guildId, key, client) {
  const entry = EMOJI_MAP[key];
  if (!entry) return '';
  const style = guildConfig.getConfig(guildId).emojiStyle;
  if (style !== 'custom' || !client?.application?.emojis?.cache) return entry.std;
  const found = client.application.emojis.cache.find((e) => e.name === entry.name);
  return found ? `<:${found.name}:${found.id}>` : entry.std;
}

module.exports = { getEmoji, EMOJI_MAP };
