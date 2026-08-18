// Per-server counting minigame. Each server picks its own channel (configurable from
// the dashboard's Server tab, defaulting to COUNTING_CHANNEL_ID from .env on the
// original server) and gets its own independent count/state.
const { makeGuildStore } = require('./guildStore');
const guildConfig = require('./guildConfig');

const store = makeGuildStore('counting-state.json', () => ({ currentCount: 1, lastUserId: null }));

function setupCounting(client) {
  client.on('messageCreate', async (message) => {
    if (!message.guild || message.author.bot) return;

    const channelId = guildConfig.getConfig(message.guild.id).countingChannelId;
    if (!channelId || message.channelId !== channelId) return;

    const content = message.content.trim();
    if (!/^\d+$/.test(content)) return; // only pure numbers count as a move

    const number = parseInt(content, 10);
    const state = store.get(message.guild.id);

    // Rule 1: the same person can't count twice in a row
    if (message.author.id === state.lastUserId) {
      store.set(message.guild.id, { currentCount: 1, lastUserId: null });
      await message.react('❌').catch(() => {});
      await message.channel.send(`❌ ${message.author}, you can't count twice in a row! Back to **1**.`);
      return;
    }

    // Rule 2: the number must be exactly the next expected number
    if (number !== state.currentCount) {
      const expected = state.currentCount;
      store.set(message.guild.id, { currentCount: 1, lastUserId: null });
      await message.react('❌').catch(() => {});
      await message.channel.send(
        `❌ ${message.author} broke the count! Expected **${expected}**, but got **${number}**. Back to **1**.`
      );
      return;
    }

    // Correct!
    await message.react('✅').catch(() => {});
    store.set(message.guild.id, { currentCount: number + 1, lastUserId: message.author.id });
  });

  console.log('Counting game active (per-server channel, configurable from the dashboard).');
}

function getCountingState(guildId) {
  return store.get(guildId);
}

function resetCountingState(guildId) {
  const fresh = { currentCount: 1, lastUserId: null };
  store.set(guildId, fresh);
  return fresh;
}

module.exports = { setupCounting, getCountingState, resetCountingState };
