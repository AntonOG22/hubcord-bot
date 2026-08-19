// Bot-wide (not per-server) settings, controlled only from the owner-only
// admin panel. Reuses the same guildStore persistence machinery (Supabase-
// backed, survives restarts) by always keying off one fixed sentinel ID
// instead of a real guild ID — there's nothing per-server about this file.
const { makeGuildStore } = require('./guildStore');

const GLOBAL_KEY = '_global';
const store = makeGuildStore('bot-settings.json', () => ({
  watermarkDisabled: false,
  disabledFeatures: [], // bot-wide feature kill-switch, on top of each server's own toggle
  blockedUserIds: [], // Discord user IDs denied at the OAuth callback, before a session is ever created
}));

function isWatermarkDisabled() {
  return !!store.get(GLOBAL_KEY).watermarkDisabled;
}

function setWatermarkDisabled(value) {
  const settings = store.get(GLOBAL_KEY);
  settings.watermarkDisabled = !!value;
  store.save();
  return settings;
}

// ---------- Bot-wide feature kill-switch ----------
// Distinct from features.js's per-server toggle: this is a second, global
// gate a feature must also pass. Meant for "shut this off everywhere right
// now" (cost or abuse control) without having to touch every server.

function getGlobalDisabledFeatures() {
  return store.get(GLOBAL_KEY).disabledFeatures || [];
}

function setGlobalFeatureEnabled(key, enabled) {
  const settings = store.get(GLOBAL_KEY);
  const disabled = new Set(settings.disabledFeatures || []);
  if (enabled) disabled.delete(key);
  else disabled.add(key);
  settings.disabledFeatures = [...disabled];
  store.save();
  return settings;
}

// ---------- Login blocklist ----------
// Checked in the OAuth callback, before req.session.userId is ever set —
// a blocked user never gets a session at all, not even a read-only one.

function listBlockedUsers() {
  return store.get(GLOBAL_KEY).blockedUserIds || [];
}

function isUserBlocked(userId) {
  return listBlockedUsers().includes(String(userId));
}

function blockUser(userId) {
  const settings = store.get(GLOBAL_KEY);
  const ids = new Set(settings.blockedUserIds || []);
  ids.add(String(userId));
  settings.blockedUserIds = [...ids];
  store.save();
  return settings;
}

function unblockUser(userId) {
  const settings = store.get(GLOBAL_KEY);
  settings.blockedUserIds = (settings.blockedUserIds || []).filter((id) => id !== String(userId));
  store.save();
  return settings;
}

module.exports = {
  isWatermarkDisabled,
  setWatermarkDisabled,
  getGlobalDisabledFeatures,
  setGlobalFeatureEnabled,
  listBlockedUsers,
  isUserBlocked,
  blockUser,
  unblockUser,
};
