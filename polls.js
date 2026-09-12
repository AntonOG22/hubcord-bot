// Timed reaction polls: like !poll, but this one closes itself after a set
// duration and edits its own message in place with the final vote tally
// instead of just sitting there forever. Uses the same durable-timer pattern
// as giveaways.js — the end time is persisted and rescheduled on startup,
// since a bare in-memory setTimeout alone wouldn't survive a restart for
// anything running more than a few minutes.
const fs = require('fs');
const path = require('path');
const { EmbedBuilder } = require('discord.js');
const { brandFooter } = require('./brand');

const STATE_FILE = path.join(__dirname, 'timed-polls-state.json');
const NUMBER_EMOJI = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

let polls = {}; // messageId -> { channelId, guildId, question, options, endsAt, ended }
let clientRef = null;
const timers = new Map();

function load() {
  try {
    polls = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    polls = {};
  }
}

function save() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(polls, null, 2));
}

function buildEmbed(poll, results) {
  const embed = new EmbedBuilder()
    .setColor(poll.ended ? 0x99aab5 : 0x5865f2)
    .setFooter(brandFooter(clientRef, poll.guildId))
    .setTimestamp();

  if (poll.ended) {
    const total = results.reduce((sum, r) => sum + r.count, 0);
    const lines = results.map((r, i) => {
      const pct = total > 0 ? Math.round((r.count / total) * 100) : 0;
      return `${NUMBER_EMOJI[i]} ${r.option} — **${r.count}** vote${r.count === 1 ? '' : 's'} (${pct}%)`;
    });
    embed.setTitle(`📊 Poll ended: ${poll.question}`).setDescription(lines.join('\n\n') || 'No votes.');
  } else {
    const optionLines = poll.options.map((o, i) => `${NUMBER_EMOJI[i]} ${o}`).join('\n\n');
    embed.setTitle(`📊 ${poll.question}`).setDescription(`${optionLines}\n\nEnds <t:${Math.floor(poll.endsAt / 1000)}:R>`);
  }
  return embed;
}

async function endPoll(messageId) {
  const poll = polls[messageId];
  if (!poll || poll.ended) return;

  try {
    const channel = await clientRef.channels.fetch(poll.channelId);
    const message = await channel.messages.fetch(messageId);

    const results = poll.options.map((option, i) => {
      const reaction = message.reactions.cache.get(NUMBER_EMOJI[i]);
      // -1 for the bot's own reaction it added when posting the poll
      const count = reaction ? Math.max(0, reaction.count - 1) : 0;
      return { option, count };
    });

    poll.ended = true;
    save();

    await message.edit({ embeds: [buildEmbed(poll, results)] });
  } catch (err) {
    console.error('Failed to end timed poll:', err.message);
  }

  timers.delete(messageId);
}

function scheduleEnd(messageId, delayMs) {
  const clamped = Math.min(delayMs, 2147483647); // setTimeout's own max delay
  timers.set(messageId, setTimeout(() => endPoll(messageId), clamped));
}

function setupPolls(client) {
  clientRef = client;
  load();

  client.once('ready', () => {
    // Reschedule anything that was still running when the bot last restarted
    for (const [messageId, poll] of Object.entries(polls)) {
      if (poll.ended) continue;
      const remaining = poll.endsAt - Date.now();
      if (remaining <= 0) endPoll(messageId);
      else scheduleEnd(messageId, remaining);
    }
  });

  console.log('Timed polls active.');
}

async function createTimedPoll(channelId, guildId, question, options, durationMinutes) {
  if (options.length < 2 || options.length > NUMBER_EMOJI.length) {
    throw new Error(`Provide between 2 and ${NUMBER_EMOJI.length} options.`);
  }
  const channel = await clientRef.channels.fetch(channelId);
  const endsAt = Date.now() + durationMinutes * 60 * 1000;
  const poll = { channelId, guildId, question, options, endsAt, ended: false };

  const message = await channel.send({ embeds: [buildEmbed(poll, [])] });
  for (let i = 0; i < options.length; i++) await message.react(NUMBER_EMOJI[i]);

  polls[message.id] = poll;
  save();
  scheduleEnd(message.id, durationMinutes * 60 * 1000);

  return message.id;
}

module.exports = { setupPolls, createTimedPoll };
