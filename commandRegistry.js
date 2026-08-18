// The full command table. Each entry: { name, aliases, category, permission, usage,
// description, run(message, args, ctx) }. `permission` is a discord.js
// PermissionFlagsBits value the invoking member must have (Administrators always
// pass), or null for a public command anyone can use.
//
// `run` returns a string to reply with, or throws an Error with a user-facing
// message on failure — commandHandler.js takes care of sending the reply either way.
const { PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const { brandFooter } = require('./brand');

const warnings = require('./warnings');
const xpSystem = require('./xpSystem');
const stickyMessages = require('./stickyMessages');
const autoResponses = require('./autoResponses');
const giveaways = require('./giveaways');
const reminders = require('./reminders');
const funCommands = require('./funCommands');
const automod = require('./automod');
const antiRaid = require('./antiRaid');
const verificationGate = require('./verificationGate');
const reactionRoles = require('./reactionRoles');
const countingGame = require('./counting');
const stats = require('./stats');
const commandConfig = require('./commandConfig');
const guildConfig = require('./guildConfig');
const tickets = require('./tickets');
const rateCommands = require('./rateCommands');
const rolePanels = require('./rolePanels');

const P = PermissionFlagsBits;

// ---------- Helpers ----------

async function resolveMember(message, token) {
  if (!token) return null;
  const id = token.replace(/[<@!>]/g, '');
  try {
    return await message.guild.members.fetch(id);
  } catch {
    try {
      const found = await message.guild.members.fetch({ query: token, limit: 1 });
      return found.first() || null;
    } catch {
      return null;
    }
  }
}

async function resolveRole(message, token) {
  if (!token) return null;
  const id = token.replace(/[<@&>]/g, '');
  const byId = message.guild.roles.cache.get(id);
  if (byId) return byId;
  return message.guild.roles.cache.find((r) => r.name.toLowerCase() === token.toLowerCase()) || null;
}

function formatDuration(minutes) {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return `${h}h ${m}m`;
}

const PERMISSION_NAMES = Object.fromEntries(
  Object.entries(PermissionFlagsBits).map(([name, bit]) => [bit.toString(), name])
);
function permissionLabel(bit) {
  return bit ? PERMISSION_NAMES[bit.toString()] || 'Unknown permission' : null;
}

// ---------- Command table ----------

const commands = [];

function cmd(def) {
  commands.push(def);
}

// ===== MODERATION =====

cmd({
  name: 'kick', aliases: ['k'], category: 'Moderation', permission: P.KickMembers,
  usage: '<@user> [reason]', description: 'Kicks a member from the server.',
  run: async (message, args) => {
    const member = await resolveMember(message, args[0]);
    if (!member) throw new Error('Could not find that member.');
    const reason = args.slice(1).join(' ') || 'No reason given';
    await member.kick(reason);
    return `👢 Kicked **${member.user.tag}** (${reason})`;
  },
});

cmd({
  name: 'ban', aliases: ['b'], category: 'Moderation', permission: P.BanMembers,
  usage: '<@user> [reason]', description: 'Bans a member from the server.',
  run: async (message, args) => {
    const member = await resolveMember(message, args[0]);
    if (!member) throw new Error('Could not find that member.');
    const reason = args.slice(1).join(' ') || 'No reason given';
    await member.ban({ reason });
    return `🔨 Banned **${member.user.tag}** (${reason})`;
  },
});

cmd({
  name: 'unban', aliases: [], category: 'Moderation', permission: P.BanMembers,
  usage: '<userId>', description: 'Unbans a user by ID.',
  run: async (message, args) => {
    if (!args[0]) throw new Error('Provide a user ID.');
    await message.guild.bans.remove(args[0], 'Unbanned via command');
    return `✅ Unbanned user ${args[0]}`;
  },
});

cmd({
  name: 'softban', aliases: [], category: 'Moderation', permission: P.BanMembers,
  usage: '<@user> [reason]', description: 'Bans then immediately unbans, clearing recent messages without a lasting ban.',
  run: async (message, args) => {
    const member = await resolveMember(message, args[0]);
    if (!member) throw new Error('Could not find that member.');
    const reason = args.slice(1).join(' ') || 'No reason given';
    const userId = member.id;
    await member.ban({ reason, deleteMessageSeconds: 86400 });
    await message.guild.bans.remove(userId, 'Softban cleanup');
    return `🧹 Softbanned **${member.user.tag}** (messages cleared, not permanently banned)`;
  },
});

cmd({
  name: 'timeout', aliases: ['mute'], category: 'Moderation', permission: P.ModerateMembers,
  usage: '<@user> <minutes> [reason]', description: 'Times out a member for a number of minutes.',
  run: async (message, args) => {
    const member = await resolveMember(message, args[0]);
    if (!member) throw new Error('Could not find that member.');
    const minutes = parseInt(args[1], 10);
    if (!minutes || minutes <= 0) throw new Error('Provide a number of minutes.');
    const reason = args.slice(2).join(' ') || 'No reason given';
    await member.timeout(minutes * 60 * 1000, reason);
    return `⏱️ Timed out **${member.user.tag}** for ${minutes}m (${reason})`;
  },
});

cmd({
  name: 'untimeout', aliases: ['unmute'], category: 'Moderation', permission: P.ModerateMembers,
  usage: '<@user>', description: 'Removes an active timeout from a member.',
  run: async (message, args) => {
    const member = await resolveMember(message, args[0]);
    if (!member) throw new Error('Could not find that member.');
    await member.timeout(null, 'Timeout removed via command');
    return `▶️ Removed timeout from **${member.user.tag}**`;
  },
});

cmd({
  name: 'warn', aliases: [], category: 'Moderation', permission: P.ModerateMembers,
  usage: '<@user> <reason>', description: 'Issues a warning to a member.',
  run: async (message, args) => {
    const member = await resolveMember(message, args[0]);
    if (!member) throw new Error('Could not find that member.');
    const reason = args.slice(1).join(' ');
    if (!reason) throw new Error('Provide a reason.');
    const result = await warnings.addWarning(message.client, message.guild, member.id, reason, message.author.tag);
    return `⚠️ Warned **${member.user.tag}** (${result.warnings.length} total)${result.autoTimedOut ? ' — auto-timed out' : ''}`;
  },
});

cmd({
  name: 'warnings', aliases: ['warns'], category: 'Moderation', permission: P.ModerateMembers,
  usage: '<@user>', description: "Shows a member's warning history.",
  run: async (message, args) => {
    const member = await resolveMember(message, args[0]);
    if (!member) throw new Error('Could not find that member.');
    const list = warnings.getWarnings(message.guild.id, member.id);
    if (list.length === 0) return `${member.user.tag} has no warnings.`;
    return `**Warnings for ${member.user.tag}:**\n${list.map((w, i) => `${i + 1}. ${w.reason} (by ${w.by})`).join('\n')}`;
  },
});

cmd({
  name: 'clearwarnings', aliases: ['warnclear'], category: 'Moderation', permission: P.ModerateMembers,
  usage: '<@user>', description: "Clears a member's warnings.",
  run: async (message, args) => {
    const member = await resolveMember(message, args[0]);
    if (!member) throw new Error('Could not find that member.');
    warnings.clearWarnings(message.guild.id, member.id);
    return `🧹 Cleared warnings for **${member.user.tag}**`;
  },
});

cmd({
  name: 'purge', aliases: ['clear'], category: 'Moderation', permission: P.ManageMessages,
  usage: '<amount 1-100>', description: 'Deletes recent messages in this channel.',
  run: async (message, args) => {
    const amount = Math.min(Math.max(parseInt(args[0], 10) || 0, 1), 100);
    const deleted = await message.channel.bulkDelete(amount + 1, true); // +1 to include the command message
    return `🧹 Purged ${deleted.size - 1} messages`;
  },
});

cmd({
  name: 'purgeuser', aliases: [], category: 'Moderation', permission: P.ManageMessages,
  usage: '<@user> <amount 1-100>', description: "Deletes a specific user's recent messages in this channel.",
  run: async (message, args) => {
    const member = await resolveMember(message, args[0]);
    if (!member) throw new Error('Could not find that member.');
    const amount = Math.min(Math.max(parseInt(args[1], 10) || 0, 1), 100);
    const recent = await message.channel.messages.fetch({ limit: 100 });
    const targets = recent.filter((m) => m.author.id === member.id).first(amount);
    await message.channel.bulkDelete(targets, true);
    return `🧹 Purged ${targets.length} messages from **${member.user.tag}**`;
  },
});

cmd({
  name: 'purgebots', aliases: [], category: 'Moderation', permission: P.ManageMessages,
  usage: '<amount 1-100>', description: 'Deletes recent messages sent by bots in this channel.',
  run: async (message, args) => {
    const amount = Math.min(Math.max(parseInt(args[0], 10) || 0, 1), 100);
    const recent = await message.channel.messages.fetch({ limit: 100 });
    const targets = recent.filter((m) => m.author.bot).first(amount);
    await message.channel.bulkDelete(targets, true);
    return `🧹 Purged ${targets.length} bot messages`;
  },
});

cmd({
  name: 'slowmode', aliases: ['sm'], category: 'Moderation', permission: P.ManageChannels,
  usage: '<seconds>', description: 'Sets slowmode for this channel (0 = off).',
  run: async (message, args) => {
    const seconds = parseInt(args[0], 10) || 0;
    await message.channel.setRateLimitPerUser(seconds);
    return `🐢 Slowmode set to ${seconds}s`;
  },
});

cmd({
  name: 'lock', aliases: [], category: 'Moderation', permission: P.ManageChannels,
  usage: '', description: 'Locks this channel (denies @everyone Send Messages).',
  run: async (message) => {
    await message.channel.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: false });
    return '🔒 Channel locked';
  },
});

