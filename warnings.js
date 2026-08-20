// Per-server warnings. The same person warned on two different servers the bot
// manages gets two independent warning counts, not a shared one.
const { makeGuildStore } = require('./guildStore');
const { sendModerationDm } = require('./moderationDm');

const store = makeGuildStore('warnings-state.json', () => ({})); // guildId -> { userId: [{reason,by,time}] }
const AUTO_TIMEOUT_THRESHOLD = 3;
const AUTO_TIMEOUT_MINUTES = 30;

// The one place every warning in the app flows through (dashboard, chat
// commands, rule-based automod, AI automod all call this) — so the DM
// notice only needs to live here once to cover all of them.
async function addWarning(client, guild, userId, reason, byTag) {
  const warningsForGuild = store.get(guild.id);
  const list = warningsForGuild[userId] || [];
  list.push({ reason, by: byTag, time: new Date().toISOString() });
  warningsForGuild[userId] = list;
  store.save();

  let member;
  try {
    member = await guild.members.fetch(userId);
  } catch {
    member = null; // they may have already left — DM/auto-timeout below just no-ops then
  }

  if (member) await sendModerationDm(client, member, guild, { action: 'warn', reason, moderatorTag: byTag });

  if (list.length >= AUTO_TIMEOUT_THRESHOLD && list.length % AUTO_TIMEOUT_THRESHOLD === 0) {
    try {
      if (!member) member = await guild.members.fetch(userId);
      const autoReason = `Auto-timeout: reached ${list.length} warnings`;
      await member.timeout(AUTO_TIMEOUT_MINUTES * 60 * 1000, autoReason);
      await sendModerationDm(client, member, guild, {
        action: 'timeout',
        reason: autoReason,
        moderatorTag: 'Auto-Moderation',
        durationText: `${AUTO_TIMEOUT_MINUTES} minutes`,
      });
      return { warnings: list, autoTimedOut: true };
    } catch (err) {
      console.error('Auto-timeout after warning failed:', err.message);
    }
  }

  return { warnings: list, autoTimedOut: false };
}

function getWarnings(guildId, userId) {
  return store.get(guildId)[userId] || [];
}

function clearWarnings(guildId, userId) {
  delete store.get(guildId)[userId];
  store.save();
}

function getAllWarned(guildId) {
  return Object.entries(store.get(guildId)).map(([userId, list]) => ({ userId, count: list.length }));
}

module.exports = { addWarning, getWarnings, clearWarnings, getAllWarned, AUTO_TIMEOUT_THRESHOLD };
