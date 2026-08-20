// Per-server keyword auto-replies. Without this, a trigger word set up on one server
// would fire the bot's reply on every other server it's in too.
const { makeGuildStore } = require('./guildStore');
const features = require('./features');
const { fillPlaceholders } = require('./placeholders');
const { applyColorCodes } = require('./textFormatting');

const store = makeGuildStore('autoresponses-state.json', () => []); // guildId -> [{id, trigger, reply}]

function setupAutoResponses(client) {
  client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;
    if (!features.isEnabled(message.guild.id, 'autoResponses')) return;
    const content = message.content.toLowerCase();

    const responses = store.get(message.guild.id);
    const match = responses.find((r) => content.includes(r.trigger.toLowerCase()));
    if (!match) return;

    try {
      // Auto-responses always send as plain content, never an embed — so
      // §colors work here (applyColorCodes), but "label"(url) link masking
      // never would, and is deliberately left alone rather than converted.
      const filled = fillPlaceholders(match.reply, { member: message.member, channel: message.channel });
      await message.reply(applyColorCodes(filled));
    } catch (err) {
      console.error('Auto-response send failed:', err.message);
    }
  });

  console.log('Auto-responses active (per-server).');
}

function addResponse(guildId, trigger, reply) {
  const responses = store.get(guildId);
  const entry = { id: Date.now().toString(36), trigger, reply };
  responses.push(entry);
  store.save();
  return entry;
}

function removeResponse(guildId, id) {
  const responses = store.get(guildId).filter((r) => r.id !== id);
  store.set(guildId, responses);
}

function listResponses(guildId) {
  return store.get(guildId);
}

module.exports = { setupAutoResponses, addResponse, removeResponse, listResponses };
