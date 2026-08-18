const { EmbedBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');
const guildConfig = require('./guildConfig');
const { t } = require('./i18n');

const STATE_FILE = path.join(__dirname, 'giveaways-state.json');
const GIVEAWAY_EMOJI = '🎉';

let giveaways = {}; // messageId -> { channelId, prize, winnerCount, endsAt, ended }
let clientRef = null;
const timers = new Map();

function load() {
  try {
    giveaways = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    giveaways = {};
  }
}

function save() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(giveaways, null, 2));
}

function buildEmbed(guildId, prize, winnerCount, endsAt, ended, winners) {
  const embed = new EmbedBuilder()
    .setTitle(`🎉 Giveaway: ${prize}`)
    .setColor(ended ? 0x99aab5 : 0x57f287)
    .setTimestamp();

  if (ended) {
    embed.setDescription(
      winners.length > 0
        ? t(guildId, 'giveaway.winners', { plural: winners.length > 1 ? 's' : '', list: winners.map((w) => `<@${w}>`).join(', ') })
        : t(guildId, 'giveaway.noWinners')
    );
  } else {
    embed.setDescription(
      t(guildId, 'giveaway.active', { count: winnerCount, endsAt: `<t:${Math.floor(endsAt / 1000)}:R>` })
    );
  }
  return embed;
}

async function endGiveaway(messageId) {
  const giveaway = giveaways[messageId];
  if (!giveaway || giveaway.ended) return;

  try {
    const channel = await clientRef.channels.fetch(giveaway.channelId);
    const message = await channel.messages.fetch(messageId);
    const reaction = message.reactions.cache.get(GIVEAWAY_EMOJI);

    let winners = [];
    if (reaction) {
      const users = await reaction.users.fetch();
      const entrants = [...users.values()].filter((u) => !u.bot).map((u) => u.id);
      const shuffled = entrants.sort(() => Math.random() - 0.5);
      winners = shuffled.slice(0, giveaway.winnerCount);
    }

    giveaway.ended = true;
    giveaway.winners = winners;
    save();

    const guildId = channel.guild?.id;
    await message.edit({ embeds: [buildEmbed(guildId, giveaway.prize, giveaway.winnerCount, giveaway.endsAt, true, winners)] });

    if (winners.length > 0) {
      await channel.send(
        t(guildId, 'giveaway.congrats', { list: winners.map((w) => `<@${w}>`).join(', '), prize: giveaway.prize })
      );
    } else {
      await channel.send(t(guildId, 'giveaway.noEntries', { prize: giveaway.prize }));
    }
  } catch (err) {
    console.error('Failed to end giveaway:', err.message);
  }

  timers.delete(messageId);
}

function scheduleEnd(messageId, delayMs) {
  const clamped = Math.min(delayMs, 2147483647); // setTimeout max delay
  const timer = setTimeout(() => endGiveaway(messageId), clamped);
  timers.set(messageId, timer);
}

function setupGiveaways(client) {
  clientRef = client;
  load();

  client.once('ready', () => {
    // Reschedule anything that was still running when the bot last restarted
    for (const [messageId, g] of Object.entries(giveaways)) {
      if (g.ended) continue;
      const remaining = g.endsAt - Date.now();
      if (remaining <= 0) {
        endGiveaway(messageId);
      } else {
        scheduleEnd(messageId, remaining);
      }
    }
  });

  console.log('Giveaway system active.');
}

async function createGiveaway(channelId, prize, durationMinutes, winnerCount) {
  const channel = await clientRef.channels.fetch(channelId);
  const endsAt = Date.now() + durationMinutes * 60 * 1000;
  const pingRoleId = channel.guild ? guildConfig.getConfig(channel.guild.id).giveawayPingRoleId : null;

  const message = await channel.send({
    content: pingRoleId ? `<@&${pingRoleId}>` : undefined,
    embeds: [buildEmbed(channel.guild?.id, prize, winnerCount, endsAt, false, [])],
    allowedMentions: pingRoleId ? { roles: [pingRoleId] } : undefined,
  });
  await message.react(GIVEAWAY_EMOJI);

  giveaways[message.id] = { channelId, prize, winnerCount, endsAt, ended: false };
  save();
  scheduleEnd(message.id, durationMinutes * 60 * 1000);

  return message.id;
}

function listGiveaways() {
  return Object.entries(giveaways).map(([messageId, g]) => ({ messageId, ...g }));
}

async function endGiveawayNow(messageId) {
  const timer = timers.get(messageId);
  if (timer) clearTimeout(timer);
  await endGiveaway(messageId);
}

module.exports = { setupGiveaways, createGiveaway, listGiveaways, endGiveawayNow };
