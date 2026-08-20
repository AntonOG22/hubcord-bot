// AI-powered automod: a fast, cheap Mistral model looks at each message
// against the server's own rules (a custom system prompt + a strictness
// level) and can act on its own — delete, warn, timeout, and only kick/ban
// once a server has explicitly opted into "strict" mode. Runs alongside
// (not instead of) the rule-based filters in automod.js, and shares that
// module's ignore list (roles/channels exempt from automod entirely).
//
// Uses its OWN Mistral API key (MISTRAL_AUTOMOD_API_KEY) and its own,
// smaller/cheaper model — separate from the dashboard's AI agent
// (aiAgent.js, mistral-large-latest) — so the two features' usage and cost
// never mix, and this one runs on every eligible chat message while that
// one only runs when someone actively opens the AI chat widget.
//
// Safety rails, in order:
//   1. Per-server opt-in switch (off by default).
//   2. Per-guild rate limit — this model only ever sees a bounded number of
//      messages per minute, no matter how busy the server is.
//   3. Action is capped by the server's chosen strictness level, regardless
//      of what the model itself decides — a "lenient" server can never get
//      an autonomous kick/ban no matter what the model outputs.
//   4. If the API errors or is unreachable, automod backs off for a minute
//      and posts one clear, non-spammy notice to mod-logs instead of
//      retrying every message or going silent.
const { EmbedBuilder } = require('discord.js');
const { makeGuildStore, safeAssign } = require('./guildStore');
const guildConfig = require('./guildConfig');
const features = require('./features');
const warnings = require('./warnings');
const automod = require('./automod');
const { sendModerationDm } = require('./moderationDm');
const botActionRegistry = require('./botActionRegistry');
const { brandFooter } = require('./brand');

const MISTRAL_URL = 'https://api.mistral.ai/v1/chat/completions';
const MODEL = 'mistral-small-latest'; // fast + cheap by design — this runs on live chat, not a one-off reply
const MEMORY_MAX_NOTES_PER_USER = 5;

const RATE_LIMIT_MAX = 20; // messages sent to the model per guild per minute, max
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const rateHits = new Map(); // guildId -> timestamps[]

const OUTAGE_BACKOFF_MS = 60 * 1000;
let outageUntil = 0;
let outageNotifiedAt = 0;

const configStore = makeGuildStore('ai-automod-config.json', () => ({
  enabled: false,
  systemPrompt: '', // extra server-specific rules, appended to the base prompt below
  strictness: 'moderate', // 'lenient' | 'moderate' | 'strict'
}));

const memoryStore = makeGuildStore('ai-automod-memory.json', () => ({})); // userId -> { notes: [{time, summary}] }

const STRICTNESS_GUIDANCE = {
  lenient: 'Be lenient — only flag clear, unambiguous violations (slurs, explicit threats, obvious spam/scam links). Give the benefit of the doubt on anything borderline or ambiguous.',
  moderate: 'Be reasonably strict — flag clear rule violations and repeated minor ones, but don\'t nitpick harmless banter or jokes between friends.',
  strict: 'Be strict — flag violations promptly, including borderline harassment, persistent minor rule-breaking, and anything that could make other members uncomfortable.',
};

// The action a model is even ALLOWED to pick is capped here regardless of
// what it outputs — this is enforced in code (capAction below), not just
// requested in the prompt, so a bad/hallucinated model response can never
// exceed what the server explicitly opted into.
const STRICTNESS_CAP = { lenient: 'warn', moderate: 'timeout', strict: 'ban' };
const ACTION_RANK = { none: 0, delete: 1, warn: 2, timeout: 3, kick: 4, ban: 5 };

function capAction(action, strictness) {
  const cap = STRICTNESS_CAP[strictness] || 'timeout';
  if ((ACTION_RANK[action] ?? 0) > (ACTION_RANK[cap] ?? 0)) return cap;
  return action;
}

const BASE_PROMPT = `You are an AI moderation assistant for a Discord server. You will be shown one chat message and must decide whether it violates the server's rules.

Respond with ONLY a JSON object, no other text, in exactly this shape:
{"violates": boolean, "severity": "none"|"low"|"medium"|"high", "reason": "short reason, one sentence", "action": "none"|"delete"|"warn"|"timeout"|"kick"|"ban"}

Guidance for "action":
- "none" if violates is false.
- Prefer the mildest effective action. Reserve kick/ban for severe, unambiguous cases only.
- If genuinely unsure whether it's a real violation, set violates to false rather than guessing.

Strictness level for this server: {{strictness}}
{{strictnessGuidance}}
{{memoryContext}}{{customPrompt}}`;

function buildMemoryContext(guildId, userId) {
  const mem = memoryStore.get(guildId)[userId];
  if (!mem || mem.notes.length === 0) return '';
  const recent = mem.notes.slice(-3).map((n) => `- ${n.summary}`).join('\n');
  return `\nRecent moderation history for this specific user (use to judge repeat behavior, don't over-weight a single old note):\n${recent}\n`;
}

function recordMemory(guildId, userId, summary) {
  const mem = memoryStore.get(guildId);
  const entry = mem[userId] || { notes: [] };
  entry.notes.push({ time: new Date().toISOString(), summary });
  if (entry.notes.length > MEMORY_MAX_NOTES_PER_USER) entry.notes = entry.notes.slice(-MEMORY_MAX_NOTES_PER_USER);
  mem[userId] = entry;
  memoryStore.save();
}

