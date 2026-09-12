// Optional per-server "level tier" roles — e.g. Level 1-4, Level 5-24, Level 25-49.
// Off by default. When a server owner turns it on from the dashboard, the bot
// auto-creates one role per tier (if it hasn't already) and from then on keeps
// each member wearing exactly the one tier role that matches their current
// level, swapping it out automatically on every level-up.
const guildConfig = require('./guildConfig');

const DEFAULT_TIERS = [
  { minLevel: 1, maxLevel: 4, name: 'Level 1-4' },
  { minLevel: 5, maxLevel: 24, name: 'Level 5-24' },
  { minLevel: 25, maxLevel: 49, name: 'Level 25-49' },
  { minLevel: 50, maxLevel: 99, name: 'Level 50-99' },
  { minLevel: 100, maxLevel: null, name: 'Level 100+' },
];

function getTiers(guildId) {
  const config = guildConfig.getConfig(guildId);
  return Array.isArray(config.levelRoleTiers) && config.levelRoleTiers.length
    ? config.levelRoleTiers
    : DEFAULT_TIERS;
}

function tierForLevel(tiers, level) {
  return tiers.find((t) => level >= t.minLevel && (t.maxLevel == null || level <= t.maxLevel)) || null;
}

// Creates any tier role that doesn't have a saved ID yet (or whose saved role was
// deleted since). Safe to call repeatedly — idempotent once every tier has a role.
async function ensureRolesExist(guild) {
  const config = guildConfig.getConfig(guild.id);
  const tiers = getTiers(guild.id);
  const roleMap = { ...(config.levelRoleMap || {}) };
  for (const tier of tiers) {
    const existingId = roleMap[tier.name];
    if (existingId && guild.roles.cache.has(existingId)) continue;
    try {
      const role = await guild.roles.create({
        name: tier.name,
        mentionable: false,
        reason: 'Auto-created level-role tier (XP/leveling)',
      });
      roleMap[tier.name] = role.id;
    } catch (err) {
      console.error(`Could not create level-role tier "${tier.name}" for guild ${guild.id}:`, err.message);
    }
  }
  guildConfig.updateConfig(guild.id, { levelRoleMap: roleMap });
  return roleMap;
}

// Turns the feature on/off for a server. Enabling immediately creates any
// missing tier roles; disabling just stops future syncing — it never deletes
// roles or strips them from members, since a mod may still want to keep them.
async function setEnabled(guild, enabled) {
  guildConfig.updateConfig(guild.id, { levelRolesEnabled: !!enabled });
  if (enabled) await ensureRolesExist(guild);
}

// Called on every level-up (text or voice). Adds the member's current tier
// role and removes any other tier role they're wearing, so exactly one tier
// role is ever active at a time. No-op entirely when the feature is off.
async function syncMemberLevelRole(guild, member, level) {
  const config = guildConfig.getConfig(guild.id);
  if (!config.levelRolesEnabled) return;

  const tiers = getTiers(guild.id);
  const roleMap = config.levelRoleMap || {};
  const currentTier = tierForLevel(tiers, level);
  const targetRoleId = currentTier ? roleMap[currentTier.name] : null;
  const allTierRoleIds = new Set(Object.values(roleMap).filter(Boolean));

  try {
    const toRemove = member.roles.cache.filter((r) => allTierRoleIds.has(r.id) && r.id !== targetRoleId);
    for (const role of toRemove.values()) {
      await member.roles.remove(role).catch(() => {});
    }
    if (targetRoleId && !member.roles.cache.has(targetRoleId)) {
      await member.roles.add(targetRoleId).catch(() => {});
    }
  } catch (err) {
    console.error(`Could not sync level role for member ${member.id} in guild ${guild.id}:`, err.message);
  }
}

module.exports = { DEFAULT_TIERS, getTiers, tierForLevel, ensureRolesExist, setEnabled, syncMemberLevelRole };
