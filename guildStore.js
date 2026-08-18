// Generic helper for state that needs to be kept separate per Discord server. Every
// module that used to keep a flat JSON blob (counting, XP, warnings, tickets, ...)
// goes through here, keyed by whichever guild the triggering event belongs to.
//
// Backed by a Supabase Postgres table (`bot_state`) when SUPABASE_URL/SUPABASE_KEY
// are set, so state survives redeploys/restarts even on hosts with no persistent
// disk (e.g. Render's free tier). Reads/writes still happen against an in-memory
// cache for zero-latency synchronous access — Supabase is loaded into that cache
// once at startup (via `preloadAll`) and every `save()` pushes the current cache
// back up in the background. Falls back to a local JSON file (the original
// behavior) if Supabase isn't configured, so local dev still works with no setup.
const fs = require('fs');
const path = require('path');

let supabase = null;
try {
  if (process.env.SUPABASE_URL && process.env.SUPABASE_KEY) {
    const { createClient } = require('@supabase/supabase-js');
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  }
} catch (err) {
  console.error('Could not set up Supabase client, falling back to local file storage only:', err.message);
}

const registeredStores = []; // for preloadAll()

function makeGuildStore(fileName, makeDefaults) {
  const STATE_FILE = path.join(__dirname, fileName);
  let all = {};

  function loadLocal() {
    try {
      all = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch {
      all = {};
    }
  }

  function saveLocal() {
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify(all, null, 2));
    } catch {
      // Read-only filesystem (e.g. some hosts) — Supabase is the real source of
      // truth when configured, so a failed local write here is not fatal.
    }
  }

  async function loadFromSupabase() {
    if (!supabase) {
      loadLocal();
      return;
    }
    try {
      const { data, error } = await supabase.from('bot_state').select('guild_id, data').eq('store_name', fileName);
      if (error) throw error;
      all = {};
      for (const row of data) all[row.guild_id] = row.data;
    } catch (err) {
      console.error(`Could not load "${fileName}" from Supabase, falling back to local file:`, err.message);
      loadLocal();
    }
  }

  async function persistAll() {
    if (!supabase) return;
    const rows = Object.entries(all).map(([guildId, data]) => ({
      store_name: fileName,
      guild_id: guildId,
      data,
      updated_at: new Date().toISOString(),
    }));
    if (rows.length === 0) return;
    try {
      const { error } = await supabase.from('bot_state').upsert(rows, { onConflict: 'store_name,guild_id' });
      if (error) throw error;
    } catch (err) {
      console.error(`Could not persist "${fileName}" to Supabase:`, err.message);
    }
  }

  function get(guildId) {
    const key = String(guildId);
    if (!all[key]) {
      all[key] = typeof makeDefaults === 'function' ? makeDefaults() : JSON.parse(JSON.stringify(makeDefaults));
    }
    return all[key];
  }

  function set(guildId, value) {
    all[String(guildId)] = value;
    save();
  }

  function save() {
    saveLocal();
    persistAll(); // fire-and-forget — synchronous callers don't need to wait on this
  }

  function allGuildIds() {
    return Object.keys(all);
  }

  registeredStores.push(loadFromSupabase);
  return { get, set, save, allGuildIds };
}

// Loads every registered store's data from Supabase into memory. Must be awaited
// once at startup, before the bot logs in / any command can run — otherwise the
// first reads would see empty defaults instead of the persisted data.
async function preloadAll() {
  await Promise.all(registeredStores.map((load) => load()));
  if (supabase) {
    console.log(`Loaded ${registeredStores.length} state store(s) from Supabase.`);
  } else {
    console.log('SUPABASE_URL/SUPABASE_KEY not set — using local JSON files only (state will NOT survive a redeploy on hosts without persistent disk).');
  }
}

module.exports = { makeGuildStore, preloadAll };