cmd({
  name: 'unlock', aliases: [], category: 'Moderation', permission: P.ManageChannels,
  usage: '', description: 'Unlocks this channel.',
  run: async (message) => {
    await message.channel.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: null });
    return '🔓 Channel unlocked';
  },
});

cmd({
  name: 'lockdown', aliases: [], category: 'Moderation', permission: P.Administrator,
  usage: '', description: 'Locks every text channel server-wide.',
  run: async (message) => {
    const count = await antiRaid.setLockdown(message.guild.id, true);
    return `🔒 Server-wide lockdown enabled (${count} channels)`;
  },
});

cmd({
  name: 'unlockdown', aliases: [], category: 'Moderation', permission: P.Administrator,
  usage: '', description: 'Lifts a server-wide lockdown.',
  run: async (message) => {
    const count = await antiRaid.setLockdown(message.guild.id, false);
    return `🔓 Lockdown lifted (${count} channels)`;
  },
});

cmd({
  name: 'nick', aliases: ['nickname'], category: 'Moderation', permission: P.ManageNicknames,
  usage: '<@user> <new nickname>', description: "Changes a member's nickname.",
  run: async (message, args) => {
    const member = await resolveMember(message, args[0]);
    if (!member) throw new Error('Could not find that member.');
    const nick = args.slice(1).join(' ');
    await member.setNickname(nick || null);
    return `✏️ Set nickname for **${member.user.tag}** to "${nick || '(reset)'}"`;
  },
});

cmd({
  name: 'nickreset', aliases: [], category: 'Moderation', permission: P.ManageNicknames,
  usage: '<@user>', description: "Resets a member's nickname.",
  run: async (message, args) => {
    const member = await resolveMember(message, args[0]);
    if (!member) throw new Error('Could not find that member.');
    await member.setNickname(null);
    return `✏️ Reset nickname for **${member.user.tag}**`;
  },
});

cmd({
  name: 'roleadd', aliases: ['giverole'], category: 'Moderation', permission: P.ManageRoles,
  usage: '<@user> <role>', description: 'Adds a role to a member.',
  run: async (message, args) => {
    const member = await resolveMember(message, args[0]);
    if (!member) throw new Error('Could not find that member.');
    const role = await resolveRole(message, args.slice(1).join(' '));
    if (!role) throw new Error('Could not find that role.');
    await member.roles.add(role);
    return `➕ Gave **${role.name}** to **${member.user.tag}**`;
  },
});

cmd({
  name: 'roleremove', aliases: ['takerole'], category: 'Moderation', permission: P.ManageRoles,
  usage: '<@user> <role>', description: 'Removes a role from a member.',
  run: async (message, args) => {
    const member = await resolveMember(message, args[0]);
    if (!member) throw new Error('Could not find that member.');
    const role = await resolveRole(message, args.slice(1).join(' '));
    if (!role) throw new Error('Could not find that role.');
    await member.roles.remove(role);
    return `➖ Removed **${role.name}** from **${member.user.tag}**`;
  },
});

cmd({
  name: 'massrole', aliases: [], category: 'Moderation', permission: P.ManageRoles,
  usage: '<role> <all|humans|bots>', description: 'Adds a role to many members at once.',
  run: async (message, args) => {
    const filter = args.pop();
    const role = await resolveRole(message, args.join(' '));
    if (!role) throw new Error('Could not find that role.');
    const members = await message.guild.members.fetch();
    const targets = members.filter((m) => (filter === 'bots' ? m.user.bot : filter === 'humans' ? !m.user.bot : true));
    let count = 0;
    for (const m of targets.values()) {
      try { await m.roles.add(role); count += 1; } catch { /* skip */ }
    }
    return `➕ Gave **${role.name}** to ${count} members`;
  },
});

