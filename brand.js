// A small, consistent watermark on every embed the bot sends — same idea as
// "TicketTool.xyz - Ticketing without clutter" at the bottom of their panels:
// a tiny icon + one line of gray footer text, never louder than that. Discord
// embeds only support one footer, so when an embed already needs its footer
// for something informative (e.g. "Opened by X"), the two get combined
// instead of overwritten.
const TAGLINE = 'Emerald — hubcord-bot.onrender.com';

function brandFooter(client, existingText) {
  return {
    text: existingText ? `${existingText} • Emerald` : TAGLINE,
    iconURL: client?.user?.displayAvatarURL?.({ size: 32 }) || undefined,
  };
}

module.exports = { brandFooter, TAGLINE };
