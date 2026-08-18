// Per-server verification gate: instead of instantly giving new members the configured
// role, post a button they must click first. Each server toggles this independently and
// uses its own configured member role (guildConfig).
const { ButtonBuilder, ButtonStyle, ActionRowBuilder, EmbedBuilder } = require('discord.js');
const { makeGuildStore } = require('./guildStore');
const guildConfig = require('./guildConfig');

const BUTTON_ID = 'mcsmp-verify-button';
const store = makeGuildStore('verification-state.json', () => ({ enabled: false }));

function setupVerificationGate(client) {
  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton() || interaction.customId !== BUTTON_ID) return;

    const memberRoleId = guildConfig.getConfig(interaction.guildId).memberRoleId;
    if (!memberRoleId) {
      await interaction
        .reply({ content: 'Verification is not fully configured on this server yet — ask an admin to set the Member Role in the dashboard.', ephemeral: true })
        .catch(() => {});
      return;
    }

    try {
      await interaction.member.roles.add(memberRoleId);
      await interaction.reply({ content: '✅ Verified! Welcome.', ephemeral: true });
    } catch (err) {
      await interaction.reply({ content: `Could not verify you: ${err.message}`, ephemeral: true }).catch(() => {});
    }
  });

  console.log('Verification gate active (per-server).');
}

async function postVerificationMessage(client, channelId) {
  const channel = await client.channels.fetch(channelId);
  const embed = new EmbedBuilder()
    .setTitle('✅ Verify to get access')
    .setDescription('Click the button below to verify and unlock the rest of the server.')
    .setColor(0x57f287);
  const button = new ButtonBuilder().setCustomId(BUTTON_ID).setLabel('Verify').setStyle(ButtonStyle.Success);
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
