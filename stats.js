// Per-server insights: per-channel message counts (today), a daily member-count
// snapshot for a growth chart, and a most-active-chatters leaderboard. Traffic on one
// server never gets mixed into another server's numbers.
const { makeGuildStore } = require('./guildStore');

const DAY_MS = 24 * 60 * 60 * 1000;

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

const store = makeGuildStore('stats-state.json', () => ({
  channelCounts: {},
  memberHistory: [],
  userMessageCounts: {},
  day: todayKey(),
}));

function ensureFreshDay(state) {
  if (state.day !== todayKey()) {
    state.channelCounts = {};
    state.day = todayKey();
  }
}

function setupStats(client) {
  client.on('messageCreate', (message) => {
    if (message.author.bot || !message.guild) return;

    const state = store.get(message.guild.id);
    ensureFreshDay(state);

    const channelName = message.channel.name || message.channelId;
    state.channelCounts[channelName] = (state.channelCounts[channelName] || 0) + 1;

    const tag = message.author.tag;
    state.userMessageCounts[tag] = (state.userMessageCounts[tag] || 0) + 1;

    store.save();
  });

  // Daily member-count snapshot for every guild the bot is in, for a growth chart
  setInterval(() => {
    let changed = false;
    for (const guild of client.guilds.cache.values()) {
      const state = store.get(guild.id);
      const last = state.memberHistory[state.memberHistory.length - 1];
      if (!last || Date.now() - new Date(last.time).getTime() > DAY_MS) {
        state.memberHistory.push({ time: new Date().toISOString(), count: guild.memberCount });
        if (state.memberHistory.length > 90) state.memberHistory.shift();
        changed = true;
      }
    }
    if (changed) store.save();
  }, 60 * 60 * 1000); // check hourly, only actually snapshots once/day per guild

  // Take one snapshot immediately on startup so the chart isn't empty
  client.once('ready', () => {
    for (const guild of client.guilds.cache.values()) {
      const state = store.get(guild.id);
      state.memberHistory.push({ time: new Date().toISOString(), count: guild.memberCount });
    }
    store.save();
  });

  console.log('Server stats tracking active (per-server).');
}

function getChannelCounts(guildId) {
  const state = store.get(guildId);
  ensureFreshDay(state);
  return Object.entries(state.channelCounts)
    .map(([channel, count]) => ({ channel, count }))
    .sort((a, b) => b.count - a.count);
}

function getMemberHistory(guildId) {
  return store.get(guildId).memberHistory;
}

function getMostActive(guildId, limit = 10) {
  return Object.entries(store.get(guildId).userMessageCounts)
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

function getNewMembersThisWeek(guild) {
  const weekAgo = Date.now() - 7 * DAY_MS;
  return guild.members.cache.filter((m) => m.joinedTimestamp && m.joinedTimestamp > weekAgo).size;
}

module.exports = { setupStats, getChannelCounts, getMemberHistory, getMostActive, getNewMembersThisWeek };