function isRateLimited(guildId) {
  const now = Date.now();
  const hits = (rateHits.get(guildId) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (hits.length >= RATE_LIMIT_MAX) {
    rateHits.set(guildId, hits);
    return true;
  }
  hits.push(now);
  rateHits.set(guildId, hits);
  return false;
}

async function notifyOutage(client, guildId) {
  // At most one notice every OUTAGE_BACKOFF_MS window — never a message per
  // failed classification, which could otherwise flood mod-logs if Mistral
  // is down for an extended stretch.
  if (Date.now() - outageNotifiedAt < OUTAGE_BACKOFF_MS) return;
  outageNotifiedAt = Date.now();
  const modLogsChannelId = guildConfig.getConfig(guildId).modLogsChannelId;
  if (!modLogsChannelId) return;
  try {
    const channel = await client.channels.fetch(modLogsChannelId);
    await channel.send('⚠️ Automod AI is currently unavailable. We apologize for the inconvenience — the rest of automod (link/word filters, etc.) is unaffected and still active.');
  } catch {
    // best-effort only, never let a notification failure cascade
  }
}

async function classify(apiKey, config, guildId, userId, content) {
  const prompt = BASE_PROMPT
    .replace('{{strictness}}', config.strictness)
    .replace('{{strictnessGuidance}}', STRICTNESS_GUIDANCE[config.strictness] || STRICTNESS_GUIDANCE.moderate)
    .replace('{{memoryContext}}', buildMemoryContext(guildId, userId))
    .replace('{{customPrompt}}', config.systemPrompt ? `\nAdditional server-specific rules from this server's admins:\n${config.systemPrompt}\n` : '');

  const res = await fetch(MISTRAL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: content.slice(0, 2000) },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1,
      max_tokens: 200,
    }),
  });

  if (!res.ok) throw new Error(`Mistral automod request failed: ${res.status}`);
  const data = await res.json();
  const raw = data.choices?.[0]?.message?.content;
  if (!raw) throw new Error('Mistral automod returned no content');
  return JSON.parse(raw);
}

async function handleMessage(client, message) {
  const guildId = message.guild.id;
  if (!features.isEnabled(guildId, 'aiAutomod')) return;
  const config = configStore.get(guildId);
  if (!config.enabled) return;
  if (!message.member || message.member.permissions.has('ManageMessages')) return; // staff exempt
  if (automod.isIgnored(guildId, message)) return;
  if (!message.content || message.content.trim().length < 3) return; // nothing meaningful to classify

  const apiKey = process.env.MISTRAL_AUTOMOD_API_KEY;
  if (!apiKey) return; // not configured on this bot instance — silently inert, same pattern as e.g. Twitch alerts

  if (Date.now() < outageUntil) return;
  if (isRateLimited(guildId)) return;

  let result;
  try {
    result = await classify(apiKey, config, guildId, message.author.id, message.content);
  } catch (err) {
    console.error('AI automod classification failed:', err.message);
    outageUntil = Date.now() + OUTAGE_BACKOFF_MS;
    await notifyOutage(client, guildId);
    return;
  }

  if (!result || !result.violates) return;
  const action = capAction(result.action || 'none', config.strictness);
  if (action === 'none') return;

  try {
    await message.delete().catch(() => {});
    const reasonLabel = `AI automod: ${result.reason}`;
    if (action === 'warn') {
      await warnings.addWarning(client, message.guild, message.author.id, reasonLabel, 'AI Automod');
    } else if (action === 'timeout') {
      botActionRegistry.markAutomated(guildId, message.author.id, 'timeout');
      await message.member.timeout(10 * 60 * 1000, reasonLabel);
      await sendModerationDm(client, message.member, message.guild.name, { action: 'timeout', reason: reasonLabel, moderatorTag: 'AI Automod', durationText: '10 minutes' });
    } else if (action === 'kick') {
      await message.member.kick(reasonLabel);
    } else if (action === 'ban') {
      botActionRegistry.markAutomated(guildId, message.author.id, 'ban');
      await sendModerationDm(client, message.member, message.guild.name, { action: 'ban', reason: reasonLabel, moderatorTag: 'AI Automod' });
      await message.member.ban({ reason: reasonLabel });
    }
  } catch (err) {
    console.error('AI automod action failed:', err.message);
  }

  recordMemory(guildId, message.author.id, `${new Date().toLocaleDateString()}: ${result.severity} severity — ${result.reason} (action: ${action})`);

  const modLogsChannelId = guildConfig.getConfig(guildId).modLogsChannelId;
  if (modLogsChannelId) {
    try {
      const channel = await client.channels.fetch(modLogsChannelId);
      const embed = new EmbedBuilder()
        .setColor(0x9b59b6)
        .setTitle('🤖 AI Automod Action')
        .setDescription(`**User:** ${message.author}\n**Channel:** ${message.channel}\n**Severity:** ${result.severity}\n**Action:** ${action}\n**Reason:** ${result.reason}`)
        .setFooter(brandFooter(client))
        .setTimestamp();
      await channel.send({ embeds: [embed] });
    } catch (err) {
      console.error('AI automod could not post to mod-logs:', err.message);
    }
  }
}

function setupAiAutomod(client) {
  client.on('messageCreate', (message) => {
    if (message.author.bot || !message.guild) return;
    handleMessage(client, message).catch((err) => console.error('AI automod handler crashed:', err.message));
  });
  console.log(
    process.env.MISTRAL_AUTOMOD_API_KEY
      ? 'AI automod active (Mistral-powered, per-server opt-in).'
      : 'MISTRAL_AUTOMOD_API_KEY not set — AI automod is disabled bot-wide until it\'s configured.'
  );
}

function getConfig(guildId) {
  return configStore.get(guildId);
}

function updateConfig(guildId, patch) {
  const config = safeAssign(configStore.get(guildId), patch);
  configStore.save();
  return config;
}

function isConfigured() {
  return !!process.env.MISTRAL_AUTOMOD_API_KEY;
}

module.exports = { setupAiAutomod, getConfig, updateConfig, isConfigured };
