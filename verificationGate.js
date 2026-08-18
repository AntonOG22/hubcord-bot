// Per-server verification gate: instead of instantly giving new members the configured
// role, post a button they must click first. Each server toggles this independently and
// uses its own configured member role (guildConfig).
const { ButtonBuilder, ButtonStyle, ActionRowBuilder, EmbedBuilder } = require('discord.js');
const { makeGuildStore } = require('./guildStore');
const guildConfig = require('./guildConfig');
const { t } = require('./i18n');

const BUTTON_ID = 'mcsmp-verify-button';
const store = makeGuildStore('verification-state.json', () => ({ enabled: false }));

function setupVerificationGate(client) {
  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton() || interaction.customId !== BUTTON_ID) return;

    const memberRoleId = guildConfig.getConfig(interaction.guildId).memberRoleId;
    if (!memberRoleId) {
      await interaction
        .reply({ content: t(interaction.guildId, 'verify.notConfigured'), ephemeral: true })
        .catch(() => {});
      return;
    }

    try {
      await interaction.member.roles.add(memberRoleId);
      await interaction.reply({ content: t(interaction.guildId, 'verify.success'), ephemeral: true });
    } catch (err) {
      await interaction.reply({ content: t(interaction.guildId, 'verify.failed', { error: err.message }), ephemeral: true }).catch(() => {});
    }
  });

  console.log('Verification gate active (per-server).');
}

async function postVerificationMessage(client, channelId) {
  const channel = await client.channels.fetch(channelId);
  const guildId = channel.guild.id;
  const embed = new EmbedBuilder()
    .setTitle(t(guildId, 'verify.embedTitle'))
    .setDescription(t(guildId, 'verify.embedDesc'))
    .setColor(0x57f287);
  const button = new ButtonBuilder().setCustomId(BUTTON_ID).setLabel(t(guildId, 'verify.button')).setStyle(ButtonStyle.Success);
  const row = new ActionRowBuilder().addComponents(button);
  await channel.send({ embeds: [embed], components: [row] });
}

function isEnabled(guildId) {
  return store.get(guildId).enabled;
}

function setEnabled(guildId, value) {
  store.set(guildId, { enabled: value });
}

module.exports = { setupVerificationGate, postVerificationMessage, isEnabled, setEnabled };
