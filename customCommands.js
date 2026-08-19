// Per-server custom text commands: an admin (or the AI agent) defines a command
// name and a response, and it becomes usable as `!name` immediately — no code
// changes, no restart. Distinct from auto-responses (which match a trigger word
// anywhere in a message): a custom command is an exact command invocation, same
// as any built-in command, and can optionally be posted as an embed.
const { makeGuildStore } = require('./guildStore');

const store = makeGuildStore('custom-commands.json', () => []);

function sanitizeName(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32);
}

function list(guildId) {
  return store.get(guildId);
}

function find(guildId, name) {
  return store.get(guildId).find((c) => c.name === sanitizeName(name));
}

function add(guildId, { name, response, embedTitle, color, imageUrl }) {
  const commands = store.get(guildId);
  const cleanName = sanitizeName(name);
  if (!cleanName) throw new Error('Give the command a name using letters, numbers, - or _.');
  if (!response || !response.trim()) throw new Error('The command needs a response.');
  if (commands.some((c) => c.name === cleanName)) throw new Error(`A custom command named "${cleanName}" already exists.`);
  commands.push({
    name: cleanName,
    response: response.trim(),
    embedTitle: embedTitle || null,
    color: color || null,
    imageUrl: imageUrl || null,
  });
  store.save();
  return commands;
}

function remove(guildId, name) {
  const cleanName = sanitizeName(name);
  const commands = store.get(guildId).filter((c) => c.name !== cleanName);
  store.set(guildId, commands);
  return commands;
}

module.exports = { list, find, add, remove, sanitizeName };
