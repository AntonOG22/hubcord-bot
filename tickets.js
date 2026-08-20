// Full per-server ticket system, built around named "panels" — each panel is its own
// embed + button, posted wherever you like, and creates tickets in its own category
// (e.g. a "Bug Reports" panel posting to #bug-reports and filing tickets under the
// BUG REPORTS category, completely separate from a "Support" panel/category).
//
// Closing a ticket does NOT delete it or post anywhere externally: it hides the
// channel from whoever opened it and moves it into a configurable "closed tickets"
// category, where staff can permanently delete it, pull a transcript, or reopen it.
const {
  ButtonBuilder, ButtonStyle, ActionRowBuilder, EmbedBuilder, ChannelType, PermissionFlagsBits,
} = require('discord.js');
const { makeGuildStore, safeAssign } = require('./guildStore');
const { t } = require('./i18n');
const { brandFooter } = require('./brand');

const MAX_SUPPORT_ROLES = 3;

const configStore = makeGuildStore('ticket-config.json', () => ({
  supportRoleIds: [], // up to MAX_SUPPORT_ROLES roles, all pinged + given access on a new ticket
  closedCategoryChannelId: null,
  ticketNameFormat: 'ticket-{username}',
  welcomeMessage: "Thanks for reaching out, {user}! Support will be with you shortly.\nDescribe your issue below and a staff member will help soon.",
  maxOpenPerUser: 1,
  autoCloseHours: 0, // 0 = disabled
  panels: [],
}));

const stateStore = makeGuildStore('tickets-state.json', () => ({ nextNumber: 1, tickets: [] }));

let clientRef = null;

// ---------- Helpers ----------

function sanitizeChannelName(name) {
  return name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 90) || 'ticket';
}

function colorToInt(hex) {
  return parseInt((hex || '#3fe8d6').replace('#', ''), 16) || 0x3fe8d6;
}

function buildTicketName(config, member, number) {
  return sanitizeChannelName(
    config.ticketNameFormat.replace('{username}', member.user.username).replace('{count}', String(number))
  );
}

function buildPanelEmbed(panel, client) {
  return new EmbedBuilder()
    .setTitle(panel.panelTitle)
    .setDescription(panel.panelDescription)
    .setColor(colorToInt(panel.panelColor))
    .setFooter(brandFooter(client));
}

