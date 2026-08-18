// Per-server raid detection and lockdown. Join bursts are tracked independently per
// server, and a lockdown only ever touches the server it was triggered for.
const guildConfig = require('./guildConfig');
const features = require('./features');

const JOIN_WINDOW_MS = 10000;
const JOIN_THRESHOLD = 5;

let clientRef = null;
const recentJoinsByGuild = new Map(); // guildId -> [timestamps]

async function alertModLogs(guildId, text) {
  const modLogsChannelId = guildConfig.getConfig(guildId).modLogsChannelId;
  if (!modLogsChannelId) return;
  try {
    const channel = await clientRef.channels.fetch(modLogsChannelId);
    await channel.send(text);
  } catch (err) {
    console.error('Anti-raid could not post to mod-logs:', err.message);
  }
}

function setupAntiRaid(client) {
  clientRef = client;

  client.on('guildMemberAdd', (member) => {
    const guildId = member.guild.id;
    if (!features.isEnabled(guildId, 'antiRaid')) return;
    const now = Date.now();
    const recentJoins = (recentJoinsByGuild.get(guildId) || []).filter((t) => now - t < JOIN_WINDOW_MS);
    recentJoins.push(now);
    recentJoinsByGuild.set(guildId, recentJoins);

    if (recentJoins.length >= JOIN_THRESHOLD) {
      alertModLogs(
        guildId,
        `🚨 **Possible raid detected:** ${recentJoins.length} members joined within ${JOIN_WINDOW_MS / 1000}s. Consider using the Lockdown button on the dashboard.`
      );
      recentJoinsByGuild.set(guildId, []);
    }
  });

  console.log('Anti-raid join monitoring active (per-server).');
}

async function setLockdown(guildId, locked) {
  const guild = clientRef.guilds.cache.get(guildId);
  if (!guild) throw new Error('Guild not found');

  const textChannels = guild.channels.cache.filter((c) => c.isTextBased() && !c.isVoiceBased());
  let count = 0;
  for (const channel of textChannels.values()) {
    try {
      await channel.permissionOverwrites.edit(guild.roles.everyone, {
        SendMessages: locked ? false : null,
      });
      count += 1;
    } catch {
      // missing permission on this specific channel, skip it
    }
  }

  await alertModLogs(guildId, locked ? `🔒 **Server-wide lockdown enabled** (${count} channels).` : `🔓 **Lockdown lifted** (${count} channels).`);
  return count;
}

module.exports = { setupAntiRaid, setLockdown };