cmd({
  name: 'massunrole', aliases: [], category: 'Moderation', permission: P.ManageRoles,
  usage: '<role> <all|humans|bots>', description: 'Removes a role from many members at once.',
  run: async (message, args) => {
    const filter = args.pop();
    const role = await resolveRole(message, args.join(' '));
    if (!role) throw new Error('Could not find that role.');
    const members = await message.guild.members.fetch();
    const targets = members.filter((m) => (filter === 'bots' ? m.user.bot : filter === 'humans' ? !m.user.bot : true));
    let count = 0;
    for (const m of targets.values()) {
      try { await m.roles.remove(role); count += 1; } catch { /* skip */ }
    }
    return `➖ Removed **${role.name}** from ${count} members`;
  },
});

cmd({
  name: 'kickbots', aliases: [], category: 'Moderation', permission: P.Administrator,
  usage: '', description: 'Kicks all bots except this one.',
  run: async (message) => {
    const members = await message.guild.members.fetch();
    const bots = members.filter((m) => m.user.bot && m.id !== message.client.user.id);
    let count = 0;
    for (const m of bots.values()) {
      try { await m.kick('Mass bot kick'); count += 1; } catch { /* skip */ }
    }
    return `👢 Kicked ${count} bots`;
  },
});

cmd({
  name: 'banlist', aliases: ['bans'], category: 'Moderation', permission: P.BanMembers,
  usage: '', description: 'Lists banned users.',
  run: async (message) => {
    const bans = await message.guild.bans.fetch();
    if (bans.size === 0) return 'No banned users.';
    return `**Banned users (${bans.size}):**\n${[...bans.values()].slice(0, 20).map((b) => b.user.tag).join(', ')}`;
  },
});

cmd({
  name: 'listwarned', aliases: [], category: 'Moderation', permission: P.ModerateMembers,
  usage: '', description: 'Lists every member who currently has warnings.',
  run: async (message) => {
    const list = warnings.getAllWarned(message.guild.id);
    if (list.length === 0) return 'No one has any warnings.';
    return list.map((w) => `<@${w.userId}> — ${w.count} warning(s)`).join('\n');
  },
});

// ===== INFO / UTILITY =====

cmd({
  name: 'ping', aliases: [], category: 'Info', permission: null,
  usage: '', description: "Shows the bot's latency.",
  run: async (message) => `🏓 Pong! ${Math.round(message.client.ws.ping)}ms`,
});

cmd({
  name: 'uptime', aliases: [], category: 'Info', permission: null,
  usage: '', description: 'Shows how long the bot has been running.',
  run: async (message) => `⏳ Bot has been up for ${formatDuration(process.uptime() / 60)}`,
});

cmd({
  name: 'userinfo', aliases: ['whois'], category: 'Info', permission: null,
  usage: '[@user]', description: 'Shows info about a member.',
  run: async (message, args) => {
    const member = args[0] ? await resolveMember(message, args[0]) : message.member;
    if (!member) throw new Error('Could not find that member.');
    return `**${member.user.tag}**\nJoined server: ${member.joinedAt?.toDateString()}\nAccount created: ${member.user.createdAt.toDateString()}\nRoles: ${member.roles.cache.filter((r) => r.id !== message.guild.id).map((r) => r.name).join(', ') || 'none'}`;
  },
});

cmd({
  name: 'serverinfo', aliases: [], category: 'Info', permission: null,
  usage: '', description: 'Shows info about this server.',
  run: async (message) => {
    const g = message.guild;
    return `**${g.name}**\nMembers: ${g.memberCount}\nChannels: ${g.channels.cache.size}\nRoles: ${g.roles.cache.size}\nCreated: ${g.createdAt.toDateString()}`;
  },
});

cmd({
  name: 'avatar', aliases: ['av'], category: 'Info', permission: null,
  usage: '[@user]', description: "Shows a member's avatar.",
  run: async (message, args) => {
    const member = args[0] ? await resolveMember(message, args[0]) : message.member;
    if (!member) throw new Error('Could not find that member.');
    return member.user.displayAvatarURL({ size: 512 });
  },
});

cmd({
  name: 'roleinfo', aliases: [], category: 'Info', permission: null,
  usage: '<role>', description: 'Shows info about a role.',
  run: async (message, args) => {
    const role = await resolveRole(message, args.join(' '));
    if (!role) throw new Error('Could not find that role.');
    return `**${role.name}**\nColor: ${role.hexColor}\nMembers: ${role.members.size}\nPosition: ${role.position}`;
  },
});

cmd({
  name: 'rolelist', aliases: ['roles'], category: 'Info', permission: null,
  usage: '', description: 'Lists all roles on the server.',
  run: async (message) => {
    const roles = message.guild.roles.cache.filter((r) => r.id !== message.guild.id).sort((a, b) => b.position - a.position);
    return `**Roles:** ${roles.map((r) => r.name).join(', ')}`;
  },
});

cmd({
  name: 'rolemembers', aliases: [], category: 'Info', permission: null,
  usage: '<role>', description: 'Lists members that have a role.',
  run: async (message, args) => {
    const role = await resolveRole(message, args.join(' '));
    if (!role) throw new Error('Could not find that role.');
    if (role.members.size === 0) return `No one has **${role.name}**.`;
    return `**${role.name}** (${role.members.size}):\n${[...role.members.values()].slice(0, 30).map((m) => m.user.tag).join(', ')}`;
  },
});

cmd({
  name: 'channelinfo', aliases: [], category: 'Info', permission: null,
  usage: '', description: 'Shows info about this channel.',
  run: async (message) => `**#${message.channel.name}**\nID: ${message.channel.id}\nSlowmode: ${message.channel.rateLimitPerUser || 0}s`,
});

cmd({
  name: 'membercount', aliases: [], category: 'Info', permission: null,
  usage: '', description: 'Shows the current member count.',
  run: async (message) => `👥 ${message.guild.memberCount} members`,
});

cmd({
  name: 'rank', aliases: ['level'], category: 'Info', permission: null,
  usage: '[@user]', description: "Shows a member's level and XP.",
  run: async (message, args) => {
    const member = args[0] ? await resolveMember(message, args[0]) : message.member;
    if (!member) throw new Error('Could not find that member.');
    const data = xpSystem.getUserXp(message.guild.id, member.id);
    return `**${member.user.tag}** — Level ${data.level}, ${data.xp} XP`;
  },
});

