// Per-server custom text commands: an admin (or the AI agent) defines a command
// name and a response, and it becomes usable as `!name` immediately — no code
// changes, no restart. Distinct from auto-responses (which match a trigger word
// anywhere in a message): a custom command is an exact command invocation, same
// as any built-in command.
//
// Optional extras per command: post as an embed (with its own title/color/
// image) instead of plain text, restrict it to specific roles, make it
// "private" (reply DMed to whoever ran it, and their trigger message deleted,
// so nobody else sees it was used — Discord's real ephemeral replies only
// exist for slash-command interactions, not prefix text commands, so a DM +
// delete is the closest equivalent here), a per-user cooldown, and a few
// placeholder variables ({user}, {username}, {server}, {membercount}).
const { makeGuildStore } = require('./guildStore');

const store = makeGuildStore('custom-commands.json', () => []);

// In-memory only — a restart clearing everyone's cooldown is a fine trade-off
// for a lightweight anti-spam feature, not something that needs to survive
// restarts like the command definitions themselves do.
const lastUsed = new Map(); // `${guildId}:${userId}:${name}` -> timestamp

function sanitizeName(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32);
}

// Backfills any field added after a command was originally created — same
// pattern (and same reason) as automod.js's getConfig(): an existing saved
// command from before this feature predates these keys entirely, not just
// defaults to a falsy value, so reading them directly would be undefined.
function normalize(cmd) {
  let changed = false;
  if (cmd.useEmbed === undefined) {
    cmd.useEmbed = !!(cmd.embedTitle || cmd.imageUrl); // legacy commands that already had these get carried forward as embeds
    changed = true;
  }
  if (!cmd.allowedRoleIds) { cmd.allowedRoleIds = []; changed = true; }
  if (!cmd.visibility) { cmd.visibility = 'public'; changed = true; }
  if (cmd.cooldownSeconds === undefined) { cmd.cooldownSeconds = 0; changed = true; }
  if (cmd.useCount === undefined) { cmd.useCount = 0; changed = true; }
  return changed;
}

function list(guildId) {
  const commands = store.get(guildId);
  let changed = false;
  for (const cmd of commands) {
    if (normalize(cmd)) changed = true;
  }
  if (changed) store.save();
  return commands;
}

function find(guildId, name) {
  return list(guildId).find((c) => c.name === sanitizeName(name));
}

function add(guildId, { name, response, useEmbed, embedTitle, color, imageUrl, allowedRoleIds, visibility, cooldownSeconds }) {
  const commands = store.get(guildId);
  const cleanName = sanitizeName(name);
  if (!cleanName) throw new Error('Give the command a name using letters, numbers, - or _.');
  if (!response || !response.trim()) throw new Error('The command needs a response.');
  if (commands.some((c) => c.name === cleanName)) throw new Error(`A custom command named "${cleanName}" already exists.`);
  commands.push({
    name: cleanName,
    response: response.trim(),
    useEmbed: !!useEmbed,
    embedTitle: embedTitle || null,
    color: color || null,
    imageUrl: imageUrl || null,
    allowedRoleIds: Array.isArray(allowedRoleIds) ? allowedRoleIds : [],
    visibility: visibility === 'private' ? 'private' : 'public',
    cooldownSeconds: Math.max(0, Math.min(3600, parseInt(cooldownSeconds, 10) || 0)),
    useCount: 0,
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

// Empty allow-list = everyone can use it (the historical default — adding
// this never silently locks existing commands to nobody). Administrators
// always pass, same exemption used everywhere else in this codebase.
function canUse(command, member) {
  if (!command.allowedRoleIds || command.allowedRoleIds.length === 0) return true;
  if (member.permissions.has('Administrator')) return true;
  return command.allowedRoleIds.some((id) => member.roles.cache.has(id));
}

// Returns the number of seconds still remaining, or null if it's fine to run.
function checkCooldown(guildId, userId, command) {
  if (!command.cooldownSeconds) return null;
  const key = `${guildId}:${userId}:${command.name}`;
  const last = lastUsed.get(key);
  if (!last) return null;
  const remaining = command.cooldownSeconds - (Date.now() - last) / 1000;
  return remaining > 0 ? Math.ceil(remaining) : null;
}

function recordUse(guildId, userId, command) {
  lastUsed.set(`${guildId}:${userId}:${command.name}`, Date.now());
  command.useCount = (command.useCount || 0) + 1;
  store.save();
}

function fillPlaceholders(text, member) {
  return (text || '')
    .replaceAll('{user}', `${member}`)
    .replaceAll('{username}', member.user?.tag || member.user?.username || 'Unknown')
    .replaceAll('{server}', member.guild.name)
    .replaceAll('{membercount}', String(member.guild.memberCount));
}

module.exports = { list, find, add, remove, sanitizeName, canUse, checkCooldown, recordUse, fillPlaceholders };
