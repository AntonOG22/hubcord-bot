// A tiny, server-only marker for "this specific ban/timeout was just
// performed autonomously by AI automod" — lets modLogTracker.js skip its
// own duplicate plain-text line for these specific actions (AI automod
// already posts its own detailed embed) without trusting anything an admin
// could type themselves, like a ban reason string. Matching on reason text
// (the earlier approach) let any admin with Ban Members hide their own
// manual ban from the mod-log/audit trail just by typing a recognizable
// reason — this can't be spoofed the same way, since it's set here, in
// code, at the exact moment AI automod itself performs the action, never
// from anything a request body or command argument controls.
const recent = new Map(); // `${guildId}:${userId}:${action}` -> expiry timestamp
const TTL_MS = 5000; // generous enough for the audit-log lookup that follows within ~1s, short enough nothing lingers

function markAutomated(guildId, userId, action) {
  recent.set(`${guildId}:${userId}:${action}`, Date.now() + TTL_MS);
}

// One-shot: checking consumes the mark, so a second unrelated ban/timeout on
// the same user shortly after doesn't accidentally get suppressed too.
function wasJustAutomated(guildId, userId, action) {
  const key = `${guildId}:${userId}:${action}`;
  const expiry = recent.get(key);
  if (!expiry) return false;
  recent.delete(key);
  return Date.now() <= expiry;
}

module.exports = { markAutomated, wasJustAutomated };
