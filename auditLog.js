// Tracks every mutating action taken from the dashboard, for accountability — kept
// per-server (unlike the single-tenant original) so one server's admins never see
// another server's audit trail.
const { makeGuildStore } = require('./guildStore');

const MAX_ENTRIES = 200;
const store = makeGuildStore('audit-log.json', () => []);

function record(guildId, action, detail) {
  const entries = store.get(guildId);
  entries.unshift({ time: new Date().toISOString(), action, detail });
  if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;
  store.save();
}

function getEntries(guildId) {
  return store.get(guildId);
}

module.exports = { record, getEntries };
