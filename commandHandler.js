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
const { brandFooter } = require('./brand');
const { t } = require('./i18n');
const { applyColorCodes, stripColorCodes, applyLinkMasking } = require('./textFormatting');

const commandMap = new Map();
for (const c of commands) {
  commandMap.set(c.name, c);
  for (const alias of c.aliases) commandMap.set(alias, c);
}

// Standard edit-distance algorithm (insert/delete/substitute, each cost 1) —
// used to guess what someone meant to type, e.g. "hel" -> "help" is distance 1.
function levenshtein(a, b) {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d = Array.from({ length: rows }, (_, i) => [i, ...Array(cols - 1).fill(0)]);
  for (let j = 0; j < cols; j++) d[0][j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
    }
  }
  return d[rows - 1][cols - 1];
}

// Every command name/alias this specific server can currently actually run:
// the ~100 built-in commands, its own custom "rate" commands, and its own
// dashboard/AI-created custom commands — a typo suggestion pointing at a
// command that doesn't even work here would be worse than no suggestion.
function allKnownCommandNames(guildId) {
  const names = [...commandMap.keys()];
  for (const type of rateCommands.getTypes(guildId)) names.push(`rate${type.key}`);
  for (const custom of customCommands.list(guildId)) names.push(custom.name);
  return names;
}

// Only ever suggests something genuinely close — a wildly different guess
// would be more confusing than just saying "try !help". The threshold scales
// a little with word length so e.g. "kik" -> "kick" (distance 1) still
// matches even though 1/3 of the typed word was "wrong".
function closestCommandName(guildId, typed) {
  const names = allKnownCommandNames(guildId);
  let best = null;
  let bestDistance = Infinity;
  for (const name of names) {
    const distance = levenshtein(typed, name);
    if (distance < bestDistance) {
      best = name;
      bestDistance = distance;
    }
  }
  const threshold = Math.max(2, Math.ceil(typed.length / 2));
  return bestDistance <= threshold ? best : null;
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
      if (!custom) {
        const suggestion = closestCommandName(message.guild.id, commandName);
        const reply = suggestion
          ? t(message.guild.id, 'command.unknownWithSuggestion', { prefix, cmd: commandName, suggestion })
          : t(message.guild.id, 'command.unknownNoSuggestion', { prefix, cmd: commandName });
        await message.reply(reply).catch(() => {});
        return;
      }
      if (!customCommands.canUse(custom, message.member)) {
        await message.reply("🚫 You don't have permission to use this command.").catch(() => {});
        return;
      }

      const cooldownRemaining = customCommands.checkCooldown(message.guild.id, message.author.id, custom);
      if (cooldownRemaining) {
        await message.reply(`⏳ This command is on cooldown — try again in ${cooldownRemaining}s.`).catch(() => {});
        return;
      }

      const responseText = customCommands.fillPlaceholders(custom.response, message.member, message.channel);
      const titleText = custom.embedTitle ? customCommands.fillPlaceholders(custom.embedTitle, message.member, message.channel) : null;

      // §color and "label"(url) are each other's mirror image — one only
      // renders in plain content, the other only inside an embed. Apply
      // whichever actually works for the path this command is taking, and
      // strip the other's raw syntax so it doesn't show up as literal
      // leftover text. See textFormatting.js.
      let payload;
      if (custom.useEmbed) {
        const embed = new EmbedBuilder()
          .setDescription(applyLinkMasking(stripColorCodes(responseText)))
          .setColor(custom.color ? parseInt(custom.color.replace('#', ''), 16) : 0x3ecf8e)
          .setFooter(brandFooter(message.client, message.guild.id));
        if (titleText) embed.setTitle(applyLinkMasking(stripColorCodes(titleText)));
        if (custom.imageUrl) embed.setImage(custom.imageUrl);
        payload = { embeds: [embed] };
      } else {
        payload = { content: applyColorCodes(responseText) };
      }

      customCommands.recordUse(message.guild.id, message.author.id, custom);

      if (custom.visibility === 'private') {
        // Real ephemeral replies only exist for slash-command interactions —
        // this is a prefix text command, so the closest equivalent is: DM the
        // response, and delete the trigger message so nobody in the channel
        // even sees what was typed.
        await message.delete().catch(() => {});
        try {
          await message.author.send(payload);
        } catch {
          // DMs closed — best effort: a self-deleting channel message instead
          // of failing silently, even though it's briefly visible to anyone
          // watching that exact moment.
          try {
            const sent = await message.channel.send({ content: `${message.author}, I couldn't DM you (check your privacy settings) — sending it here instead, this message deletes itself shortly:`, ...payload });
            setTimeout(() => sent.delete().catch(() => {}), 8000);
          } catch (err) {
            console.error(`Custom command "${custom.name}" private fallback failed:`, err.message);
          }
        }
        return;
      }

      try {
        await message.reply(payload);
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
