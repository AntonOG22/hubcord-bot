// Sequential per-server "case numbers" for the moderation actions that
// actually matter for later lookback (bans, kicks, timeouts, warns) — same
// idea as Dyno/ModMail's case system. Not every mod-log line gets one (role
// tweaks, slowmode changes, bulk purges stay plain) — only real punishments,
// so case numbers stay meaningful instead of racing up from routine noise.
const { makeGuildStore } = require('./guildStore');

const store = makeGuildStore('mod-cases.json', () => ({ nextId: 1, cases: [] }));
const MAX_CASES_KEPT = 500; // per server — plenty for lookback, keeps the store from growing forever

function recordCase(guildId, { type, targetTag, moderatorTag, reason }) {
  const state = store.get(guildId);
  const id = state.nextId++;
  state.cases.push({
    id,
    type,
    targetTag: targetTag || null,
    moderatorTag: moderatorTag || null,
    reason: reason || null,
    timestamp: Date.now(),
  });
  if (state.cases.length > MAX_CASES_KEPT) state.cases.splice(0, state.cases.length - MAX_CASES_KEPT);
  store.save();
  return id;
}

function getCase(guildId, id) {
  const numericId = Number(id);
  if (!Number.isInteger(numericId)) return null;
  return store.get(guildId).cases.find((c) => c.id === numericId) || null;
}

module.exports = { recordCase, getCase };
