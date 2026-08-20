// Self-assign "notification role" panels: an embed with buttons, where clicking a
// button toggles that role on the clicking member (on if they don't have it, off if
// they do). Unlike reactionRoles.js (reaction-based, one role per message), each
// panel here can hold several toggle-buttons and is fully manageable from the
// dashboard's Fun tab — add as many panels as you want, each with its own roles.
const { ButtonBuilder, ButtonStyle, ActionRowBuilder, EmbedBuilder } = require('discord.js');
const { makeGuildStore } = require('./guildStore');
const { brandFooter } = require('./brand');

const store = makeGuildStore('role-panels.json', () => ({ panels: [] }));

let clientRef = null;

function colorToInt(hex) {
  return parseInt((hex || '#3fe8d6').replace('#', ''), 16) || 0x3fe8d6;
}

function buildPanelEmbed(panel, guildId) {
  return new EmbedBuilder().setTitle(panel.title).setDescription(panel.description).setColor(colorToInt(panel.color)).setFooter(brandFooter(clientRef, guildId));
}

function buildPanelComponents(panel) {
  const roles = panel.roles.slice(0, 5);
  if (roles.length === 0) return [];
  const row = new ActionRowBuilder().addComponents(
    roles.map((r) =>
      new ButtonBuilder().setCustomId(`rolepanel-toggle:${panel.id}:${r.roleId}`).setLabel(r.label).setEmoji(r.emoji || '🔔').setStyle(ButtonStyle.Secondary)
    )
  );
  return [row];
}

function setupRolePanels(client) {
  clientRef = client;

  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton() || !interaction.guild) return;
    if (!interaction.customId.startsWith('rolepanel-toggle:')) return;

    const [, , roleId] = interaction.customId.split(':');
    const member = interaction.member;

    try {
      if (member.roles.cache.has(roleId)) {
        await member.roles.remove(roleId);
        await interaction.reply({ content: `🔕 Removed <@&${roleId}> — you won't be notified anymore.`, ephemeral: true });
      } else {
        await member.roles.add(roleId);
        await interaction.reply({ content: `🔔 Added <@&${roleId}> — you'll now get notified.`, ephemeral: true });
      }
    } catch (err) {
      await interaction.reply({ content: `❌ Could not update your roles: ${err.message}`, ephemeral: true }).catch(() => {});
    }
  });

  console.log('Role panels active (per-server, self-assign notification roles).');
}

function getPanels(guildId) {
  return store.get(guildId).panels;
}

function addPanel(guildId, { name, title, description, color }) {
  const config = store.get(guildId);
  const id = Date.now().toString(36);
  config.panels.push({
    id,
    name,
    title: title || name,
    description: description || 'Click a button below to toggle a notification role.',
    color: color || '#3fe8d6',
    roles: [],
  });
  store.save();
  return config.panels;
}

function removePanel(guildId, panelId) {
  const config = store.get(guildId);
  config.panels = config.panels.filter((p) => p.id !== panelId);
  store.save();
  return config.panels;
}

function addRole(guildId, panelId, { roleId, label, emoji }) {
  const config = store.get(guildId);
  const panel = config.panels.find((p) => p.id === panelId);
  if (!panel) throw new Error('Panel not found.');
  if (panel.roles.length >= 5) throw new Error('A panel can hold at most 5 roles (one Discord button row).');
  if (panel.roles.some((r) => r.roleId === roleId)) throw new Error('That role is already on this panel.');
  panel.roles.push({ roleId, label, emoji: emoji || '🔔' });
  store.save();
  return config.panels;
}

function removeRole(guildId, panelId, roleId) {
  const config = store.get(guildId);
  const panel = config.panels.find((p) => p.id === panelId);
  if (!panel) throw new Error('Panel not found.');
  panel.roles = panel.roles.filter((r) => r.roleId !== roleId);
  store.save();
  return config.panels;
}

async function postPanel(client, guildId, panelId, channelId) {
  const config = store.get(guildId);
  const panel = config.panels.find((p) => p.id === panelId);
  if (!panel) throw new Error('Panel not found.');
  const channel = await client.channels.fetch(channelId);
  await channel.send({ embeds: [buildPanelEmbed(panel, guildId)], components: buildPanelComponents(panel) });
}

module.exports = { setupRolePanels, getPanels, addPanel, removePanel, addRole, removeRole, postPanel };
