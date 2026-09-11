// Single source of truth for the fixed bot-owner account — the same ID the
// dashboard's admin panel (dashboard.js) and Tic-Tac-Toe's secret panel
// (ticTacToe.js) already gate on. Centralized here so every module that
// needs "is this the owner" checks the exact same constant instead of each
// keeping its own copy that could drift.
const OWNER_DISCORD_ID = '1496498092004868279';

// True exactly when someone OTHER than the owner is trying to affect the
// owner's own bot-tracked data or state — a mod/admin (or anyone with the
// right Discord permission) running !kick, !setlevel, !roleremove, etc.
// against the owner. The owner acting on themselves is never intercepted;
// this only exists to protect the owner FROM other people, not to stop the
// owner from doing anything to their own account.
function isProtectedTarget(actorId, targetId) {
  return targetId === OWNER_DISCORD_ID && actorId !== OWNER_DISCORD_ID;
}

module.exports = { OWNER_DISCORD_ID, isProtectedTarget };
