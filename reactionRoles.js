// Self-assign roles: react to a configured message with a configured emoji to get
// (or remove) a role.
const fs = require('fs');
const path = require('path');
const features = require('./features');

const STATE_FILE = path.join(__dirname, 'reactionroles-state.json');

// [{ messageId, channelId, emoji, roleId }]
let mappings = [];
let clientRef = null;

function load() {
  try {
    mappings = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    mappings = [];
  }
}

function save() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(mappings, null, 2));
}

function normalizeEmoji(reactionEmoji) {
  return reactionEmoji.id || reactionEmoji.name;
}

function setupReactionRoles(client) {
  clientRef = client;
  load();

  client.on('messageReactionAdd', async (reaction, user) => {
    if (user.bot) return;
    if (reaction.partial) await reaction.fetch().catch(() => {});

    const match = mappings.find(
      (m) => m.messageId === reaction.message.id && m.emoji === normalizeEmoji(reaction.emoji)
    );
    if (!match) return;

    try {
      const guild = reaction.message.guild;
      if (guild && !features.isEnabled(guild.id, 'reactionRoles')) return;
      const member = await guild.members.fetch(user.id);
      await member.roles.add(match.roleId);
    } catch (err) {
      console.error('Reaction role add failed:', err.message);
    }
  });

  client.on('messageReactionRemove', async (reaction, user) => {
    if (user.bot) return;
    if (reaction.partial) await reaction.fetch().catch(() => {});

    const match = mappings.find(
      (m) => m.messageId === reaction.message.id && m.emoji === normalizeEmoji(reaction.emoji)
    );
    if (!match) return;

    try {
      const guild = reaction.message.guild;
      if (guild && !features.isEnabled(guild.id, 'reactionRoles')) return;
      const member = await guild.members.fetch(user.id);
      await member.roles.remove(match.roleId);
    } catch (err) {
      console.error('Reaction role remove failed:', err.message);
    }
  });

  console.log(`Reaction roles active (${mappings.length} configured).`);
}

async function createReactionRole(channelId, text, emoji, roleId) {
  const channel = await clientRef.channels.fetch(channelId);
  const message = await channel.send({ content: text });
  await message.react(emoji);

  mappings.push({ messageId: message.id, channelId, emoji, roleId });
  save();
  return message.id;
}

function listReactionRoles() {
  return mappings;
}

function removeReactionRole(messageId) {
  mappings = mappings.filter((m) => m.messageId !== messageId);
  save();
}

module.exports = { setupReactionRoles, createReactionRole, listReactionRoles, removeReactionRole };
