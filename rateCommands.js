// Per-server "rate" commands: silly fun commands like !rateaura @user that pick a
// random 1-100 and reply with it. Fully configurable from the dashboard — add or
// remove as many as you want (rateaura, raterizz, whatever), each with its own label
// and emoji. Comes pre-seeded with a handful of common ones.
const { makeGuildStore } = require('./guildStore');

const store = makeGuildStore('rate-commands.json', () => [
  { key: 'aura', label: 'Aura', emoji: '✨' },
  { key: 'rizz', label: 'Rizz', emoji: '😏' },
  { key: 'sigma', label: 'Sigma', emoji: '🗿' },
  { key: 'iq', label: 'IQ', emoji: '🧠' },
  { key: 'drip', label: 'Drip', emoji: '🕶️' },
]);

function sanitizeKey(key) {
  return (key || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
}

function getTypes(guildId) {
  return store.get(guildId);
}

function findType(guildId, key) {
  return store.get(guildId).find((t) => t.key === key);
}

// Matches a full command name like "rateaura" against this guild's configured types,
// returning the matching type (or null). Used by commandHandler.js for commands that
// aren't in the static registry.
function matchCommandName(guildId, commandName) {
  if (!commandName.startsWith('rate')) return null;
  const key = commandName.slice(4);
  return findType(guildId, key) || null;
}

function addType(guildId, label, emoji) {
  const types = store.get(guildId);
  const key = sanitizeKey(label);
  if (!key) throw new Error('Give it a name to build the command from, e.g. "Aura" -> !rateaura.');
  if (types.some((t) => t.key === key)) throw new Error(`A rate command for "${key}" already exists.`);
  types.push({ key, label, emoji: emoji || '🎲' });
  store.save();
  return types;
}

function removeType(guildId, key) {
  const types = store.get(guildId).filter((t) => t.key !== key);
  store.set(guildId, types);
  return types;
}

async function runRate(message, args, type) {
  const target = args[0] ? await resolveMemberLazy(message, args[0]) : message.member;
  if (!target) throw new Error('Could not find that member.');
  const value = Math.floor(Math.random() * 100) + 1;
  await message.reply(`${target} has **${value}%** ${type.label}! ${type.emoji}`);
}

// Lazily requires commandRegistry's resolveMember to avoid a require cycle
// (commandRegistry requires this module too, for the dashboard/help listing).
async function resolveMemberLazy(message, token) {
  const { resolveMember } = require('./commandRegistry');
  return resolveMember(message, token);
}

module.exports = { getTypes, findType, matchCommandName, addType, removeType, runRate };
