require('dotenv').config();
const { Client, GatewayIntentBits, Partials } = require('discord.js');
const { setupCounting } = require('./counting');
const { startDashboard } = require('./dashboard');
const { patchConsole } = require('./logBuffer');
const { setupActivityTracking } = require('./activity');
const { setupModLogTracking } = require('./modLogTracker');
const { setupXp } = require('./xpSystem');
const { setupSticky } = require('./stickyMessages');
const { setupAutoResponses } = require('./autoResponses');
const { setupGiveaways } = require('./giveaways');
const { setupReminders } = require('./reminders');
const { setupAutomod } = require('./automod');
const { setupAntiRaid } = require('./antiRaid');
const { setupReactionRoles } = require('./reactionRoles');
const { setupStats } = require('./stats');
const verificationGate = require('./verificationGate');
const { setupCommandHandler } = require('./commandHandler');
const guildConfig = require('./guildConfig');
const { setupTickets } = require('./tickets');
const { setupRolePanels } = require('./rolePanels');
const { setupJoinLeaveMessages } = require('./joinLeaveMessages');
const { setupStreamAlerts } = require('./streamAlerts');
const { setupAiAutomod } = require('./aiAutomod');
const { preloadAll } = require('./guildStore');

patchConsole();

const TOKEN = process.env.DISCORD_TOKEN;
const DASHBOARD_PORT = parseInt(process.env.PORT || process.env.DASHBOARD_PORT || '3000', 10);

if (!TOKEN) {
  console.error('Error: DISCORD_TOKEN is missing in the .env file.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction],
});

client.once('ready', async () => {
  console.log(`Bot logged in as ${client.user.tag}, in ${client.guilds.cache.size} server(s)`);

  // No "home guild" here — this bot is multi-tenant, every server it's in configures
  // itself entirely through the dashboard, with no .env fallback for any of them.

  setupCounting(client);
  setupActivityTracking(client);
  setupModLogTracking(client);
  setupXp(client, { excludedChannelIds: [] });
  setupSticky(client);
  setupAutoResponses(client);
  setupGiveaways(client);
  setupReminders(client);
  setupAutomod(client);
  setupAntiRaid(client);
  setupReactionRoles(client);
  setupStats(client);
  setupTickets(client);
  setupRolePanels(client);
  setupJoinLeaveMessages(client);
  setupStreamAlerts(client);
  setupAiAutomod(client);
  verificationGate.setupVerificationGate(client);

  setupCommandHandler(client, { client });
});

client.on('guildMemberAdd', async (member) => {
  const memberRoleId = guildConfig.getConfig(member.guild.id).memberRoleId;
  if (!memberRoleId) return;
  if (verificationGate.isEnabled(member.guild.id)) return;
  try {
    await member.roles.add(memberRoleId);
    console.log(`Gave Member role to ${member.user.tag} in ${member.guild.name}`);
  } catch (err) {
    console.error(`Could not give Member role to ${member.user.tag}:`, err.message);
  }
});

// Load every per-server state store from Supabase (if configured) before logging in,
// so the very first reads see the real persisted data instead of empty defaults.
(async () => {
  await preloadAll();

  // The web dashboard starts immediately here, independent of the Discord
  // gateway login below — it used to wait for the bot's 'ready' event, which
  // meant a slow or rate-limited Discord login took the *entire website*
  // down with it (landing page, login, Terms — none of which need the bot to
  // be connected). Guild-scoped routes already handle an empty/not-yet-ready
  // client.guilds.cache gracefully (they 403 with "bot not in that server"),
  // so there's no correctness cost to starting the server first.
  if (process.env.DASHBOARD_SESSION_SECRET) {
    startDashboard(client, {
      port: DASHBOARD_PORT,
      clientId: process.env.DISCORD_CLIENT_ID,
      clientSecret: process.env.DISCORD_CLIENT_SECRET,
      sessionSecret: process.env.DASHBOARD_SESSION_SECRET,
      publicUrl: process.env.PUBLIC_URL,
    });
  } else {
    console.log('DASHBOARD_SESSION_SECRET not set, web dashboard is disabled.');
  }

  client.login(TOKEN).catch((err) => {
    console.error('Login failed. Is the token correct?', err);
    process.exit(1);
  });
})();