function buildPanelComponents(panel) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ticket-open:${panel.id}`).setLabel(panel.buttonLabel).setEmoji(panel.buttonEmoji || '🎫').setStyle(ButtonStyle.Primary)
  );
  return [row];
}

function openControlsRow(guildId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket-close').setLabel(t(guildId, 'ticket.btnClose')).setEmoji('🔒').setStyle(ButtonStyle.Danger)
  );
}

function closeConfirmRow(guildId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket-close-confirm').setLabel(t(guildId, 'ticket.btnConfirmClose')).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('ticket-close-cancel').setLabel(t(guildId, 'ticket.btnCancel')).setStyle(ButtonStyle.Secondary)
  );
}

function closedControlsRow(guildId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket-reopen').setLabel(t(guildId, 'ticket.btnReopen')).setEmoji('🔓').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('ticket-transcript').setLabel(t(guildId, 'ticket.btnTranscript')).setEmoji('📄').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('ticket-delete').setLabel(t(guildId, 'ticket.btnDelete')).setEmoji('🗑️').setStyle(ButtonStyle.Danger)
  );
}

function deleteConfirmRow(guildId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket-delete-confirm').setLabel(t(guildId, 'ticket.btnPermanentlyDelete')).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('ticket-delete-cancel').setLabel(t(guildId, 'ticket.btnCancel')).setStyle(ButtonStyle.Secondary)
  );
}

function findOpenTicket(guildId, channelId) {
  return stateStore.get(guildId).tickets.find((t) => t.channelId === channelId && t.status === 'open');
}

function findClosedTicket(guildId, channelId) {
  return stateStore.get(guildId).tickets.find((t) => t.channelId === channelId && t.status === 'closed');
}

async function generateTranscript(channel) {
  let messages = [];
  let before;
  for (let i = 0; i < 5; i++) {
    const batch = await channel.messages.fetch({ limit: 100, before });
    if (batch.size === 0) break;
    messages.push(...batch.values());
    before = batch.last().id;
    if (batch.size < 100) break;
  }
  messages.reverse();
  const lines = messages.map((m) => `[${m.createdAt.toISOString()}] ${m.author.tag}: ${m.content || '(no text / embed / attachment)'}`);
  return lines.join('\n') || '(no messages)';
}

// ---------- Ticket lifecycle ----------

async function openTicket(interaction, panelId) {
  const guild = interaction.guild;
  const config = configStore.get(guild.id);
  const state = stateStore.get(guild.id);
  const member = interaction.member;

  const panel = config.panels.find((p) => p.id === panelId);
  if (!panel) {
    return interaction.reply({ content: t(guild.id, 'ticket.panelGone'), ephemeral: true });
  }

  const openCount = state.tickets.filter((tk) => tk.userId === member.id && tk.status === 'open').length;
  if (openCount >= config.maxOpenPerUser) {
    return interaction.reply({ content: t(guild.id, 'ticket.maxOpen', { count: openCount, max: config.maxOpenPerUser }), ephemeral: true });
  }

  const number = state.nextNumber;
  const name = buildTicketName(config, member, number);

  const overwrites = [
    { id: guild.roles.everyone, deny: [PermissionFlagsBits.ViewChannel] },
    { id: member.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
    { id: guild.members.me.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels] },
  ];
  for (const roleId of config.supportRoleIds || []) {
    overwrites.push({ id: roleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
  }

  let channel;
  try {
    channel = await guild.channels.create({
      name,
      type: ChannelType.GuildText,
      parent: panel.categoryChannelId || undefined,
      permissionOverwrites: overwrites,
      topic: `Ticket for ${member.user.tag} — ${panel.name}`,
    });
  } catch (err) {
    return interaction.reply({ content: t(guild.id, 'ticket.createFailed', { error: err.message }), ephemeral: true });
  }

  const ticket = {
    id: `${guild.id}-${number}`,
    number,
    channelId: channel.id,
    userId: member.id,
    userTag: member.user.tag,
    panelId: panel.id,
    panelName: panel.name,
    originalCategoryId: panel.categoryChannelId || null,
    status: 'open',
    createdAt: new Date().toISOString(),
    closedAt: null,
    closedBy: null,
    lastActivity: new Date().toISOString(),
  };
  state.tickets.push(ticket);
  state.nextNumber += 1;
  stateStore.save();

  const embed = new EmbedBuilder()
    .setTitle(t(guild.id, 'ticket.embedTitle', { number, panel: panel.name }))
    .setDescription(config.welcomeMessage.replace('{user}', `${member}`))
    .setColor(colorToInt(panel.panelColor))
    .setFooter(brandFooter(interaction.client, t(guild.id, 'ticket.footerOpenedBy', { tag: member.user.tag })))
    .setTimestamp();

  await channel.send({
    content: `${(config.supportRoleIds || []).map((id) => `<@&${id}>`).join(' ')} ${member}`.trim(),
    embeds: [embed],
    components: [openControlsRow(guild.id)],
  });

  await interaction.reply({ content: t(guild.id, 'ticket.created', { channel: channel.toString() }), ephemeral: true });
}

// Hides the channel from whoever opened it and moves it into the closed-tickets
// category, instead of deleting it or posting a transcript anywhere.
async function performClose(guild, ticket, closedByTag) {
  const config = configStore.get(guild.id);
  const channel = await guild.channels.fetch(ticket.channelId).catch(() => null);
  if (!channel) throw new Error('Ticket channel no longer exists.');

  ticket.status = 'closed';
  ticket.closedAt = new Date().toISOString();
  ticket.closedBy = closedByTag;
  stateStore.save();

  await channel.permissionOverwrites.delete(ticket.userId).catch(() => {});
  if (config.closedCategoryChannelId) {
    await channel.setParent(config.closedCategoryChannelId, { lockPermissions: false }).catch((err) => {
      console.error('Could not move ticket to closed category:', err.message);
    });
  }
  if (!channel.name.startsWith('closed-')) {
    await channel.setName(sanitizeChannelName(`closed-${channel.name}`)).catch(() => {});
  }

  const embed = new EmbedBuilder()
    .setTitle(t(guild.id, 'ticket.closedTitle', { number: ticket.number }))
    .setDescription(t(guild.id, 'ticket.closedDesc', { by: closedByTag, user: ticket.userTag }))
    .setColor(0xff5c4d)
    .setFooter(brandFooter(guild.client))
    .setTimestamp();

  await channel.send({ embeds: [embed], components: [closedControlsRow(guild.id)] }).catch(() => {});
}

async function performReopen(guild, ticket) {
  const channel = await guild.channels.fetch(ticket.channelId).catch(() => null);
  if (!channel) throw new Error('Ticket channel no longer exists.');

  ticket.status = 'open';
  ticket.closedAt = null;
  ticket.closedBy = null;
  ticket.lastActivity = new Date().toISOString();
  stateStore.save();

  await channel.permissionOverwrites.edit(ticket.userId, {
    ViewChannel: true,
    SendMessages: true,
    ReadMessageHistory: true,
  }).catch(() => {});
  if (ticket.originalCategoryId) {
    await channel.setParent(ticket.originalCategoryId, { lockPermissions: false }).catch(() => {});
  }
  if (channel.name.startsWith('closed-')) {
    await channel.setName(channel.name.replace(/^closed-/, '')).catch(() => {});
  }

  const embed = new EmbedBuilder()
    .setTitle(t(guild.id, 'ticket.reopenedTitle', { number: ticket.number }))
    .setDescription(t(guild.id, 'ticket.reopenedDesc', { userMention: `<@${ticket.userId}>` }))
    .setColor(0x3ddc84)
    .setFooter(brandFooter(guild.client))
    .setTimestamp();

  await channel.send({ content: `<@${ticket.userId}>`, embeds: [embed], components: [openControlsRow(guild.id)] }).catch(() => {});
}

async function addParticipant(guild, channelId, member) {
  const channel = await guild.channels.fetch(channelId);
  await channel.permissionOverwrites.edit(member.id, {
    ViewChannel: true,
    SendMessages: true,
    ReadMessageHistory: true,
  });
}

async function removeParticipant(guild, channelId, member) {
  const channel = await guild.channels.fetch(channelId);
  await channel.permissionOverwrites.delete(member.id);
}

// Convenience wrapper used by chat commands (!ticketclose etc.), which don't go
// through the button-confirmation flow.
async function closeTicket(client, guildId, channelId, closedByTag) {
  const guild = await client.guilds.fetch(guildId);
  const ticket = findOpenTicket(guildId, channelId);
  if (!ticket) throw new Error('This channel is not an open ticket.');
  await performClose(guild, ticket, closedByTag);
  return ticket;
}

async function reopenTicket(client, guildId, channelId) {
  const guild = await client.guilds.fetch(guildId);
  const ticket = findClosedTicket(guildId, channelId);
  if (!ticket) throw new Error('This channel is not a closed ticket.');
  await performReopen(guild, ticket);
  return ticket;
}

async function deleteTicket(client, guildId, channelId) {
  const state = stateStore.get(guildId);
  const ticket = state.tickets.find((t) => t.channelId === channelId);
  if (!ticket) throw new Error('No ticket record for this channel.');
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (channel) await channel.delete().catch(() => {});
  state.tickets = state.tickets.filter((t) => t.channelId !== channelId);
  stateStore.save();
  return ticket;
}

// ---------- Setup ----------

function setupTickets(client) {
  clientRef = client;

  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton() || !interaction.guild) return;
    const guild = interaction.guild;

    try {
      if (interaction.customId.startsWith('ticket-open:')) {
        await openTicket(interaction, interaction.customId.split(':')[1]);
        return;
      }

      if (interaction.customId === 'ticket-close') {
        const ticket = findOpenTicket(guild.id, interaction.channelId);
        if (!ticket) return interaction.reply({ content: t(guild.id, 'ticket.notOpen'), ephemeral: true });
        await interaction.reply({ content: t(guild.id, 'ticket.confirmClose'), components: [closeConfirmRow(guild.id)] });
        return;
      }

      if (interaction.customId === 'ticket-close-cancel') {
        await interaction.message.delete().catch(() => {});
        return;
      }

      if (interaction.customId === 'ticket-close-confirm') {
        const ticket = findOpenTicket(guild.id, interaction.channelId);
        if (!ticket) return interaction.reply({ content: t(guild.id, 'ticket.notOpen'), ephemeral: true });
        await interaction.message.delete().catch(() => {});
        await performClose(guild, ticket, interaction.user.tag);
        return;
      }

      if (interaction.customId === 'ticket-reopen') {
        const ticket = findClosedTicket(guild.id, interaction.channelId);
        if (!ticket) return interaction.reply({ content: t(guild.id, 'ticket.notClosed'), ephemeral: true });
        await interaction.deferUpdate();
        await performReopen(guild, ticket);
        return;
      }

      if (interaction.customId === 'ticket-transcript') {
        const ticket = findClosedTicket(guild.id, interaction.channelId) || findOpenTicket(guild.id, interaction.channelId);
        if (!ticket) return interaction.reply({ content: t(guild.id, 'ticket.noRecord'), ephemeral: true });
        await interaction.deferReply();
        const transcript = await generateTranscript(interaction.channel);
        await interaction.editReply({
          content: t(guild.id, 'ticket.transcriptTitle', { number: ticket.number }),
          files: [{ attachment: Buffer.from(transcript, 'utf8'), name: `ticket-${ticket.number}-transcript.txt` }],
        });
        return;
      }

      if (interaction.customId === 'ticket-delete') {
        await interaction.reply({ content: t(guild.id, 'ticket.confirmDelete'), components: [deleteConfirmRow(guild.id)] });
        return;
      }

      if (interaction.customId === 'ticket-delete-cancel') {
        await interaction.message.delete().catch(() => {});
        return;
      }

      if (interaction.customId === 'ticket-delete-confirm') {
        await interaction.deferReply();
        await deleteTicket(client, guild.id, interaction.channelId);
        // channel is gone at this point, nothing left to reply into
        return;
      }
    } catch (err) {
      const reply = { content: t(guild.id, 'ticket.error', { message: err.message }), ephemeral: true };
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp(reply).catch(() => {});
      } else {
        await interaction.reply(reply).catch(() => {});
      }
    }
  });

  // Track last-activity per ticket so inactivity auto-close knows what's actually quiet
  client.on('messageCreate', (message) => {
    if (!message.guild || message.author.bot) return;
    const ticket = findOpenTicket(message.guild.id, message.channelId);
    if (ticket) {
      ticket.lastActivity = new Date().toISOString();
      stateStore.save();
    }
  });

  // Auto-close tickets that have been quiet longer than the configured threshold
  setInterval(async () => {
    for (const guild of client.guilds.cache.values()) {
      const config = configStore.get(guild.id);
      if (!config.autoCloseHours) continue;
      const state = stateStore.get(guild.id);
      const cutoff = Date.now() - config.autoCloseHours * 60 * 60 * 1000;
      for (const ticket of state.tickets.filter((t) => t.status === 'open')) {
        if (new Date(ticket.lastActivity).getTime() < cutoff) {
          try {
            await performClose(guild, ticket, 'Auto-close (inactivity)');
          } catch (err) {
            console.error('Auto-close ticket failed:', err.message);
          }
        }
      }
    }
  }, 15 * 60 * 1000);

  console.log('Ticket system active (per-server, fully configurable).');
}

// ---------- Config & info (used by the dashboard and by chat commands) ----------

function getConfig(guildId) {
  const config = configStore.get(guildId);
  // One-time migration from the old single supportRoleId field to the new
  // up-to-3 supportRoleIds array — existing servers keep their configured
  // role instead of silently losing it the first time this runs.
  if (!config.supportRoleIds) {
    config.supportRoleIds = config.supportRoleId ? [config.supportRoleId] : [];
    delete config.supportRoleId;
    configStore.save();
  }
  return config;
}

function updateConfig(guildId, patch) {
  const config = safeAssign(configStore.get(guildId), patch);
  configStore.save();
  return config;
}

function addPanel(guildId, panel) {
  const config = configStore.get(guildId);
  const id = Date.now().toString(36);
  config.panels.push({
    id,
    name: panel.name,
    buttonLabel: panel.buttonLabel || panel.name,
    buttonEmoji: panel.buttonEmoji || '🎫',
    panelTitle: panel.panelTitle || panel.name,
    panelDescription: panel.panelDescription || 'Click the button below to open a private ticket with our staff.',
    panelColor: panel.panelColor || '#3fe8d6',
    categoryChannelId: panel.categoryChannelId || null,
  });
  configStore.save();
  return config.panels;
}

function updatePanel(guildId, panelId, patch) {
  const config = configStore.get(guildId);
  const panel = config.panels.find((p) => p.id === panelId);
  if (!panel) throw new Error('Panel not found.');
  safeAssign(panel, patch);
  configStore.save();
  return config.panels;
}

function removePanel(guildId, panelId) {
  const config = configStore.get(guildId);
  config.panels = config.panels.filter((p) => p.id !== panelId);
  configStore.save();
  return config.panels;
}

async function postPanel(client, guildId, panelId, channelId) {
  const config = configStore.get(guildId);
  const panel = config.panels.find((p) => p.id === panelId);
  if (!panel) throw new Error('Panel not found.');
  const channel = await client.channels.fetch(channelId);
  await channel.send({ embeds: [buildPanelEmbed(panel, client)], components: buildPanelComponents(panel) });
}

function listTickets(guildId, status) {
  return stateStore
    .get(guildId)
    .tickets.filter((t) => !status || t.status === status)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function getStats(guildId) {
  const state = stateStore.get(guildId);
  const open = state.tickets.filter((t) => t.status === 'open').length;
  const closed = state.tickets.filter((t) => t.status === 'closed');
  const avgResolutionMinutes = closed.length
    ? Math.round(closed.reduce((sum, t) => sum + (new Date(t.closedAt) - new Date(t.createdAt)) / 60000, 0) / closed.length)
    : 0;
  const byStaff = {};
  for (const t of closed) {
    if (!t.closedBy) continue;
    byStaff[t.closedBy] = (byStaff[t.closedBy] || 0) + 1;
  }
  return { open, closedTotal: closed.length, totalTickets: state.tickets.length, avgResolutionMinutes, byStaff };
}

module.exports = {
  MAX_SUPPORT_ROLES,
  setupTickets,
  getConfig,
  updateConfig,
  addPanel,
  updatePanel,
  removePanel,
  postPanel,
  listTickets,
  getStats,
  closeTicket,
  reopenTicket,
  deleteTicket,
  addParticipant,
  removeParticipant,
};
