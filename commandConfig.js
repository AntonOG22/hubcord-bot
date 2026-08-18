// Per-server chat-command prefix (e.g. "!" or "?") and disabled-command set,
// configurable from the dashboard. Each server the bot manages gets its own prefix and
// its own set of disabled commands.
const { makeGuildStore } = require('./guildStore');

const store = makeGuildStore('command-config.json', () => ({ prefix: '!', disabled: [] }));

function getPrefix(guildId) {
  return store.get(guildId).prefix;
}

function setPrefix(guildId, prefix) {
  store.get(guildId).prefix = prefix;
  store.save();
}

function isDisabled(guildId, name) {
  return store.get(guildId).disabled.includes(name);
}

function setDisabled(guildId, name, disabled) {
  const state = store.get(guildId);
  state.disabled = state.disabled.filter((n) => n !== name);
  if (disabled) state.disabled.push(name);
  store.save();
}

function getState(guildId) {
  return store.get(guildId);
}

module.exports = { getPrefix, setPrefix, isDisabled, setDisabled, getState };
