// The dashboard's built-in AI agent. It can do anything a logged-in server
// manager could do by hand through the dashboard UI — because that's
// literally what it does: every tool below is a thin wrapper around one of
// the dashboard's own existing API routes, called back into this very
// server over an internal loopback HTTP request that carries the *same*
// signed session cookie the browser sent. That request goes through
// requireGuildAccess exactly like a normal click would, so the agent can
// never do more than the person driving it is already allowed to do — no
// separate, weaker permission path exists for it.
//
// The Mistral API key never reaches the browser: it's read once from
// process.env here, on the server, and every chat call happens server-side.
// The client only ever sees the assistant's replies and a summary of which
// actions it took.
const http = require('http');

const MISTRAL_URL = 'https://api.mistral.ai/v1/chat/completions';
const MODEL = 'mistral-large-latest';
const MAX_TOOL_ITERATIONS = 6;

const SYSTEM_PROMPT = `You are the built-in assistant inside the Emerald Discord bot's admin dashboard, currently helping manage the server "{{guildName}}".

Rules:
- Respond in English by default. If the person writes to you in another language, reply in that language instead — you're fluent in all of them.
- You can do anything the tools below let you do: create and post ticket panels, role panels, and reaction roles; create channels and categories; create custom commands; send messages, announcements, polls, and DMs; kick, ban, timeout, warn, and manage roles; configure automod, verification, tickets, and server settings; run giveaways, reminders, sticky messages, auto-responses; and more. If there's a tool for it, you're allowed to just do it — don't ask for confirmation on routine, low-risk requests, just act and then report what you did.
- Discord channels, roles, and members are referred to by name in conversation, never by ID. Always resolve a name to an ID first using list_channels / list_categories / list_roles / list_members before calling a tool that needs an ID — never guess or invent an ID. If no suitable channel or category exists yet, create one with create_channel / create_category instead of asking the user to make it themselves.
- A few tools are marked as sensitive (ban, kick, purge, lockdown, bulk role changes). Those are never executed automatically, no matter what — the system will always hold them for the user to explicitly confirm in the UI first, so just call the tool as normal and let the system handle asking for confirmation.
- If a request is ambiguous (e.g. two channels with a similar name), ask a short clarifying question instead of guessing.
- You only ever act on this one server — you have no visibility into, or effect on, any other server the bot is in.
- After taking action, confirm briefly and concretely what happened (what was created/changed/sent), not a generic "done".
- If a tool call fails, explain what went wrong in plain language, don't just repeat the raw error.`;

