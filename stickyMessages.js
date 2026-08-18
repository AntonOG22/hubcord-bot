// A "sticky" message stays at the bottom of a channel: whenever a new message comes
// in, the old sticky gets deleted and reposted fresh underneath it.
const fs = require('fs');
const path = require('path');
const features = require('./features');

const STATE_FILE = path.join(__dirname, 'sticky-state.json');

let stickies = {}; // channelId -> { text, messageId }

function load() {
  try {
    stickies = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    stickies = {};
  }
}

function save() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(stickies, null, 2));
}

function setupSticky(client) {
  load();

  client.on('messageCreate', async (message) => {
    const sticky = stickies[message.channelId];
    if (!sticky) return;
    if (message.guild && !features.isEnabled(message.guild.id, 'stickyMessages')) return;
    if (message.id === sticky.messageId) return; // don't react to our own repost

    try {
      if (sticky.messageId) {
        const old = await message.channel.messages.fetch(sticky.messageId).catch(() => null);
        if (old) await old.delete().catch(() => {});
      }
      const posted = await message.channel.send({ content: `📌 ${sticky.text}` });
      stickies[message.channelId] = { text: sticky.text, messageId: posted.id };
      save();
    } catch (err) {
      console.error('Sticky message repost failed:', err.message);
    }
  });

  console.log('Sticky message tracking active.');
}

async function setSticky(client, channelId, text) {
  const channel = await client.channels.fetch(channelId);
  const posted = await channel.send({ content: `📌 ${text}` });
  stickies[channelId] = { text, messageId: posted.id };
  save();
}

async function removeSticky(client, channelId) {
  const sticky = stickies[channelId];
  if (!sticky) return;
  try {
    const channel = await client.channels.fetch(channelId);
    const old = await channel.messages.fetch(sticky.messageId).catch(() => null);
    if (old) await old.delete().catch(() => {});
  } catch {
    // channel or message already gone, nothing to clean up
  }
  delete stickies[channelId];
  save();
}

function listStickies() {
  return Object.entries(stickies).map(([channelId, s]) => ({ channelId, text: s.text }));
}

module.exports = { setupSticky, setSticky, removeSticky, listStickies };
