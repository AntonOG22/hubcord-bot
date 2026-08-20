// Per-server rule-based auto-moderation. Every filter below is independent
// (its own on/off switch), and every violation goes through one shared
// punishment pipeline: either a single configurable "default punishment"
// (delete / warn / timeout / kick / ban) or, if escalation is turned on, a
// per-user ladder that gets stricter the more that person violates rules
// within a rolling window. Ignore lists (roles/channels) are also shared
// with the AI automod module (aiAutomod.js reads the same config here) so
// staff only have to set exemptions in one place.
const { makeGuildStore, safeAssign } = require('./guildStore');
const guildConfig = require('./guildConfig');
const features = require('./features');
const warnings = require('./warnings');
const { sendModerationDm } = require('./moderationDm');

const DEFAULTS = () => ({
  // existing filters
  linkFilter: false,
  linkWhitelist: ['tenor.com', 'youtube.com', 'youtu.be', 'imgur.com', 'x.com', 'twitter.com'],
  inviteFilter: false,
  capsFilter: false,
  mentionSpamFilter: false,
  duplicateSpamFilter: false,
  accountAgeGateDays: 0, // 0 = disabled

  // word filter
  wordFilterEnabled: false,
  bannedWords: [], // plain words/phrases, case-insensitive, bypass-normalized (leetspeak/spacing)

  // link blacklist + built-in scam domain protection (separate from the
  // whitelist-based linkFilter above — this blocks specific bad domains
  // even if linkFilter itself is off)
  linkBlacklistEnabled: false,
  linkBlacklist: [], // explicit banned domains/fragments
  scamDomainFilter: true, // small built-in seed list of known scam/phishing patterns, on by default

  // more filters
  zalgoFilter: false,
  wallOfTextFilter: false,
  wallOfTextMaxLines: 15,
  wallOfTextMaxChars: 2000,
  emojiSpamFilter: false,
  emojiSpamMax: 10,
  attachmentBlocklistEnabled: false,
  attachmentBlocklist: ['exe', 'bat', 'scr', 'cmd', 'msi', 'jar'],

  // punishments
  defaultPunishment: 'delete', // 'delete' | 'warn' | 'timeout' | 'kick' | 'ban'
  timeoutMinutes: 10,
  escalationEnabled: false, // when on, overrides defaultPunishment with the ladder below
  escalationResetHours: 24, // a user's violation count resets after this long with no new violations

  // ignore list — shared with aiAutomod.js
  ignoreRoleIds: [],
  ignoreChannelIds: [],

  // mini raid-in-a-channel protection: auto-slowmode a channel that's
  // getting hit with a burst of violations, separate from the full
  // server-wide anti-raid system (antiRaid.js)
  raidSlowmodeEnabled: false,
  raidSlowmodeThreshold: 5, // violations in the window below
  raidSlowmodeWindowSeconds: 30,
  raidSlowmodeSeconds: 10, // slowmode value applied to the channel
  raidSlowmodeDurationMinutes: 5, // how long before it's lifted automatically
});

const store = makeGuildStore('automod-state.json', DEFAULTS);
const escalationStore = makeGuildStore('automod-escalation.json', () => ({})); // userId -> { count, lastAt }
let clientRef = null;

const ESCALATION_LADDER = ['delete', 'warn', 'timeout', 'kick', 'ban'];

// Small, honest starter list — not exhaustive, just catches the most common
// recurring Discord scam/phishing domain patterns (fake Nitro gifts, fake
// Steam trade sites). Server admins can add more via linkBlacklist.
const KNOWN_SCAM_DOMAIN_FRAGMENTS = [
  'dlscord', 'discorc', 'discrod', 'discord-nitro', 'discordnitro', 'discord-gift',
  'steamcomminuty', 'steancommunity', 'stearncommunity', 'steamcommuntiy',
];

const recentMessages = new Map(); // `${guildId}:${userId}` -> { text, count, lastTime }
const raidWindow = new Map(); // `${guildId}:${channelId}` -> timestamps[]

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

function isIgnored(guildId, message) {
  const config = getConfig(guildId);
  if (config.ignoreChannelIds.includes(message.channelId)) return true;
  if (message.member && config.ignoreRoleIds.some((id) => message.member.roles.cache.has(id))) return true;
  return false;
}

// ---------- Bypass-resistant word matching ----------

function normalizeLeet(text) {
  return text
    .toLowerCase()
    .replace(/[0@]/g, 'o')
    .replace(/[1!|]/g, 'i')
    .replace(/3/g, 'e')
    .replace(/4/g, 'a')
    .replace(/[5$]/g, 's')
    .replace(/7/g, 't');
}

