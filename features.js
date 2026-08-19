// Per-server master on/off switches for entire feature modules — distinct
// from the fine-grained settings each module already has (e.g. automod's
// individual filters). This is the "just turn the whole thing off" layer:
// XP granting, counting, automod, anti-raid, activity tracking, mod-log
// tracking, sticky messages, auto-responses, and reaction roles all check
// isEnabled() first thing in their event handlers, before doing any work.
//
// Stored as an array of disabled feature keys on guildConfig (empty array =
// everything on, the historical default — adding this never silently
// disables anything for existing servers).
const guildConfig = require('./guildConfig');
const botSettings = require('./botSettings');

const FEATURES = [
  { key: 'xp', label: 'XP / Leveling', description: 'Members earn XP from chatting and appear on the leaderboard.' },
  { key: 'counting', label: 'Counting Game', description: 'The counting minigame in the configured channel.' },
  { key: 'automod', label: 'Auto-Moderation', description: 'Link/invite/caps/spam filtering (master switch — individual filters are still configured in Security).' },
  { key: 'antiRaid', label: 'Anti-Raid Monitoring', description: 'Detects and responds to mass-join raids.' },
  { key: 'activityTracking', label: 'Activity Tracking', description: 'Per-channel and per-member activity stats shown in Insights.' },
  { key: 'modLog', label: 'Mod-Log Tracking', description: 'Logs bans, kicks, role changes, and message deletions to the mod-log channel.' },
  { key: 'stickyMessages', label: 'Sticky Messages', description: 'Messages that stay pinned to the bottom of a channel.' },
  { key: 'autoResponses', label: 'Auto-Responses', description: 'Automatic replies when a message contains a trigger word.' },
  { key: 'reactionRoles', label: 'Reaction Roles', description: 'Reacting to a message to get/remove a role.' },
  { key: 'streamAlerts', label: 'Stream Alerts', description: 'Twitch go-live and YouTube new-video notifications.' },
];

function isEnabled(guildId, key) {
  if (botSettings.getGlobalDisabledFeatures().includes(key)) return false; // owner-level kill-switch wins over any per-server setting
  const disabled = guildConfig.getConfig(guildId).disabledFeatures || [];
  return !disabled.includes(key);
}

function setEnabled(guildId, key, enabled) {
  const config = guildConfig.getConfig(guildId);
  const disabled = new Set(config.disabledFeatures || []);
  if (enabled) disabled.delete(key);
  else disabled.add(key);
  return guildConfig.updateConfig(guildId, { disabledFeatures: [...disabled] });
}

function listWithState(guildId) {
  const disabled = new Set(guildConfig.getConfig(guildId).disabledFeatures || []);
  const globalDisabled = new Set(botSettings.getGlobalDisabledFeatures());
  return FEATURES.map((f) => ({
    ...f,
    enabled: !disabled.has(f.key) && !globalDisabled.has(f.key),
    globallyDisabled: globalDisabled.has(f.key), // this server's own toggle can't override it — shown as a note in the UI
  }));
}

module.exports = { FEATURES, isEnabled, setEnabled, listWithState };
