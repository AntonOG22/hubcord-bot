# Hubcord

A public, multi-tenant Discord bot dashboard. Anyone can log in with their own
Discord account and manage only the servers where Discord confirms they have
Manage Server — moderation, tickets, leveling, automod, giveaways, custom
commands, self-assign role panels, and more.

## Security model

- No shared password. Every session is a real Discord OAuth2 login.
- Every guild-scoped API request re-verifies, live against Discord, that the
  logged-in user currently has Manage Server (or Administrator, or is the
  owner) on the requested server — never trusted from a stale cookie.
- The bot must also actually be a member of that server.
- Per-server data (tickets, XP, warnings, audit log, etc.) is fully isolated —
  one server's admins never see another server's data.
- DM history viewing and the raw console log were deliberately left out of
  the dashboard, since a global inbox/log would leak across unrelated tenants.

## Running locally

```bash
npm install
cp .env.example .env   # fill in real values
node index.js
```

Requires a Discord Application with:
- A bot user (Bot tab) with **Message Content** and **Server Members** privileged intents enabled
- An OAuth2 Client Secret (OAuth2 tab)
- A redirect URI registered: `http://localhost:3001/auth/callback` (or your deployed URL + `/auth/callback`)

## Deploying to Render

1. Push to a GitHub repo.
2. Create a Render Web Service pointed at it. Build: `npm install`. Start: `node index.js`.
3. Set environment variables from `.env.example` — leave `PUBLIC_URL` set to your Render URL.
4. Add `<your-render-url>/auth/callback` as a redirect URI in the Discord app's OAuth2 settings.
5. Set up a free uptime pinger (UptimeRobot etc.) hitting the Render URL every 5-10 minutes so the free tier doesn't sleep.
