// Slash-command bridge: every "!" command (see commandRegistry.js) also gets
// a slash-command equivalent, grouped by category into one top-level command
// per category (/info, /fun, /tickets, ...) — Discord caps a single command
// at 25 direct subcommands, and Moderation alone has 26, so Moderation is
// split into two subcommand GROUPS instead (/mod member ..., /mod server ...).
//
// Each subcommand takes one optional "args" text field instead of individually
// typed options (a real @user picker for /mod member kick, a channel picker
// for /automation ..., etc.) — hand-designing proper typed options for all
// ~125 commands is a much bigger project on its own. This way every command
// behaves identically to its "!" version: type the exact same arguments
// you'd type after "!name" into the args field. "!" stays the primary,
// documented way to use the bot; slash commands are the same functionality,
// just launchable the other way too.
const { SlashCommandBuilder } = require('discord.js');
const { commands } = require('./commandRegistry');
const commandConfig = require('./commandConfig');

const CATEGORY_SLUGS = {
  Info: 'info',
  Music: 'music',
  Fun: 'fun',
  Automation: 'automation',
  Messaging: 'messaging',
  Tickets: 'tickets',
  XP: 'xp',
  Automod: 'automod',
  Verification: 'verification',
  Counting: 'counting',
};

// Moderation (26 commands) doesn't fit in one flat command (Discord's cap is
// 25 direct subcommands), so it's split into two subcommand groups under one
// /mod command instead: actions aimed at a specific member vs. actions aimed
// at the server/channel as a whole.
const MODERATION_GROUPS = {
  member: ['kick', 'ban', 'unban', 'softban', 'timeout', 'untimeout', 'warn', 'warnings', 'clearwarnings', 'nick', 'nickreset', 'roleadd', 'roleremove'],
  server: ['purge', 'purgeuser', 'purgebots', 'slowmode', 'lock', 'unlock', 'lockdown', 'unlockdown', 'massrole', 'massunrole', 'kickbots', 'banlist', 'listwarned'],
};

function clip(text, max) {
  const s = (text || '').trim() || 'No description.';
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function buildSubcommand(cmd) {
  return (sub) => {
    sub.setName(cmd.name).setDescription(clip(cmd.description, 100));
    if (cmd.usage) {
      sub.addStringOption((opt) => opt.setName('args').setDescription(clip(`Same as: !${cmd.name} ${cmd.usage}`, 100)).setRequired(false));
    }
    return sub;
  };
}

function buildSlashCommands() {
  const byCategory = new Map();
  for (const cmd of commands) {
    if (cmd.category === 'Moderation') continue; // handled separately below
    if (!byCategory.has(cmd.category)) byCategory.set(cmd.category, []);
    byCategory.get(cmd.category).push(cmd);
  }

  const builders = [];
  for (const [category, list] of byCategory) {
    const slug = CATEGORY_SLUGS[category] || category.toLowerCase().replace(/[^a-z0-9]/g, '');
    const builder = new SlashCommandBuilder().setName(slug).setDescription(clip(`${category} commands`, 100));
    for (const cmd of list) builder.addSubcommand(buildSubcommand(cmd));
    builders.push(builder);
  }

  const modBuilder = new SlashCommandBuilder().setName('mod').setDescription('Moderation commands');
  for (const [groupName, names] of Object.entries(MODERATION_GROUPS)) {
    modBuilder.addSubcommandGroup((group) => {
      group.setName(groupName).setDescription(clip(`Moderation actions — ${groupName}`, 100));
      for (const name of names) {
        const cmd = commands.find((c) => c.name === name);
        if (cmd) group.addSubcommand(buildSubcommand(cmd));
      }
      return group;
    });
  }
  builders.push(modBuilder);

  return builders.map((b) => b.toJSON());
}

async function registerSlashCommands(client) {
  try {
    const payload = buildSlashCommands();
    await client.application.commands.set(payload);
    console.log(`Slash commands registered (${payload.length} top-level, covering ${commands.length} "!" commands).`);
  } catch (err) {
    console.error('Could not register slash commands:', err.message);
  }
}

// The handful of message properties every command's run() actually touches
// (verified by grepping commandRegistry.js) — a plain object exposing just
// these lets the exact same run() functions execute unchanged for both "!"
// and "/", no per-command rewrite needed.
function buildFakeMessage(interaction) {
  return {
    author: interaction.user,
    channel: interaction.channel,
    channelId: interaction.channelId,
    client: interaction.client,
    guild: interaction.guild,
    member: interaction.member,
  };
}

function setupSlashCommands(client, ctx) {
  client.once('ready', () => registerSlashCommands(client));

  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand() || !interaction.guild) return;

    // Subcommand names are exactly the original "!" command names (unique
    // across the whole bot already), so this works the same whether it came
    // through a plain subcommand or one of Moderation's subcommand groups.
    const commandName = interaction.options.getSubcommand(false);
    const command = commandName ? commands.find((c) => c.name === commandName) : null;
    if (!command) {
      await interaction.reply({ content: "❌ That command isn't available.", ephemeral: true }).catch(() => {});
      return;
    }

    if (commandConfig.isDisabled(interaction.guild.id, command.name)) {
      await interaction.reply({ content: '🚫 This command is currently disabled.', ephemeral: true }).catch(() => {});
      return;
    }
    if (command.permission && !interaction.member.permissions.has(command.permission)) {
      await interaction.reply({ content: "🚫 You don't have permission to use this command.", ephemeral: true }).catch(() => {});
      return;
    }

    const raw = interaction.options.getString('args') || '';
    const args = raw.trim() ? raw.trim().split(/\s+/) : [];
    const fakeMessage = buildFakeMessage(interaction);

    try {
      const result = await command.run(fakeMessage, args, ctx);
      if (result) {
        await interaction.reply(result.length > 1900 ? `${result.slice(0, 1900)}…` : result);
      } else {
        // The command already sent its own visible message (channel.send) —
        // Discord still requires every interaction to get *some* response,
        // so this is a tiny confirmation only the invoker sees.
        await interaction.reply({ content: '✅ Done.', ephemeral: true });
      }
    } catch (err) {
      console.error(`Slash command "${command.name}" failed:`, err);
      const payload = { content: `❌ ${err.message || 'Something went wrong running that command.'}`, ephemeral: true };
      if (interaction.replied || interaction.deferred) await interaction.followUp(payload).catch(() => {});
      else await interaction.reply(payload).catch(() => {});
    }
  });

  console.log('Slash-command bridge active (all "!" commands also available via "/").');
}

module.exports = { setupSlashCommands };
