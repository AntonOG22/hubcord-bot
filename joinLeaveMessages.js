// Per-server join/leave announcement messages. Each one is independently
// enabled/disabled, posts to its own channel, and can optionally carry an
// image (a fixed URL/upload — not a per-user generated card). The member's
// own avatar (the small thumbnail, top-right of the embed) has its own
// separate on/off switch. Supports a few placeholders so the same message
// adapts to whoever triggered it.
const { EmbedBuilder } = require('discord.js');
const { makeGuildStore, safeAssign } = require('./guildStore');
const { brandFooter } = require('./brand');

const DEFAULT_MESSAGE = () => ({
  enabled: false,
  channelId: null,
  title: '',
  description: '',
  imageUrl: '',
  avatarEnabled: true, // the joining/leaving member's own avatar thumbnail — separate from the custom image above
  color: '#3ecf8e',
});

const store = makeGuildStore('join-leave-config.json', () => ({
  join: { ...DEFAULT_MESSAGE(), description: 'Welcome {user} to **{server}**! We now have {membercount} members.' },
  leave: { ...DEFAULT_MESSAGE(), color: '#f0655f', description: '{username} has left **{server}**. We now have {membercount} members.' },
}));

// Backfills any field added after a server's config was first saved — same
// pattern as automod.js/customCommands.js: an existing record predates the
// field entirely (missing, not just falsy), so reading it directly would be
// undefined and silently change behavior (here: the avatar would stop
// showing, since `undefined` is falsy) rather than defaulting sensibly.
function normalize(message) {
  let changed = false;
  if (message.avatarEnabled === undefined) {
    message.avatarEnabled = true;
    changed = true;
  }
  return changed;
}

function getConfig(guildId) {
  const config = store.get(guildId);
  const changed = normalize(config.join) | normalize(config.leave);
  if (changed) store.save();
  return config;
}

function fillPlaceholders(text, member) {
  return (text || '')
    .replaceAll('{user}', `${member}`)
    .replaceAll('{username}', member.user?.tag || member.user?.username || 'Unknown')
    .replaceAll('{server}', member.guild.name)
    .replaceAll('{membercount}', String(member.guild.memberCount));
}

function colorToInt(hex) {
  return parseInt((hex || '#3ecf8e').replace('#', ''), 16) || 0x3ecf8e;
}

async function sendMessage(client, member, config) {
  if (!config.enabled || !config.channelId) return;
  try {
    const channel = await client.channels.fetch(config.channelId);
    if (!channel || !channel.isTextBased()) return;

    const embed = new EmbedBuilder()
      .setColor(colorToInt(config.color))
      .setFooter(brandFooter(client, member.guild.id))
      .setTimestamp();

    if (config.title) embed.setTitle(fillPlaceholders(config.title, member));
    if (config.description) embed.setDescription(fillPlaceholders(config.description, member));
    if (config.imageUrl) embed.setImage(config.imageUrl);
    if (config.avatarEnabled) embed.setThumbnail(member.user.displayAvatarURL({ size: 128 }));

    await channel.send({ embeds: [embed] });
  } catch (err) {
    console.error('Join/leave message failed:', err.message);
  }
}

function setupJoinLeaveMessages(client) {
  client.on('guildMemberAdd', (member) => {
    const config = getConfig(member.guild.id).join;
    sendMessage(client, member, config);
  });

  client.on('guildMemberRemove', (member) => {
    const config = getConfig(member.guild.id).leave;
    sendMessage(client, member, config);
  });

  console.log('Join/leave messages active (per-server, optional image).');
}

function updateConfig(guildId, patch) {
  const config = getConfig(guildId);
  if (patch.join) safeAssign(config.join, patch.join);
  if (patch.leave) safeAssign(config.leave, patch.leave);
  store.save();
  return config;
}

module.exports = { setupJoinLeaveMessages, getConfig, updateConfig };
