// Per-server join/leave announcement messages. Each one is independently
// enabled/disabled, posts to its own channel, and can optionally carry an
// image (a fixed URL/upload — not a per-user generated card). Supports a
// few placeholders so the same message adapts to whoever triggered it.
const { EmbedBuilder } = require('discord.js');
const { makeGuildStore, safeAssign } = require('./guildStore');
const { brandFooter } = require('./brand');

const DEFAULT_MESSAGE = () => ({
  enabled: false,
  channelId: null,
  title: '',
  description: '',
  imageUrl: '',
  color: '#3ecf8e',
});

const store = makeGuildStore('join-leave-config.json', () => ({
  join: { ...DEFAULT_MESSAGE(), description: 'Welcome {user} to **{server}**! We now have {membercount} members.' },
  leave: { ...DEFAULT_MESSAGE(), color: '#f0655f', description: '{username} has left **{server}**. We now have {membercount} members.' },
}));

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
      .setFooter(brandFooter(client))
      .setTimestamp();

    if (config.title) embed.setTitle(fillPlaceholders(config.title, member));
    if (config.description) embed.setDescription(fillPlaceholders(config.description, member));
    if (config.imageUrl) embed.setImage(config.imageUrl);
    embed.setThumbnail(member.user.displayAvatarURL({ size: 128 }));

    await channel.send({ embeds: [embed] });
  } catch (err) {
    console.error('Join/leave message failed:', err.message);
  }
}

function setupJoinLeaveMessages(client) {
  client.on('guildMemberAdd', (member) => {
    const config = store.get(member.guild.id).join;
    sendMessage(client, member, config);
  });

  client.on('guildMemberRemove', (member) => {
    const config = store.get(member.guild.id).leave;
    sendMessage(client, member, config);
  });

  console.log('Join/leave messages active (per-server, optional image).');
}

function getConfig(guildId) {
  return store.get(guildId);
}

function updateConfig(guildId, patch) {
  const config = store.get(guildId);
  if (patch.join) safeAssign(config.join, patch.join);
  if (patch.leave) safeAssign(config.leave, patch.leave);
  store.save();
  return config;
}

module.exports = { setupJoinLeaveMessages, getConfig, updateConfig };
