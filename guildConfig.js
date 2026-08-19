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
  language: 'en', // 'en' | 'de' | 'fr' — see i18n.js for what this actually translates
  disabledFeatures: [], // feature keys turned off for this server — see features.js
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
  store.save();
  return getConfig(guildId);
}

module.exports = { setHomeDefaults, getConfig, updateConfig };
