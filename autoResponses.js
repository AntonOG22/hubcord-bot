// Per-server keyword auto-replies. Without this, a trigger word set up on one server
// would fire the bot's reply on every other server it's in too.
const { makeGuildStore } = require('./guildStore');

const store = makeGuildStore('autoresponses-state.json', () => []); // guildId -> [{id, trigger, reply}]

function setupAutoResponses(client) {
  client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;
    const content = message.content.toLowerCase();

    const responses = store.get(message.guild.id);
    const match = responses.find((r) => content.includes(r.trigger.toLowerCase()));
    if (!match) return;

    try {
      await message.reply(match.reply);
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
