// Shared placeholder variables usable in custom commands, auto-responses,
// and the dashboard's "Send a Message" — one place defining what each
// {token} means, so all three features stay consistent instead of each
// having their own slightly-different substitution logic.
//
// Context is optional and additive: pass `member` when a specific member
// triggered this (custom commands, auto-responses), and/or `channel` when a
// specific channel is involved. Any placeholder whose context wasn't
// provided (e.g. {user} with no member — the dashboard's "Send a Message"
// isn't triggered by any one member) is simply left untouched in the text
// rather than replaced with something confusing like an empty string, so an
// admin who left a user-placeholder in a message they wrote themselves sees
// exactly why it didn't get filled in.
function buildPlaceholderMap({ member, channel } = {}) {
  const guild = member?.guild || channel?.guild;
  const user = member?.user;
  const now = new Date();
  const map = {};

  if (member) {
    map['{user}'] = `${member}`;
    map['{username}'] = user?.tag || user?.username || '';
    map['{userid}'] = user?.id || '';
    map['{useravatar}'] = user?.displayAvatarURL?.({ size: 128 }) || '';
  }
  if (guild) {
    map['{server}'] = guild.name;
    map['{serverid}'] = guild.id;
    map['{servericon}'] = guild.iconURL?.({ size: 128 }) || '';
    map['{membercount}'] = String(guild.memberCount);
    map['{boostcount}'] = String(guild.premiumSubscriptionCount || 0);
    map['{rolecount}'] = String(guild.roles.cache.size);
  }
  if (channel) {
    map['{channelname}'] = channel.name || '';
    map['{channelmention}'] = `${channel}`;
  }
  map['{date}'] = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  map['{time}'] = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

  return map;
}

function fillPlaceholders(text, context = {}) {
  if (!text) return text;
  const map = buildPlaceholderMap(context);
  let result = text;
  for (const [token, value] of Object.entries(map)) result = result.replaceAll(token, value);
  return result;
}

module.exports = { fillPlaceholders };
