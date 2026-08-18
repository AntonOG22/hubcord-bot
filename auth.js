// Discord OAuth2 (Authorization Code flow) helpers. This is the entire trust boundary
// for the public dashboard: a visitor proves who they are by authorizing with Discord,
// we fetch their real guild list + permissions from Discord's own API, and every
// dashboard route only ever acts on guilds that visitor actually administers AND that
// this bot is actually a member of. Nobody can manage a server that isn't both.
const DISCORD_API = 'https://discord.com/api/v10';
const MANAGE_GUILD = 0x20; // Discord permission bit for "Manage Server"
const ADMINISTRATOR = 0x8;

function getAuthorizeUrl({ clientId, redirectUri, state }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'identify guilds',
    state,
    prompt: 'consent',
  });
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

async function exchangeCode({ clientId, clientSecret, redirectUri, code }) {
  const res = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    }),
  });
  if (!res.ok) throw new Error(`Discord token exchange failed: ${res.status} ${await res.text()}`);
  return res.json(); // { access_token, token_type, expires_in, refresh_token, scope }
}

async function fetchDiscordUser(accessToken) {
  const res = await fetch(`${DISCORD_API}/users/@me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Could not fetch Discord user: ${res.status}`);
  return res.json(); // { id, username, avatar, ... }
}

async function fetchUserGuilds(accessToken) {
  const res = await fetch(`${DISCORD_API}/users/@me/guilds`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Could not fetch user guilds: ${res.status}`);
  return res.json(); // [{ id, name, icon, owner, permissions, ... }]
}

// A user can manage a guild through the dashboard only if Discord itself says they
// have Manage Server or Administrator there (owner always implicitly has both).
function hasManagePermission(guild) {
  const perms = BigInt(guild.permissions || '0');
  return guild.owner === true || (perms & BigInt(MANAGE_GUILD)) !== 0n || (perms & BigInt(ADMINISTRATOR)) !== 0n;
}

module.exports = { getAuthorizeUrl, exchangeCode, fetchDiscordUser, fetchUserGuilds, hasManagePermission };
