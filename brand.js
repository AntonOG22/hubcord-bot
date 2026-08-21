// A small, consistent watermark on every embed the bot sends — same idea as
// "TicketTool.xyz - Ticketing without clutter" at the bottom of their panels:
// a tiny icon + one line of gray footer text, never louder than that. Discord
// embeds only support one footer, so when an embed already needs its footer
// for something informative (e.g. "Opened by X"), the two get combined
// instead of overwritten.
//
// Two independent off-switches, both from the admin panel:
//   - Bot-wide (owner only, botSettings.js) — turns it off everywhere.
//   - Per-server (any server admin, guildConfig.js) — turns it off just for
//     that one server's embeds (join/leave messages, tickets, role panels,
//     giveaways, custom commands, everything that calls this function).
// Either one being on is enough to hide it. Official announcements/
// broadcasts are NEVER affected by either switch — they use their own fixed
// "✅ Verified official message" footer (see dashboard.js's
// buildOfficialAnnouncementEmbed), which doesn't call this function at all,
// specifically so it keeps proving a message really came from the real bot
// even on a server that's turned the regular watermark off.
const botSettings = require('./botSettings');
const guildConfig = require('./guildConfig');

// Derived from PUBLIC_URL instead of hardcoded — a hardcoded domain here
// silently goes stale every time the bot moves hosts (this has already
// happened once). Falls back to a plain "Emerald" tagline if PUBLIC_URL
// isn't set (e.g. local dev).
const domain = process.env.PUBLIC_URL ? process.env.PUBLIC_URL.replace(/^https?:\/\//, '').replace(/\/$/, '') : null;
const TAGLINE = domain ? `Emerald — ${domain}` : 'Emerald';

function brandFooter(client, guildId, existingText) {
  const disabled = botSettings.isWatermarkDisabled() || (guildId && !!guildConfig.getConfig(guildId).watermarkDisabled);
  if (disabled) {
    return existingText ? { text: existingText } : null;
  }
  return {
    text: existingText ? `${existingText} • Emerald` : TAGLINE,
    iconURL: client?.user?.displayAvatarURL?.({ size: 32 }) || undefined,
  };
}

module.exports = { brandFooter, TAGLINE };
