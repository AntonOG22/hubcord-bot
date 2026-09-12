// Watches Discord's own Audit Log for moderation-relevant events and posts them to
// each server's own configured mod-logs channel (guildConfig), no matter whether the
// action was taken through the dashboard or directly in Discord — and no matter which
// of the bot's servers it happened on.
const { AuditLogEvent } = require('discord.js');
const guildConfig = require('./guildConfig');
const features = require('./features');
const botActionRegistry = require('./botActionRegistry');
const modCases = require('./modCases');

// Finds the most recent matching audit log entry for a target, so we know who did it.
async function findAuditEntry(guild, type, targetId) {
  try {
    const logs = await guild.fetchAuditLogs({ type, limit: 5 });
    return (
      logs.entries.find(
        (e) => e.target?.id === targetId && Date.now() - e.createdTimestamp < 15000
      ) || null
    );
  } catch (err) {
    console.error('Could not read audit log:', err.message);
    return null;
  }
}

// `caseInfo` (type/targetTag/moderatorTag/reason) is only passed for actions
// worth a lookupable case number (bans, kicks, timeouts, warns) — routine
// stuff like role tweaks or slowmode changes stays plain. The case is
// recorded even if there's no mod-log channel configured, so !case still
// works; only the channel post itself depends on that.
async function post(client, guildId, text, caseInfo = null) {
  let prefix = '';
  if (caseInfo) {
    const id = modCases.recordCase(guildId, caseInfo);
    prefix = `\`Case #${id}\` `;
  }

  if (!features.isEnabled(guildId, 'modLog')) return;
  const modLogsChannelId = guildConfig.getConfig(guildId).modLogsChannelId;
  if (!modLogsChannelId) return;
  try {
    const channel = await client.channels.fetch(modLogsChannelId);
    await channel.send({ content: `${prefix}${text}` });
  } catch (err) {
    console.error('Could not post to mod-logs:', err.message);
  }
}

