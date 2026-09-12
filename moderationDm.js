// Sends the member a DM explaining a moderation action taken against them —
// which server, who did it (or "Auto-Moderation"/"AI Automod" for automated
// actions), and why. Used by every place in the codebase that warns, times
// out, or bans someone (manual dashboard actions, chat commands, rule-based
// automod, and AI automod), so the notice is consistent no matter which
// path triggered it.
//
// `target` can be a GuildMember or a plain User (banning someone who isn't
// currently a member only gives you a User) — either way, just needs a
// `.send()`. This never throws: a closed DM, a bot-blocked user, or the two
// no longer sharing a server (very common right after a ban) all just mean
// the notice silently doesn't arrive — that must never block the real
// moderation action itself, so every call site awaits this AFTER deciding
// to act, and ignores failure.
const { EmbedBuilder } = require('discord.js');
const { brandFooter } = require('./brand');
const { getEmoji } = require('./emoji');

// emojiKey is null for actions with no dedicated icon asset yet (timeout) —
// getEmoji() would just be passed through unused in that case anyway, but
// staying explicit here avoids a misleading lookup.
const ACTION_INFO = {
  warn: { verb: 'warned', emoji: '⚠️', emojiKey: 'status_warning', color: 0xf0b132 },
  timeout: { verb: 'timed out', emoji: '⏱️', emojiKey: null, color: 0xe67e22 },
  ban: { verb: 'banned', emoji: '🔨', emojiKey: 'mod_ban', color: 0xed4245 },
};

async function sendModerationDm(client, target, guild, { action, reason, moderatorTag, durationText }) {
  const info = ACTION_INFO[action];
  if (!info || !target) return;

  try {
    const emoji = info.emojiKey ? getEmoji(guild.id, info.emojiKey, client) : info.emoji;
    const embed = new EmbedBuilder()
      .setColor(info.color)
      .setTitle(`${emoji} You were ${info.verb} in ${guild.name}`)
      .setDescription(reason ? `**Reason:** ${reason}` : 'No reason was given.')
      .setFooter(brandFooter(client, guild.id))
      .setTimestamp();
    if (moderatorTag) embed.addFields({ name: 'Moderator', value: moderatorTag, inline: true });
    if (durationText) embed.addFields({ name: 'Duration', value: durationText, inline: true });

    await target.send({ embeds: [embed] });
  } catch (err) {
    console.error(`Could not DM ${action} notice to ${target.tag || target.user?.tag || target.id}:`, err.message);
  }
}

module.exports = { sendModerationDm };