cmd({
  name: 'leaderboard', aliases: ['top'], category: 'Info', permission: null,
  usage: '', description: 'Shows the XP leaderboard.',
  run: async (message) => {
    const list = xpSystem.getLeaderboard(message.guild.id, 10);
    if (list.length === 0) return 'No XP earned yet.';
    return `**Leaderboard:**\n${list.map((u, i) => `${i + 1}. ${u.tag} — Level ${u.level} (${u.xp} XP)`).join('\n')}`;
  },
});

cmd({
  name: 'prefix', aliases: [], category: 'Info', permission: null,
  usage: '', description: 'Shows the current command prefix.',
  run: async (message) => `Current prefix: \`${commandConfig.getPrefix(message.guild.id)}\``,
});

cmd({
  name: 'stats', aliases: [], category: 'Info', permission: null,
  usage: '', description: "Shows today's most active channels.",
  run: async (message) => {
    const list = stats.getChannelCounts(message.guild.id);
    if (list.length === 0) return 'No messages recorded yet today.';
    return `**Most active today:**\n${list.slice(0, 10).map((c) => `#${c.channel} — ${c.count}`).join('\n')}`;
  },
});

cmd({
  name: 'mostactive', aliases: [], category: 'Info', permission: null,
  usage: '', description: 'Shows the most active members all-time.',
  run: async (message) => {
    const list = stats.getMostActive(message.guild.id, 10);
    if (list.length === 0) return 'No activity recorded yet.';
    return `**Most active members:**\n${list.map((m, i) => `${i + 1}. ${m.tag} — ${m.count} messages`).join('\n')}`;
  },
});

cmd({
  name: 'newmembers', aliases: [], category: 'Info', permission: null,
  usage: '', description: 'Shows how many members joined in the last 7 days.',
  run: async (message) => `📈 ${stats.getNewMembersThisWeek(message.guild)} new members this week`,
});

cmd({
  name: 'botinfo', aliases: ['about'], category: 'Info', permission: null,
  usage: '', description: 'Shows info about the bot.',
  run: async (message) => `🤖 **${message.client.user.tag}**\nServing ${message.client.guilds.cache.size} server(s)\nPing: ${Math.round(message.client.ws.ping)}ms`,
});

cmd({
  name: 'invite', aliases: [], category: 'Info', permission: null,
  usage: '', description: 'Generates an invite link for the bot.',
  run: async (message) => `🔗 https://discord.com/oauth2/authorize?client_id=${message.client.user.id}&permissions=8&scope=bot`,
});

cmd({
  name: 'timestamp', aliases: ['ts'], category: 'Info', permission: null,
  usage: '[minutes from now]', description: 'Shows a Discord timestamp tag, optionally offset into the future.',
  run: async (message, args) => {
    const minutes = parseInt(args[0], 10) || 0;
    const seconds = Math.floor(Date.now() / 1000) + minutes * 60;
    return `🕒 <t:${seconds}:F> → \`<t:${seconds}:F>\``;
  },
});

cmd({
  name: 'testperm', aliases: ['permtest'], category: 'Info', permission: P.Administrator,
  usage: '<role> <command>', description: 'Dry-run: checks whether a given role would be allowed to use a command, without actually running it.',
  run: async (message, args) => {
    const commandToken = args.pop();
    if (!commandToken) throw new Error('Format: testperm <role> <command>');
    const role = await resolveRole(message, args.join(' '));
    if (!role) throw new Error('Could not find that role.');
    const target = commands.find((c) => c.name === commandToken.toLowerCase() || c.aliases.includes(commandToken.toLowerCase()));
    if (!target) throw new Error(`Unknown command "${commandToken}".`);

    if (!target.permission) {
      return `✅ **${role.name}** CAN use \`${target.name}\` — it's available to everyone.`;
    }
    const allowed = role.permissions.has(target.permission);
    return `${allowed ? '✅' : '🚫'} **${role.name}** ${allowed ? 'CAN' : 'CANNOT'} use \`${target.name}\` (requires **${permissionLabel(target.permission)}**).`;
  },
});

cmd({
  name: 'leaderboards', aliases: ['ranks', 'lb'], category: 'Info', permission: null,
  usage: '', description: 'Shows the combined XP and activity leaderboards.',
  run: async (message) => {
    const xpList = xpSystem.getLeaderboard(message.guild.id, 5);
    const activeList = stats.getMostActive(message.guild.id, 5);

    const embed = new EmbedBuilder().setTitle('🏆 Leaderboards').setColor(0x3fe8d6).setFooter(brandFooter(message.client));

    embed.addFields({
      name: '⭐ Top XP',
      value: xpList.length ? xpList.map((u, i) => `${i + 1}. ${u.tag} — Lvl ${u.level} (${u.xp} XP)`).join('\n') : 'No data yet.',
    });
    embed.addFields({
      name: '💬 Most Active (today)',
      value: activeList.length ? activeList.map((m, i) => `${i + 1}. ${m.tag} — ${m.count} messages`).join('\n') : 'No data yet.',
    });

    await message.channel.send({ embeds: [embed] });
    return null;
  },
});

cmd({
  name: 'memberhelp', aliases: ['membercommands'], category: 'Info', permission: null,
  usage: '', description: 'Posts a full list of member commands (including fun/rate commands) with descriptions.',
  run: async (message) => {
    const prefix = commandConfig.getPrefix(message.guild.id);
    const publicCommands = commands.filter((c) => !c.permission);
    const byCategory = {};
    for (const c of publicCommands) {
      (byCategory[c.category] = byCategory[c.category] || []).push(c);
    }

    const embed = new EmbedBuilder()
      .setTitle('📖 Member Commands')
      .setDescription(`Prefix: \`${prefix}\``)
      .setColor(0x3fe8d6)
      .setFooter(brandFooter(message.client));

    for (const [category, cmds] of Object.entries(byCategory)) {
      const value = cmds.map((c) => `\`${prefix}${c.name}\` — ${c.description}`).join('\n').slice(0, 1024);
      embed.addFields({ name: category, value });
    }

    const rateTypes = rateCommands.getTypes(message.guild.id);
    if (rateTypes.length) {
      embed.addFields({
        name: 'Rate Commands',
        value: rateTypes.map((t) => `\`${prefix}rate${t.key} [@user]\` — ${t.emoji} rate someone's ${t.label}`).join('\n').slice(0, 1024),
      });
    }

    await message.channel.send({ embeds: [embed] });
    return null;
  },
});

// ===== FUN =====

cmd({
  name: 'roll', aliases: ['dice'], category: 'Fun', permission: null,
  usage: '[sides]', description: 'Rolls a dice.',
  run: async (message, args) => `🎲 Rolled a **${funCommands.rollDice(parseInt(args[0], 10) || 6)}**!`,
});

