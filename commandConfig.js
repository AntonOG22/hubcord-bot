// Per-server chat-command prefix (e.g. "!" or "?") and disabled-command set,
// configurable from the dashboard. Each server the bot manages gets its own prefix and
// its own set of disabled commands. An optional second prefix can be active at the same
// time as the primary one (e.g. both "!" and "?" trigger commands) — most servers only
// ever set the primary, so `secondaryPrefix` defaults to null (off) rather than forcing
// everyone into a two-prefix setup.
const { makeGuildStore } = require('./guildStore');

const store = makeGuildStore('command-config.json', () => ({ prefix: '!', secondaryPrefix: null, disabled: [] }));

function getPrefix(guildId) {
  return store.get(guildId).prefix;
}

function setPrefix(guildId, prefix) {
  store.get(guildId).prefix = prefix;
  store.save();
}

function getSecondaryPrefix(guildId) {
  return store.get(guildId).secondaryPrefix || null;
}

function setSecondaryPrefix(guildId, prefix) {
  store.get(guildId).secondaryPrefix = prefix || null;
  store.save();
}

// Every prefix currently active for a server, longest first — matching
// longest-first matters when one prefix is a prefix of the other (e.g. "!"
// and "!!"), so the longer one gets first shot at matching instead of the
// shorter one always winning and leaving a stray "!" in the parsed args.
function getPrefixes(guildId) {
  const state = store.get(guildId);
  const list = state.secondaryPrefix ? [state.prefix, state.secondaryPrefix] : [state.prefix];
  return list.sort((a, b) => b.length - a.length);
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

module.exports = { getPrefix, setPrefix, getSecondaryPrefix, setSecondaryPrefix, getPrefixes, isDisabled, setDisabled, getState };