// Every entry maps 1:1 to an existing dashboard route. `path` may contain
// :param segments, which are pulled out of the model's arguments and
// substituted into the URL; whatever's left becomes the JSON body (POST/
// DELETE) or query string (GET).
const TOOLS = [
  // ---- Lookups (read-only, used to resolve names to Discord IDs) ----
  {
    name: 'list_channels',
    method: 'GET',
    path: '/api/channels',
    description: 'List every text channel in this server with its ID and parent category. Use this to resolve a channel name to an ID before calling any tool that needs channelId.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'list_categories',
    method: 'GET',
    path: '/api/categories',
    description: 'List every channel category in this server with its ID. Use this to resolve a category name to categoryId.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'list_roles',
    method: 'GET',
    path: '/api/roles',
    description: 'List every role in this server with its ID, color, and member count. Use this to resolve a role name to roleId.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'find_members',
    method: 'GET',
    path: '/api/members',
    description: 'Search server members by username to resolve a name to a userId.',
    parameters: { type: 'object', properties: { search: { type: 'string', description: 'Username to search for' } }, required: ['search'] },
  },
  {
    name: 'get_guild_config',
    method: 'GET',
    path: '/api/guild-config',
    description: 'Read this server\'s current settings (counting channel, auto-role, mod-log channel, announcements channel, ping roles).',
    parameters: { type: 'object', properties: {}, required: [] },
  },

  // ---- Channel / category creation ----
  {
    name: 'create_category',
    method: 'POST',
    path: '/api/categories',
    description: 'Create a new, empty channel category. Use this when the user wants tickets/channels organized somewhere that doesn\'t exist yet.',
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },
  {
    name: 'create_channel',
    method: 'POST',
    path: '/api/channels',
    description: 'Create a new text or voice channel, optionally inside a category.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        categoryId: { type: 'string', description: 'Category to create it under (optional)' },
        type: { type: 'string', enum: ['text', 'voice'] },
      },
      required: ['name'],
    },
  },

  // ---- Messaging ----
  {
    name: 'send_message',
    method: 'POST',
    path: '/api/send',
    description: 'Post a message into a channel as the bot. If title is given, it is posted as an embed.',
    parameters: {
      type: 'object',
      properties: {
        channelId: { type: 'string' },
        message: { type: 'string', description: 'Message body / embed description' },
        title: { type: 'string', description: 'Optional embed title — omit for a plain message' },
        color: { type: 'string', description: 'Optional hex color like #17e88f, only used with title' },
      },
      required: ['channelId', 'message'],
    },
  },
  {
    name: 'send_announcement_template',
    method: 'POST',
    path: '/api/announce-template',
    description: 'Post a pre-built announcement (maintenance or event) to this server\'s configured announcements channel.',
    parameters: { type: 'object', properties: { type: { type: 'string', enum: ['maintenance', 'event'] } }, required: ['type'] },
  },
  {
    name: 'create_poll',
    method: 'POST',
    path: '/api/poll',
    description: 'Post a reaction-based poll (2-10 options) into a channel.',
    parameters: {
      type: 'object',
      properties: {
        channelId: { type: 'string' },
        question: { type: 'string' },
        options: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 10 },
      },
      required: ['channelId', 'question', 'options'],
    },
  },
  {
    name: 'send_dm',
    method: 'POST',
    path: '/api/dm',
    description: "Send a direct message, through the bot, to a member of this server.",
    parameters: { type: 'object', properties: { userId: { type: 'string' }, message: { type: 'string' } }, required: ['userId', 'message'] },
  },

  // ---- Moderation ----
  {
    name: 'kick_member',
    method: 'POST',
    path: '/api/moderation/kick',
    sensitive: true,
    describe: (a) => `Kick <@${a.userId}>${a.reason ? ` (reason: ${a.reason})` : ''}`,
    description: 'Kick a member from the server.',
    parameters: { type: 'object', properties: { userId: { type: 'string' }, reason: { type: 'string' } }, required: ['userId'] },
  },
  {
    name: 'ban_member',
    method: 'POST',
    path: '/api/moderation/ban',
    sensitive: true,
    describe: (a) => `Ban user ID ${a.userId}${a.reason ? ` (reason: ${a.reason})` : ''}`,
    description: 'Ban a member (or a raw user ID not currently in the server) from the server.',
    parameters: { type: 'object', properties: { userId: { type: 'string' }, reason: { type: 'string' }, deleteMessageDays: { type: 'number', description: 'Days of their recent messages to delete, 0-7' } }, required: ['userId'] },
  },
  {
    name: 'unban_user',
    method: 'POST',
    path: '/api/moderation/unban',
    description: 'Remove a ban for a user ID.',
    parameters: { type: 'object', properties: { userId: { type: 'string' } }, required: ['userId'] },
  },
  {
    name: 'timeout_member',
    method: 'POST',
    path: '/api/moderation/timeout',
    description: "Put a member in Discord timeout for a number of minutes.",
    parameters: { type: 'object', properties: { userId: { type: 'string' }, minutes: { type: 'number' }, reason: { type: 'string' } }, required: ['userId', 'minutes'] },
  },
  {
    name: 'warn_member',
    method: 'POST',
    path: '/api/warnings',
    description: 'Issue a warning to a member. A 3rd active warning auto-times them out for 30 minutes.',
    parameters: { type: 'object', properties: { userId: { type: 'string' }, reason: { type: 'string' } }, required: ['userId', 'reason'] },
  },
  {
    name: 'clear_warnings',
    method: 'DELETE',
    path: '/api/warnings/:userId',
    description: "Clear a member's warning history.",
    parameters: { type: 'object', properties: { userId: { type: 'string' } }, required: ['userId'] },
  },
  {
    name: 'add_role_to_member',
    method: 'POST',
    path: '/api/roles/add',
    description: 'Give a role to a member.',
    parameters: { type: 'object', properties: { userId: { type: 'string' }, roleId: { type: 'string' } }, required: ['userId', 'roleId'] },
  },
  {
    name: 'remove_role_from_member',
    method: 'POST',
    path: '/api/roles/remove',
    description: 'Remove a role from a member.',
    parameters: { type: 'object', properties: { userId: { type: 'string' }, roleId: { type: 'string' } }, required: ['userId', 'roleId'] },
  },
  {
    name: 'bulk_role_assign',
    method: 'POST',
    path: '/api/members/bulk-role',
    sensitive: true,
    describe: (a) => `Give role ID ${a.roleId} to ${a.filter || 'all'} members`,
    description: 'Give a role to many members at once, optionally filtered to only bots or only humans.',
    parameters: { type: 'object', properties: { roleId: { type: 'string' }, filter: { type: 'string', enum: ['all', 'bots', 'humans'] } }, required: ['roleId'] },
  },
  {
    name: 'purge_messages',
    method: 'POST',
    path: '/api/purge',
    sensitive: true,
    describe: (a) => `Delete ${a.amount} recent messages in <#${a.channelId}>`,
    description: 'Bulk-delete recent messages (max 100, and only ones under 14 days old) in a channel.',
    parameters: { type: 'object', properties: { channelId: { type: 'string' }, amount: { type: 'number' } }, required: ['channelId', 'amount'] },
  },
  {
    name: 'set_slowmode',
    method: 'POST',
    path: '/api/slowmode',
    description: 'Set (or clear, with seconds 0) slowmode on a channel.',
    parameters: { type: 'object', properties: { channelId: { type: 'string' }, seconds: { type: 'number' } }, required: ['channelId', 'seconds'] },
  },
  {
    name: 'set_lockdown',
    method: 'POST',
    path: '/api/lockdown',
    sensitive: true,
    describe: (a) => (a.locked ? 'Lock down every text channel for @everyone' : 'Lift the server-wide lockdown'),
    description: 'Lock down (or lift lockdown on) every text channel for @everyone — an emergency raid response.',
    parameters: { type: 'object', properties: { locked: { type: 'boolean' } }, required: ['locked'] },
  },

  // ---- Automod / verification ----
  {
    name: 'update_automod_settings',
    method: 'POST',
    path: '/api/automod',
    description: 'Update auto-moderation settings. Only include the fields being changed. Staff (Manage Messages) are always exempt.',
    parameters: {
      type: 'object',
      properties: {
        linkFilter: { type: 'boolean', description: 'Block links not on the whitelist' },
        linkWhitelist: { type: 'array', items: { type: 'string' }, description: 'Domains allowed even with linkFilter on' },
        inviteFilter: { type: 'boolean', description: 'Block Discord invite links' },
        capsFilter: { type: 'boolean', description: 'Block excessive-caps messages' },
        mentionSpamFilter: { type: 'boolean', description: 'Block messages that mention many users at once' },
        duplicateSpamFilter: { type: 'boolean', description: 'Block the same message repeated quickly' },
        accountAgeGateDays: { type: 'number', description: 'Minimum Discord account age to post, in days. 0 = off' },
      },
      required: [],
    },
  },
  {
    name: 'set_verification_gate',
    method: 'POST',
    path: '/api/verification',
    description: 'Turn the verification gate (members must click a button before getting the member role) on or off.',
    parameters: { type: 'object', properties: { enabled: { type: 'boolean' } }, required: ['enabled'] },
  },
  {
    name: 'post_verification_button',
    method: 'POST',
    path: '/api/verification/post',
    description: 'Post the verification button message into a channel.',
    parameters: { type: 'object', properties: { channelId: { type: 'string' } }, required: ['channelId'] },
  },

  // ---- Tickets ----
  {
    name: 'update_ticket_config',
    method: 'POST',
    path: '/api/tickets/config',
    description: 'Update global ticket settings shared by every panel. Only include fields being changed.',
    parameters: {
      type: 'object',
      properties: {
        supportRoleId: { type: 'string' },
        closedCategoryChannelId: { type: 'string', description: 'Category closed tickets get moved into' },
        ticketNameFormat: { type: 'string', description: 'Use {username} and {count}' },
        welcomeMessage: { type: 'string', description: 'Use {user}' },
        maxOpenPerUser: { type: 'number' },
        autoCloseHours: { type: 'number', description: '0 = off' },
      },
      required: [],
    },
  },
  {
    name: 'create_ticket_panel',
    method: 'POST',
    path: '/api/tickets/panels',
    description: 'Create a new support ticket panel (embed + button). Does not post it anywhere yet — use post_ticket_panel for that.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Internal panel name' },
        title: { type: 'string', description: 'Embed title' },
        description: { type: 'string', description: 'Embed description' },
        color: { type: 'string', description: 'Hex color like #17e88f' },
        categoryChannelId: { type: 'string', description: 'Category where new ticket channels get created — resolve with list_categories, or make one first with create_category if none fits' },
      },
      required: ['name'],
    },
  },
  {
    name: 'post_ticket_panel',
    method: 'POST',
    path: '/api/tickets/panels/:id/post',
    description: "Post an existing ticket panel's embed+button into a channel so members can open tickets from it.",
    parameters: { type: 'object', properties: { id: { type: 'string', description: 'Panel ID' }, channelId: { type: 'string' } }, required: ['id', 'channelId'] },
  },
  {
    name: 'close_ticket',
    method: 'POST',
    path: '/api/tickets/:channelId/close',
    description: 'Close an open ticket by its channel ID.',
    parameters: { type: 'object', properties: { channelId: { type: 'string' } }, required: ['channelId'] },
  },

  // ---- Role panels & reaction roles ----
  {
    name: 'create_role_panel',
    method: 'POST',
    path: '/api/role-panels',
    description: 'Create a new self-assign role panel (button-based). Add roles to it with add_role_to_panel, then post it with post_role_panel.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, color: { type: 'string' } },
      required: ['name'],
    },
  },
  {
    name: 'add_role_to_panel',
    method: 'POST',
    path: '/api/role-panels/:id/roles',
    description: 'Add a self-assign button for a role to an existing role panel (max 5 per panel).',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Panel ID' }, roleId: { type: 'string' }, label: { type: 'string' }, emoji: { type: 'string' } },
      required: ['id', 'roleId', 'label'],
    },
  },
  {
    name: 'post_role_panel',
    method: 'POST',
    path: '/api/role-panels/:id/post',
    description: 'Post a role panel into a channel.',
    parameters: { type: 'object', properties: { id: { type: 'string' }, channelId: { type: 'string' } }, required: ['id', 'channelId'] },
  },
  {
    name: 'create_reaction_role',
    method: 'POST',
    path: '/api/reaction-roles',
    description: 'Post a message where reacting with an emoji gives a role (un-reacting removes it).',
    parameters: {
      type: 'object',
      properties: { channelId: { type: 'string' }, text: { type: 'string' }, emoji: { type: 'string' }, roleId: { type: 'string' } },
      required: ['channelId', 'text', 'emoji', 'roleId'],
    },
  },

  // ---- Automation ----
  {
    name: 'set_sticky_message',
    method: 'POST',
    path: '/api/sticky',
    description: 'Pin a message to the bottom of a channel (it reposts itself after new messages).',
    parameters: { type: 'object', properties: { channelId: { type: 'string' }, text: { type: 'string' } }, required: ['channelId', 'text'] },
  },
  {
    name: 'add_autoresponse',
    method: 'POST',
    path: '/api/autoresponses',
    description: 'Make the bot auto-reply whenever a message contains a trigger word.',
    parameters: { type: 'object', properties: { trigger: { type: 'string' }, reply: { type: 'string' } }, required: ['trigger', 'reply'] },
  },
  {
    name: 'start_giveaway',
    method: 'POST',
    path: '/api/giveaways',
    description: 'Start a giveaway in a channel.',
    parameters: {
      type: 'object',
      properties: { channelId: { type: 'string' }, prize: { type: 'string' }, durationMinutes: { type: 'number' }, winnerCount: { type: 'number' } },
      required: ['channelId', 'prize', 'durationMinutes', 'winnerCount'],
    },
  },
  {
    name: 'schedule_reminder',
    method: 'POST',
    path: '/api/reminders',
    description: 'Schedule a message to be posted in a channel at a future time, optionally repeating.',
    parameters: {
      type: 'object',
      properties: {
        channelId: { type: 'string' },
        message: { type: 'string' },
        sendAt: { type: 'string', description: 'ISO 8601 datetime' },
        repeat: { type: 'string', enum: ['none', 'daily', 'weekly'] },
      },
      required: ['channelId', 'message', 'sendAt'],
    },
  },
  {
    name: 'add_rate_command',
    method: 'POST',
    path: '/api/rate-commands',
    description: 'Create a new custom !rate-style command (e.g. !rateaura) that gives a random 1-100% rating.',
    parameters: { type: 'object', properties: { label: { type: 'string' }, emoji: { type: 'string' } }, required: ['label'] },
  },
  {
    name: 'create_custom_command',
    method: 'POST',
    path: '/api/custom-commands',
    description: 'Create a brand new chat command (e.g. !rules) with any fixed text response the user wants. Distinct from add_autoresponse: this is an exact command, not a trigger word matched inside any message.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Command name without the prefix, letters/numbers/-/_ only' },
        response: { type: 'string', description: 'What the bot replies with' },
        embedTitle: { type: 'string', description: 'Optional — if set, the response is posted as an embed with this title' },
        color: { type: 'string', description: 'Optional hex color for the embed' },
      },
      required: ['name', 'response'],
    },
  },
  {
    name: 'remove_custom_command',
    method: 'DELETE',
    path: '/api/custom-commands/:name',
    description: 'Delete a custom command.',
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },
  {
    name: 'list_custom_commands',
    method: 'GET',
    path: '/api/custom-commands',
    description: 'List every custom command currently defined on this server.',
    parameters: { type: 'object', properties: {}, required: [] },
  },

  // ---- Server / commands config ----
  {
    name: 'update_guild_config',
    method: 'POST',
    path: '/api/guild-config',
    description: 'Update server settings — counting game channel, role auto-given on join, mod-log channel, announcements channel, giveaway/announcement ping roles. Only include fields being changed.',
    parameters: {
      type: 'object',
      properties: {
        countingChannelId: { type: 'string' },
        memberRoleId: { type: 'string', description: 'Role automatically given to new members on join' },
        modLogsChannelId: { type: 'string' },
        announcementsChannelId: { type: 'string' },
        giveawayPingRoleId: { type: 'string' },
        announcementPingRoleId: { type: 'string' },
      },
      required: [],
    },
  },
  {
    name: 'set_command_prefix',
    method: 'POST',
    path: '/api/commands/prefix',
    description: "Change this server's chat command prefix (1-3 characters).",
    parameters: { type: 'object', properties: { prefix: { type: 'string' } }, required: ['prefix'] },
  },
  {
    name: 'toggle_command',
    method: 'POST',
    path: '/api/commands/:name/toggle',
    description: 'Enable or disable a specific chat command for this server.',
    parameters: { type: 'object', properties: { name: { type: 'string', description: 'Command name' }, disabled: { type: 'boolean' } }, required: ['name', 'disabled'] },
  },
  {
    name: 'reset_counting_game',
    method: 'POST',
    path: '/api/counting/reset',
    description: 'Reset the counting game back to 1.',
    parameters: { type: 'object', properties: {}, required: [] },
  },

  // ---- Fun ----
  {
    name: 'post_fun_content',
    method: 'POST',
    path: '/api/fun/:type',
    description: 'Post a quick fun message: dice roll, coin flip, quote of the day, trivia, would-you-rather, or a compliment.',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['dice', 'coinflip', 'quote', 'trivia', 'wyr', 'compliment'] },
        channelId: { type: 'string' },
        targetUserId: { type: 'string', description: 'Only used for compliment' },
      },
      required: ['type', 'channelId'],
    },
  },
];