function compact(text) {
  return text.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function containsBannedWord(content, bannedWords) {
  if (bannedWords.length === 0) return null;
  const normalized = normalizeLeet(content);
  const compacted = compact(normalized);
  for (const word of bannedWords) {
    const cleanWord = compact(normalizeLeet(word));
    if (!cleanWord) continue;
    if (normalized.includes(word.toLowerCase()) || compacted.includes(cleanWord)) return word;
  }
  return null;
}

// ---------- Punishment pipeline ----------

function nextEscalationStep(guildId, userId, config) {
  const state = escalationStore.get(guildId);
  const resetMs = (config.escalationResetHours || 24) * 60 * 60 * 1000;
  const now = Date.now();
  let entry = state[userId];
  if (!entry || now - entry.lastAt > resetMs) entry = { count: 0, lastAt: now };
  entry.count += 1;
  entry.lastAt = now;
  state[userId] = entry;
  escalationStore.save();
  return ESCALATION_LADDER[Math.min(entry.count - 1, ESCALATION_LADDER.length - 1)];
}

async function maybeTriggerRaidSlowmode(config, message) {
  if (!config.raidSlowmodeEnabled) return;
  const key = `${message.guild.id}:${message.channelId}`;
  const now = Date.now();
  const windowMs = (config.raidSlowmodeWindowSeconds || 30) * 1000;
  const hits = (raidWindow.get(key) || []).filter((t) => now - t < windowMs);
  hits.push(now);
  raidWindow.set(key, hits);
  if (hits.length < (config.raidSlowmodeThreshold || 5)) return;

  raidWindow.set(key, []); // reset so it doesn't re-trigger every single message after
  try {
    await message.channel.setRateLimitPerUser(config.raidSlowmodeSeconds || 10, 'Auto-mod: violation burst detected');
    await flag(message.guild.id, message.channel, { toString: () => 'the channel' }, `applied ${config.raidSlowmodeSeconds}s slowmode after a burst of violations`);
    const durationMs = (config.raidSlowmodeDurationMinutes || 5) * 60 * 1000;
    setTimeout(() => {
      message.channel.setRateLimitPerUser(0, 'Auto-mod: raid slowmode expired').catch(() => {});
    }, durationMs);
  } catch (err) {
    console.error('Auto-mod raid slowmode failed:', err.message);
  }
}

async function applyPunishment(guild, message, config, reasonLabel) {
  await message.delete().catch(() => {});
  await maybeTriggerRaidSlowmode(config, message);

  const punishment = config.escalationEnabled
    ? nextEscalationStep(guild.id, message.author.id, config)
    : config.defaultPunishment || 'delete';

  try {
    if (punishment === 'warn') {
      await warnings.addWarning(clientRef, guild, message.author.id, reasonLabel, 'Auto-Moderation');
    } else if (punishment === 'timeout' && message.member) {
      await message.member.timeout((config.timeoutMinutes || 10) * 60 * 1000, reasonLabel);
      await sendModerationDm(clientRef, message.member, guild, { action: 'timeout', reason: reasonLabel, moderatorTag: 'Auto-Moderation', durationText: `${config.timeoutMinutes || 10} minutes` });
    } else if (punishment === 'kick' && message.member) {
      await message.member.kick(reasonLabel);
    } else if (punishment === 'ban' && message.member) {
      await sendModerationDm(clientRef, message.member, guild, { action: 'ban', reason: reasonLabel, moderatorTag: 'Auto-Moderation' });
      await message.member.ban({ reason: reasonLabel });
    }
  } catch (err) {
    console.error('Auto-mod punishment failed:', err.message);
  }

  await flag(guild.id, message.channel, message.author, `${reasonLabel} → ${punishment}`);
}

// ---------- Filters ----------

const URL_RE = /https?:\/\/([^\s/]+)/gi;
const INVITE_RE = /(discord\.gg|discord\.com\/invite)\/\S+/i;
const ZALGO_RE = /[̀-ͯ᪰-᫿᷀-᷿⃐-⃿]/g;
const CUSTOM_EMOJI_RE = /<a?:\w+:\d+>/g;
const UNICODE_EMOJI_RE = /\p{Extended_Pictographic}/gu;

function setupAutomod(client) {
  clientRef = client;

  client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;
    if (!features.isEnabled(message.guild.id, 'automod')) return;
    if (!message.member || message.member.permissions.has('ManageMessages')) return; // staff exempt
    if (isIgnored(message.guild.id, message)) return;

    const config = getConfig(message.guild.id);
    const content = message.content;

    if (config.inviteFilter && INVITE_RE.test(content)) {
      return applyPunishment(message.guild, message, config, 'blocked a Discord invite link');
    }

    if (config.linkFilter) {
      const matches = [...content.matchAll(URL_RE)];
      const bad = matches.find((m) => !config.linkWhitelist.some((allowed) => m[1].includes(allowed)));
      if (bad) return applyPunishment(message.guild, message, config, `blocked a link (${bad[1]})`);
    }

    if (config.linkBlacklistEnabled && config.linkBlacklist.length > 0) {
      const matches = [...content.matchAll(URL_RE)];
      const bad = matches.find((m) => config.linkBlacklist.some((blocked) => m[1].toLowerCase().includes(blocked.toLowerCase())));
      if (bad) return applyPunishment(message.guild, message, config, `blocked a blacklisted link (${bad[1]})`);
    }

    if (config.scamDomainFilter) {
      const matches = [...content.matchAll(URL_RE)];
      const bad = matches.find((m) => KNOWN_SCAM_DOMAIN_FRAGMENTS.some((frag) => m[1].toLowerCase().includes(frag)));
      if (bad) return applyPunishment(message.guild, message, config, `blocked a suspected scam link (${bad[1]})`);
    }

    if (config.wordFilterEnabled) {
      const hit = containsBannedWord(content, config.bannedWords);
      if (hit) return applyPunishment(message.guild, message, config, `blocked a banned word`);
    }

    if (config.capsFilter && content.length >= 12) {
      const letters = content.replace(/[^a-zA-Z]/g, '');
      const upper = content.replace(/[^A-Z]/g, '');
      if (letters.length > 8 && upper.length / letters.length > 0.7) {
        return applyPunishment(message.guild, message, config, 'blocked excessive caps');
      }
    }

    if (config.zalgoFilter) {
      const combining = content.match(ZALGO_RE);
      if (combining && combining.length > 5) return applyPunishment(message.guild, message, config, 'blocked zalgo/unicode spam');
    }

    if (config.wallOfTextFilter) {
      const lines = content.split('\n').length;
      if (lines > config.wallOfTextMaxLines || content.length > config.wallOfTextMaxChars) {
        return applyPunishment(message.guild, message, config, 'blocked a wall-of-text message');
      }
    }

    if (config.emojiSpamFilter) {
      const customCount = (content.match(CUSTOM_EMOJI_RE) || []).length;
      const unicodeCount = (content.match(UNICODE_EMOJI_RE) || []).length;
      if (customCount + unicodeCount > config.emojiSpamMax) {
        return applyPunishment(message.guild, message, config, 'blocked excessive emoji spam');
      }
    }

    if (config.attachmentBlocklistEnabled && message.attachments.size > 0) {
      const badAttachment = [...message.attachments.values()].find((a) => {
        const ext = (a.name || '').split('.').pop()?.toLowerCase();
        return config.attachmentBlocklist.includes(ext);
      });
      if (badAttachment) return applyPunishment(message.guild, message, config, `blocked a disallowed file attachment (.${badAttachment.name.split('.').pop()})`);
    }

    if (config.mentionSpamFilter && message.mentions.users.size + message.mentions.roles.size >= 5) {
      return applyPunishment(message.guild, message, config, 'blocked mass mentions');
    }

    if (config.duplicateSpamFilter) {
      const key = `${message.guild.id}:${message.author.id}`;
      const prev = recentMessages.get(key);
      const now = Date.now();
      if (prev && prev.text === content && now - prev.lastTime < 10000) {
        const count = prev.count + 1;
        recentMessages.set(key, { text: content, count, lastTime: now });
        if (count >= 3) return applyPunishment(message.guild, message, config, 'blocked repeated spam messages');
        return;
      }
      recentMessages.set(key, { text: content, count: 1, lastTime: now });
    }
  });

  client.on('guildMemberAdd', async (member) => {
    const config = getConfig(member.guild.id);
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

// Guilds configured before a given field existed have a saved record that
// predates it entirely (missing, not just falsy) — makeGuildStore only
// applies DEFAULTS() to a brand-new record, never backfills an existing
// one. Every automod filter that calls an array/object method directly on
// a config field (e.g. ignoreChannelIds.includes(...)) will crash for those
// older records unless the field is backfilled first, so every read in this
// file goes through this instead of a raw store.get().
function getConfig(guildId) {
  const config = store.get(guildId);
  const defaults = DEFAULTS();
  let changed = false;
  for (const key of Object.keys(defaults)) {
    if (!(key in config)) {
      config[key] = defaults[key];
      changed = true;
    }
  }
  if (changed) store.save();
  return config;
}

function updateConfig(guildId, patch) {
  const config = safeAssign(getConfig(guildId), patch);
  store.save();
  return config;
}

module.exports = { setupAutomod, getConfig, updateConfig, isIgnored };