cmd({
  name: 'coinflip', aliases: ['flip'], category: 'Fun', permission: null,
  usage: '', description: 'Flips a coin.',
  run: async () => `🪙 **${funCommands.coinFlip()}**!`,
});

cmd({
  name: 'quote', aliases: [], category: 'Fun', permission: null,
  usage: '', description: 'Shares a random quote.',
  run: async () => `💬 ${funCommands.randomQuote()}`,
});

cmd({
  name: 'trivia', aliases: [], category: 'Fun', permission: null,
  usage: '', description: 'Posts a trivia question.',
  run: async () => {
    const t = funCommands.randomTrivia();
    return `🧠 **Trivia:** ${t.q}\n||${t.a}||`;
  },
});

cmd({
  name: 'wyr', aliases: ['wouldyourather'], category: 'Fun', permission: null,
  usage: '', description: 'Posts a "would you rather" question.',
  run: async () => `🤔 ${funCommands.randomWouldYouRather()}`,
});

cmd({
  name: 'compliment', aliases: [], category: 'Fun', permission: null,
  usage: '[@user]', description: 'Gives someone a compliment.',
  run: async (message, args) => {
    const member = args[0] ? await resolveMember(message, args[0]) : message.member;
    return `💖 ${member} ${funCommands.randomCompliment()}`;
  },
});

cmd({
  name: '8ball', aliases: ['eightball'], category: 'Fun', permission: null,
  usage: '<question>', description: 'Asks the magic 8-ball a question.',
  run: async (message, args) => {
    if (args.length === 0) throw new Error('Ask a question!');
    return `🎱 ${funCommands.eightBall()}`;
  },
});

cmd({
  name: 'randomcolor', aliases: [], category: 'Fun', permission: null,
  usage: '', description: 'Generates a random hex color.',
  run: async () => `🎨 #${Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0').toUpperCase()}`,
});

cmd({
  name: 'ratelist', aliases: [], category: 'Fun', permission: null,
  usage: '', description: 'Lists all the !rate... commands available on this server.',
  run: async (message) => {
    const prefix = commandConfig.getPrefix(message.guild.id);
    const types = rateCommands.getTypes(message.guild.id);
    if (types.length === 0) return 'No rate commands configured yet.';
    return `**Rate commands:**\n${types.map((t) => `\`${prefix}rate${t.key}\` — ${t.emoji} ${t.label}`).join('\n')}`;
  },
});

// ===== MESSAGING =====

cmd({
  name: 'announce', aliases: [], category: 'Messaging', permission: P.ManageGuild,
  usage: '<message>', description: 'Posts an @everyone announcement to #announcements.',
  run: async (message, args) => {
    const text = args.join(' ');
    if (!text) throw new Error('Provide a message.');
    const announcementsChannelId = guildConfig.getConfig(message.guild.id).announcementsChannelId;
    if (!announcementsChannelId) throw new Error('No announcements channel set for this server (see the dashboard Server tab).');
    const channel = await message.client.channels.fetch(announcementsChannelId);
    await channel.send({ content: `@everyone ${text}`, allowedMentions: { parse: ['everyone'] } });
    return '📢 Announcement posted';
  },
});

cmd({
  name: 'annoucment', aliases: ['announcement'], category: 'Messaging', permission: P.Administrator,
  usage: '<title> | <text>', description: "Posts a green-accented announcement embed to the server's announcements channel from anywhere, pinging the announcement role.",
  run: async (message, args) => {
    const [title, text] = args.join(' ').split('|').map((s) => s.trim());
    if (!title || !text) throw new Error('Format: !annoucment <title> | <text>');

    const config = guildConfig.getConfig(message.guild.id);
    if (!config.announcementsChannelId) throw new Error('No announcements channel set for this server (see the dashboard Server tab).');

    const channel = await message.client.channels.fetch(config.announcementsChannelId);
    const embed = new EmbedBuilder().setTitle(title).setDescription(text).setColor(0x3ddc84).setFooter(brandFooter(message.client)).setTimestamp();
    const pingContent = config.announcementPingRoleId ? `<@&${config.announcementPingRoleId}>` : '';

    await channel.send({
      content: pingContent,
      embeds: [embed],
      allowedMentions: config.announcementPingRoleId ? { roles: [config.announcementPingRoleId] } : undefined,
    });

    return `📢 Announcement posted in <#${config.announcementsChannelId}>`;
  },
});

cmd({
  name: 'dm', aliases: [], category: 'Messaging', permission: P.ManageGuild,
  usage: '<@user> <message>', description: 'Sends a DM to a member as the bot.',
  run: async (message, args) => {
    const member = await resolveMember(message, args[0]);
    if (!member) throw new Error('Could not find that member.');
    const text = args.slice(1).join(' ');
    if (!text) throw new Error('Provide a message.');
    await member.send(text);
    return `📩 DM sent to **${member.user.tag}**`;
  },
});

cmd({
  name: 'poll', aliases: [], category: 'Messaging', permission: P.ManageGuild,
  usage: '<question> | <option1> | <option2> ...', description: 'Posts a reaction poll (separate parts with |).',
  run: async (message, args) => {
    const parts = args.join(' ').split('|').map((s) => s.trim()).filter(Boolean);
    if (parts.length < 3) throw new Error('Format: question | option1 | option2 | ...');
    const [question, ...options] = parts;
    const numberEmoji = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
    const embed = new EmbedBuilder().setTitle(`📊 ${question}`).setDescription(options.map((o, i) => `${numberEmoji[i]} ${o}`).join('\n\n')).setColor(0x5865f2).setFooter(brandFooter(message.client));
    const msg = await message.channel.send({ embeds: [embed] });
    for (let i = 0; i < options.length; i++) await msg.react(numberEmoji[i]);
    return null;
  },
});

cmd({
  name: 'embed', aliases: [], category: 'Messaging', permission: P.ManageGuild,
  usage: '<title> | <description>', description: 'Posts an embed message.',
  run: async (message, args) => {
    const [title, description] = args.join(' ').split('|').map((s) => s.trim());
    if (!title || !description) throw new Error('Format: title | description');
    const embed = new EmbedBuilder().setTitle(title).setDescription(description).setColor(0x5865f2).setFooter(brandFooter(message.client));
    await message.channel.send({ embeds: [embed] });
    return null;
  },
});

cmd({
  name: 'echo', aliases: [], category: 'Messaging', permission: P.ManageGuild,
  usage: '<message>', description: 'Repeats a message as the bot.',
  run: async (message, args) => {
    const text = args.join(' ');
    if (!text) throw new Error('Provide a message.');
    await message.channel.send(text);
    return null;
  },
});