function toMistralTool(tool) {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

function buildPath(pathTemplate, args) {
  return pathTemplate.replace(/:([a-zA-Z]+)/g, (_, key) => {
    const val = args[key];
    delete args[key];
    return encodeURIComponent(val ?? '');
  });
}

function callInternalApi({ port, method, path, guildId, cookieHeader, body }) {
  return new Promise((resolve, reject) => {
    const payload = body != null ? JSON.stringify(body) : null;
    const options = {
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-guild-id': guildId,
        Cookie: cookieHeader || '',
      },
    };
    if (payload) options.headers['Content-Length'] = Buffer.byteLength(payload);

    const request = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        let parsed;
        try {
          parsed = data ? JSON.parse(data) : null;
        } catch {
          parsed = data;
        }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

// Runs one user turn to completion, including any number of tool-call
// round-trips, and returns the final natural-language reply plus a log of
// every action actually taken (or attempted).
async function runAgentTurn({ apiKey, port, cookieHeader, guildId, guildName, history, userMessage }) {
  if (!apiKey) throw new Error('AI agent is not configured (missing API key)');

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT.replace('{{guildName}}', guildName) },
    ...(history || []).map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: userMessage },
  ];

  const actions = [];
  const pendingActions = [];

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const resp = await fetch(MISTRAL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: MODEL,
        messages,
        tools: TOOLS.map(toMistralTool),
        tool_choice: 'auto',
        temperature: 0.3,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      console.error(`Mistral API error ${resp.status}: ${errText.slice(0, 300)}`);
      throw new Error('AI agent request failed');
    }

    const data = await resp.json();
    const message = data.choices?.[0]?.message;
    if (!message) throw new Error('AI agent returned no response');
    messages.push(message);

    if (!message.tool_calls || message.tool_calls.length === 0) {
      return { reply: message.content || '(no response)', actions, pendingActions };
    }

    for (const call of message.tool_calls) {
      const tool = TOOLS.find((t) => t.name === call.function.name);
      let args = {};
      try {
        args = JSON.parse(call.function.arguments || '{}');
      } catch {
        // leave args empty, the tool call below will likely fail validation server-side
      }

      // Sensitive tools are never auto-executed, no matter what the model
      // decides — the call is held for the user to explicitly approve in the
      // UI (see /api/ai/confirm). The model just gets told it's pending so it
      // can wrap up its reply accordingly.
      if (tool && tool.sensitive) {
        const pending = {
          id: call.id,
          tool: tool.name,
          args,
          description: tool.describe ? tool.describe(args) : `${tool.name}(${JSON.stringify(args)})`,
        };
        pendingActions.push(pending);
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          name: call.function.name,
          content: JSON.stringify({ status: 'awaiting_user_confirmation' }),
        });
        continue;
      }

      let resultBody;
      let status;
      if (!tool) {
        resultBody = { error: `Unknown tool: ${call.function.name}` };
        status = 400;
      } else {
        const argsForRequest = { ...args };
        const resolvedPath = buildPath(tool.path, argsForRequest);
        const isGet = tool.method === 'GET';
        const query = isGet && Object.keys(argsForRequest).length ? `?${new URLSearchParams(argsForRequest).toString()}` : '';
        const dispatched = await callInternalApi({
          port,
          method: tool.method,
          path: resolvedPath + query,
          guildId,
          cookieHeader,
          body: isGet ? null : argsForRequest,
        });
        resultBody = dispatched.body;
        status = dispatched.status;
      }

      actions.push({ tool: call.function.name, args, status, ok: status >= 200 && status < 300 });
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        name: call.function.name,
        content: JSON.stringify(resultBody ?? {}).slice(0, 4000),
      });
    }
  }

  return {
    reply: "I took several steps on this but hit my per-turn action limit — tell me to continue if there's more to do.",
    actions,
    pendingActions,
  };
}

// Executes exactly one previously-proposed sensitive tool call, after the
// user has explicitly approved it in the UI. Re-validates the tool name and
// re-runs it through the same internal loopback + requireGuildAccess path as
// everything else — nothing here trusts the client's word that it's safe.
async function confirmAction({ port, cookieHeader, guildId, tool: toolName, args }) {
  const tool = TOOLS.find((t) => t.name === toolName);
  if (!tool) throw new Error('Unknown tool');
  const argsForRequest = { ...(args || {}) };
  const resolvedPath = buildPath(tool.path, argsForRequest);
  const isGet = tool.method === 'GET';
  const query = isGet && Object.keys(argsForRequest).length ? `?${new URLSearchParams(argsForRequest).toString()}` : '';
  const dispatched = await callInternalApi({
    port,
    method: tool.method,
    path: resolvedPath + query,
    guildId,
    cookieHeader,
    body: isGet ? null : argsForRequest,
  });
  return { tool: toolName, status: dispatched.status, ok: dispatched.status >= 200 && dispatched.status < 300, body: dispatched.body };
}

module.exports = { runAgentTurn, confirmAction, TOOLS };
