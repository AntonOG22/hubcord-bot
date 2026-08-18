// Tracks recent member join/leave events in memory for the dashboard's activity feed,
// kept separate per server so switching servers in the dashboard shows that server's
// own joins/leaves.
const MAX_EVENTS = 100;
const eventsByGuild = new Map(); // guildId -> events[]

function record(guildId, type, member) {
  const events = eventsByGuild.get(guildId) || [];
  events.unshift({
    type, // 'join' | 'leave'
    time: new Date().toISOString(),
    tag: member.user?.tag || member.tag || 'Unknown',
    id: member.id,
    avatar: member.user?.displayAvatarURL?.({ size: 64 }) || null,
  });
  if (events.length > MAX_EVENTS) events.length = MAX_EVENTS;
  eventsByGuild.set(guildId, events);
}

function setupActivityTracking(client) {
  client.on('guildMemberAdd', (member) => record(member.guild.id, 'join', member));
  client.on('guildMemberRemove', (member) => record(member.guild.id, 'leave', member));
}

function getEvents(guildId) {
  return eventsByGuild.get(guildId) || [];
}

module.exports = { setupActivityTracking, getEvents };
