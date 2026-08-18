// Per-server auto-moderation: link filter, invite filter, caps spam, mention spam,
// duplicate-message spam, and a new-account age gate. Every server the bot manages
// gets its own independent on/off switches and its own alerts channel.
const { makeGuildStore } = require('./guildStore');
const guildConfig = require('./guildConfig');

const DEFAULTS = () => ({
  linkFilter: false,
  linkWhitelist: ['tenor.com', 'youtube.com', 'youtu.be', 'imgur.com', 'x.com', 'twitter.com'],
  inviteFilter: false,
  capsFilter: false,
  mentionSpamFilter: false,
  duplicateSpamFilter: false,
  accountAgeGateDays: 0, // 0 = disabled
});

const store = makeGuildStore('automod-state.json', DEFAULTS);
let clientRef = null;

const recentMessages = new Map(); // `${guildId}:${userId}` -> { text, count, lastTime }

async function flag(guildId, channel, member, reason) {
  const modLogsChannelId = guildConfig.getConfig(guildId).modLogsChannelId;
  if (!modLogsChannelId) return;
  try {
    const modLog = await clientRef.channels.fetch(modLogsChannelId);
    await modLog.send(`🛡️ Auto-mod: ${reason} — ${member} in ${channel}`);
  } catch (err) {
    console.error('Auto-mod could not post to mod-logs:', err.message);
  }
}

const URL_RE = /https?:\/\/([^\s/]+)/gi;
const INVITE_RE = /(discord\.gg|discord\.com\/invite)\/\S+/i;

function setupAutomod(client) {
  clientRef = client;

  client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;
    if (!message.member || message.member.permissions.has('ManageMessages')) return; // staff exempt

    const config = store.get(message.guild.id);
    const content = message.content;

    if (config.inviteFilter && INVITE_RE.test(content)) {
      await message.delete().catch(() => {});
      await flag(message.guild.id, message.channel, message.author, 'blocked a Discord invite link');
      return;
    }

    if (config.linkFilter) {
      const matches = [...content.matchAll(URL_RE)];
      const bad = matches.find((m) => !config.linkWhitelist.some((allowed) => m[1].includes(allowed)));
      if (bad) {
        await message.delete().catch(() => {});
        await flag(message.guild.id, message.channel, message.author, `blocked a link (${bad[1]})`);
        return;
      }
    }

    if (config.capsFilter && content.length >= 12) {
      const letters = content.replace(/[^a-zA-Z]/g, '');
      const upper = content.replace(/[^A-Z]/g, '');
      if (letters.length > 8 && upper.length / letters.length > 0.7) {
        await message.delete().catch(() => {});
        await flag(message.guild.id, message.channel, message.author, 'blocked excessive caps');
        return;
      }
    }

    if (config.mentionSpamFilter && message.mentions.users.size + message.mentions.roles.size >= 5) {
      await message.delete().catch(() => {});
      await flag(message.guild.id, message.channel, message.author, 'blocked mass mentions');
      return;
    }

    if (config.duplicateSpamFilter) {
      const key = `${message.guild.id}:${message.author.id}`;
      const prev = recentMessages.get(key);
      const now = Date.now();
      if (prev && prev.text === content && now - prev.lastTime < 10000) {
        const count = prev.count + 1;
        recentMessages.set(key, { text: content, count, lastTime: now });
        if (count >= 3) {
          await message.delete().catch(() => {});
          await flag(message.guild.id, message.channel, message.author, 'blocked repeated spam messages');
        }
        return;
      }
      recentMessages.set(key, { text: content, count: 1, lastTime: now });
    }
  });

  client.on('guildMemberAdd', async (member) => {
    const config = store.get(member.guild.id);
    if (!config.accountAgeGateDays) return;
    const ageDays = (Date.now() - member.user.createdTimestamp) / (1000 * 60 * 60 * 24);
    if (ageDays < config.accountAgeGateDays) {
      await flag(
        member.guild.id,
        { toString: () => 'server join' },
        member.user,
        `new account flagged (${Math.floor(ageDays)} days old, threshold is ${config.accountAgeGateDays})`
      );
    }
  });

  console.log('Auto-moderation active (per-server settings).');
}

function getConfig(guildId) {
  return store.get(guildId);
}

function updateConfig(guildId, patch) {
  const config = Object.assign(store.get(guildId), patch);
  store.save();
  return config;
}

module.exports = { setupAutomod, getConfig, updateConfig };
