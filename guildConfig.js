// Per-server settings: which channel runs the counting game, which role new members
// get, which channel mod-logs/auto-mod alerts go to, and which channel announcements
// post to. The original server (from .env) keeps working exactly as before via
// setHomeDefaults — any other server the bot joins starts with these unset, and the
// owner configures them per-server from the dashboard's Server tab.
const { makeGuildStore, safeAssign } = require('./guildStore');

const store = makeGuildStore('guild-config.json', () => ({
  countingChannelId: null,
  memberRoleId: null,
  modLogsChannelId: null,
  announcementsChannelId: null,
  giveawayPingRoleId: null,
  announcementPingRoleId: null,
  levelUpChannelId: null, // if unset, level-up messages post in whichever channel triggered them
  levelRolesEnabled: false, // opt-in: auto-create & assign tier roles (Level 1-4, 5-24, ...) as members level up
  levelRoleTiers: null, // null = use levelRoles.js's DEFAULT_TIERS; otherwise an array of {minLevel, maxLevel, name} set from the dashboard
  levelRoleMap: {}, // tier name -> role ID, filled in once the tier roles are auto-created
  doubleXpVoiceChannelId: null, // optional: being in this one voice channel doubles voice XP gains
  xpRoleMultipliers: [], // up to 10 {roleId, multiplier} — highest applicable multiplier wins if a member has more than one
  watermarkDisabled: false, // per-server opt-out of the "Emerald" footer, set from the admin panel. Official announcements/broadcasts are never affected — they use their own fixed "verified official" footer specifically to prove they came from the real bot.
  language: 'en', // 'en' | 'de' | 'fr' — see i18n.js for what this actually translates
  disabledFeatures: [], // feature keys turned off for this server — see features.js
  emojiStyle: 'standard', // 'standard' | 'custom' — see emoji.js. Custom uses this bot's own uploaded application emojis where available, falling back to the standard Unicode one for anything not (yet) uploaded.
}));

let homeGuildId = null;
let homeDefaults = {};

function setHomeDefaults(guildId, defaults) {
  homeGuildId = guildId;
  homeDefaults = defaults;
}

function stripEmpty(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== null && v !== undefined && v !== ''));
}

// Dashboard-saved values always win; on the original home server, anything not yet
// explicitly set falls back to the .env value so nothing breaks on first run.
function getConfig(guildId) {
  const state = store.get(guildId);
  if (String(guildId) === String(homeGuildId)) {
    return { ...homeDefaults, ...stripEmpty(state) };
  }
  return state;
}

function updateConfig(guildId, patch) {
  const state = store.get(guildId);
  safeAssign(state, patch);
  if (patch && patch.emojiStyle !== undefined && patch.emojiStyle !== 'custom') {
    state.emojiStyle = 'standard'; // anything other than the one real alternative just means "standard"
  }
  store.save();
  return getConfig(guildId);
}

module.exports = { setHomeDefaults, getConfig, updateConfig };
