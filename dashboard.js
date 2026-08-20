// The public multi-tenant dashboard. Anyone can visit it, but every action requires:
//   1. A real Discord login (OAuth2 Authorization Code flow) — no shared password.
//   2. Discord itself confirming, on every single request, that the logged-in user
//      currently has Manage Server (or Administrator, or is the owner) on the guild
//      they're trying to act on — re-checked live, never trusted from a stale cookie.
//   3. The bot actually being a member of that guild.
// A user who fails any of these gets a 401/403 — there is no path from "logged in"
// to "can touch guild X" that skips this chain. See requireGuildAccess() below.
const path = require('path');
const multer = require('multer');
const crypto = require('crypto');
const express = require('express');
const cookieSession = require('cookie-session');
const { ChannelType, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { getAuthorizeUrl, exchangeCode, fetchDiscordUser, fetchUserGuilds, hasManagePermission } = require('./auth');
const { getEvents } = require('./activity');
const auditLog = require('./auditLog');
const { getCountingState, resetCountingState } = require('./counting');
const warnings = require('./warnings');
const xpSystem = require('./xpSystem');
const stickyMessages = require('./stickyMessages');
const autoResponses = require('./autoResponses');
const giveaways = require('./giveaways');
const reminders = require('./reminders');
const automod = require('./automod');
const antiRaid = require('./antiRaid');
const funCommands = require('./funCommands');
const reactionRoles = require('./reactionRoles');
const stats = require('./stats');
const verificationGate = require('./verificationGate');
const commandConfig = require('./commandConfig');
const { commands: commandList } = require('./commandRegistry');
const guildConfig = require('./guildConfig');
const tickets = require('./tickets');
const rateCommands = require('./rateCommands');
const rolePanels = require('./rolePanels');
const aiAgent = require('./aiAgent');
const customCommands = require('./customCommands');
const { brandFooter } = require('./brand');
const botSettings = require('./botSettings');
const features = require('./features');
const joinLeaveMessages = require('./joinLeaveMessages');
const imageUpload = require('./imageUpload');
const streamAlerts = require('./streamAlerts');
const aiAutomod = require('./aiAutomod');
const { sendModerationDm } = require('./moderationDm');
const { fillPlaceholders } = require('./placeholders');
const helmet = require('helmet');

const PERMISSION_NAMES = Object.fromEntries(
  Object.entries(PermissionFlagsBits).map(([name, bit]) => [bit.toString(), name])
);
function permissionLabel(bit) {
  return bit ? PERMISSION_NAMES[bit.toString()] || 'Unknown permission' : null;
}

const ANNOUNCEMENT_TEMPLATES = {
  maintenance: {
    title: '🛠️ Scheduled Maintenance',
    description: 'The server is going down for scheduled maintenance. We will let you know when it is back.',
    color: 0xed4245,
  },
  event: {
    title: '🎉 Event Starting Soon',
    description: 'Something fun is about to happen — jump in now!',
    color: 0x57f287,
  },
};

const NUMBER_EMOJI = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

// Fixed template for official cross-server announcements sent from the owner
// admin panel. Deliberately NOT configurable through any input field (color,
// author name/icon, and footer text are hardcoded here, not accepted from
// the request body) — the only things an owner can vary are the title and
// message text. That's what makes these recognizable as genuinely official:
// no server admin can produce this exact look through anything the dashboard
// exposes to them, because the /api/admin/announcement route itself is
// behind requireOwner and this template is baked into server code, not data.
function buildOfficialAnnouncementEmbed(client, { title, message }) {
  const botAvatar = client.user?.displayAvatarURL({ size: 128 }) || null;
  return new EmbedBuilder()
    .setColor(0x2ecc71)
    .setAuthor({ name: 'Emerald — Official Announcement', iconURL: botAvatar || undefined })
    .setTitle(`📢 ${title}`)
    .setDescription(message)
    .setFooter({ text: '✅ Verified official message — sent directly by the Emerald team', iconURL: botAvatar || undefined })
    .setTimestamp();
}

// The single Discord user ID allowed into the owner/admin panel. This is a
// server-side constant, never read from anything the client sends — the
// browser has no way to influence this value. Access is decided purely by
// req.session.userId, which itself comes only from a completed Discord OAuth
// login and lives in a cookie signed with DASHBOARD_SESSION_SECRET. A client
// cannot forge or edit that cookie without the signing secret, so there is no
// request the browser can construct that passes this check while lying about
// who's logged in — this is a real server-side gate, not a UI toggle.
const OWNER_DISCORD_ID = '1496498092004868279';

// Discord's user-guilds endpoint is rate-limited and doesn't change often — cache
// each user's guild list for a short window instead of re-fetching on every request.
const GUILD_CACHE_MS = 30 * 1000;
const guildListCache = new Map(); // userId -> { guilds, fetchedAt }

function startDashboard(client, { port, clientId, clientSecret, sessionSecret, publicUrl }) {
  const app = express();
  app.set('trust proxy', 1); // Render sits behind a proxy; needed for secure cookies
  app.disable('x-powered-by'); // don't hand an attacker a free "this is Express" fingerprint

  // Standard security headers (the set an audit like Mozilla Observatory
  // checks for): CSP, HSTS, frame-ancestors (replaces X-Frame-Options),
  // nosniff, a strict referrer policy, and same-origin resource policy.
  // Scoped tightly to what this dashboard actually loads — there are no
  // inline <script> tags anywhere (only the external app.js), so script-src
  // stays fully locked down with no 'unsafe-inline'/'unsafe-eval'. The
  // markup does have plain style="" attributes scattered around (small
  // margin tweaks), which need 'unsafe-inline' on style-src specifically —
  // CSS alone can't execute JS, a much lower bar than allowing it for
  // scripts, so this is a deliberate, narrow exception, not a blanket one.
  const supabaseOrigin = (() => {
    try {
      return process.env.SUPABASE_URL ? new URL(process.env.SUPABASE_URL).origin : null;
    } catch {
      return null;
    }
  })();
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
          fontSrc: ["'self'", 'https://fonts.gstatic.com'],
          imgSrc: ["'self'", 'data:', 'https://cdn.discordapp.com', 'https://media.discordapp.net', ...(supabaseOrigin ? [supabaseOrigin] : [])],
          connectSrc: ["'self'"],
          frameAncestors: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          objectSrc: ["'none'"],
          upgradeInsecureRequests: [],
        },
      },
      crossOriginResourcePolicy: { policy: 'same-origin' },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      // Deliberately more conservative than helmet's 2-year default while
      // this is still fresh — easy to raise later, hard to walk back once
      // browsers have cached a long max-age. Not submitting to the HSTS
      // preload list: this runs on a shared onrender.com hostname, not a
      // domain we independently control end-to-end.
      hsts: { maxAge: 15552000, includeSubDomains: true, preload: false },
    })
  );

  app.use(express.json());
  app.use(
    cookieSession({
      name: 'session',
      keys: [sessionSecret],
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
    })
  );
  app.use(express.static(path.join(__dirname, 'public')));

  const startedAt = Date.now();

  function getRedirectUri(req) {
    return `${publicUrl || `${req.protocol}://${req.get('host')}`}/auth/callback`;
  }

  function audit(guildId, action, detail) {
    auditLog.record(guildId, action, detail);
  }

  async function getManageableGuilds(userId, accessToken) {
    const cached = guildListCache.get(userId);
    if (cached && Date.now() - cached.fetchedAt < GUILD_CACHE_MS) return cached.guilds;

    const raw = await fetchUserGuilds(accessToken);
    const manageable = raw.filter(hasManagePermission);
    guildListCache.set(userId, { guilds: manageable, fetchedAt: Date.now() });
    return manageable;
  }

  // ---------- Auth (Discord OAuth2) ----------

  function requireAuth(req, res, next) {
    if (!req.session?.userId) return res.status(401).json({ error: 'Not logged in' });
    // Re-checked on every request, not just at login — otherwise blocking
    // someone who already has a signed-in session (cookies last 30 days)
    // would have no effect until it happened to expire on its own.
    if (botSettings.isUserBlocked(req.session.userId)) {
      req.session = null;
      return res.status(403).json({ error: 'This account has been blocked from accessing the dashboard.' });
    }
    next();
  }

  // True only for a completed, real Discord login as the one hardcoded owner
  // ID above. Nothing about this can be influenced by request headers, query
  // params, or body — it reads exclusively from the signed session cookie.
  function isOwner(req) {
    return req.session?.userId === OWNER_DISCORD_ID;
  }

  // Gate for the owner-only admin panel. Every /api/admin/* route uses this —
  // anyone else gets a flat 403, logged in or not, no matter what they send.
  function requireOwner(req, res, next) {
    if (!req.session?.userId) return res.status(401).json({ error: 'Not logged in' });
    if (!isOwner(req)) return res.status(403).json({ error: 'Owner access only' });
    next();
  }

  // Re-verifies, on every single guild-scoped request, that the logged-in user
  // currently has Manage Server on the requested guild AND the bot is present there.
  // This is the entire authorization boundary for the whole dashboard — nothing
  // downstream trusts the client to only ask for guilds it's allowed to touch.
  // The one exception: the hardcoded owner account, who is allowed onto any
  // guild the bot is in — still re-verified server-side on every request, the
  // same way, just against OWNER_DISCORD_ID instead of a Discord permission bit.
  async function requireGuildAccess(req, res, next) {
    if (!req.session?.userId) return res.status(401).json({ error: 'Not logged in' });
    if (botSettings.isUserBlocked(req.session.userId)) {
      req.session = null;
      return res.status(403).json({ error: 'This account has been blocked from accessing the dashboard.' });
    }

    const guildId = req.header('x-guild-id');
    if (!guildId) return res.status(400).json({ error: 'x-guild-id header is required' });

    const botGuild = client.guilds.cache.get(guildId);
    if (!botGuild) return res.status(403).json({ error: 'The bot is not in that server' });

    if (isOwner(req)) {
      req.guildId = guildId;
      req.guild = botGuild;
      return next();
    }

    try {
      const manageable = await getManageableGuilds(req.session.userId, req.session.accessToken);
      const allowed = manageable.some((g) => g.id === guildId);
      if (!allowed) return res.status(403).json({ error: "You don't manage that server" });
    } catch (err) {
      return res.status(401).json({ error: 'Discord session expired, please log in again' });
    }

    req.guildId = guildId;
    req.guild = botGuild;
    next();
  }

  // ---------- Login cooldown ----------
  // A failed login (bad/expired state, or Discord's token endpoint erroring —
  // including Discord's own global rate limit, which is exactly what repeated
  // rapid retries trip) puts that IP on a short, escalating cooldown. This
  // protects Discord's API from getting hammered by someone (or a bug)
  // retrying in a loop, which is what actually caused an outage once already.
  // Enforced here, server-side — /auth/login refuses to even start the
  // Discord round-trip while an IP is on cooldown, no matter what the client
  // does or doesn't send.
  const LOGIN_FAIL_THRESHOLD = 2;
  const LOGIN_LOCKOUT_MS = 3 * 60 * 1000;
  const loginAttempts = new Map(); // ip -> { fails, lockedUntil }

  function loginState(ip) {
    return loginAttempts.get(ip) || { fails: 0, lockedUntil: 0 };
  }
  function recordLoginFailure(ip) {
    const state = loginState(ip);
    state.fails += 1;
    if (state.fails >= LOGIN_FAIL_THRESHOLD) {
      state.lockedUntil = Date.now() + LOGIN_LOCKOUT_MS;
      state.fails = 0;
    }
    loginAttempts.set(ip, state);
  }
  function clearLoginFailures(ip) {
    loginAttempts.delete(ip);
  }

  // Simple per-user sliding-window rate limiter for endpoints that cost real
  // money or storage per call (Mistral AI requests, image uploads) — without
  // this, any logged-in user could hammer these in a loop and run up costs
  // or fill storage, even though they're otherwise correctly auth-gated.
  // Keyed by session userId (falls back to IP pre-login, though both routes
  // already require a session via requireGuildAccess).
  function makeRateLimiter({ windowMs, max }) {
    const hits = new Map(); // key -> array of timestamps
    return function rateLimit(req, res, next) {
      const key = req.session?.userId || req.ip;
      const now = Date.now();
      const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
      if (recent.length >= max) {
        const retryAfter = Math.ceil((windowMs - (now - recent[0])) / 1000);
        res.set('Retry-After', String(retryAfter));
        return res.status(429).json({ error: 'Too many requests, please slow down.', retryAfter });
      }
      recent.push(now);
      hits.set(key, recent);
      next();
    };
  }
  const aiChatRateLimit = makeRateLimiter({ windowMs: 60 * 1000, max: 12 }); // ~1 msg/5s sustained
  const uploadRateLimit = makeRateLimiter({ windowMs: 60 * 1000, max: 20 });

  app.get('/auth/login', (req, res) => {
    const state = loginState(req.ip);
    if (state.lockedUntil > Date.now()) {
      const retrySeconds = Math.ceil((state.lockedUntil - Date.now()) / 1000);
      return res.redirect(`/?auth_error=cooldown&retry=${retrySeconds}`);
    }

    const oauthState = crypto.randomBytes(16).toString('hex');
    req.session.oauthState = oauthState;
    res.redirect(getAuthorizeUrl({ clientId, redirectUri: getRedirectUri(req), state: oauthState }));
  });

  app.get('/auth/callback', async (req, res) => {
    const { code, state } = req.query;
    if (!code || !state || state !== req.session?.oauthState) {
      recordLoginFailure(req.ip);
      return res.redirect('/?auth_error=state');
    }
    req.session.oauthState = null;

    try {
      const token = await exchangeCode({ clientId, clientSecret, redirectUri: getRedirectUri(req), code });
      const user = await fetchDiscordUser(token.access_token);

      if (botSettings.isUserBlocked(user.id)) {
        recordLoginFailure(req.ip);
        return res.redirect('/?auth_error=blocked');
      }

      req.session.userId = user.id;
      req.session.username = `${user.username}${user.discriminator && user.discriminator !== '0' ? `#${user.discriminator}` : ''}`;
      req.session.avatar = user.avatar
        ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`
        : `https://cdn.discordapp.com/embed/avatars/${Number(BigInt(user.id) >> 22n) % 6}.png`;
      req.session.accessToken = token.access_token;

      clearLoginFailures(req.ip);
      res.redirect('/dashboard');
    } catch (err) {
      console.error('OAuth callback failed:', err.message);
      recordLoginFailure(req.ip);
      res.redirect('/?auth_error=failed');
    }
  });

  app.get('/auth/logout', (req, res) => {
    req.session = null;
    res.redirect('/');
  });

  app.get('/api/me', requireAuth, (req, res) => {
    res.json({
      userId: req.session.userId,
      username: req.session.username,
      avatar: req.session.avatar,
      isOwner: isOwner(req),
    });
  });

  // Every server the logged-in user manages, split by whether the bot is already
  // there — the "not yet" list powers the one-click "Add to this server" flow.
  // The owner additionally sees every server the bot is in at all, managed or not.
  app.get('/api/guilds', requireAuth, async (req, res) => {
    try {
      const manageable = await getManageableGuilds(req.session.userId, req.session.accessToken);
      const withBot = [];
      const withoutBot = [];
      const seen = new Set();
      for (const g of manageable) {
        const botGuild = client.guilds.cache.get(g.id);
        const entry = {
          id: g.id,
          name: g.name,
          icon: g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=64` : null,
          memberCount: botGuild?.memberCount ?? null,
        };
        seen.add(g.id);
        (botGuild ? withBot : withoutBot).push(entry);
      }
      if (isOwner(req)) {
        for (const botGuild of client.guilds.cache.values()) {
          if (seen.has(botGuild.id)) continue;
          withBot.push({
            id: botGuild.id,
            name: botGuild.name,
            icon: botGuild.iconURL({ size: 64 }),
            memberCount: botGuild.memberCount,
          });
        }
      }
      withBot.sort((a, b) => a.name.localeCompare(b.name));
      withoutBot.sort((a, b) => a.name.localeCompare(b.name));
      res.json({ withBot, withoutBot });
    } catch (err) {
      res.status(401).json({ error: 'Discord session expired, please log in again' });
    }
  });

  // ---------- Owner-only admin panel ----------
  // Everything under here is gated by requireOwner: a flat 403 for anyone whose
  // session isn't OWNER_DISCORD_ID, checked fresh on every single request.

  app.get('/api/admin/overview', requireOwner, (req, res) => {
    const guilds = [...client.guilds.cache.values()]
      .map((g) => ({
        id: g.id,
        name: g.name,
        icon: g.iconURL({ size: 64 }),
        memberCount: g.memberCount,
        boostTier: g.premiumTier,
      }))
      .sort((a, b) => b.memberCount - a.memberCount);

    res.json({
      botTag: client.user?.tag || null,
      botAvatar: client.user?.displayAvatarURL({ size: 128 }) || null,
      botPing: Math.round(client.ws.ping),
      botUptimeMs: Date.now() - startedAt,
      totalGuilds: guilds.length,
      totalMembers: guilds.reduce((sum, g) => sum + (g.memberCount || 0), 0),
      watermarkDisabled: botSettings.isWatermarkDisabled(),
      guilds,
    });
  });

  // Bot-wide, not per-server — turning this on removes the small "Emerald"
  // footer from every embed the bot sends, for every server, until turned
  // back off. Owner-only, same as everything else under /api/admin.
  app.post('/api/admin/watermark', requireOwner, (req, res) => {
    const { disabled } = req.body || {};
    const settings = botSettings.setWatermarkDisabled(!!disabled);
    audit('_global', 'Toggled bot watermark', settings.watermarkDisabled ? 'disabled' : 'enabled');
    res.json(settings);
  });

  // ---------- Global feature kill-switch ----------
  // Sits above each server's own per-guild toggle (features.js) — flipping
  // one of these off here disables it everywhere immediately, regardless of
  // what any individual server has it set to. Meant for shutting something
  // off fast (cost spike, abuse, a bug) without visiting every server.
  app.get('/api/admin/global-features', requireOwner, (req, res) => {
    const disabled = new Set(botSettings.getGlobalDisabledFeatures());
    res.json(features.FEATURES.map((f) => ({ ...f, enabled: !disabled.has(f.key) })));
  });

  app.post('/api/admin/global-features/:key/toggle', requireOwner, (req, res) => {
    const { key } = req.params;
    if (!features.FEATURES.some((f) => f.key === key)) return res.status(404).json({ error: 'Unknown feature' });
    const { enabled } = req.body || {};
    botSettings.setGlobalFeatureEnabled(key, !!enabled);
    audit('_global', 'Toggled global feature kill-switch', `${key}: ${enabled ? 'enabled' : 'disabled everywhere'}`);
    const disabled = new Set(botSettings.getGlobalDisabledFeatures());
    res.json(features.FEATURES.map((f) => ({ ...f, enabled: !disabled.has(f.key) })));
  });

  // ---------- Leave a server ----------
  // Removes the bot from a server entirely — for abusive or inactive
  // servers the owner wants gone without needing Discord's own app UI.
  app.delete('/api/admin/guilds/:guildId', requireOwner, async (req, res) => {
    const guild = client.guilds.cache.get(req.params.guildId);
    if (!guild) return res.status(404).json({ error: 'Server not found' });
    const name = guild.name;
    try {
      await guild.leave();
      audit('_global', 'Bot left a server', `${name} (${req.params.guildId})`);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message || 'Failed to leave server' });
    }
  });

  // ---------- Login blocklist ----------
  // Checked in /auth/callback, before any session is created — a blocked
  // user is turned away at login, never even getting a read-only session.
  app.get('/api/admin/blocked-users', requireOwner, (req, res) => {
    res.json({ blockedUserIds: botSettings.listBlockedUsers() });
  });

  app.post('/api/admin/blocked-users', requireOwner, (req, res) => {
    const { userId } = req.body || {};
    if (!userId || !/^\d{15,25}$/.test(String(userId))) return res.status(400).json({ error: 'A valid Discord user ID is required' });
    if (String(userId) === OWNER_DISCORD_ID) return res.status(400).json({ error: "You can't block the owner account" });
    const settings = botSettings.blockUser(userId);
    audit('_global', 'Blocked a user from logging in', String(userId));
    res.json({ blockedUserIds: settings.blockedUserIds });
  });

  app.delete('/api/admin/blocked-users/:userId', requireOwner, (req, res) => {
    const settings = botSettings.unblockUser(req.params.userId);
    audit('_global', 'Unblocked a user', req.params.userId);
    res.json({ blockedUserIds: settings.blockedUserIds });
  });

  // Text channels of ANY guild the bot is in (not just ones the owner personally
  // manages) — needed so the owner can pick a target for an official announcement
  // regardless of their own permissions there.
  app.get('/api/admin/guilds/:guildId/channels', requireOwner, (req, res) => {
    const guild = client.guilds.cache.get(req.params.guildId);
    if (!guild) return res.status(404).json({ error: 'Server not found' });
    const channels = guild.channels.cache
      .filter((c) => c.type === ChannelType.GuildText && c.viewable)
      .map((c) => ({ id: c.id, name: c.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ channels });
  });

  app.post('/api/admin/announcement', requireOwner, async (req, res) => {
    const { guildId, channelId, title, message } = req.body || {};
    if (!guildId || !channelId || !title || !message) {
      return res.status(400).json({ error: 'guildId, channelId, title, and message are all required' });
    }
    if (String(title).length > 200) return res.status(400).json({ error: 'Title is too long (max 200 characters)' });
    if (String(message).length > 4000) return res.status(400).json({ error: 'Message is too long (max 4000 characters)' });

    const guild = client.guilds.cache.get(guildId);
    if (!guild) return res.status(404).json({ error: 'Server not found' });
    const channel = guild.channels.cache.get(channelId);
    if (!channel || channel.type !== ChannelType.GuildText) return res.status(404).json({ error: 'Channel not found' });

    try {
      const embed = buildOfficialAnnouncementEmbed(client, { title: String(title), message: String(message) });
      await channel.send({ embeds: [embed] });
      audit(guildId, 'Sent official Emerald announcement', `#${channel.name}: ${title}`);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message || 'Failed to send announcement' });
    }
  });

  // Picks where a broadcast lands on one server, with no per-guild input —
  // this only runs for /api/admin/broadcast, which by design has no per-guild
  // channel selection (that's the whole point of "send to every server at
  // once"). Priority: a channel that looks like it's meant for announcements,
  // then one that looks like the server's general chat, then whichever text
  // channel has seen the most activity today, then just the first available
  // text channel — always finds somewhere to land rather than skipping a
  // server outright.
  function pickBroadcastChannel(guild) {
    const textChannels = [...guild.channels.cache.values()].filter(
      (c) => c.type === ChannelType.GuildText && c.viewable && c.permissionsFor(guild.members.me)?.has(PermissionFlagsBits.SendMessages)
    );
    if (textChannels.length === 0) return null;

    const byName = (re) => textChannels.find((c) => re.test(c.name));
    const announcements = byName(/announc|ank[uü]ndig|annonce/i);
    if (announcements) return announcements;

    const general = byName(/^general$|general-chat|allgemein|g[eé]n[eé]ral/i);
    if (general) return general;

    const counts = stats.getChannelCounts(guild.id); // [{channel: name, count}], most active first
    for (const { channel: name } of counts) {
      const match = textChannels.find((c) => c.name === name);
      if (match) return match;
    }

    return textChannels[0];
  }

  app.post('/api/admin/broadcast', requireOwner, async (req, res) => {
    const { title, message } = req.body || {};
    if (!title || !message) return res.status(400).json({ error: 'title and message are required' });
    if (String(title).length > 200) return res.status(400).json({ error: 'Title is too long (max 200 characters)' });
    if (String(message).length > 4000) return res.status(400).json({ error: 'Message is too long (max 4000 characters)' });

    const embed = buildOfficialAnnouncementEmbed(client, { title: String(title), message: String(message) });
    const results = [];

    for (const guild of client.guilds.cache.values()) {
      const channel = pickBroadcastChannel(guild);
      if (!channel) {
        results.push({ guildId: guild.id, guildName: guild.name, ok: false, error: 'No usable text channel' });
        continue;
      }
      try {
        await channel.send({ embeds: [embed] });
        audit(guild.id, 'Sent official Emerald broadcast', `#${channel.name}: ${title}`);
        results.push({ guildId: guild.id, guildName: guild.name, ok: true, channelName: channel.name });
      } catch (err) {
        results.push({ guildId: guild.id, guildName: guild.name, ok: false, error: err.message || 'Failed to send' });
      }
    }

    audit('_global', 'Sent official Emerald broadcast to all servers', `${results.filter((r) => r.ok).length}/${results.length} succeeded — ${title}`);
    res.json({ results });
  });

  app.get('/api/invite-url', requireAuth, (req, res) => {
    const guildId = req.query.guildId;
    const params = new URLSearchParams({
      client_id: clientId,
      scope: 'bot',
      permissions: '8', // Administrator — simplest default, matches the !invite command
    });
    if (guildId) params.set('guild_id', guildId);
    res.json({ url: `https://discord.com/oauth2/authorize?${params.toString()}` });
  });

  // ---------- Overview ----------

  app.get('/api/status', requireGuildAccess, (req, res) => {
    res.json({
      botTag: client.user?.tag || null,
      botAvatar: client.user?.displayAvatarURL({ size: 128 }) || null,
      botPing: Math.round(client.ws.ping),
      botUptimeMs: Date.now() - startedAt,
      guildName: req.guild.name,
      memberCount: req.guild.memberCount,
    });
  });

  app.get('/api/guild-info', requireGuildAccess, (req, res) => {
    const guild = req.guild;
    res.json({
      name: guild.name,
      icon: guild.iconURL({ size: 128 }) || null,
      memberCount: guild.memberCount,
      boostTier: guild.premiumTier,
      boostCount: guild.premiumSubscriptionCount || 0,
      createdAt: guild.createdAt,
      channelCount: guild.channels.cache.size,
      roleCount: guild.roles.cache.size,
    });
  });

  // Per-server display name only — Discord's own Change Nickname mechanism.
  // The bot's real username and avatar are unaffected, and this has no
  // effect on any other server the bot is in. Discord doesn't currently let
  // bots set a per-server profile picture at all (user accounts only), so
  // there's no equivalent avatar route here — see setNickname's own error
  // handling below for the one real failure mode (bot's own role too low).
  app.get('/api/bot-nickname', requireGuildAccess, (req, res) => {
    res.json({ nickname: req.guild.members.me?.nickname || null });
  });

  app.post('/api/bot-nickname', requireGuildAccess, async (req, res) => {
    const { nickname } = req.body || {};
    const clean = nickname == null ? null : String(nickname).trim().slice(0, 32) || null;
    try {
      await req.guild.members.me.setNickname(clean);
      audit(req.guildId, 'Changed bot nickname', clean || '(reset to default)');
      res.json({ nickname: clean });
    } catch (err) {
      res.status(400).json({ error: `Could not change nickname — the bot needs "Change Nickname" permission on this server. (${err.message})` });
    }
  });

  app.get('/api/channels', requireGuildAccess, (req, res) => {
    const channels = req.guild.channels.cache
      .filter((c) => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement)
      .map((c) => ({ id: c.id, name: c.name, parent: c.parent?.name || null }))
      .sort((a, b) => (a.parent || '').localeCompare(b.parent || ''));
    res.json(channels);
  });

  app.get('/api/categories', requireGuildAccess, (req, res) => {
    // Every category is listed regardless of whether it has any channels in it
    // yet — a brand-new, empty category is a completely valid destination for
    // a ticket panel or a channel about to be created.
    const categories = req.guild.channels.cache
      .filter((c) => c.type === ChannelType.GuildCategory)
      .map((c) => ({ id: c.id, name: c.name, channelCount: c.children?.cache.size ?? 0 }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json(categories);
  });

  app.post('/api/categories', requireGuildAccess, async (req, res) => {
    const { name } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
    try {
      const category = await req.guild.channels.create({ name: name.trim(), type: ChannelType.GuildCategory });
      audit(req.guildId, 'Created category', category.name);
      res.json({ id: category.id, name: category.name, channelCount: 0 });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/channels', requireGuildAccess, async (req, res) => {
    const { name, categoryId, type } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
    if (categoryId && !req.guild.channels.cache.has(categoryId)) return res.status(400).json({ error: 'That category is not in this server' });
    try {
      const channel = await req.guild.channels.create({
        name: name.trim(),
        type: type === 'voice' ? ChannelType.GuildVoice : ChannelType.GuildText,
        parent: categoryId || undefined,
      });
      audit(req.guildId, 'Created channel', `#${channel.name}`);
      res.json({ id: channel.id, name: channel.name, parent: channel.parent?.name || null });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/activity', requireGuildAccess, (req, res) => {
    res.json(getEvents(req.guildId));
  });

  app.get('/api/audit', requireGuildAccess, (req, res) => {
    res.json(auditLog.getEntries(req.guildId));
  });

  // ---------- Messaging ----------

  app.post('/api/send', requireGuildAccess, async (req, res) => {
    const { channelId, message, title, color, imageUrl } = req.body || {};
    if (!channelId || !message) return res.status(400).json({ error: 'channelId and message are required' });
    if (!req.guild.channels.cache.has(channelId)) return res.status(400).json({ error: 'That channel is not in this server' });

    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased()) return res.status(400).json({ error: 'Not a text channel' });

      // No specific member triggers this (an admin wrote it, not a member's
      // message), so only server/channel/date/time placeholders resolve —
      // user-specific ones like {user} are left untouched in the text. See
      // placeholders.js.
      const filledMessage = fillPlaceholders(message, { channel });
      const filledTitle = title ? fillPlaceholders(title, { channel }) : title;

      if (filledTitle || imageUrl) {
        const embed = new EmbedBuilder()
          .setDescription(filledMessage)
          .setColor(color ? parseInt(color.replace('#', ''), 16) : 0x3fe8d6)
          .setFooter(brandFooter(client))
          .setTimestamp();
        if (filledTitle) embed.setTitle(filledTitle);
        if (imageUrl) embed.setImage(imageUrl);
        await channel.send({ embeds: [embed] });
      } else {
        await channel.send({ content: filledMessage });
      }

      audit(req.guildId, 'Sent message', `#${channel.name}`);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/announce-template', requireGuildAccess, async (req, res) => {
    const { type } = req.body || {};
    const template = ANNOUNCEMENT_TEMPLATES[type];
    if (!template) return res.status(400).json({ error: 'Unknown template' });
    const announcementsChannelId = guildConfig.getConfig(req.guildId).announcementsChannelId;
    if (!announcementsChannelId) return res.status(400).json({ error: 'No announcements channel set for this server (see the Server tab)' });

    try {
      const channel = await client.channels.fetch(announcementsChannelId);
      const embed = new EmbedBuilder().setTitle(template.title).setDescription(template.description).setColor(template.color).setFooter(brandFooter(client)).setTimestamp();
      await channel.send({ content: '@everyone', embeds: [embed], allowedMentions: { parse: ['everyone'] } });
      audit(req.guildId, 'Sent announcement template', type);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/poll', requireGuildAccess, async (req, res) => {
    const { channelId, question, options } = req.body || {};
    if (!channelId || !question || !Array.isArray(options) || options.length < 2) {
      return res.status(400).json({ error: 'channelId, question, and at least 2 options are required' });
    }
    if (options.length > 10) return res.status(400).json({ error: 'Max 10 options' });
    if (!req.guild.channels.cache.has(channelId)) return res.status(400).json({ error: 'That channel is not in this server' });

    try {
      const channel = await client.channels.fetch(channelId);
      const description = options.map((opt, i) => `${NUMBER_EMOJI[i]} ${opt}`).join('\n\n');
      const embed = new EmbedBuilder().setTitle(`📊 ${question}`).setDescription(description).setColor(0x3fe8d6).setFooter(brandFooter(client)).setTimestamp();
      const msg = await channel.send({ embeds: [embed] });
      for (let i = 0; i < options.length; i++) await msg.react(NUMBER_EMOJI[i]);
      audit(req.guildId, 'Created poll', `"${question}" in #${channel.name}`);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/dm', requireGuildAccess, async (req, res) => {
    const { userId, message } = req.body || {};
    if (!userId || !message) return res.status(400).json({ error: 'userId and message are required' });
    // Only lets you DM someone who is actually a member of the server you manage —
    // otherwise this endpoint would let any dashboard user message an arbitrary
    // Discord user through the bot.
    try {
      const member = await req.guild.members.fetch(userId);
      await member.send(message);
      audit(req.guildId, 'Sent DM', member.user.tag);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: `Could not DM this member (${err.message})` });
    }
  });

  // ---------- Members & Moderation ----------

  app.get('/api/members', requireGuildAccess, async (req, res) => {
    const search = (req.query.search || '').toString().trim();
    try {
      const members = search
        ? await req.guild.members.fetch({ query: search, limit: 20 })
        : await req.guild.members.fetch({ limit: 25 });
      const list = [...members.values()].map((m) => ({
        id: m.id,
        tag: m.user.tag,
        avatar: m.user.displayAvatarURL({ size: 64 }),
        bot: m.user.bot,
        joinedAt: m.joinedAt,
        roles: m.roles.cache.filter((r) => r.id !== req.guild.id).map((r) => ({ id: r.id, name: r.name, color: r.hexColor })),
      }));
      res.json(list);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/moderation/kick', requireGuildAccess, async (req, res) => {
    const { userId, reason } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId is required' });
    try {
      const member = await req.guild.members.fetch(userId);
      const tag = member.user.tag;
      await member.kick(reason || 'No reason given');
      audit(req.guildId, 'Kicked member', `${tag} (${reason || 'no reason'})`);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/moderation/ban', requireGuildAccess, async (req, res) => {
    const { userId, reason, deleteMessageDays } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId is required' });
    try {
      const user = await client.users.fetch(userId);
      // Sent before the ban, not after — once banned, the bot and this user
      // very likely no longer share a server, and Discord won't reliably
      // deliver a DM at that point.
      await sendModerationDm(client, user, req.guild.name, { action: 'ban', reason, moderatorTag: req.session.username });
      await req.guild.members.ban(userId, {
        reason: reason || 'No reason given',
        deleteMessageSeconds: (parseInt(deleteMessageDays, 10) || 0) * 86400,
      });
      audit(req.guildId, 'Banned member', `${user.tag} (${reason || 'no reason'})`);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/moderation/unban', requireGuildAccess, async (req, res) => {
    const { userId } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId is required' });
    try {
      await req.guild.bans.remove(userId, 'Unbanned via dashboard');
      audit(req.guildId, 'Unbanned user', userId);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/moderation/bans', requireGuildAccess, async (req, res) => {
    try {
      const bans = await req.guild.bans.fetch();
      const list = [...bans.values()].map((b) => ({ id: b.user.id, tag: b.user.tag, avatar: b.user.displayAvatarURL({ size: 64 }), reason: b.reason || null }));
      res.json(list);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/moderation/timeout', requireGuildAccess, async (req, res) => {
    const { userId, minutes, reason } = req.body || {};
    if (!userId || !minutes) return res.status(400).json({ error: 'userId and minutes are required' });
    try {
      const member = await req.guild.members.fetch(userId);
      await member.timeout(parseInt(minutes, 10) * 60 * 1000, reason || 'No reason given');
      await sendModerationDm(client, member, req.guild.name, { action: 'timeout', reason, moderatorTag: req.session.username, durationText: `${minutes} minutes` });
      audit(req.guildId, 'Timed out member', `${member.user.tag} for ${minutes}m (${reason || 'no reason'})`);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/roles', requireGuildAccess, (req, res) => {
    const roles = req.guild.roles.cache
      .filter((r) => r.id !== req.guild.id)
      .sort((a, b) => b.position - a.position)
      .map((r) => ({ id: r.id, name: r.name, color: r.hexColor === '#000000' ? '#99aab5' : r.hexColor, memberCount: r.members.size, position: r.position }));
    res.json(roles);
  });

  app.post('/api/roles/add', requireGuildAccess, async (req, res) => {
    const { userId, roleId } = req.body || {};
    if (!userId || !roleId) return res.status(400).json({ error: 'userId and roleId are required' });
    if (!req.guild.roles.cache.has(roleId)) return res.status(400).json({ error: 'That role is not in this server' });
    try {
      const member = await req.guild.members.fetch(userId);
      const role = req.guild.roles.cache.get(roleId);
      await member.roles.add(roleId);
      audit(req.guildId, 'Added role', `${role?.name || roleId} → ${member.user.tag}`);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/roles/remove', requireGuildAccess, async (req, res) => {
    const { userId, roleId } = req.body || {};
    if (!userId || !roleId) return res.status(400).json({ error: 'userId and roleId are required' });
    try {
      const member = await req.guild.members.fetch(userId);
      const role = req.guild.roles.cache.get(roleId);
      await member.roles.remove(roleId);
      audit(req.guildId, 'Removed role', `${role?.name || roleId} ← ${member.user.tag}`);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/purge', requireGuildAccess, async (req, res) => {
    const { channelId, amount } = req.body || {};
    const count = Math.min(Math.max(parseInt(amount, 10) || 0, 1), 100);
    if (!channelId) return res.status(400).json({ error: 'channelId is required' });
    if (!req.guild.channels.cache.has(channelId)) return res.status(400).json({ error: 'That channel is not in this server' });
    try {
      const channel = await client.channels.fetch(channelId);
      const deleted = await channel.bulkDelete(count, true);
      audit(req.guildId, 'Purged messages', `${deleted.size} in #${channel.name}`);
      res.json({ ok: true, deleted: deleted.size });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/slowmode', requireGuildAccess, async (req, res) => {
    const { channelId, seconds } = req.body || {};
    if (!channelId) return res.status(400).json({ error: 'channelId is required' });
    if (!req.guild.channels.cache.has(channelId)) return res.status(400).json({ error: 'That channel is not in this server' });
    try {
      const channel = await client.channels.fetch(channelId);
      await channel.setRateLimitPerUser(parseInt(seconds, 10) || 0);
      audit(req.guildId, 'Set slowmode', `${seconds || 0}s in #${channel.name}`);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---------- Counting game ----------

  app.get('/api/counting/state', requireGuildAccess, (req, res) => {
    res.json(getCountingState(req.guildId));
  });

  app.post('/api/counting/reset', requireGuildAccess, (req, res) => {
    const state = resetCountingState(req.guildId);
    audit(req.guildId, 'Reset counting game', 'back to 1');
    res.json(state);
  });

  // ---------- Warnings ----------

  app.get('/api/warnings', requireGuildAccess, (req, res) => {
    res.json(warnings.getAllWarned(req.guildId));
  });

  app.get('/api/warnings/:userId', requireGuildAccess, (req, res) => {
    res.json(warnings.getWarnings(req.guildId, req.params.userId));
  });

  app.post('/api/warnings', requireGuildAccess, async (req, res) => {
    const { userId, reason } = req.body || {};
    if (!userId || !reason) return res.status(400).json({ error: 'userId and reason are required' });
    try {
      const member = await req.guild.members.fetch(userId);
      const result = await warnings.addWarning(client, req.guild, userId, reason, req.session.username);
      audit(req.guildId, 'Warned member', `${member.user.tag} (${reason})${result.autoTimedOut ? ' — auto-timed out' : ''}`);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/warnings/:userId', requireGuildAccess, (req, res) => {
    warnings.clearWarnings(req.guildId, req.params.userId);
    audit(req.guildId, 'Cleared warnings', req.params.userId);
    res.json({ ok: true });
  });

  // ---------- Leveling ----------

  app.get('/api/leaderboard', requireGuildAccess, (req, res) => {
    res.json(xpSystem.getLeaderboard(req.guildId, 15));
  });

  // ---------- Sticky messages ----------

  app.get('/api/sticky', requireGuildAccess, (req, res) => {
    res.json(stickyMessages.listStickies().filter((s) => req.guild.channels.cache.has(s.channelId)));
  });

  app.post('/api/sticky', requireGuildAccess, async (req, res) => {
    const { channelId, text } = req.body || {};
    if (!channelId || !text) return res.status(400).json({ error: 'channelId and text are required' });
    if (!req.guild.channels.cache.has(channelId)) return res.status(400).json({ error: 'That channel is not in this server' });
    try {
      await stickyMessages.setSticky(client, channelId, text);
      audit(req.guildId, 'Set sticky message', `#${channelId}`);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/sticky/:channelId', requireGuildAccess, async (req, res) => {
    if (!req.guild.channels.cache.has(req.params.channelId)) return res.status(400).json({ error: 'That channel is not in this server' });
    try {
      await stickyMessages.removeSticky(client, req.params.channelId);
      audit(req.guildId, 'Removed sticky message', `#${req.params.channelId}`);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---------- Auto-responses ----------

  app.get('/api/autoresponses', requireGuildAccess, (req, res) => {
    res.json(autoResponses.listResponses(req.guildId));
  });

  app.post('/api/autoresponses', requireGuildAccess, (req, res) => {
    const { trigger, reply } = req.body || {};
    if (!trigger || !reply) return res.status(400).json({ error: 'trigger and reply are required' });
    const entry = autoResponses.addResponse(req.guildId, trigger, reply);
    audit(req.guildId, 'Added auto-response', trigger);
    res.json(entry);
  });

  app.delete('/api/autoresponses/:id', requireGuildAccess, (req, res) => {
    autoResponses.removeResponse(req.guildId, req.params.id);
    audit(req.guildId, 'Removed auto-response', req.params.id);
    res.json({ ok: true });
  });

  app.post('/api/autoresponses/preset-rules', requireGuildAccess, (req, res) => {
    const entry = autoResponses.addResponse(req.guildId, 'rules', 'Check out our rules in the rules channel! 📜');
    audit(req.guildId, 'Added preset auto-response', 'rules');
    res.json(entry);
  });

  // ---------- Giveaways ----------

  app.get('/api/giveaways', requireGuildAccess, (req, res) => {
    res.json(giveaways.listGiveaways().filter((g) => req.guild.channels.cache.has(g.channelId)));
  });

  app.post('/api/giveaways', requireGuildAccess, async (req, res) => {
    const { channelId, prize, durationMinutes, winnerCount } = req.body || {};
    if (!channelId || !prize || !durationMinutes || !winnerCount) {
      return res.status(400).json({ error: 'channelId, prize, durationMinutes, and winnerCount are required' });
    }
    if (!req.guild.channels.cache.has(channelId)) return res.status(400).json({ error: 'That channel is not in this server' });
    try {
      const messageId = await giveaways.createGiveaway(channelId, prize, parseInt(durationMinutes, 10), parseInt(winnerCount, 10));
      audit(req.guildId, 'Started giveaway', prize);
      res.json({ ok: true, messageId });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/giveaways/:messageId/end', requireGuildAccess, async (req, res) => {
    // giveaways.js stores everything in one flat messageId-keyed map, not
    // scoped by guild — without this check, any server's admin could end
    // any OTHER server's giveaway just by knowing/guessing its message ID.
    const giveaway = giveaways.listGiveaways().find((g) => g.messageId === req.params.messageId);
    if (giveaway && !req.guild.channels.cache.has(giveaway.channelId)) {
      return res.status(404).json({ error: 'Giveaway not found' });
    }
    try {
      await giveaways.endGiveawayNow(req.params.messageId);
      audit(req.guildId, 'Ended giveaway early', req.params.messageId);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---------- Reminders ----------

  app.get('/api/reminders', requireGuildAccess, (req, res) => {
    res.json(reminders.listReminders().filter((r) => req.guild.channels.cache.has(r.channelId)));
  });

  app.post('/api/reminders', requireGuildAccess, (req, res) => {
    const { channelId, message, sendAt, repeat } = req.body || {};
    if (!channelId || !message || !sendAt) return res.status(400).json({ error: 'channelId, message, and sendAt are required' });
    if (!req.guild.channels.cache.has(channelId)) return res.status(400).json({ error: 'That channel is not in this server' });
    const entry = reminders.createReminder(channelId, message, sendAt, repeat || 'none');
    audit(req.guildId, 'Scheduled reminder', message);
    res.json(entry);
  });

  app.delete('/api/reminders/:id', requireGuildAccess, (req, res) => {
    // Same as giveaways above: reminders.js is one flat array shared by every
    // server, not keyed by guild — check the target reminder's channel is
    // actually in this guild before letting the cancel through.
    const reminder = reminders.listReminders().find((r) => r.id === req.params.id);
    if (reminder && !req.guild.channels.cache.has(reminder.channelId)) {
      return res.status(404).json({ error: 'Reminder not found' });
    }
    reminders.cancelReminder(req.params.id);
    audit(req.guildId, 'Cancelled reminder', req.params.id);
    res.json({ ok: true });
  });

  // ---------- Auto-moderation ----------

  app.get('/api/automod', requireGuildAccess, (req, res) => {
    res.json(automod.getConfig(req.guildId));
  });

  const PUNISHMENTS = ['delete', 'warn', 'timeout', 'kick', 'ban'];
  const MAX_LIST_ITEMS = 100; // bannedWords / linkBlacklist / attachmentBlocklist — generous but bounded

  app.post('/api/automod', requireGuildAccess, (req, res) => {
    const patch = req.body || {};

    if (patch.defaultPunishment !== undefined && !PUNISHMENTS.includes(patch.defaultPunishment)) {
      return res.status(400).json({ error: `defaultPunishment must be one of: ${PUNISHMENTS.join(', ')}` });
    }
    for (const key of ['bannedWords', 'linkBlacklist', 'attachmentBlocklist']) {
      if (patch[key] !== undefined && (!Array.isArray(patch[key]) || patch[key].length > MAX_LIST_ITEMS)) {
        return res.status(400).json({ error: `${key} must be a list of at most ${MAX_LIST_ITEMS} items` });
      }
    }
    for (const key of ['ignoreRoleIds']) {
      if (patch[key] !== undefined) {
        if (!Array.isArray(patch[key]) || patch[key].some((id) => !req.guild.roles.cache.has(id))) {
          return res.status(400).json({ error: 'ignoreRoleIds must only contain roles in this server' });
        }
      }
    }
    if (patch.ignoreChannelIds !== undefined) {
      if (!Array.isArray(patch.ignoreChannelIds) || patch.ignoreChannelIds.some((id) => !req.guild.channels.cache.has(id))) {
        return res.status(400).json({ error: 'ignoreChannelIds must only contain channels in this server' });
      }
    }

    const config = automod.updateConfig(req.guildId, patch);
    audit(req.guildId, 'Updated auto-mod settings', Object.keys(patch).join(', '));
    res.json(config);
  });

  // ---------- AI Automod (Mistral-powered) ----------
  // The API key never leaves this server — the dashboard only ever sees
  // `configured: true/false` (whether MISTRAL_AUTOMOD_API_KEY is set on this
  // deployment), never the key itself.
  const AI_AUTOMOD_STRICTNESS = ['lenient', 'moderate', 'strict'];
  const AI_AUTOMOD_PROMPT_MAX = 2000;

  app.get('/api/ai-automod', requireGuildAccess, (req, res) => {
    res.json({ ...aiAutomod.getConfig(req.guildId), configured: aiAutomod.isConfigured() });
  });

  app.post('/api/ai-automod', requireGuildAccess, (req, res) => {
    const patch = req.body || {};
    if (patch.strictness !== undefined && !AI_AUTOMOD_STRICTNESS.includes(patch.strictness)) {
      return res.status(400).json({ error: `strictness must be one of: ${AI_AUTOMOD_STRICTNESS.join(', ')}` });
    }
    if (patch.systemPrompt !== undefined && String(patch.systemPrompt).length > AI_AUTOMOD_PROMPT_MAX) {
      return res.status(400).json({ error: `System prompt is too long (max ${AI_AUTOMOD_PROMPT_MAX} characters)` });
    }
    if (patch.enabled && !aiAutomod.isConfigured()) {
      return res.status(400).json({ error: 'AI automod is not configured on this bot yet (missing API key) — ask the bot owner to set it up.' });
    }
    const config = aiAutomod.updateConfig(req.guildId, patch);
    audit(req.guildId, 'Updated AI automod settings', Object.keys(patch).join(', '));
    res.json({ ...config, configured: aiAutomod.isConfigured() });
  });

  // ---------- Anti-raid / lockdown ----------

  app.post('/api/lockdown', requireGuildAccess, async (req, res) => {
    const { locked } = req.body || {};
    try {
      const count = await antiRaid.setLockdown(req.guildId, !!locked);
      audit(req.guildId, locked ? 'Enabled server lockdown' : 'Lifted server lockdown', `${count} channels`);
      res.json({ ok: true, channelsAffected: count });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---------- Fun commands ----------

  app.post('/api/fun/:type', requireGuildAccess, async (req, res) => {
    const { channelId, targetUserId } = req.body || {};
    if (!channelId) return res.status(400).json({ error: 'channelId is required' });
    if (!req.guild.channels.cache.has(channelId)) return res.status(400).json({ error: 'That channel is not in this server' });

    try {
      const channel = await client.channels.fetch(channelId);
      let text;
      switch (req.params.type) {
        case 'dice': text = `🎲 Rolled a **${funCommands.rollDice(6)}**!`; break;
        case 'coinflip': text = `🪙 **${funCommands.coinFlip()}**!`; break;
        case 'quote': text = `💬 ${funCommands.randomQuote()}`; break;
        case 'trivia': { const t = funCommands.randomTrivia(); text = `🧠 **Trivia:** ${t.q}\n||${t.a}||`; break; }
        case 'wyr': text = `🤔 ${funCommands.randomWouldYouRather()}`; break;
        case 'compliment':
          text = targetUserId ? `💖 <@${targetUserId}> ${funCommands.randomCompliment()}` : `💖 Someone in this server ${funCommands.randomCompliment()}`;
          break;
        default: return res.status(400).json({ error: 'Unknown fun command type' });
      }
      await channel.send({ content: text, allowedMentions: { parse: ['users'] } });
      audit(req.guildId, 'Posted fun content', req.params.type);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---------- Reaction roles ----------

  app.get('/api/reaction-roles', requireGuildAccess, (req, res) => {
    res.json(reactionRoles.listReactionRoles().filter((r) => req.guild.channels.cache.has(r.channelId)));
  });

  app.post('/api/reaction-roles', requireGuildAccess, async (req, res) => {
    const { channelId, text, emoji, roleId } = req.body || {};
    if (!channelId || !text || !emoji || !roleId) return res.status(400).json({ error: 'channelId, text, emoji, and roleId are required' });
    if (!req.guild.channels.cache.has(channelId) || !req.guild.roles.cache.has(roleId)) {
      return res.status(400).json({ error: 'That channel or role is not in this server' });
    }
    try {
      const messageId = await reactionRoles.createReactionRole(channelId, text, emoji, roleId);
      audit(req.guildId, 'Created reaction role', `${emoji} in #${channelId}`);
      res.json({ ok: true, messageId });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/reaction-roles/:messageId', requireGuildAccess, (req, res) => {
    // Same pattern again: reactionRoles.js keeps one flat array for every
    // server. Without this check, any server's admin could remove any OTHER
    // server's reaction-role mapping just by knowing/guessing its message ID.
    const mapping = reactionRoles.listReactionRoles().find((m) => m.messageId === req.params.messageId);
    if (mapping && !req.guild.channels.cache.has(mapping.channelId)) {
      return res.status(404).json({ error: 'Reaction role not found' });
    }
    reactionRoles.removeReactionRole(req.params.messageId);
    audit(req.guildId, 'Removed reaction role', req.params.messageId);
    res.json({ ok: true });
  });

  // ---------- Stats ----------

  app.get('/api/stats/channels', requireGuildAccess, (req, res) => {
    res.json(stats.getChannelCounts(req.guildId));
  });

  app.get('/api/stats/growth', requireGuildAccess, (req, res) => {
    res.json(stats.getMemberHistory(req.guildId));
  });

  app.get('/api/stats/most-active', requireGuildAccess, (req, res) => {
    res.json(stats.getMostActive(req.guildId, 10));
  });

  app.get('/api/stats/summary', requireGuildAccess, (req, res) => {
    res.json({
      newMembersThisWeek: stats.getNewMembersThisWeek(req.guild),
      dashboardActionsTotal: auditLog.getEntries(req.guildId).length,
    });
  });

  // ---------- Verification gate ----------

  app.get('/api/verification', requireGuildAccess, (req, res) => {
    res.json({ enabled: verificationGate.isEnabled(req.guildId) });
  });

  app.post('/api/verification', requireGuildAccess, (req, res) => {
    const { enabled } = req.body || {};
    verificationGate.setEnabled(req.guildId, !!enabled);
    audit(req.guildId, 'Toggled verification gate', enabled ? 'enabled' : 'disabled');
    res.json({ enabled: !!enabled });
  });

  app.post('/api/verification/post', requireGuildAccess, async (req, res) => {
    const { channelId } = req.body || {};
    if (!channelId) return res.status(400).json({ error: 'channelId is required' });
    if (!req.guild.channels.cache.has(channelId)) return res.status(400).json({ error: 'That channel is not in this server' });
    try {
      await verificationGate.postVerificationMessage(client, channelId);
      audit(req.guildId, 'Posted verification message', `#${channelId}`);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---------- Bulk role assign & member export ----------

  app.post('/api/members/bulk-role', requireGuildAccess, async (req, res) => {
    const { roleId, filter } = req.body || {};
    if (!roleId) return res.status(400).json({ error: 'roleId is required' });
    if (!req.guild.roles.cache.has(roleId)) return res.status(400).json({ error: 'That role is not in this server' });
    try {
      const members = await req.guild.members.fetch();
      const targets = members.filter((m) => (filter === 'bots' ? m.user.bot : filter === 'humans' ? !m.user.bot : true));
      let count = 0;
      for (const member of targets.values()) {
        try { await member.roles.add(roleId); count += 1; } catch { /* hierarchy or perms, skip */ }
      }
      audit(req.guildId, 'Bulk role assign', `role ${roleId} to ${count} members (${filter || 'all'})`);
      res.json({ ok: true, count });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/members/export', requireGuildAccess, async (req, res) => {
    try {
      const members = await req.guild.members.fetch();
      const list = [...members.values()].map((m) => ({
        id: m.id,
        tag: m.user.tag,
        joinedAt: m.joinedAt,
        roles: m.roles.cache.filter((r) => r.id !== req.guild.id).map((r) => r.name),
      }));
      audit(req.guildId, 'Exported member list', `${list.length} members`);
      res.json(list);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---------- Custom commands ----------

  app.get('/api/commands/config', requireGuildAccess, (req, res) => {
    res.json(commandConfig.getState(req.guildId));
  });

  app.post('/api/commands/prefix', requireGuildAccess, (req, res) => {
    const { prefix } = req.body || {};
    if (!prefix || prefix.length > 3) return res.status(400).json({ error: 'Prefix must be 1-3 characters' });
    commandConfig.setPrefix(req.guildId, prefix);
    audit(req.guildId, 'Changed command prefix', prefix);
    res.json({ ok: true, prefix });
  });

  app.get('/api/commands', requireGuildAccess, (req, res) => {
    const state = commandConfig.getState(req.guildId);
    const list = commandList.map((c) => ({
      name: c.name,
      aliases: c.aliases,
      category: c.category,
      usage: c.usage,
      description: c.description,
      permission: permissionLabel(c.permission),
      disabled: state.disabled.includes(c.name),
    }));
    res.json({ prefix: state.prefix, commands: list });
  });

  app.post('/api/commands/:name/toggle', requireGuildAccess, (req, res) => {
    const { disabled } = req.body || {};
    const exists = commandList.some((c) => c.name === req.params.name);
    if (!exists) return res.status(404).json({ error: 'Unknown command' });
    commandConfig.setDisabled(req.guildId, req.params.name, !!disabled);
    audit(req.guildId, disabled ? 'Disabled command' : 'Enabled command', req.params.name);
    res.json({ ok: true });
  });

  // ---------- Custom commands (per-server, admin/AI-defined) ----------

  app.get('/api/custom-commands', requireGuildAccess, (req, res) => {
    res.json(customCommands.list(req.guildId));
  });

  app.post('/api/custom-commands', requireGuildAccess, (req, res) => {
    const body = req.body || {};
    if (body.allowedRoleIds !== undefined) {
      if (!Array.isArray(body.allowedRoleIds) || body.allowedRoleIds.some((id) => !req.guild.roles.cache.has(id))) {
        return res.status(400).json({ error: 'allowedRoleIds must only contain roles in this server' });
      }
    }
    if (body.visibility !== undefined && !['public', 'private'].includes(body.visibility)) {
      return res.status(400).json({ error: 'visibility must be "public" or "private"' });
    }
    try {
      const list = customCommands.add(req.guildId, body);
      audit(req.guildId, 'Added custom command', body.name);
      res.json(list);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.delete('/api/custom-commands/:name', requireGuildAccess, (req, res) => {
    const list = customCommands.remove(req.guildId, req.params.name);
    audit(req.guildId, 'Removed custom command', req.params.name);
    res.json(list);
  });

  // ---------- Per-server settings ----------

  app.get('/api/guild-config', requireGuildAccess, (req, res) => {
    res.json(guildConfig.getConfig(req.guildId));
  });

  app.post('/api/guild-config', requireGuildAccess, (req, res) => {
    const patch = req.body || {};
    const config = guildConfig.updateConfig(req.guildId, patch);
    audit(req.guildId, 'Updated server settings', Object.keys(patch).join(', '));
    res.json(config);
  });

  // ---------- Image uploads ----------
  // Used anywhere the dashboard takes an "image URL" (join/leave messages,
  // Send a Message, custom commands) as an alternative to pasting a link —
  // uploads go to a public Supabase Storage bucket and the resulting
  // permanent URL is used exactly like a pasted one everywhere else.
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

  // multer's own errors (file too big, etc.) surface through its callback,
  // not the usual middleware chain — wrapped here so they come back as the
  // same JSON error shape as everything else instead of an HTML error page.
  function uploadSingleImage(req, res, next) {
    upload.single('image')(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
      next();
    });
  }

  app.post('/api/upload-image', requireGuildAccess, uploadRateLimit, uploadSingleImage, async (req, res) => {
    try {
      const url = await imageUpload.uploadImage(req.guildId, req.file);
      audit(req.guildId, 'Uploaded image', req.file?.originalname || 'image');
      res.json({ url });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ---------- Stream alerts (Twitch live / YouTube new video) ----------

  app.get('/api/stream-alerts', requireGuildAccess, (req, res) => {
    res.json({ tracked: streamAlerts.listTracked(req.guildId), twitchConfigured: !!(process.env.TWITCH_CLIENT_ID && process.env.TWITCH_CLIENT_SECRET) });
  });

  app.post('/api/stream-alerts', requireGuildAccess, (req, res) => {
    const { platform, identifier, notifyChannelId, pingRoleId } = req.body || {};
    if (!['twitch', 'youtube'].includes(platform)) return res.status(400).json({ error: 'platform must be "twitch" or "youtube"' });
    if (!identifier || !String(identifier).trim()) return res.status(400).json({ error: 'identifier is required (Twitch username or YouTube channel ID)' });
    if (!notifyChannelId || !req.guild.channels.cache.has(notifyChannelId)) return res.status(400).json({ error: 'A valid notification channel in this server is required' });
    // "everyone" is a fixed sentinel, not a real role ID — @everyone/@here need
    // no role lookup, everything else must be an actual role in this server.
    if (pingRoleId && pingRoleId !== 'everyone' && !req.guild.roles.cache.has(pingRoleId)) {
      return res.status(400).json({ error: 'That role is not in this server' });
    }
    // Without a cap, one server could add unbounded entries — since Twitch
    // checks are batched across every server sharing this process, that would
    // degrade or break stream alerts for every OTHER server too, not just this
    // one (Twitch's Helix API also hard-caps a single request at 100 logins).
    if (streamAlerts.listTracked(req.guildId).length >= streamAlerts.MAX_TRACKED_PER_GUILD) {
      return res.status(400).json({ error: `This server is already tracking the maximum of ${streamAlerts.MAX_TRACKED_PER_GUILD} channels — remove one first.` });
    }

    const entry = streamAlerts.addTracked(req.guildId, { platform, identifier, notifyChannelId, pingRoleId: pingRoleId || null });
    audit(req.guildId, 'Added stream alert', `${platform}: ${identifier}`);
    res.json(entry);
  });

  app.delete('/api/stream-alerts/:id', requireGuildAccess, (req, res) => {
    streamAlerts.removeTracked(req.guildId, req.params.id);
    audit(req.guildId, 'Removed stream alert', req.params.id);
    res.json({ ok: true });
  });

  // ---------- Join / leave messages ----------

  app.get('/api/join-leave-config', requireGuildAccess, (req, res) => {
    res.json(joinLeaveMessages.getConfig(req.guildId));
  });

  app.post('/api/join-leave-config', requireGuildAccess, (req, res) => {
    const patch = req.body || {};
    const config = joinLeaveMessages.updateConfig(req.guildId, patch);
    audit(req.guildId, 'Updated join/leave messages', Object.keys(patch).join(', '));
    res.json(config);
  });

  // ---------- Feature toggles ----------
  // Master on/off switches for entire modules (XP, automod, anti-raid, etc.)
  // — separate from each module's own fine-grained settings. See features.js.

  app.get('/api/features', requireGuildAccess, (req, res) => {
    res.json(features.listWithState(req.guildId));
  });

  app.post('/api/features/:key/toggle', requireGuildAccess, (req, res) => {
    const { enabled } = req.body || {};
    const exists = features.FEATURES.some((f) => f.key === req.params.key);
    if (!exists) return res.status(404).json({ error: 'Unknown feature' });
    features.setEnabled(req.guildId, req.params.key, !!enabled);
    audit(req.guildId, enabled ? 'Enabled feature' : 'Disabled feature', req.params.key);
    res.json(features.listWithState(req.guildId));
  });

  // ---------- Tickets ----------

  app.get('/api/tickets/config', requireGuildAccess, (req, res) => {
    res.json(tickets.getConfig(req.guildId));
  });

  app.post('/api/tickets/config', requireGuildAccess, (req, res) => {
    const patch = req.body || {};
    if (patch.supportRoleIds !== undefined) {
      if (!Array.isArray(patch.supportRoleIds) || patch.supportRoleIds.length > tickets.MAX_SUPPORT_ROLES) {
        return res.status(400).json({ error: `You can set at most ${tickets.MAX_SUPPORT_ROLES} support roles.` });
      }
      if (patch.supportRoleIds.some((id) => !req.guild.roles.cache.has(id))) {
        return res.status(400).json({ error: 'One of those roles is not in this server.' });
      }
    }
    const config = tickets.updateConfig(req.guildId, patch);
    audit(req.guildId, 'Updated ticket settings', Object.keys(patch).join(', '));
    res.json(config);
  });

  app.post('/api/tickets/panels', requireGuildAccess, (req, res) => {
    const panel = req.body || {};
    if (!panel.name) return res.status(400).json({ error: 'name is required' });
    const panels = tickets.addPanel(req.guildId, panel);
    audit(req.guildId, 'Added ticket panel', panel.name);
    res.json(panels);
  });

  app.post('/api/tickets/panels/:id', requireGuildAccess, (req, res) => {
    try {
      const panels = tickets.updatePanel(req.guildId, req.params.id, req.body || {});
      audit(req.guildId, 'Updated ticket panel', req.params.id);
      res.json(panels);
    } catch (err) {
      res.status(404).json({ error: err.message });
    }
  });

  app.delete('/api/tickets/panels/:id', requireGuildAccess, (req, res) => {
    const panels = tickets.removePanel(req.guildId, req.params.id);
    audit(req.guildId, 'Removed ticket panel', req.params.id);
    res.json(panels);
  });

  app.post('/api/tickets/panels/:id/post', requireGuildAccess, async (req, res) => {
    const { channelId } = req.body || {};
    if (!channelId) return res.status(400).json({ error: 'channelId is required' });
    if (!req.guild.channels.cache.has(channelId)) return res.status(400).json({ error: 'That channel is not in this server' });
    try {
      await tickets.postPanel(client, req.guildId, req.params.id, channelId);
      audit(req.guildId, 'Posted ticket panel', `#${channelId}`);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/tickets', requireGuildAccess, (req, res) => {
    res.json(tickets.listTickets(req.guildId, req.query.status));
  });

  app.get('/api/tickets/stats', requireGuildAccess, (req, res) => {
    res.json(tickets.getStats(req.guildId));
  });

  app.post('/api/tickets/:channelId/close', requireGuildAccess, async (req, res) => {
    try {
      const ticket = await tickets.closeTicket(client, req.guildId, req.params.channelId, req.session.username);
      audit(req.guildId, 'Closed ticket', `#${ticket.number}`);
      res.json({ ok: true, ticket });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/tickets/:channelId/reopen', requireGuildAccess, async (req, res) => {
    try {
      const ticket = await tickets.reopenTicket(client, req.guildId, req.params.channelId);
      audit(req.guildId, 'Reopened ticket', `#${ticket.number}`);
      res.json({ ok: true, ticket });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.delete('/api/tickets/:channelId', requireGuildAccess, async (req, res) => {
    try {
      const ticket = await tickets.deleteTicket(client, req.guildId, req.params.channelId);
      audit(req.guildId, 'Deleted ticket', `#${ticket.number}`);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ---------- Custom rate commands ----------

  app.get('/api/rate-commands', requireGuildAccess, (req, res) => {
    res.json(rateCommands.getTypes(req.guildId));
  });

  app.post('/api/rate-commands', requireGuildAccess, (req, res) => {
    const { label, emoji } = req.body || {};
    if (!label) return res.status(400).json({ error: 'label is required' });
    try {
      const types = rateCommands.addType(req.guildId, label, emoji);
      audit(req.guildId, 'Added rate command', label);
      res.json(types);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.delete('/api/rate-commands/:key', requireGuildAccess, (req, res) => {
    const types = rateCommands.removeType(req.guildId, req.params.key);
    audit(req.guildId, 'Removed rate command', req.params.key);
    res.json(types);
  });

  // ---------- Role panels ----------

  app.get('/api/role-panels', requireGuildAccess, (req, res) => {
    res.json(rolePanels.getPanels(req.guildId));
  });

  app.post('/api/role-panels', requireGuildAccess, (req, res) => {
    const { name, title, description, color } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name is required' });
    const panels = rolePanels.addPanel(req.guildId, { name, title, description, color });
    audit(req.guildId, 'Added role panel', name);
    res.json(panels);
  });

  app.delete('/api/role-panels/:id', requireGuildAccess, (req, res) => {
    const panels = rolePanels.removePanel(req.guildId, req.params.id);
    audit(req.guildId, 'Removed role panel', req.params.id);
    res.json(panels);
  });

  app.post('/api/role-panels/:id/roles', requireGuildAccess, (req, res) => {
    const { roleId, label, emoji } = req.body || {};
    if (!roleId || !label) return res.status(400).json({ error: 'roleId and label are required' });
    if (!req.guild.roles.cache.has(roleId)) return res.status(400).json({ error: 'That role is not in this server' });
    try {
      const panels = rolePanels.addRole(req.guildId, req.params.id, { roleId, label, emoji });
      audit(req.guildId, 'Added role to panel', label);
      res.json(panels);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.delete('/api/role-panels/:id/roles/:roleId', requireGuildAccess, (req, res) => {
    try {
      const panels = rolePanels.removeRole(req.guildId, req.params.id, req.params.roleId);
      audit(req.guildId, 'Removed role from panel', req.params.roleId);
      res.json(panels);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/role-panels/:id/post', requireGuildAccess, async (req, res) => {
    const { channelId } = req.body || {};
    if (!channelId) return res.status(400).json({ error: 'channelId is required' });
    if (!req.guild.channels.cache.has(channelId)) return res.status(400).json({ error: 'That channel is not in this server' });
    try {
      await rolePanels.postPanel(client, req.guildId, req.params.id, channelId);
      audit(req.guildId, 'Posted role panel', `#${channelId}`);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---------- AI agent ----------
  // Gated by requireGuildAccess just like every other route here — the agent
  // can only be driven for a server the logged-in user actually manages (or
  // by the owner), and every action it takes is re-checked by that same
  // middleware a second time when the agent's tool calls loop back into this
  // server. See aiAgent.js for the full explanation of that design.

  const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;

  // Client-facing errors here are deliberately generic — the AI agent talks
  // to Mistral's API and to this server's own routes, and neither of those
  // error messages is something a normal dashboard user should have to
  // parse. Full detail always goes to the server log via console.error;
  // the browser only ever gets a flat "failed, try again".
  app.post('/api/ai/chat', requireGuildAccess, aiChatRateLimit, async (req, res) => {
    if (!MISTRAL_API_KEY) {
      console.error('AI agent used without MISTRAL_API_KEY configured');
      return res.status(503).json({ failed: true });
    }
    const { message, history } = req.body || {};
    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ failed: true });
    }
    const safeHistory = Array.isArray(history)
      ? history
          .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
          .slice(-20)
      : [];

    try {
      const result = await aiAgent.runAgentTurn({
        apiKey: MISTRAL_API_KEY,
        port,
        cookieHeader: req.headers.cookie,
        guildId: req.guildId,
        guildName: req.guild.name,
        history: safeHistory,
        userMessage: message.trim().slice(0, 2000),
      });
      if (result.actions.length) {
        audit(req.guildId, 'AI agent', `"${message.trim().slice(0, 100)}" → ${result.actions.map((a) => a.tool).join(', ')}`);
      }
      res.json(result);
    } catch (err) {
      console.error('AI agent error:', err.message);
      res.status(500).json({ failed: true });
    }
  });

  // A sensitive tool call the agent proposed but did not execute — the user
  // approved it explicitly in the chat UI, so run it now, for real, through
  // the exact same guild-scoped path as everything else.
  app.post('/api/ai/confirm', requireGuildAccess, async (req, res) => {
    const { tool, args } = req.body || {};
    if (!tool || typeof tool !== 'string') return res.status(400).json({ failed: true });
    const toolDef = aiAgent.TOOLS.find((t) => t.name === tool);
    if (!toolDef || !toolDef.sensitive) return res.status(400).json({ failed: true });

    try {
      const result = await aiAgent.confirmAction({ port, cookieHeader: req.headers.cookie, guildId: req.guildId, tool, args });
      audit(req.guildId, 'AI agent (confirmed)', `${tool} — ${result.ok ? 'ok' : 'failed'}`);
      res.json(result);
    } catch (err) {
      console.error('AI agent confirm error:', err.message);
      res.status(500).json({ failed: true });
    }
  });

  // Client-side routing: any non-API, non-static GET falls back to index.html, which
  // shows the landing page or the dashboard shell depending on login state.
  app.get(/^\/(?!api|auth)(?!.*\.\w+$).*/, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  app.listen(port, () => {
    console.log(`Dashboard running on port ${port}`);
  });
}

module.exports = { startDashboard };
