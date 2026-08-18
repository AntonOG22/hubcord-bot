// Per-server warnings. The same person warned on two different servers the bot
// manages gets two independent warning counts, not a shared one.
const { makeGuildStore } = require('./guildStore');

const store = makeGuildStore('warnings-state.json', () => ({})); // guildId -> { userId: [{reason,by,time}] }
const AUTO_TIMEOUT_THRESHOLD = 3;
const AUTO_TIMEOUT_MINUTES = 30;

async function addWarning(client, guild, userId, reason, byTag) {
  const warningsForGuild = store.get(guild.id);
  const list = warningsForGuild[userId] || [];
  list.push({ reason, by: byTag, time: new Date().toISOString() });
  warningsForGuild[userId] = list;
  store.save();

  if (list.length >= AUTO_TIMEOUT_THRESHOLD && list.length % AUTO_TIMEOUT_THRESHOLD === 0) {
    try {
      const member = await guild.members.fetch(userId);
      await member.timeout(
        AUTO_TIMEOUT_MINUTES * 60 * 1000,
        `Auto-timeout: reached ${list.length} warnings`
      );
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