cmd({
  name: 'sendto', aliases: [], category: 'Messaging', permission: P.ManageGuild,
  usage: '<#channel> <message>', description: 'Sends a message to another channel.',
  run: async (message, args) => {
    const channelId = args[0]?.replace(/[<#>]/g, '');
    const text = args.slice(1).join(' ');
    if (!channelId || !text) throw new Error('Format: sendto #channel message');
    const channel = await message.client.channels.fetch(channelId);
    await channel.send(text);
    return `✅ Sent to #${channel.name}`;
  },
});

cmd({
  name: 'stickyset', aliases: [], category: 'Messaging', permission: P.ManageGuild,
  usage: '<text>', description: 'Sets a sticky message for this channel.',
  run: async (message, args, ctx) => {
    const text = args.join(' ');
    if (!text) throw new Error('Provide the sticky text.');
    await stickyMessages.setSticky(ctx.client, message.channelId, text);
    return '📌 Sticky message set';
  },
});

cmd({
  name: 'stickyremove', aliases: [], category: 'Messaging', permission: P.ManageGuild,
  usage: '', description: 'Removes the sticky message from this channel.',
  run: async (message, args, ctx) => {
    await stickyMessages.removeSticky(ctx.client, message.channelId);
    return '✅ Sticky message removed';
  },
});

cmd({
  name: 'stickylist', aliases: [], category: 'Messaging', permission: P.ManageGuild,
  usage: '', description: 'Lists all sticky messages.',
  run: async () => {
    const list = stickyMessages.listStickies();
    if (list.length === 0) return 'No sticky messages set.';
    return list.map((s) => `<#${s.channelId}>: ${s.text}`).join('\n');
  },
});

cmd({
  name: 'template', aliases: [], category: 'Messaging', permission: P.ManageGuild,
  usage: '<maintenance|event>', description: 'Posts an announcement template.',
  run: async (message, args) => {
    const templates = {
      maintenance: { title: '🛠️ Scheduled Maintenance', description: 'The server is going down for scheduled maintenance.', color: 0xed4245 },
      event: { title: '🎉 Event Starting Soon', description: 'Something fun is about to happen — jump in now!', color: 0x57f287 },
    };
    const t = templates[args[0]];
    if (!t) throw new Error('Options: maintenance, event');
    const announcementsChannelId = guildConfig.getConfig(message.guild.id).announcementsChannelId;
    if (!announcementsChannelId) throw new Error('No announcements channel set for this server (see the dashboard Server tab).');
    const channel = await message.client.channels.fetch(announcementsChannelId);
    const embed = new EmbedBuilder().setTitle(t.title).setDescription(t.description).setColor(t.color).setFooter(brandFooter(message.client));
    await channel.send({ content: '@everyone', embeds: [embed], allowedMentions: { parse: ['everyone'] } });
    return '📢 Template posted';
  },
});

// ===== AUTOMATION =====

cmd({
  name: 'autoresponseadd', aliases: [], category: 'Automation', permission: P.ManageGuild,
  usage: '<trigger> | <reply>', description: 'Adds an auto-response.',
  run: async (message, args) => {
    const [trigger, reply] = args.join(' ').split('|').map((s) => s.trim());
    if (!trigger || !reply) throw new Error('Format: trigger | reply');
    autoResponses.addResponse(message.guild.id, trigger, reply);
    return `✅ Auto-response added for "${trigger}"`;
  },
});

cmd({
  name: 'autoresponseremove', aliases: [], category: 'Automation', permission: P.ManageGuild,
  usage: '<trigger>', description: 'Removes an auto-response by trigger word.',
  run: async (message, args) => {
    const trigger = args.join(' ');
    const match = autoResponses.listResponses(message.guild.id).find((r) => r.trigger.toLowerCase() === trigger.toLowerCase());
    if (!match) throw new Error('No auto-response with that trigger.');
    autoResponses.removeResponse(message.guild.id, match.id);
    return `✅ Removed auto-response for "${trigger}"`;
  },
});

cmd({
  name: 'autoresponselist', aliases: [], category: 'Automation', permission: P.ManageGuild,
  usage: '', description: 'Lists all auto-responses.',
  run: async (message) => {
    const list = autoResponses.listResponses(message.guild.id);
    if (list.length === 0) return 'No auto-responses configured.';
    return list.map((r) => `"${r.trigger}" → ${r.reply}`).join('\n');
  },
});

cmd({
  name: 'reactionrole', aliases: [], category: 'Automation', permission: P.ManageRoles,
  usage: '<emoji> <role> | <message text>', description: 'Creates a reaction-role message.',
  run: async (message, args) => {
    const emoji = args.shift();
    const roleToken = args.shift();
    const text = args.join(' ').replace(/^\|\s*/, '');
    const role = await resolveRole(message, roleToken);
    if (!emoji || !role || !text) throw new Error('Format: reactionrole <emoji> <role> | <message text>');
    await reactionRoles.createReactionRole(message.channelId, text, emoji, role.id);
    return '✅ Reaction role created';
  },
});

cmd({
  name: 'reactionrolelist', aliases: [], category: 'Automation', permission: P.ManageRoles,
  usage: '', description: 'Lists all reaction roles.',
  run: async () => {
    const list = reactionRoles.listReactionRoles();
    if (list.length === 0) return 'No reaction roles set up.';
    return list.map((r) => `${r.emoji} → <@&${r.roleId}>`).join('\n');
  },
});

cmd({
  name: 'rolepanels', aliases: [], category: 'Automation', permission: P.ManageRoles,
  usage: '', description: 'Lists configured self-assign role panels.',
  run: async (message) => {
    const panels = rolePanels.getPanels(message.guild.id);
    if (panels.length === 0) return 'No role panels configured yet — create one from the dashboard.';
    return panels.map((p) => `**${p.name}** — ${p.roles.length} role(s): ${p.roles.map((r) => r.label).join(', ') || 'none yet'}`).join('\n');
  },
});

cmd({
  name: 'rolepanelpost', aliases: [], category: 'Automation', permission: P.ManageRoles,
  usage: '<panel name> [#channel]', description: 'Posts a configured role panel by name (falls back to this channel).',
  run: async (message, args, ctx) => {
    const lastArgIsChannel = /^<#\d+>$/.test(args[args.length - 1] || '');
    const channelId = lastArgIsChannel ? args.pop().replace(/[<#>]/g, '') : message.channelId;
    const nameQuery = args.join(' ').toLowerCase();
    const panel = rolePanels.getPanels(message.guild.id).find((p) => p.name.toLowerCase() === nameQuery);
    if (!panel) throw new Error(`No role panel named "${nameQuery}". Use !rolepanels to see what's configured.`);
    await rolePanels.postPanel(ctx.client, message.guild.id, panel.id, channelId);
    return `✅ "${panel.name}" role panel posted in <#${channelId}>`;
  },
});

cmd({
  name: 'reminderset', aliases: ['remindme'], category: 'Automation', permission: P.ManageGuild,
  usage: '<minutes> <message>', description: 'Schedules a reminder in this channel.',
  run: async (message, args) => {
    const minutes = parseInt(args[0], 10);
    const text = args.slice(1).join(' ');
    if (!minutes || !text) throw new Error('Format: reminderset <minutes> <message>');
    const sendAt = new Date(Date.now() + minutes * 60 * 1000).toISOString();
    reminders.createReminder(message.channelId, text, sendAt);
    return `⏰ Reminder set for ${minutes} minutes from now`;
  },
});

cmd({
  name: 'reminderlist', aliases: [], category: 'Automation', permission: P.ManageGuild,
  usage: '', description: 'Lists upcoming reminders.',
  run: async () => {
    const list = reminders.listReminders();
    if (list.length === 0) return 'No reminders scheduled.';
    return list.map((r) => `${r.id}: "${r.message}" at ${new Date(r.sendAt).toLocaleString()}`).join('\n');
  },
});

cmd({
  name: 'remindercancel', aliases: [], category: 'Automation', permission: P.ManageGuild,
  usage: '<id>', description: 'Cancels a scheduled reminder.',
  run: async (message, args) => {
    if (!args[0]) throw new Error('Provide a reminder ID (see reminderlist).');
    reminders.cancelReminder(args[0]);
    return '✅ Reminder cancelled';
  },
});

cmd({
  name: 'giveawaystart', aliases: [], category: 'Automation', permission: P.ManageGuild,
  usage: '<minutes> <winners> <prize>', description: 'Starts a giveaway in this channel.',
  run: async (message, args) => {
    const minutes = parseInt(args[0], 10);
    const winners = parseInt(args[1], 10);
    const prize = args.slice(2).join(' ');
    if (!minutes || !winners || !prize) throw new Error('Format: giveawaystart <minutes> <winners> <prize>');
    await giveaways.createGiveaway(message.channelId, prize, minutes, winners);
    return '🎉 Giveaway started!';
  },
});

cmd({
  name: 'giveawayend', aliases: [], category: 'Automation', permission: P.ManageGuild,
  usage: '<messageId>', description: 'Ends a giveaway immediately.',
  run: async (message, args) => {
    if (!args[0]) throw new Error('Provide the giveaway message ID.');
    await giveaways.endGiveawayNow(args[0]);
    return '🎉 Giveaway ended';
  },
});

cmd({
  name: 'giveawaylist', aliases: [], category: 'Automation', permission: P.ManageGuild,
  usage: '', description: 'Lists giveaways.',
  run: async () => {
    const list = giveaways.listGiveaways();
    if (list.length === 0) return 'No giveaways yet.';
    return list.map((g) => `${g.messageId}: ${g.prize} (${g.ended ? 'ended' : 'active'})`).join('\n');
  },
});

// ===== AUTOMOD =====

cmd({
  name: 'automodstatus', aliases: [], category: 'Automod', permission: P.ManageGuild,
  usage: '', description: 'Shows current auto-mod settings.',
  run: async (message) => {
    const c = automod.getConfig(message.guild.id);
    return `Link filter: ${c.linkFilter}\nInvite filter: ${c.inviteFilter}\nCaps filter: ${c.capsFilter}\nMention spam filter: ${c.mentionSpamFilter}\nDuplicate spam filter: ${c.duplicateSpamFilter}\nAccount age gate: ${c.accountAgeGateDays} days`;
  },
});

function automodToggleCommand(name, key, label) {
  cmd({
    name, aliases: [], category: 'Automod', permission: P.ManageGuild,
    usage: '<on|off>', description: `Toggles ${label}.`,
    run: async (message, args) => {
      const on = args[0]?.toLowerCase() === 'on';
      automod.updateConfig(message.guild.id, { [key]: on });
      return `✅ ${label} is now ${on ? 'ON' : 'OFF'}`;
    },
  });
}

automodToggleCommand('linkfilter', 'linkFilter', 'link filter');
automodToggleCommand('invitefilter', 'inviteFilter', 'invite filter');
automodToggleCommand('capsfilter', 'capsFilter', 'caps filter');
automodToggleCommand('mentionfilter', 'mentionSpamFilter', 'mention spam filter');
automodToggleCommand('dupfilter', 'duplicateSpamFilter', 'duplicate spam filter');

cmd({
  name: 'agegate', aliases: [], category: 'Automod', permission: P.ManageGuild,
  usage: '<days>', description: 'Sets the new-account age gate (0 = off).',
  run: async (message, args) => {
    const days = parseInt(args[0], 10) || 0;
    automod.updateConfig(message.guild.id, { accountAgeGateDays: days });
    return `✅ Account age gate set to ${days} days`;
  },
});

// ===== VERIFICATION =====

cmd({
  name: 'verification', aliases: [], category: 'Verification', permission: P.Administrator,
  usage: '<on|off>', description: 'Toggles the verification gate.',
  run: async (message, args) => {
    const on = args[0]?.toLowerCase() === 'on';
    verificationGate.setEnabled(message.guild.id, on);
    return `✅ Verification gate is now ${on ? 'ON' : 'OFF'}`;
  },
});

cmd({
  name: 'verificationpost', aliases: [], category: 'Verification', permission: P.Administrator,
  usage: '', description: 'Posts the verify button in this channel.',
  run: async (message, args, ctx) => {
    await verificationGate.postVerificationMessage(ctx.client, message.channelId);
    return '✅ Verify button posted';
  },
});

// ===== COUNTING =====

cmd({
  name: 'countingstate', aliases: [], category: 'Counting', permission: null,
  usage: '', description: 'Shows the current counting game state.',
  run: async (message) => {
    const s = countingGame.getCountingState(message.guild.id);
    return `🔢 Next number: **${s.currentCount}**`;
  },
});

cmd({
  name: 'countingreset', aliases: [], category: 'Counting', permission: P.ManageGuild,
  usage: '', description: 'Resets the counting game to 1.',
  run: async (message) => {
    countingGame.resetCountingState(message.guild.id);
    return '✅ Counting game reset to 1';
  },
});

// ===== XP ADMIN =====

cmd({
  name: 'addxp', aliases: [], category: 'XP', permission: P.ManageGuild,
  usage: '<@user> <amount>', description: "Adds XP to a member.",
  run: async (message, args) => {
    const member = await resolveMember(message, args[0]);
    if (!member) throw new Error('Could not find that member.');
    const amount = parseInt(args[1], 10);
    if (!amount) throw new Error('Provide an amount.');
    const user = xpSystem.addXp(message.guild.id, member.id, member.user.tag, amount);
    return `✅ **${member.user.tag}** now has ${user.xp} XP (Level ${user.level})`;
  },
});

cmd({
  name: 'removexp', aliases: [], category: 'XP', permission: P.ManageGuild,
  usage: '<@user> <amount>', description: "Removes XP from a member.",
  run: async (message, args) => {
    const member = await resolveMember(message, args[0]);
    if (!member) throw new Error('Could not find that member.');
    const amount = parseInt(args[1], 10);
    if (!amount) throw new Error('Provide an amount.');
    const user = xpSystem.addXp(message.guild.id, member.id, member.user.tag, -amount);
    return `✅ **${member.user.tag}** now has ${user.xp} XP (Level ${user.level})`;
  },
});

cmd({
  name: 'setlevel', aliases: [], category: 'XP', permission: P.ManageGuild,
  usage: '<@user> <level>', description: "Sets a member's level directly.",
  run: async (message, args) => {
    const member = await resolveMember(message, args[0]);
    if (!member) throw new Error('Could not find that member.');
    const level = parseInt(args[1], 10);
    if (level === undefined || isNaN(level)) throw new Error('Provide a level.');
    xpSystem.setLevel(message.guild.id, member.id, member.user.tag, level);
    return `✅ **${member.user.tag}** is now Level ${level}`;
  },
});

// ===== TICKETS =====

cmd({
  name: 'ticketpanel', aliases: [], category: 'Tickets', permission: P.ManageGuild,
  usage: '<panel name> [#channel]', description: 'Posts a configured ticket panel by name (falls back to this channel).',
  run: async (message, args, ctx) => {
    const config = tickets.getConfig(message.guild.id);
    const lastArgIsChannel = /^<#\d+>$/.test(args[args.length - 1] || '');
    const channelId = lastArgIsChannel ? args.pop().replace(/[<#>]/g, '') : message.channelId;
    const nameQuery = args.join(' ').toLowerCase();
    const panel = config.panels.find((p) => p.name.toLowerCase() === nameQuery);
    if (!panel) {
      if (config.panels.length === 0) throw new Error('No ticket panels configured yet — create one from the dashboard Tickets tab.');
      throw new Error(`No panel named "${nameQuery}". Available: ${config.panels.map((p) => p.name).join(', ')}`);
    }
    await tickets.postPanel(ctx.client, message.guild.id, panel.id, channelId);
    return `✅ "${panel.name}" panel posted in <#${channelId}>`;
  },
});

cmd({
  name: 'ticketclose', aliases: [], category: 'Tickets', permission: P.ManageChannels,
  usage: '', description: 'Closes the current ticket channel (hides it from the opener, moves it to the closed-tickets category).',
  run: async (message, args, ctx) => {
    await tickets.closeTicket(ctx.client, message.guild.id, message.channelId, message.author.tag);
    return null;
  },
});

cmd({
  name: 'ticketreopen', aliases: [], category: 'Tickets', permission: P.ManageChannels,
  usage: '', description: 'Reopens the current (closed) ticket channel.',
  run: async (message, args, ctx) => {
    await tickets.reopenTicket(ctx.client, message.guild.id, message.channelId);
    return null;
  },
});

cmd({
  name: 'ticketdelete', aliases: [], category: 'Tickets', permission: P.ManageChannels,
  usage: '', description: 'Permanently deletes the current ticket channel. Cannot be undone.',
  run: async (message, args, ctx) => {
    await tickets.deleteTicket(ctx.client, message.guild.id, message.channelId);
    return null;
  },
});

cmd({
  name: 'ticketadd', aliases: [], category: 'Tickets', permission: P.ManageChannels,
  usage: '<@user>', description: 'Adds a member to the current ticket channel.',
  run: async (message, args) => {
    const member = await resolveMember(message, args[0]);
    if (!member) throw new Error('Could not find that member.');
    await tickets.addParticipant(message.guild, message.channelId, member);
    return `➕ Added **${member.user.tag}** to this ticket`;
  },
});

cmd({
  name: 'ticketremove', aliases: [], category: 'Tickets', permission: P.ManageChannels,
  usage: '<@user>', description: 'Removes a member from the current ticket channel.',
  run: async (message, args) => {
    const member = await resolveMember(message, args[0]);
    if (!member) throw new Error('Could not find that member.');
    await tickets.removeParticipant(message.guild, message.channelId, member);
    return `➖ Removed **${member.user.tag}** from this ticket`;
  },
});

cmd({
  name: 'ticketlist', aliases: [], category: 'Tickets', permission: P.ManageChannels,
  usage: '', description: 'Lists currently open tickets.',
  run: async (message) => {
    const list = tickets.listTickets(message.guild.id, 'open');
    if (list.length === 0) return 'No open tickets.';
    return list.map((t) => `#${t.number} — ${t.userTag} (${t.panelName}) <#${t.channelId}>`).join('\n');
  },
});

cmd({
  name: 'ticketstats', aliases: [], category: 'Tickets', permission: P.ManageGuild,
  usage: '', description: 'Shows ticket system statistics.',
  run: async (message) => {
    const s = tickets.getStats(message.guild.id);
    const staffLines = Object.entries(s.byStaff).sort((a, b) => b[1] - a[1]).map(([tag, count]) => `${tag}: ${count}`).join('\n') || 'none yet';
    return `**Tickets** — Open: ${s.open} | Closed: ${s.closedTotal} | Total: ${s.totalTickets}\nAvg. resolution: ${s.avgResolutionMinutes} minutes\n\n**Closed by staff:**\n${staffLines}`;
  },
});

// ===== HELP =====

cmd({
  name: 'help', aliases: ['commands'], category: 'Info', permission: null,
  usage: '[command|category]', description: 'Lists commands, or shows details for one command.',
  run: async (message, args) => {
    const prefix = commandConfig.getPrefix(message.guild.id);

    if (args[0]) {
      const found = commands.find((c) => c.name === args[0].toLowerCase() || c.aliases.includes(args[0].toLowerCase()));
      if (found) {
        return `**${prefix}${found.name}** ${found.usage}\n${found.description}\n${found.permission ? 'Requires a moderation permission' : 'Available to everyone'}`;
      }
      const category = commands.filter((c) => c.category.toLowerCase() === args[0].toLowerCase());
      if (category.length) {
        return `**${category[0].category} commands:**\n${category.map((c) => `\`${prefix}${c.name}\``).join(', ')}`;
      }
      return 'Command or category not found.';
    }

    const categories = [...new Set(commands.map((c) => c.category))];
    return `**Command categories** (use \`${prefix}help <category>\` for details):\n${categories.join(', ')}\n\nTotal commands: ${commands.length}`;
  },
});

module.exports = { commands, resolveMember, resolveRole };
