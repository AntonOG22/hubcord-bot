// Per-server message-based leveling system. Each server keeps its own XP totals for
// the same user — someone active on two servers the bot manages doesn't share a level
// between them. Cooldown to prevent farming is also tracked per server+user.
const path = require('path');
const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { makeGuildStore } = require('./guildStore');
const features = require('./features');
const guildConfig = require('./guildConfig');
const levelRoles = require('./levelRoles');

const store = makeGuildStore('xp-state.json', () => ({})); // guildId -> { userId: { xp, level, tag } }
const COOLDOWN_MS = 60 * 1000; // text-chat cooldown, prevents spam-farming
const MIN_XP = 15;
const MAX_XP = 25;
const VOICE_XP_INTERVAL_MS = 60 * 1000; // grants voice XP once per minute of being connected

const LEVELUP_ICON_PATH = path.join(__dirname, 'assets', 'levelup-icon.webp');
const LEVELUP_ICON_NAME = 'levelup-icon.webp';

let lastGain = {}; // `${guildId}:${userId}` -> timestamp, text-chat cooldown only

// The XP needed to go from `level` to `level + 1`. Quadratic, so the *increase*
// per level (the actual "how much harder is this level than the last one")
// itself grows with level too — level 2 asks for noticeably more than level 1
// did, level 50 asks for a lot more than level 49 did. Tuned to feel steadily
// grindier at high levels without being an outright wall (no exponential
// blow-up) — e.g. level 10 needs 1650 XP for that level, level 50 needs
// 23850, level 100 needs 87600.
function xpForLevel(level) {
  return 8 * level * level + 75 * level + 100;
}

function randomXpGain() {
  return Math.floor(Math.random() * (MAX_XP - MIN_XP + 1)) + MIN_XP;
}

// Adds XP to a user's stored total and levels them up as many times as the new
// total covers. Returns the new level if they leveled up at least once this
// call, otherwise null — shared by both the text-message and voice-tick paths.
function grantXp(guildId, userId, tag, amount) {
  const users = store.get(guildId);
  const user = users[userId] || { xp: 0, level: 0, tag };
  user.xp += amount;
  user.tag = tag;

  let newLevel = null;
  while (user.xp >= xpForLevel(user.level)) {
    user.level += 1;
    newLevel = user.level;
  }

  users[userId] = user;
  store.save();
  return newLevel;
}

// Posts the level-up embed and syncs the member's tier role (if that optional
// feature is on). `fallbackChannel` is the channel a text message came in on —
// used only when no level-up channel is configured, so text level-ups never
// silently go nowhere. Voice-triggered level-ups have no such channel, so they
// fall back to the configured channel or the server's system channel instead.
async function announceLevelUp(guild, member, level, fallbackChannel = null) {
  try {
    const levelUpChannelId = guildConfig.getConfig(guild.id).levelUpChannelId;
    let target = fallbackChannel;
    if (levelUpChannelId) {
      try {
        const configured = await guild.channels.fetch(levelUpChannelId);
        if (configured?.isTextBased()) target = configured;
      } catch {
        // configured channel is gone/unfetchable — keep whatever fallback we had
      }
    }
    if (!target) target = guild.systemChannel;

    if (target) {
      const embed = new EmbedBuilder()
        .setColor(0x57f287)
        .setAuthor({ name: member.displayName, iconURL: member.displayAvatarURL() })
        .setThumbnail(`attachment://${LEVELUP_ICON_NAME}`)
        .setDescription(`You reached XP level **${level}**, ${member}!`)
        .setFooter({ text: 'Earn more XP by sending messages & talking in voice channels' });
      const attachment = new AttachmentBuilder(LEVELUP_ICON_PATH, { name: LEVELUP_ICON_NAME });
      // The mention inside the embed's description doesn't ping (Discord never
      // notifies for mentions rendered inside embeds) — this extra plain-text
      // `content` above it is what actually pings the member.
      await target.send({ content: `${member}`, embeds: [embed], files: [attachment] });
    }
  } catch (err) {
    console.error('Could not send level-up message:', err.message);
  }

  await levelRoles.syncMemberLevelRole(guild, member, level).catch((err) => {
    console.error('Could not sync level role:', err.message);
  });
}

function setupXp(client, { excludedChannelIds = [] } = {}) {
  client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;
    if (!features.isEnabled(message.guild.id, 'xp')) return;
    if (excludedChannelIds.includes(message.channelId)) return;

    const key = `${message.guild.id}:${message.author.id}`;
    const now = Date.now();
    if (now - (lastGain[key] || 0) < COOLDOWN_MS) return;
    lastGain[key] = now;

    const newLevel = grantXp(message.guild.id, message.author.id, message.author.tag, randomXpGain());
    if (newLevel && message.member) {
      await announceLevelUp(message.guild, message.member, newLevel, message.channel);
    }
  });

  // Voice XP: once a minute, every non-bot member currently sitting in a
  // (non-AFK) voice channel earns the same XP range as chatting does — being
  // active in voice is worth just as much as being active in text. Skips
  // anyone deafened (self or server) and channels with fewer than 2 real
  // members — otherwise someone could just sit alone/deafened in an empty VC
  // and farm levels for free with zero actual activity.
  setInterval(() => {
    for (const guild of client.guilds.cache.values()) {
      if (!features.isEnabled(guild.id, 'xp')) continue;
      const afkChannelId = guild.afkChannelId;

      for (const channel of guild.channels.cache.values()) {
        if (!channel.isVoiceBased() || channel.id === afkChannelId) continue;
        const realMembers = [...channel.members.values()].filter((m) => !m.user.bot);
        if (realMembers.length < 2) continue;

        for (const member of realMembers) {
          if (member.voice.deaf || member.voice.selfDeaf) continue;
          const newLevel = grantXp(guild.id, member.id, member.user.tag, randomXpGain());
          if (newLevel) {
            announceLevelUp(guild, member, newLevel).catch((err) => {
              console.error('Voice level-up announcement failed:', err.message);
            });
          }
        }
      }
    }
  }, VOICE_XP_INTERVAL_MS);

  console.log('XP/leveling system active (per-server, text + voice).');
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