function setupModLogTracking(client) {
  client.on('guildBanAdd', async (ban) => {
    // AI automod already posts its own, more detailed embed for this —
    // skip the plain-text duplicate underneath it. Checked via a server-side
    // marker (botActionRegistry), not the ban's reason text — matching on
    // reason text would let any admin with Ban Members hide their OWN manual
    // ban from this log just by typing a matching reason string.
    if (botActionRegistry.wasJustAutomated(ban.guild.id, ban.user.id, 'ban')) return;
    const entry = await findAuditEntry(ban.guild, AuditLogEvent.MemberBanAdd, ban.user.id);
    const by = entry?.executor ? entry.executor.tag : 'unknown';
    const reason = entry?.reason || 'no reason given';
    post(client, ban.guild.id, `🔨 **${ban.user.tag}** was banned by **${by}** (${reason})`, {
      type: 'ban', targetTag: ban.user.tag, moderatorTag: by, reason,
    });
  });

  client.on('guildBanRemove', async (ban) => {
    const entry = await findAuditEntry(ban.guild, AuditLogEvent.MemberBanRemove, ban.user.id);
    const by = entry?.executor ? entry.executor.tag : 'unknown';
    post(client, ban.guild.id, `✅ **${ban.user.tag}** was unbanned by **${by}**`, {
      type: 'unban', targetTag: ban.user.tag, moderatorTag: by,
    });
  });

  client.on('guildMemberRemove', async (member) => {
    // Only fires as a mod-log line if it was actually a kick (has a matching audit entry).
    // A normal voluntary leave has no MemberKick audit entry, so nothing gets posted.
    const entry = await findAuditEntry(member.guild, AuditLogEvent.MemberKick, member.id);
    if (!entry) return;
    const by = entry.executor ? entry.executor.tag : 'unknown';
    const reason = entry.reason || 'no reason given';
    post(client, member.guild.id, `👢 **${member.user.tag}** was kicked by **${by}** (${reason})`, {
      type: 'kick', targetTag: member.user.tag, moderatorTag: by, reason,
    });
  });

  client.on('guildMemberUpdate', async (oldMember, newMember) => {
    // Timeout applied or removed
    const oldTimeout = oldMember.communicationDisabledUntilTimestamp;
    const newTimeout = newMember.communicationDisabledUntilTimestamp;
    if (oldTimeout !== newTimeout) {
      // Same as bans above — AI automod's own embed already covers this,
      // skip only this block (not role-change detection further below), and
      // only via the tamper-proof marker, never the reason text. A removal
      // (untimeout) is never marked by AI automod, so it's never suppressed.
      if (!botActionRegistry.wasJustAutomated(newMember.guild.id, newMember.id, 'timeout')) {
        const entry = await findAuditEntry(newMember.guild, AuditLogEvent.MemberUpdate, newMember.id);
        const by = entry?.executor ? entry.executor.tag : 'unknown';
        const reason = entry?.reason || 'no reason given';

        if (newTimeout && newTimeout > Date.now()) {
          const until = Math.floor(newTimeout / 1000);
          post(client, newMember.guild.id, `⏱️ **${newMember.user.tag}** was timed out by **${by}** until <t:${until}:f> (${reason})`, {
            type: 'timeout', targetTag: newMember.user.tag, moderatorTag: by, reason,
          });
        } else if (oldTimeout && (!newTimeout || newTimeout <= Date.now())) {
          post(client, newMember.guild.id, `▶️ Timeout removed for **${newMember.user.tag}** by **${by}**`, {
            type: 'untimeout', targetTag: newMember.user.tag, moderatorTag: by,
          });
        }
      }
    }

    // Role changes
    const oldRoles = new Set(oldMember.roles.cache.keys());
    const newRoles = new Set(newMember.roles.cache.keys());
    const added = [...newRoles].filter((id) => !oldRoles.has(id));
    const removed = [...oldRoles].filter((id) => !newRoles.has(id));

    if (added.length || removed.length) {
      const entry = await findAuditEntry(newMember.guild, AuditLogEvent.MemberRoleUpdate, newMember.id);
      const by = entry?.executor ? entry.executor.tag : 'unknown';

      for (const id of added) {
        const role = newMember.guild.roles.cache.get(id);
        post(client, newMember.guild.id, `➕ Role **${role?.name || id}** added to **${newMember.user.tag}** by **${by}**`);
      }
      for (const id of removed) {
        const role = newMember.guild.roles.cache.get(id);
        post(client, newMember.guild.id, `➖ Role **${role?.name || id}** removed from **${newMember.user.tag}** by **${by}**`);
      }
    }
  });

  client.on('messageDeleteBulk', async (messages, channel) => {
    const entry = await findAuditEntry(channel.guild, AuditLogEvent.MessageBulkDelete, channel.id);
    const by = entry?.executor ? entry.executor.tag : 'unknown';
    post(client, channel.guild.id, `🧹 **${messages.size}** messages purged in #${channel.name} by **${by}**`);
  });

  // Single-message delete/edit — clip() keeps a very long message from
  // blowing up the mod-log line, and both bail out on a partial message
  // (uncached, e.g. from before the bot last restarted) since discord.js
  // can't give us its actual content to show either way.
  const clip = (s) => {
    const text = (s || '').trim();
    if (!text) return '*(no text content)*';
    return text.length > 400 ? `${text.slice(0, 400)}…` : text;
  };

  client.on('messageDelete', async (message) => {
    if (!message.guild || message.partial || message.author?.bot) return;
    if (!message.content && message.attachments.size === 0) return; // nothing meaningful to show (e.g. embed-only)
    const attachmentNote = message.attachments.size ? `\n📎 ${message.attachments.size} attachment(s)` : '';
    post(
      client,
      message.guild.id,
      `🗑️ Message by **${message.author.tag}** deleted in #${message.channel.name}:\n> ${clip(message.content).replaceAll('\n', '\n> ')}${attachmentNote}`
    );
  });

  client.on('messageUpdate', async (oldMessage, newMessage) => {
    if (!newMessage.guild || oldMessage.partial || newMessage.partial || newMessage.author?.bot) return;
    const oldContent = (oldMessage.content || '').trim();
    const newContent = (newMessage.content || '').trim();
    if (oldContent === newContent) return; // e.g. a link preview attaching its own embed also fires this with no real text change
    post(
      client,
      newMessage.guild.id,
      `✏️ Message by **${newMessage.author.tag}** edited in #${newMessage.channel.name}:\n**Before:** ${clip(oldContent)}\n**After:** ${clip(newContent)}`
    );
  });

  client.on('channelUpdate', async (oldChannel, newChannel) => {
    if (
      typeof oldChannel.rateLimitPerUser === 'number' &&
      oldChannel.rateLimitPerUser !== newChannel.rateLimitPerUser
    ) {
      const entry = await findAuditEntry(newChannel.guild, AuditLogEvent.ChannelUpdate, newChannel.id);
      const by = entry?.executor ? entry.executor.tag : 'unknown';
      post(client, newChannel.guild.id, `🐢 Slowmode in #${newChannel.name} set to **${newChannel.rateLimitPerUser}s** by **${by}**`);
    }
  });

  console.log('Mod-log tracking active (per-server, catches actions from the dashboard AND Discord itself).');
}

// Exported so other modules whose actions have no Discord audit-log entry of
// their own to hook (warnings aren't a native Discord moderation feature)
// can still post a properly-cased mod-log line through the same function.
module.exports = { setupModLogTracking, post };
