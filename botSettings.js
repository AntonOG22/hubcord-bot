// Bot-wide (not per-server) settings, controlled only from the owner-only
// admin panel. Reuses the same guildStore persistence machinery (Supabase-
// backed, survives restarts) by always keying off one fixed sentinel ID
// instead of a real guild ID — there's nothing per-server about this file.
const { makeGuildStore } = require('./guildStore');

const GLOBAL_KEY = '_global';
const store = makeGuildStore('bot-settings.json', () => ({ watermarkDisabled: false }));

function isWatermarkDisabled() {
  return !!store.get(GLOBAL_KEY).watermarkDisabled;
}

function setWatermarkDisabled(value) {
  const settings = store.get(GLOBAL_KEY);
  settings.watermarkDisabled = !!value;
  store.save();
  return settings;
}

module.exports = { isWatermarkDisabled, setWatermarkDisabled };
