// Parses incoming messages for the configured prefix, resolves the command (or
// alias), checks the invoking member's actual Discord permissions, and runs it.
// Permission-gating is done directly against message.member.permissions — the
// server's real role setup (e.g. Moderator has Timeout but not Ban) is respected
// automatically, no separate permission system to keep in sync.
const commandConfig = require('./commandConfig');
const { commands } = require('./commandRegistry');
const rateCommands = require('./rateCommands');
const customCommands = require('./customCommands');
const { EmbedBuilder } = require('discord.js');

const commandMap = new Map();
for (const c of commands) {
  commandMap.set(c.name, c);
  for (const alias of c.aliases) commandMap.set(alias, c);
}

function setupCommandHandler(client, ctx) {
  client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;

    const prefix = commandConfig.getPrefix(message.guild.id);
    if (!message.content.startsWith(prefix)) return;

    const args = message.content.slice(prefix.length).trim().split(/\s+/);
    const commandName = args.shift()?.toLowerCase();
    if (!commandName) return;

    const command = commandMap.get(commandName);
    if (!command) {
      // Not a static command — check if it's a per-server custom "rate" command
      // (e.g. !rateaura), configurable from the dashboard's Fun tab.
      const rateType = rateCommands.matchCommandName(message.guild.id, commandName);
      if (rateType) {
        try {
          await rateCommands.runRate(message, args, rateType);
        } catch (err) {
          await message.reply(`❌ ${err.message || 'Something went wrong running that command.'}`).catch(() => {});
        }
        return;
      }

      // Still not matched — check per-server custom commands (dashboard/AI-created).
      const custom = customCommands.find(message.guild.id, commandName);
      if (!custom) return;
      try {
        if (custom.embedTitle) {
          const embed = new EmbedBuilder()
            .setTitle(custom.embedTitle)
            .setDescription(custom.response)
            .setColor(custom.color ? parseInt(custom.color.replace('#', ''), 16) : 0x3ecf8e);
          await message.reply({ embeds: [embed] });
        } else {
          await message.reply(custom.response);
        }
      } catch (err) {
        console.error(`Custom command "${custom.name}" failed:`, err);
      }
      return;
    }

    if (commandConfig.isDisabled(message.guild.id, command.name)) {
      await message.reply('🚫 This command is currently disabled.').catch(() => {});
      return;
    }

    if (command.permission && !message.member.permissions.has(command.permission)) {
      await message.reply("🚫 You don't have permission to use this command.").catch(() => {});
      return;
    }

    try {
      const result = await command.run(message, args, ctx);
      if (result) await message.reply(result.length > 1900 ? result.slice(0, 1900) + '…' : result);
    } catch (err) {
      await message.reply(`❌ ${err.message || 'Something went wrong running that command.'}`).catch(() => {});
      console.error(`Command "${command.name}" failed:`, err);
    }
  });

  console.log(`Custom command system active (${commands.length} commands, prefix configurable per server — "!" by default).`);
}

module.exports = { setupCommandHandler, commandMap };
