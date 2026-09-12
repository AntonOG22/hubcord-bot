// A "sticky" message stays at the bottom of a channel: whenever a new message comes
// in, the old sticky gets deleted and reposted fresh underneath it.
const fs = require('fs');
const path = require('path');
const features = require('./features');

const STATE_FILE = path.join(__dirname, 'sticky-state.json');

let stickies = {}; // channelId -> { text, messageId }

// A repost isn't instant (fetch old -> delete old -> send new, each a network
// round-trip), so without serializing this, a burst of messages arriving
// close together used to start several overlapping reposts at once — each
// reading the same stale messageId, each posting its own duplicate, with only
// the last one to finish ever getting remembered. That's what caused the
// "spams the channel and can't be removed anymore" bug: orphaned duplicate
// stickies nothing pointed to anymore. Now at most one repost runs per
// channel at a time; anything that arrives while one is in flight just marks
// that another repost is owed, collapsing a whole burst into exactly one.
let pendingRepost = {}; // channelId -> boolean
let queuedRepost = {}; // channelId -> boolean

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

async function repost(channelId, channel) {
  pendingRepost[channelId] = true;
  try {
    do {
      queuedRepost[channelId] = false;
      const sticky = stickies[channelId];
      if (!sticky) break; // removed while a previous iteration was working

      if (sticky.messageId) {
        const old = await channel.messages.fetch(sticky.messageId).catch(() => null);
        if (old) await old.delete().catch(() => {});
      }
      const posted = await channel.send({ content: `📌 ${sticky.text}` });

      if (!stickies[channelId]) {
        // Removed mid-repost (e.g. !stickyremove ran while we were posting) —
        // clean up the message we just posted instead of leaving an orphan.
        await posted.delete().catch(() => {});
        break;
      }
      stickies[channelId] = { text: sticky.text, messageId: posted.id };
      save();
    } while (queuedRepost[channelId]);
  } catch (err) {
    console.error('Sticky message repost failed:', err.message);
  } finally {
    pendingRepost[channelId] = false;
  }
}

function setupSticky(client) {
  load();

  client.on('messageCreate', async (message) => {
    if (message.author?.bot) return; // never treat our own repost (or any other bot's message) as new activity
    const sticky = stickies[message.channelId];
    if (!sticky) return;
    if (message.guild && !features.isEnabled(message.guild.id, 'stickyMessages')) return;

    if (pendingRepost[message.channelId]) {
      // Already reposting for this channel — it'll land at the bottom once
      // that finishes, so this message doesn't need its own repost too.
      queuedRepost[message.channelId] = true;
      return;
    }

    await repost(message.channelId, message.channel);
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
  // Clear the entry first so a repost already in flight for this channel
  // (see `repost` above) sees it's gone and cleans up after itself instead
  // of recreating the sticky right after we remove it.
  delete stickies[channelId];
  save();
  try {
    const channel = await client.channels.fetch(channelId);
    const old = await channel.messages.fetch(sticky.messageId).catch(() => null);
    if (old) await old.delete().catch(() => {});
  } catch {
    // channel or message already gone, nothing to clean up
  }
}

function listStickies() {
  return Object.entries(stickies).map(([channelId, s]) => ({ channelId, text: s.text }));
}

module.exports = { setupSticky, setSticky, removeSticky, listStickies };
