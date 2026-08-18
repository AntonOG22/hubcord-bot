// Per-server message-based leveling system. Each server keeps its own XP totals for
// the same user — someone active on two servers the bot manages doesn't share a level
// between them. Cooldown to prevent farming is also tracked per server+user.
const { makeGuildStore } = require('./guildStore');

const store = makeGuildStore('xp-state.json', () => ({})); // guildId -> { userId: { xp, level, tag } }
const COOLDOWN_MS = 60 * 1000;
const MIN_XP = 15;
const MAX_XP = 25;

let lastGain = {}; // `${guildId}:${userId}` -> timestamp

function xpForLevel(level) {
  return 5 * level * level + 50 * level + 100;
}

function setupXp(client, { excludedChannelIds = [] } = {}) {
  client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;
    if (excludedChannelIds.includes(message.channelId)) return;

    const key = `${message.guild.id}:${message.author.id}`;
    const now = Date.now();
    if (now - (lastGain[key] || 0) < COOLDOWN_MS) return;
    lastGain[key] = now;

    const users = store.get(message.guild.id);
    const gained = Math.floor(Math.random() * (MAX_XP - MIN_XP + 1)) + MIN_XP;
    const user = users[message.author.id] || { xp: 0, level: 0, tag: message.author.tag };
    user.xp += gained;
    user.tag = message.author.tag;

    let leveledUp = false;
    while (user.xp >= xpForLevel(user.level)) {
      user.level += 1;
      leveledUp = true;
    }

    users[message.author.id] = user;
    store.save();

    if (leveledUp) {
      try {
        await message.channel.send(`🎉 ${message.author} just reached **Level ${user.level}**!`);
      } catch (err) {
        console.error('Could not send level-up message:', err.message);
      }
    }
  });

  console.log('XP/leveling system active (per-server).');
}

function getLeaderboard(guildId, limit = 10) {
  const users = store.get(guildId);
  return Object.entries(users)
    .map(([userId, u]) => ({ userId, ...u }))
    .sort((a, b) => b.xp - a.xp)
    .slice(0, limit);
}

function getUserXp(guildId, userId) {
  return store.get(guildId)[userId] || { xp: 0, level: 0 };
}

function addXp(guildId, userId, tag, amount) {
  const users = store.get(guildId);
  const user = users[userId] || { xp: 0, level: 0, tag };
  user.xp = Math.max(0, user.xp + amount);
  user.tag = tag || user.tag;
  while (user.xp >= xpForLevel(user.level)) user.level += 1;
  users[userId] = user;
  store.save();
  return user;
}

function setLevel(guildId, userId, tag, level) {
  const users = store.get(guildId);
  const user = users[userId] || { xp: 0, level: 0, tag };
  user.level = level;
  user.xp = level > 0 ? xpForLevel(level - 1) : 0;
  user.tag = tag || user.tag;
  users[userId] = user;
  store.save();
  return user;
}

module.exports = { setupXp, getLeaderboard, getUserXp, xpForLevel, addXp, setLevel };
