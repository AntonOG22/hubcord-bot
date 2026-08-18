// ---------- Screens ----------

const landingScreen = document.getElementById('landing-screen');
const pickerScreen = document.getElementById('picker-screen');
const appScreen = document.getElementById('app-screen');

let selectedGuildId = null;
let me = null; // { userId, username, avatar }
let guildsCache = { withBot: [], withoutBot: [] };

function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (selectedGuildId) headers['x-guild-id'] = selectedGuildId;
  return fetch(path, { ...options, credentials: 'same-origin', headers });
}

function showScreen(name) {
  landingScreen.classList.toggle('hidden', name !== 'landing');
  pickerScreen.classList.toggle('hidden', name !== 'picker');
  appScreen.classList.toggle('hidden', name !== 'app');
}

async function boot() {
  try {
    const res = await api('/api/me');
    if (!res.ok) return showScreen('landing');
    me = await res.json();
    showScreen('picker');
    await loadPicker();
  } catch {
    showScreen('landing');
  }
}

// ---------- Server picker ----------

async function loadPicker() {
  document.getElementById('picker-username').textContent = me.username;
  document.getElementById('picker-avatar').src = me.avatar;

  const res = await api('/api/guilds');
  if (!res.ok) {
    showScreen('landing');
    return;
  }
  guildsCache = await res.json();
  renderPicker();
}

function guildCardHtml(g, withBot) {
  const icon = g.icon
    ? `<img src="${g.icon}" alt="" />`
    : `<div class="guild-fallback-icon">${escapeHtml(g.name.slice(0, 1).toUpperCase())}</div>`;
  const actionAttr = withBot ? `data-guild-select="${g.id}"` : `data-guild-invite="${g.id}"`;
  return `
    <button class="guild-card" ${actionAttr}>
      ${icon}
      <div>
        <div class="guild-card-name">${escapeHtml(g.name)}</div>
        <div class="guild-card-sub">${withBot ? `${g.memberCount ?? '—'} members` : 'Add Hubcord →'}</div>
      </div>
    </button>`;
}

function renderPicker() {
  const withBotEl = document.getElementById('picker-with-bot');
  const withoutBotEl = document.getElementById('picker-without-bot');

  withBotEl.innerHTML = guildsCache.withBot.length
    ? guildsCache.withBot.map((g) => guildCardHtml(g, true)).join('')
    : '<span class="picker-empty">No servers yet — invite the bot to one you manage below.</span>';

  withoutBotEl.innerHTML = guildsCache.withoutBot.length
    ? guildsCache.withoutBot.map((g) => guildCardHtml(g, false)).join('')
    : '<span class="picker-empty">Hubcord is already in every server you manage. 🎉</span>';

  document.querySelectorAll('[data-guild-select]').forEach((btn) => {
    btn.addEventListener('click', () => enterDashboard(btn.dataset.guildSelect));
  });
  document.querySelectorAll('[data-guild-invite]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      inviteBotTo(btn.dataset.guildInvite);
    });
  });
}

async function inviteBotTo(guildId) {
  const res = await api(`/api/invite-url?guildId=${guildId}`);
  if (!res.ok) return;
  const { url } = await res.json();
  window.open(url, '_blank', 'noopener');
}

function enterDashboard(guildId) {
  selectedGuildId = guildId;
  showScreen('app');
  init();
}

document.getElementById('switch-server-link').addEventListener('click', (e) => {
  e.preventDefault();
  selectedGuildId = null;
  initialized = false;
  showScreen('picker');
  loadPicker();
});

// ---------- Helpers ----------

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function setFeedback(el, text, ok) {
  el.textContent = text;
  el.className = 'feedback-text ' + (ok ? 'ok' : 'err');
}

function formatUptime(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${h}h ${m}m ${s}s`;
}

function timeAgo(iso) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

async function populateChannelSelect(selectEl, { withNone } = {}) {
  const res = await api('/api/channels');
  if (!res.ok) return;
  const channels = await res.json();

  selectEl.innerHTML = '';
  if (withNone) {
    const none = document.createElement('option');
    none.value = '';
    none.textContent = '— none —';
    selectEl.appendChild(none);
  }
  for (const c of channels) {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.parent ? `${c.parent} / ${c.name}` : c.name;
    selectEl.appendChild(opt);
  }
}

async function populateCategorySelect(selectEl, { withNone } = {}) {
  const res = await api('/api/categories');
  if (!res.ok) return;
  const categories = await res.json();

  selectEl.innerHTML = '';
  if (withNone) {
    const none = document.createElement('option');
    none.value = '';
    none.textContent = '— none —';
    selectEl.appendChild(none);
  }
  for (const c of categories) {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.name;
    selectEl.appendChild(opt);
  }
}

async function populateRoleSelect(selectEl, { withNone } = {}) {
  const res = await api('/api/roles');
  if (!res.ok) return;
  const roles = await res.json();

  selectEl.innerHTML = '';
  if (withNone) {
    const none = document.createElement('option');
    none.value = '';
    none.textContent = '— none —';
    selectEl.appendChild(none);
  }
  for (const r of roles) {
    const opt = document.createElement('option');
    opt.value = r.id;
    opt.textContent = r.name;
    selectEl.appendChild(opt);
  }
}

// ---------- Server switcher (inside the dashboard) ----------

function refreshGuildSelect() {
  const select = document.getElementById('guild-select');
  select.innerHTML = guildsCache.withBot
    .map((g) => `<option value="${g.id}" ${g.id === selectedGuildId ? 'selected' : ''}>${escapeHtml(g.name)}</option>`)
    .join('');
}

function switchGuildInline() {
  selectedGuildId = document.getElementById('guild-select').value;
  initialized = false;
  init();
}

// ---------- Tabs ----------

function setupTabs() {
  const buttons = document.querySelectorAll('.nav-button');
  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      buttons.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');

      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.add('hidden'));
      document.getElementById(`tab-${btn.dataset.tab}`).classList.remove('hidden');
    });
  });
}

// ---------- Init ----------

let initialized = false;

function init() {
  document.getElementById('topbar-avatar').src = me.avatar;
  document.getElementById('topbar-username').textContent = me.username;
  refreshGuildSelect();

  if (initialized) {
    refreshEverything();
    return;
  }
  initialized = true;

  setupTabs();
  document.getElementById('guild-select').addEventListener('change', switchGuildInline);

  populateChannelSelect(document.getElementById('channel-select'));
  populateChannelSelect(document.getElementById('purge-channel'));
  populateChannelSelect(document.getElementById('slowmode-channel'));
  populateChannelSelect(document.getElementById('poll-channel'));
  populateChannelSelect(document.getElementById('sticky-channel'));
  populateChannelSelect(document.getElementById('giveaway-channel'));
  populateChannelSelect(document.getElementById('reminder-channel'));
  populateChannelSelect(document.getElementById('fun-channel'));
  populateChannelSelect(document.getElementById('rr-channel'));
  populateChannelSelect(document.getElementById('verification-channel'));
  populateRoleSelect(document.getElementById('rr-role'));
  Promise.all([
    populateChannelSelect(document.getElementById('settings-counting-channel'), { withNone: true }),
    populateChannelSelect(document.getElementById('settings-modlogs-channel'), { withNone: true }),
    populateChannelSelect(document.getElementById('settings-announcements-channel'), { withNone: true }),
    populateRoleSelect(document.getElementById('settings-member-role'), { withNone: true }),
    populateRoleSelect(document.getElementById('settings-giveaway-ping-role'), { withNone: true }),
    populateRoleSelect(document.getElementById('settings-announcement-ping-role'), { withNone: true }),
  ]).then(refreshGuildSettings);

  populateChannelSelect(document.getElementById('ticket-post-channel'));
  Promise.all([
    populateCategorySelect(document.getElementById('ticket-closed-category'), { withNone: true }),
    populateCategorySelect(document.getElementById('ticket-panel-category'), { withNone: true }),
    populateRoleSelect(document.getElementById('ticket-support-role'), { withNone: true }),
  ]).then(refreshTicketConfig);

  refreshEverything();

  setInterval(refreshStatus, 5000);
  setInterval(refreshActivity, 8000);
  setInterval(refreshAuditLog, 6000);
  setInterval(refreshCountingState, 6000);
  setInterval(refreshLeaderboard, 15000);
  setInterval(refreshGiveaways, 10000);
  setInterval(refreshReminders, 10000);
  setInterval(refreshInsights, 20000);
  setInterval(refreshOpenTickets, 10000);
  setInterval(refreshClosedTickets, 15000);
  setInterval(refreshTicketStats, 20000);

  document.getElementById('send-button').addEventListener('click', sendMessage);
  document.getElementById('purge-btn').addEventListener('click', purgeMessages);
  document.getElementById('slowmode-btn').addEventListener('click', applySlowmode);
  document.getElementById('member-search-btn').addEventListener('click', () => {
    refreshMembers(document.getElementById('member-search').value.trim());
  });
  document.getElementById('member-search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') refreshMembers(document.getElementById('member-search').value.trim());
  });
  document.getElementById('counting-reset-btn').addEventListener('click', resetCounting);
  document.getElementById('dm-button').addEventListener('click', sendDm);
  document.getElementById('poll-add-option').addEventListener('click', addPollOption);
  document.getElementById('poll-create-btn').addEventListener('click', createPoll);
  document.getElementById('warn-btn').addEventListener('click', warnMember);
  document.getElementById('sticky-btn').addEventListener('click', setSticky);
  document.getElementById('autoresponse-btn').addEventListener('click', addAutoResponse);
  document.getElementById('giveaway-btn').addEventListener('click', startGiveaway);
  document.getElementById('reminder-btn').addEventListener('click', scheduleReminder);
  document.getElementById('automod-save-btn').addEventListener('click', saveAutomod);
  document.getElementById('lockdown-on-btn').addEventListener('click', () => setLockdown(true));
  document.getElementById('lockdown-off-btn').addEventListener('click', () => setLockdown(false));
  document.getElementById('verification-save-btn').addEventListener('click', saveVerification);
  document.getElementById('verification-post-btn').addEventListener('click', postVerification);
  document.getElementById('rr-btn').addEventListener('click', createReactionRole);
  document.getElementById('cmd-prefix-save-btn').addEventListener('click', saveCommandPrefix);
  document.getElementById('cmd-search').addEventListener('input', () => renderCommandList());
  document.getElementById('settings-save-btn').addEventListener('click', saveGuildSettings);
  document.getElementById('ticket-config-save-btn').addEventListener('click', saveTicketConfig);
  document.getElementById('ticket-panel-add-btn').addEventListener('click', addTicketPanel);
  document.getElementById('ticket-post-btn').addEventListener('click', postTicketPanel);
  document.getElementById('rate-command-add-btn').addEventListener('click', addRateCommand);
  document.getElementById('rp-add-btn').addEventListener('click', addRolePanel);

  document.querySelectorAll('[data-template]').forEach((btn) => {
    btn.addEventListener('click', () => sendTemplate(btn.dataset.template));
  });
  document.querySelectorAll('[data-fun]').forEach((btn) => {
    btn.addEventListener('click', () => triggerFun(btn.dataset.fun));
  });
}

function refreshEverything() {
  refreshStatus();
  refreshGuildInfo();
  refreshActivity();
  refreshBans();
  refreshRoles();
  refreshCountingState();
  refreshAuditLog();
  refreshMembers('');
  refreshWarned();
  refreshLeaderboard();
  refreshStickies();
  refreshAutoResponses();
  refreshGiveaways();
  refreshReminders();
  refreshAutomod();
  refreshVerification();
  refreshReactionRoles();
  refreshInsights();
  refreshCommands();
  refreshTicketStats();
  refreshOpenTickets();
  refreshClosedTickets();
  refreshRateCommands();
  refreshRolePanels();
  refreshGuildSettings();
  refreshTicketConfig();
}

// ---------- Overview ----------

async function refreshStatus() {
  try {
    const res = await api('/api/status');
    if (!res.ok) return;
    const data = await res.json();

    document.getElementById('bot-ping').textContent = data.botPing >= 0 ? data.botPing : '—';
    document.getElementById('member-count').textContent = data.memberCount ?? '—';
    document.getElementById('bot-uptime').textContent = formatUptime(data.botUptimeMs);

    document.getElementById('vitals-bot-tag').textContent = data.botTag || '—';
    document.getElementById('vitals-ping').textContent = data.botPing >= 0 ? `${data.botPing}ms` : '—';
    document.getElementById('vitals-members').textContent = data.memberCount ?? '—';
    document.getElementById('vitals-guild').textContent = data.guildName || '—';
  } catch {
    // network hiccup, ignore until next poll
  }
}

async function refreshGuildInfo() {
  const res = await api('/api/guild-info');
  const el = document.getElementById('guild-info');
  if (!res.ok) {
    el.innerHTML = '<span class="empty-hint">Could not load server info.</span>';
    return;
  }
  const g = await res.json();

  document.getElementById('boost-tier-quick').textContent = g.boostTier;

  el.innerHTML = `
    ${g.icon ? `<img src="${g.icon}" alt="" />` : ''}
    <div class="guild-info-stats">
      <div><span class="label">Name</span><span class="value">${escapeHtml(g.name)}</span></div>
      <div><span class="label">Members</span><span class="value">${g.memberCount}</span></div>
      <div><span class="label">Channels</span><span class="value">${g.channelCount}</span></div>
      <div><span class="label">Roles</span><span class="value">${g.roleCount}</span></div>
      <div><span class="label">Boost Tier</span><span class="value">${g.boostTier} (${g.boostCount} boosts)</span></div>
      <div><span class="label">Created</span><span class="value">${new Date(g.createdAt).toLocaleDateString()}</span></div>
    </div>
  `;
}

async function refreshActivity() {
  const res = await api('/api/activity');
  const el = document.getElementById('activity-feed');
  if (!res.ok) return;
  const events = await res.json();

  if (events.length === 0) {
    el.innerHTML = '<span class="empty-hint">No activity yet.</span>';
    return;
  }

  el.innerHTML = events
    .slice(0, 20)
    .map(
      (e) => `
      <div class="list-row">
        ${e.avatar ? `<img class="list-avatar" src="${e.avatar}" alt="" />` : ''}
        <div class="list-main">
          <div class="list-title">${e.type === 'join' ? '➕' : '➖'} ${escapeHtml(e.tag)}</div>
          <div class="list-sub">${e.type === 'join' ? 'Joined' : 'Left'} · ${timeAgo(e.time)}</div>
        </div>
      </div>
    `
    )
    .join('');
}

// ---------- Moderation ----------

let cachedRoles = [];

async function refreshMembers(search) {
  const res = await api(`/api/members?search=${encodeURIComponent(search || '')}`);
  const el = document.getElementById('member-list');
  if (!res.ok) {
    el.innerHTML = '<span class="empty-hint">Could not load members.</span>';
    return;
  }
  const members = await res.json();

  if (members.length === 0) {
    el.innerHTML = '<span class="empty-hint">No members found.</span>';
    return;
  }

  el.innerHTML = members
    .map((m) => {
      const roleChips = m.roles
        .map((r) => `<span class="role-chip" style="border-color:${r.color};color:${r.color}">${escapeHtml(r.name)}</span>`)
        .join('');
      return `
      <div class="list-row">
        <img class="list-avatar" src="${m.avatar}" alt="" />
        <div class="list-main">
          <div class="list-title">${escapeHtml(m.tag)}${m.bot ? ' <span class="muted small">BOT</span>' : ''}</div>
          <div class="list-sub">${roleChips || '<span class="muted">No roles</span>'}</div>
        </div>
        <div class="list-actions">
          <button class="secondary-button" onclick="openRoleMenu('${m.id}')">Roles</button>
          <button class="secondary-button" onclick="timeoutMember('${m.id}', '${escapeHtml(m.tag)}')">Timeout</button>
          <button class="danger-button" onclick="kickMember('${m.id}', '${escapeHtml(m.tag)}')">Kick</button>
          <button class="danger-button" onclick="banMember('${m.id}', '${escapeHtml(m.tag)}')">Ban</button>
        </div>
      </div>
    `;
    })
    .join('');
}

async function kickMember(userId, tag) {
  if (!confirm(`Kick ${tag}?`)) return;
  const reason = prompt('Reason (optional):', '') || '';
  const res = await api('/api/moderation/kick', { method: 'POST', body: JSON.stringify({ userId, reason }) });
  if (res.ok) {
    refreshMembers(document.getElementById('member-search').value.trim());
    refreshAuditLog();
  } else {
    const data = await res.json();
    alert(`Failed: ${data.error}`);
  }
}

async function banMember(userId, tag) {
  if (!confirm(`Permanently ban ${tag}? This can be undone from the Banned Users list.`)) return;
  const reason = prompt('Reason (optional):', '') || '';
  const res = await api('/api/moderation/ban', { method: 'POST', body: JSON.stringify({ userId, reason }) });
  if (res.ok) {
    refreshMembers(document.getElementById('member-search').value.trim());
    refreshBans();
    refreshAuditLog();
  } else {
    const data = await res.json();
    alert(`Failed: ${data.error}`);
  }
}

async function timeoutMember(userId, tag) {
  const minutes = prompt(`Timeout ${tag} for how many minutes?`, '10');
  if (!minutes) return;
  const reason = prompt('Reason (optional):', '') || '';
  const res = await api('/api/moderation/timeout', { method: 'POST', body: JSON.stringify({ userId, minutes, reason }) });
  if (res.ok) {
    refreshAuditLog();
  } else {
    const data = await res.json();
    alert(`Failed: ${data.error}`);
  }
}

async function refreshBans() {
  const res = await api('/api/moderation/bans');
  const el = document.getElementById('ban-list');
  if (!res.ok) return;
  const bans = await res.json();

  if (bans.length === 0) {
    el.innerHTML = '<span class="empty-hint">No banned users.</span>';
    return;
  }

  el.innerHTML = bans
    .map(
      (b) => `
      <div class="list-row">
        <img class="list-avatar" src="${b.avatar}" alt="" />
        <div class="list-main">
          <div class="list-title">${escapeHtml(b.tag)}</div>
          <div class="list-sub">${b.reason ? escapeHtml(b.reason) : 'No reason given'}</div>
        </div>
        <div class="list-actions">
          <button class="secondary-button" onclick="unbanUser('${b.id}')">Unban</button>
        </div>
      </div>
    `
    )
    .join('');
}

async function unbanUser(userId) {
  if (!confirm('Unban this user?')) return;
  const res = await api('/api/moderation/unban', { method: 'POST', body: JSON.stringify({ userId }) });
  if (res.ok) {
    refreshBans();
    refreshAuditLog();
  } else {
    const data = await res.json();
    alert(`Failed: ${data.error}`);
  }
}

async function refreshRoles() {
  const res = await api('/api/roles');
  const el = document.getElementById('role-list');
  if (!res.ok) return;
  cachedRoles = await res.json();

  el.innerHTML = cachedRoles
    .map(
      (r) => `
      <div class="list-row">
        <span class="role-chip" style="border-color:${r.color};color:${r.color}">${escapeHtml(r.name)}</span>
        <div class="list-main">
          <div class="list-sub">${r.memberCount} member${r.memberCount === 1 ? '' : 's'}</div>
        </div>
      </div>
    `
    )
    .join('');
}

function openRoleMenu(userId) {
  const roleName = prompt(
    `Type a role name to ADD, or prefix with "-" to REMOVE (e.g. "VIP" or "-VIP"):\n\nAvailable: ${cachedRoles.map((r) => r.name).join(', ')}`
  );
  if (!roleName) return;

  const remove = roleName.startsWith('-');
  const cleanName = (remove ? roleName.slice(1) : roleName).trim().toLowerCase();
  const role = cachedRoles.find((r) => r.name.toLowerCase() === cleanName);

  if (!role) {
    alert('Role not found (check spelling/case).');
    return;
  }

  api(`/api/roles/${remove ? 'remove' : 'add'}`, { method: 'POST', body: JSON.stringify({ userId, roleId: role.id }) }).then(async (res) => {
    if (res.ok) {
      refreshMembers(document.getElementById('member-search').value.trim());
      refreshRoles();
      refreshAuditLog();
    } else {
      const data = await res.json();
      alert(`Failed: ${data.error}`);
    }
  });
}

async function purgeMessages() {
  const channelId = document.getElementById('purge-channel').value;
  const amount = document.getElementById('purge-amount').value;
  const feedback = document.getElementById('purge-feedback');

  if (!confirm(`Delete the last ${amount} messages in this channel? This cannot be undone.`)) return;

  const res = await api('/api/purge', { method: 'POST', body: JSON.stringify({ channelId, amount }) });
  const data = await res.json();

  if (res.ok) {
    setFeedback(feedback, `Deleted ${data.deleted} messages.`, true);
  } else {
    setFeedback(feedback, `Failed: ${data.error}`, false);
  }
}

async function applySlowmode() {
  const channelId = document.getElementById('slowmode-channel').value;
  const seconds = document.getElementById('slowmode-seconds').value;
  const feedback = document.getElementById('slowmode-feedback');

  const res = await api('/api/slowmode', { method: 'POST', body: JSON.stringify({ channelId, seconds }) });
  const data = await res.json();

  if (res.ok) {
    setFeedback(feedback, `Slowmode set to ${seconds}s.`, true);
  } else {
    setFeedback(feedback, `Failed: ${data.error}`, false);
  }
}

// ---------- Messaging ----------

async function sendMessage() {
  const button = document.getElementById('send-button');
  const feedback = document.getElementById('send-feedback');
  const channelId = document.getElementById('channel-select').value;
  const title = document.getElementById('title-input').value.trim();
  const color = document.getElementById('color-input').value;
  const message = document.getElementById('message-input').value.trim();

  if (!channelId || !message) {
    setFeedback(feedback, 'Pick a channel and write a message first.', false);
    return;
  }

  button.disabled = true;
  button.textContent = 'Sending…';

  try {
    const res = await api('/api/send', { method: 'POST', body: JSON.stringify({ channelId, message, title: title || undefined, color }) });
    const data = await res.json();

    if (res.ok) {
      setFeedback(feedback, 'Sent!', true);
      document.getElementById('message-input').value = '';
      document.getElementById('title-input').value = '';
      refreshAuditLog();
    } else {
      setFeedback(feedback, `Failed: ${data.error || 'unknown error'}`, false);
    }
  } catch (err) {
    setFeedback(feedback, `Failed: ${err.message}`, false);
  } finally {
    button.disabled = false;
    button.textContent = 'Send';
  }
}

async function sendTemplate(type) {
  const feedback = document.getElementById('template-feedback');
  const res = await api('/api/announce-template', { method: 'POST', body: JSON.stringify({ type }) });
  const data = await res.json();

  if (res.ok) {
    setFeedback(feedback, 'Announcement sent!', true);
    refreshAuditLog();
  } else {
    setFeedback(feedback, `Failed: ${data.error}`, false);
  }
}

async function sendDm() {
  const feedback = document.getElementById('dm-feedback');
  const userId = document.getElementById('dm-user-id').value.trim();
  const message = document.getElementById('dm-message').value.trim();

  if (!userId || !message) {
    setFeedback(feedback, 'User ID and message are required.', false);
    return;
  }

  const res = await api('/api/dm', { method: 'POST', body: JSON.stringify({ userId, message }) });
  const data = await res.json();

  if (res.ok) {
    setFeedback(feedback, 'DM sent!', true);
    document.getElementById('dm-message').value = '';
    refreshAuditLog();
  } else {
    setFeedback(feedback, `Failed: ${data.error}`, false);
  }
}

function addPollOption() {
  const container = document.getElementById('poll-options');
  if (container.children.length >= 10) return;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'poll-option';
  input.placeholder = `Option ${container.children.length + 1}`;
  container.appendChild(input);
}

async function createPoll() {
  const feedback = document.getElementById('poll-feedback');
  const channelId = document.getElementById('poll-channel').value;
  const question = document.getElementById('poll-question').value.trim();
  const options = [...document.querySelectorAll('.poll-option')].map((i) => i.value.trim()).filter(Boolean);

  if (!channelId || !question || options.length < 2) {
    setFeedback(feedback, 'Channel, a question, and at least 2 options are required.', false);
    return;
  }

  const res = await api('/api/poll', { method: 'POST', body: JSON.stringify({ channelId, question, options }) });
  const data = await res.json();

  if (res.ok) {
    setFeedback(feedback, 'Poll posted!', true);
    document.getElementById('poll-question').value = '';
    document.querySelectorAll('.poll-option').forEach((i) => (i.value = ''));
    refreshAuditLog();
  } else {
    setFeedback(feedback, `Failed: ${data.error}`, false);
  }
}

// ---------- Server tab ----------

async function refreshCountingState() {
  const res = await api('/api/counting/state');
  if (!res.ok) return;
  const state = await res.json();

  document.getElementById('counting-next').textContent = `Next number: ${state.currentCount}`;
  document.getElementById('counting-last').textContent = state.lastUserId ? `Last counted by user ID ${state.lastUserId}` : 'No one has counted yet';
}

async function resetCounting() {
  if (!confirm('Reset the counting game back to 1?')) return;
  const feedback = document.getElementById('counting-feedback');
  const res = await api('/api/counting/reset', { method: 'POST' });
  if (res.ok) {
    setFeedback(feedback, 'Counting game reset.', true);
    refreshCountingState();
    refreshAuditLog();
  } else {
    setFeedback(feedback, 'Failed to reset.', false);
  }
}

async function refreshAuditLog() {
  const res = await api('/api/audit');
  const el = document.getElementById('audit-log');
  if (!res.ok) return;
  const entries = await res.json();

  if (entries.length === 0) {
    el.innerHTML = '<span class="empty-hint">No actions yet.</span>';
    return;
  }

  el.innerHTML = entries
    .slice(0, 40)
    .map(
      (e) => `
      <div class="list-row">
        <div class="list-main">
          <div class="list-title">${escapeHtml(e.action)}</div>
          <div class="list-sub">${escapeHtml(e.detail)} · ${timeAgo(e.time)}</div>
        </div>
      </div>
    `
    )
    .join('');
}

// ---------- Warnings ----------

async function refreshWarned() {
  const res = await api('/api/warnings');
  const el = document.getElementById('warned-list');
  if (!res.ok) return;
  const warned = await res.json();

  if (warned.length === 0) {
    el.innerHTML = '<span class="empty-hint">No warnings issued.</span>';
    return;
  }

  el.innerHTML = warned
    .map(
      (w) => `
      <div class="list-row">
        <div class="list-main">
          <div class="list-title">User ${w.userId}</div>
          <div class="list-sub">${w.count} warning${w.count === 1 ? '' : 's'}</div>
        </div>
        <div class="list-actions">
          <button class="secondary-button" onclick="clearWarnings('${w.userId}')">Clear</button>
        </div>
      </div>
    `
    )
    .join('');
}

async function warnMember() {
  const feedback = document.getElementById('warn-feedback');
  const userId = document.getElementById('warn-user-id').value.trim();
  const reason = document.getElementById('warn-reason').value.trim();

  if (!userId || !reason) {
    setFeedback(feedback, 'User ID and reason are required.', false);
    return;
  }

  const res = await api('/api/warnings', { method: 'POST', body: JSON.stringify({ userId, reason }) });
  const data = await res.json();

  if (res.ok) {
    setFeedback(feedback, data.autoTimedOut ? `Warned! ${data.warnings.length} warnings — auto-timed out.` : `Warned (${data.warnings.length} total).`, true);
    document.getElementById('warn-reason').value = '';
    refreshWarned();
    refreshAuditLog();
  } else {
    setFeedback(feedback, `Failed: ${data.error}`, false);
  }
}

async function clearWarnings(userId) {
  if (!confirm('Clear all warnings for this user?')) return;
  await api(`/api/warnings/${userId}`, { method: 'DELETE' });
  refreshWarned();
  refreshAuditLog();
}

// ---------- Leveling ----------

async function refreshLeaderboard() {
  const res = await api('/api/leaderboard');
  const el = document.getElementById('leaderboard-list');
  if (!res.ok) return;
  const leaderboard = await res.json();

  if (leaderboard.length === 0) {
    el.innerHTML = '<span class="empty-hint">No XP earned yet — leaderboard fills in as people chat.</span>';
    return;
  }

  const medalClass = ['gold', 'silver', 'bronze'];

  el.innerHTML = leaderboard
    .map(
      (u, i) => `
      <div class="list-row">
        <div class="rank-num ${medalClass[i] || ''}">${i + 1}</div>
        <div class="list-main">
          <div class="list-title">${escapeHtml(u.tag || u.userId)}</div>
          <div class="list-sub">Level ${u.level} · ${u.xp} XP</div>
        </div>
      </div>
    `
    )
    .join('');
}

// ---------- Automation: sticky messages ----------

async function refreshStickies() {
  const res = await api('/api/sticky');
  const el = document.getElementById('sticky-list');
  if (!res.ok) return;
  const stickies = await res.json();

  if (stickies.length === 0) {
    el.innerHTML = '<span class="empty-hint">No sticky messages set.</span>';
    return;
  }

  el.innerHTML = stickies
    .map(
      (s) => `
      <div class="list-row">
        <div class="list-main">
          <div class="list-title">📌 ${escapeHtml(s.text)}</div>
          <div class="list-sub">Channel ID: ${s.channelId}</div>
        </div>
        <div class="list-actions">
          <button class="danger-button" onclick="removeSticky('${s.channelId}')">Remove</button>
        </div>
      </div>
    `
    )
    .join('');
}

async function setSticky() {
  const feedback = document.getElementById('sticky-feedback');
  const channelId = document.getElementById('sticky-channel').value;
  const text = document.getElementById('sticky-text').value.trim();

  if (!channelId || !text) {
    setFeedback(feedback, 'Pick a channel and write the sticky text.', false);
    return;
  }

  const res = await api('/api/sticky', { method: 'POST', body: JSON.stringify({ channelId, text }) });

  if (res.ok) {
    setFeedback(feedback, 'Sticky set!', true);
    document.getElementById('sticky-text').value = '';
    refreshStickies();
    refreshAuditLog();
  } else {
    const data = await res.json();
    setFeedback(feedback, `Failed: ${data.error}`, false);
  }
}

async function removeSticky(channelId) {
  await api(`/api/sticky/${channelId}`, { method: 'DELETE' });
  refreshStickies();
  refreshAuditLog();
}

// ---------- Automation: auto-responses ----------

async function refreshAutoResponses() {
  const res = await api('/api/autoresponses');
  const el = document.getElementById('autoresponse-list');
  if (!res.ok) return;
  const responses = await res.json();

  if (responses.length === 0) {
    el.innerHTML = '<span class="empty-hint">No auto-responses configured.</span>';
    return;
  }

  el.innerHTML = responses
    .map(
      (r) => `
      <div class="list-row">
        <div class="list-main">
          <div class="list-title">"${escapeHtml(r.trigger)}" → ${escapeHtml(r.reply)}</div>
        </div>
        <div class="list-actions">
          <button class="danger-button" onclick="removeAutoResponse('${r.id}')">Remove</button>
        </div>
      </div>
    `
    )
    .join('');
}

async function addAutoResponse() {
  const feedback = document.getElementById('autoresponse-feedback');
  const trigger = document.getElementById('autoresponse-trigger').value.trim();
  const reply = document.getElementById('autoresponse-reply').value.trim();

  if (!trigger || !reply) {
    setFeedback(feedback, 'Trigger and reply are required.', false);
    return;
  }

  const res = await api('/api/autoresponses', { method: 'POST', body: JSON.stringify({ trigger, reply }) });

  if (res.ok) {
    setFeedback(feedback, 'Added!', true);
    document.getElementById('autoresponse-trigger').value = '';
    document.getElementById('autoresponse-reply').value = '';
    refreshAutoResponses();
    refreshAuditLog();
  } else {
    const data = await res.json();
    setFeedback(feedback, `Failed: ${data.error}`, false);
  }
}

async function removeAutoResponse(id) {
  await api(`/api/autoresponses/${id}`, { method: 'DELETE' });
  refreshAutoResponses();
  refreshAuditLog();
}

// ---------- Automation: giveaways ----------

async function refreshGiveaways() {
  const res = await api('/api/giveaways');
  const el = document.getElementById('giveaway-list');
  if (!res.ok) return;
  const list = await res.json();

  if (list.length === 0) {
    el.innerHTML = '<span class="empty-hint">No giveaways yet.</span>';
    return;
  }

  el.innerHTML = list
    .slice()
    .reverse()
    .map(
      (g) => `
      <div class="list-row">
        <div class="list-main">
          <div class="list-title">🎉 ${escapeHtml(g.prize)}</div>
          <div class="list-sub">${g.ended ? `Ended · ${g.winners?.length || 0} winner(s)` : `Ends ${new Date(g.endsAt).toLocaleString()}`}</div>
        </div>
        ${g.ended ? '' : `<div class="list-actions"><button class="danger-button" onclick="endGiveaway('${g.messageId}')">End Now</button></div>`}
      </div>
    `
    )
    .join('');
}

async function startGiveaway() {
  const feedback = document.getElementById('giveaway-feedback');
  const channelId = document.getElementById('giveaway-channel').value;
  const prize = document.getElementById('giveaway-prize').value.trim();
  const durationMinutes = document.getElementById('giveaway-duration').value;
  const winnerCount = document.getElementById('giveaway-winners').value;

  if (!channelId || !prize || !durationMinutes || !winnerCount) {
    setFeedback(feedback, 'All fields are required.', false);
    return;
  }

  const res = await api('/api/giveaways', { method: 'POST', body: JSON.stringify({ channelId, prize, durationMinutes, winnerCount }) });

  if (res.ok) {
    setFeedback(feedback, 'Giveaway started!', true);
    document.getElementById('giveaway-prize').value = '';
    refreshGiveaways();
    refreshAuditLog();
  } else {
    const data = await res.json();
    setFeedback(feedback, `Failed: ${data.error}`, false);
  }
}

async function endGiveaway(messageId) {
  if (!confirm('End this giveaway now and pick winners?')) return;
  await api(`/api/giveaways/${messageId}/end`, { method: 'POST' });
  refreshGiveaways();
  refreshAuditLog();
}

// ---------- Automation: reminders ----------

async function refreshReminders() {
  const res = await api('/api/reminders');
  const el = document.getElementById('reminder-list');
  if (!res.ok) return;
  const list = await res.json();

  if (list.length === 0) {
    el.innerHTML = '<span class="empty-hint">No reminders scheduled.</span>';
    return;
  }

  el.innerHTML = list
    .map(
      (r) => `
      <div class="list-row">
        <div class="list-main">
          <div class="list-title">⏰ ${escapeHtml(r.message)}</div>
          <div class="list-sub">${new Date(r.sendAt).toLocaleString()}</div>
        </div>
        <div class="list-actions">
          <button class="danger-button" onclick="cancelReminder('${r.id}')">Cancel</button>
        </div>
      </div>
    `
    )
    .join('');
}

async function scheduleReminder() {
  const feedback = document.getElementById('reminder-feedback');
  const channelId = document.getElementById('reminder-channel').value;
  const message = document.getElementById('reminder-text').value.trim();
  const sendAt = document.getElementById('reminder-time').value;
  const repeat = document.getElementById('reminder-repeat').value;

  if (!channelId || !message || !sendAt) {
    setFeedback(feedback, 'Channel, message, and time are required.', false);
    return;
  }

  const res = await api('/api/reminders', { method: 'POST', body: JSON.stringify({ channelId, message, sendAt: new Date(sendAt).toISOString(), repeat }) });

  if (res.ok) {
    setFeedback(feedback, 'Reminder scheduled!', true);
    document.getElementById('reminder-text').value = '';
    refreshReminders();
    refreshAuditLog();
  } else {
    const data = await res.json();
    setFeedback(feedback, `Failed: ${data.error}`, false);
  }
}

async function cancelReminder(id) {
  await api(`/api/reminders/${id}`, { method: 'DELETE' });
  refreshReminders();
  refreshAuditLog();
}

// ---------- Security: auto-mod ----------

const AUTOMOD_LABELS = {
  linkFilter: 'Block links (except whitelisted domains)',
  inviteFilter: 'Block Discord invite links',
  capsFilter: 'Block excessive CAPS spam',
  mentionSpamFilter: 'Block mass mentions (5+)',
  duplicateSpamFilter: 'Block repeated duplicate messages',
};

async function refreshAutomod() {
  const res = await api('/api/automod');
  if (!res.ok) return;
  const config = await res.json();

  const el = document.getElementById('automod-toggles');
  el.innerHTML = Object.entries(AUTOMOD_LABELS)
    .map(
      ([key, label]) => `
      <div class="toggle-row">
        <span class="toggle-label">${label}</span>
        <label class="toggle-switch">
          <input type="checkbox" data-automod-key="${key}" ${config[key] ? 'checked' : ''} />
          <span class="toggle-slider"></span>
        </label>
      </div>
    `
    )
    .join('');

  document.getElementById('automod-age-gate').value = config.accountAgeGateDays || 0;
}

async function saveAutomod() {
  const feedback = document.getElementById('automod-feedback');
  const patch = {};
  document.querySelectorAll('[data-automod-key]').forEach((input) => {
    patch[input.dataset.automodKey] = input.checked;
  });
  patch.accountAgeGateDays = parseInt(document.getElementById('automod-age-gate').value, 10) || 0;

  const res = await api('/api/automod', { method: 'POST', body: JSON.stringify(patch) });
  if (res.ok) {
    setFeedback(feedback, 'Saved!', true);
    refreshAuditLog();
  } else {
    setFeedback(feedback, 'Failed to save.', false);
  }
}

async function setLockdown(locked) {
  const feedback = document.getElementById('lockdown-feedback');
  if (locked && !confirm('Lock down ALL text channels right now?')) return;

  const res = await api('/api/lockdown', { method: 'POST', body: JSON.stringify({ locked }) });
  const data = await res.json();

  if (res.ok) {
    setFeedback(feedback, locked ? `Locked ${data.channelsAffected} channels.` : `Unlocked ${data.channelsAffected} channels.`, true);
    refreshAuditLog();
  } else {
    setFeedback(feedback, `Failed: ${data.error}`, false);
  }
}

// ---------- Security: verification gate ----------

async function refreshVerification() {
  const res = await api('/api/verification');
  if (!res.ok) return;
  const data = await res.json();
  document.getElementById('verification-toggle').value = String(data.enabled);
}

async function saveVerification() {
  const feedback = document.getElementById('verification-feedback');
  const enabled = document.getElementById('verification-toggle').value === 'true';
  const res = await api('/api/verification', { method: 'POST', body: JSON.stringify({ enabled }) });
  if (res.ok) {
    setFeedback(feedback, 'Saved!', true);
    refreshAuditLog();
  } else {
    setFeedback(feedback, 'Failed to save.', false);
  }
}

async function postVerification() {
  const feedback = document.getElementById('verification-feedback');
  const channelId = document.getElementById('verification-channel').value;
  if (!channelId) return;

  const res = await api('/api/verification/post', { method: 'POST', body: JSON.stringify({ channelId }) });
  if (res.ok) {
    setFeedback(feedback, 'Verify button posted!', true);
    refreshAuditLog();
  } else {
    const data = await res.json();
    setFeedback(feedback, `Failed: ${data.error}`, false);
  }
}

// ---------- Commands ----------

let commandsCache = [];

async function refreshCommands() {
  const res = await api('/api/commands');
  if (!res.ok) return;
  const data = await res.json();
  commandsCache = data.commands;
  document.getElementById('cmd-prefix-input').value = data.prefix;
  document.getElementById('cmd-count-label').textContent = `${data.commands.length} commands available, grouped by category.`;
  renderCommandList();
}

function renderCommandList() {
  const query = (document.getElementById('cmd-search').value || '').toLowerCase();
  const filtered = commandsCache.filter((c) => c.name.includes(query) || c.category.toLowerCase().includes(query) || c.description.toLowerCase().includes(query));

  const byCategory = {};
  for (const c of filtered) {
    (byCategory[c.category] = byCategory[c.category] || []).push(c);
  }

  const prefix = document.getElementById('cmd-prefix-input').value || '!';
  const el = document.getElementById('cmd-list');
  el.innerHTML = Object.entries(byCategory)
    .map(
      ([category, cmds]) => `
      <div class="command-category">
        <h3>${escapeHtml(category)}</h3>
        ${cmds
          .map(
            (c) => `
          <div class="toggle-row">
            <div>
              <span class="toggle-label"><code>${escapeHtml(prefix + c.name)}</code> ${escapeHtml(c.usage)}</span>
              <p class="muted small" style="margin:2px 0 0">${escapeHtml(c.description)}${c.permission ? ` — requires <strong>${escapeHtml(c.permission)}</strong>` : ' — everyone'}</p>
            </div>
            <label class="toggle-switch">
              <input type="checkbox" data-cmd-toggle="${c.name}" ${c.disabled ? '' : 'checked'} />
              <span class="toggle-slider"></span>
            </label>
          </div>`
          )
          .join('')}
      </div>`
    )
    .join('');

  document.querySelectorAll('[data-cmd-toggle]').forEach((input) => {
    input.addEventListener('change', () => toggleCommand(input.dataset.cmdToggle, !input.checked));
  });
}

async function saveCommandPrefix() {
  const feedback = document.getElementById('cmd-prefix-feedback');
  const prefix = document.getElementById('cmd-prefix-input').value.trim();
  if (!prefix) return setFeedback(feedback, 'Prefix cannot be empty.', false);

  const res = await api('/api/commands/prefix', { method: 'POST', body: JSON.stringify({ prefix }) });
  if (res.ok) {
    setFeedback(feedback, 'Saved!', true);
    refreshAuditLog();
    refreshCommands();
  } else {
    const data = await res.json();
    setFeedback(feedback, `Failed: ${data.error}`, false);
  }
}

async function toggleCommand(name, disabled) {
  await api(`/api/commands/${name}/toggle`, { method: 'POST', body: JSON.stringify({ disabled }) });
  refreshAuditLog();
  refreshCommands();
}

// ---------- Custom rate commands ----------

async function refreshRateCommands() {
  const res = await api('/api/rate-commands');
  if (!res.ok) return;
  const types = await res.json();
  const el = document.getElementById('rate-commands-list');

  if (types.length === 0) {
    el.innerHTML = '<span class="empty-hint">No rate commands yet.</span>';
    return;
  }

  el.innerHTML = types
    .map(
      (t) => `
    <div class="list-row">
      <div class="list-main">
        <div class="list-title">${escapeHtml(t.emoji)} <code>!rate${escapeHtml(t.key)}</code> <span class="muted small">(${escapeHtml(t.label)})</span></div>
      </div>
      <div class="list-actions">
        <button class="danger-button" data-rate-remove="${t.key}">Remove</button>
      </div>
    </div>`
    )
    .join('');

  document.querySelectorAll('[data-rate-remove]').forEach((btn) => {
    btn.addEventListener('click', () => removeRateCommand(btn.dataset.rateRemove));
  });
}

async function addRateCommand() {
  const feedback = document.getElementById('rate-command-feedback');
  const label = document.getElementById('rate-command-label').value.trim();
  const emoji = document.getElementById('rate-command-emoji').value.trim();
  if (!label) return setFeedback(feedback, 'Give it a name.', false);

  const res = await api('/api/rate-commands', { method: 'POST', body: JSON.stringify({ label, emoji }) });
  if (res.ok) {
    document.getElementById('rate-command-label').value = '';
    document.getElementById('rate-command-emoji').value = '';
    setFeedback(feedback, 'Added!', true);
    refreshRateCommands();
    refreshAuditLog();
  } else {
    const data = await res.json();
    setFeedback(feedback, `Failed: ${data.error}`, false);
  }
}

async function removeRateCommand(key) {
  await api(`/api/rate-commands/${key}`, { method: 'DELETE' });
  refreshRateCommands();
  refreshAuditLog();
}

// ---------- Role panels ----------

async function refreshRolePanels() {
  const [panelsRes, rolesRes, channelsRes] = await Promise.all([api('/api/role-panels'), api('/api/roles'), api('/api/channels')]);
  if (!panelsRes.ok) return;
  const panels = await panelsRes.json();
  const roles = rolesRes.ok ? await rolesRes.json() : [];
  const channels = channelsRes.ok ? await channelsRes.json() : [];
  renderRolePanels(panels, roles, channels);
}

function renderRolePanels(panels, roles, channels) {
  const el = document.getElementById('role-panels-list');
  if (panels.length === 0) {
    el.innerHTML = '<span class="empty-hint">No role panels yet — add one below.</span>';
    return;
  }

  const roleOptions = roles.map((r) => `<option value="${r.id}">${escapeHtml(r.name)}</option>`).join('');
  const channelOptions = channels.map((c) => `<option value="${c.id}">${c.parent ? escapeHtml(c.parent) + ' / ' : ''}${escapeHtml(c.name)}</option>`).join('');

  el.innerHTML = panels
    .map(
      (p) => `
    <div class="list-row" style="align-items:flex-start; flex-direction:column; gap:10px;">
      <div style="display:flex; justify-content:space-between; width:100%; align-items:center;">
        <div class="list-title">${escapeHtml(p.name)} <span class="muted small">(${p.roles.length}/5 roles)</span></div>
        <button class="danger-button" data-rp-remove-panel="${p.id}">Remove Panel</button>
      </div>
      <div style="display:flex; flex-wrap:wrap; gap:6px;">
        ${
          p.roles
            .map(
              (r) => `<span class="role-chip" style="border-color:var(--border); color:var(--text);">${escapeHtml(r.emoji)} ${escapeHtml(r.label)}
            <a href="#" data-rp-remove-role="${p.id}:${r.roleId}" style="margin-left:6px; color:var(--redstone);">×</a></span>`
            )
            .join('') || '<span class="muted small">No roles on this panel yet.</span>'
        }
      </div>
      <div class="row" style="margin-top:0; width:100%;">
        <select data-rp-role-select="${p.id}">${roleOptions}</select>
        <input type="text" placeholder="Label, e.g. Giveaway Pings" data-rp-role-label="${p.id}" />
        <input type="text" placeholder="Emoji" style="max-width:70px" data-rp-role-emoji="${p.id}" />
        <button class="secondary-button" data-rp-add-role="${p.id}">Add Role</button>
      </div>
      <div class="row" style="margin-top:0; width:100%;">
        <select data-rp-post-channel="${p.id}">${channelOptions}</select>
        <button class="primary-button" data-rp-post="${p.id}">Post Panel</button>
      </div>
    </div>`
    )
    .join('');

  document.querySelectorAll('[data-rp-remove-panel]').forEach((btn) => {
    btn.addEventListener('click', () => removeRolePanel(btn.dataset.rpRemovePanel));
  });
  document.querySelectorAll('[data-rp-remove-role]').forEach((link) => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const [panelId, roleId] = link.dataset.rpRemoveRole.split(':');
      removeRoleFromPanel(panelId, roleId);
    });
  });
  document.querySelectorAll('[data-rp-add-role]').forEach((btn) => {
    btn.addEventListener('click', () => addRoleToPanel(btn.dataset.rpAddRole));
  });
  document.querySelectorAll('[data-rp-post]').forEach((btn) => {
    btn.addEventListener('click', () => postRolePanel(btn.dataset.rpPost));
  });
}

async function addRolePanel() {
  const feedback = document.getElementById('rp-add-feedback');
  const name = document.getElementById('rp-new-name').value.trim();
  if (!name) return setFeedback(feedback, 'Give the panel a name.', false);

  const body = {
    name,
    color: document.getElementById('rp-new-color').value || '#3fe8d6',
    title: document.getElementById('rp-new-title').value.trim() || name,
    description: document.getElementById('rp-new-description').value.trim() || 'Click a button below to toggle a notification role on or off.',
  };

  const res = await api('/api/role-panels', { method: 'POST', body: JSON.stringify(body) });
  if (res.ok) {
    ['rp-new-name', 'rp-new-title', 'rp-new-description'].forEach((id) => (document.getElementById(id).value = ''));
    setFeedback(feedback, 'Panel added!', true);
    refreshRolePanels();
    refreshAuditLog();
  } else {
    const data = await res.json();
    setFeedback(feedback, `Failed: ${data.error}`, false);
  }
}

async function removeRolePanel(id) {
  await api(`/api/role-panels/${id}`, { method: 'DELETE' });
  refreshRolePanels();
  refreshAuditLog();
}

async function addRoleToPanel(panelId) {
  const roleId = document.querySelector(`[data-rp-role-select="${panelId}"]`).value;
  const label = document.querySelector(`[data-rp-role-label="${panelId}"]`).value.trim();
  const emoji = document.querySelector(`[data-rp-role-emoji="${panelId}"]`).value.trim();
  if (!roleId || !label) return alert('Pick a role and give it a label.');

  const res = await api(`/api/role-panels/${panelId}/roles`, { method: 'POST', body: JSON.stringify({ roleId, label, emoji }) });
  if (res.ok) {
    refreshRolePanels();
    refreshAuditLog();
  } else {
    const data = await res.json();
    alert(`Could not add role: ${data.error}`);
  }
}

async function removeRoleFromPanel(panelId, roleId) {
  await api(`/api/role-panels/${panelId}/roles/${roleId}`, { method: 'DELETE' });
  refreshRolePanels();
  refreshAuditLog();
}

async function postRolePanel(panelId) {
  const channelId = document.querySelector(`[data-rp-post-channel="${panelId}"]`).value;
  if (!channelId) return;
  const res = await api(`/api/role-panels/${panelId}/post`, { method: 'POST', body: JSON.stringify({ channelId }) });
  if (res.ok) {
    refreshAuditLog();
    alert('Panel posted!');
  } else {
    const data = await res.json();
    alert(`Could not post: ${data.error}`);
  }
}

// ---------- Per-server settings ----------

async function refreshGuildSettings() {
  const res = await api('/api/guild-config');
  if (!res.ok) return;
  const config = await res.json();
  document.getElementById('settings-counting-channel').value = config.countingChannelId || '';
  document.getElementById('settings-member-role').value = config.memberRoleId || '';
  document.getElementById('settings-modlogs-channel').value = config.modLogsChannelId || '';
  document.getElementById('settings-announcements-channel').value = config.announcementsChannelId || '';
  document.getElementById('settings-giveaway-ping-role').value = config.giveawayPingRoleId || '';
  document.getElementById('settings-announcement-ping-role').value = config.announcementPingRoleId || '';
}

async function saveGuildSettings() {
  const feedback = document.getElementById('settings-feedback');
  const patch = {
    countingChannelId: document.getElementById('settings-counting-channel').value || null,
    memberRoleId: document.getElementById('settings-member-role').value || null,
    modLogsChannelId: document.getElementById('settings-modlogs-channel').value || null,
    announcementsChannelId: document.getElementById('settings-announcements-channel').value || null,
    giveawayPingRoleId: document.getElementById('settings-giveaway-ping-role').value || null,
    announcementPingRoleId: document.getElementById('settings-announcement-ping-role').value || null,
  };
  const res = await api('/api/guild-config', { method: 'POST', body: JSON.stringify(patch) });
  if (res.ok) {
    setFeedback(feedback, 'Saved!', true);
    refreshAuditLog();
  } else {
    setFeedback(feedback, 'Failed to save.', false);
  }
}

// ---------- Tickets ----------

let ticketPanelsCache = [];

async function refreshTicketConfig() {
  const res = await api('/api/tickets/config');
  if (!res.ok) return;
  const config = await res.json();

  document.getElementById('ticket-support-role').value = config.supportRoleId || '';
  document.getElementById('ticket-closed-category').value = config.closedCategoryChannelId || '';
  document.getElementById('ticket-name-format').value = config.ticketNameFormat || '';
  document.getElementById('ticket-welcome-message').value = config.welcomeMessage || '';
  document.getElementById('ticket-max-open').value = config.maxOpenPerUser || 1;
  document.getElementById('ticket-autoclose').value = config.autoCloseHours || 0;

  ticketPanelsCache = config.panels || [];
  renderTicketPanels();
  renderTicketPanelSelect();
}

function renderTicketPanels() {
  const el = document.getElementById('ticket-panels-list');
  if (ticketPanelsCache.length === 0) {
    el.innerHTML = '<span class="empty-hint">No panels yet — add one below.</span>';
    return;
  }
  el.innerHTML = ticketPanelsCache
    .map(
      (p) => `
    <div class="list-row">
      <div class="list-main">
        <div class="list-title">${escapeHtml(p.buttonEmoji || '🎫')} ${escapeHtml(p.name)} <span class="muted small">→ ${escapeHtml(p.buttonLabel)}</span></div>
        <div class="list-sub">Category: ${p.categoryChannelId ? escapeHtml(p.categoryChannelId) : 'none set'}</div>
      </div>
      <div class="list-actions">
        <button class="danger-button" data-panel-remove="${p.id}">Remove</button>
      </div>
    </div>`
    )
    .join('');

  document.querySelectorAll('[data-panel-remove]').forEach((btn) => {
    btn.addEventListener('click', () => removeTicketPanel(btn.dataset.panelRemove));
  });
}

function renderTicketPanelSelect() {
  const select = document.getElementById('ticket-post-panel-select');
  select.innerHTML = ticketPanelsCache.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('') || '<option value="">No panels yet</option>';
}

async function addTicketPanel() {
  const feedback = document.getElementById('ticket-panel-add-feedback');
  const name = document.getElementById('ticket-panel-name').value.trim();
  if (!name) return setFeedback(feedback, 'Give the panel a name.', false);

  const body = {
    name,
    buttonLabel: document.getElementById('ticket-panel-button-label').value.trim() || name,
    buttonEmoji: document.getElementById('ticket-panel-button-emoji').value.trim() || '🎫',
    panelTitle: document.getElementById('ticket-panel-title').value.trim() || name,
    panelDescription: document.getElementById('ticket-panel-description').value.trim() || 'Click the button below to open a private ticket with our staff.',
    panelColor: document.getElementById('ticket-panel-color').value || '#3fe8d6',
    categoryChannelId: document.getElementById('ticket-panel-category').value || null,
  };

  const res = await api('/api/tickets/panels', { method: 'POST', body: JSON.stringify(body) });
  if (res.ok) {
    ['ticket-panel-name', 'ticket-panel-button-label', 'ticket-panel-button-emoji', 'ticket-panel-title', 'ticket-panel-description'].forEach((id) => {
      document.getElementById(id).value = '';
    });
    setFeedback(feedback, 'Panel added!', true);
    refreshTicketConfig();
    refreshAuditLog();
  } else {
    const data = await res.json();
    setFeedback(feedback, `Failed: ${data.error}`, false);
  }
}

async function removeTicketPanel(id) {
  await api(`/api/tickets/panels/${id}`, { method: 'DELETE' });
  refreshTicketConfig();
  refreshAuditLog();
}

async function saveTicketConfig() {
  const feedback = document.getElementById('ticket-config-feedback');
  const patch = {
    supportRoleId: document.getElementById('ticket-support-role').value || null,
    closedCategoryChannelId: document.getElementById('ticket-closed-category').value || null,
    ticketNameFormat: document.getElementById('ticket-name-format').value || 'ticket-{username}',
    welcomeMessage: document.getElementById('ticket-welcome-message').value,
    maxOpenPerUser: parseInt(document.getElementById('ticket-max-open').value, 10) || 1,
    autoCloseHours: parseInt(document.getElementById('ticket-autoclose').value, 10) || 0,
  };

  const res = await api('/api/tickets/config', { method: 'POST', body: JSON.stringify(patch) });
  if (res.ok) {
    setFeedback(feedback, 'Saved!', true);
    refreshAuditLog();
  } else {
    setFeedback(feedback, 'Failed to save.', false);
  }
}

async function postTicketPanel() {
  const feedback = document.getElementById('ticket-post-feedback');
  const panelId = document.getElementById('ticket-post-panel-select').value;
  const channelId = document.getElementById('ticket-post-channel').value;
  if (!panelId || !channelId) return setFeedback(feedback, 'Pick a panel and a channel.', false);

  const res = await api(`/api/tickets/panels/${panelId}/post`, { method: 'POST', body: JSON.stringify({ channelId }) });
  if (res.ok) {
    setFeedback(feedback, 'Panel posted!', true);
    refreshAuditLog();
  } else {
    const data = await res.json();
    setFeedback(feedback, `Failed: ${data.error}`, false);
  }
}

async function refreshTicketStats() {
  const res = await api('/api/tickets/stats');
  if (!res.ok) return;
  const s = await res.json();
  document.getElementById('ticket-stat-open').textContent = s.open;
  document.getElementById('ticket-stat-closed').textContent = s.closedTotal;
  document.getElementById('ticket-stat-avg').textContent = s.avgResolutionMinutes;
  document.getElementById('ticket-stat-total').textContent = s.totalTickets;
}

async function refreshOpenTickets() {
  const res = await api('/api/tickets?status=open');
  if (!res.ok) return;
  const list = await res.json();
  const el = document.getElementById('ticket-open-list');

  if (list.length === 0) {
    el.innerHTML = '<span class="empty-hint">No open tickets right now.</span>';
    return;
  }

  el.innerHTML = list
    .map(
      (t) => `
    <div class="list-row">
      <div class="list-main">
        <div class="list-title">#${t.number} — ${escapeHtml(t.userTag)} <span class="muted small">(${escapeHtml(t.panelName)})</span></div>
        <div class="list-sub">opened ${new Date(t.createdAt).toLocaleString()}</div>
      </div>
      <div class="list-actions">
        <button class="danger-button" data-ticket-close="${t.channelId}">Close</button>
      </div>
    </div>`
    )
    .join('');

  document.querySelectorAll('[data-ticket-close]').forEach((btn) => {
    btn.addEventListener('click', () => closeTicketAction(btn.dataset.ticketClose));
  });
}

async function refreshClosedTickets() {
  const res = await api('/api/tickets?status=closed');
  if (!res.ok) return;
  const list = await res.json();
  const el = document.getElementById('ticket-closed-list');

  if (list.length === 0) {
    el.innerHTML = '<span class="empty-hint">No closed tickets.</span>';
    return;
  }

  el.innerHTML = list
    .slice(0, 30)
    .map(
      (t) => `
    <div class="list-row">
      <div class="list-main">
        <div class="list-title">#${t.number} — ${escapeHtml(t.userTag)} <span class="muted small">(${escapeHtml(t.panelName)})</span></div>
        <div class="list-sub">closed by ${escapeHtml(t.closedBy || 'unknown')} · ${new Date(t.closedAt).toLocaleString()}</div>
      </div>
      <div class="list-actions">
        <button class="secondary-button" data-ticket-reopen="${t.channelId}">Reopen</button>
        <button class="danger-button" data-ticket-delete="${t.channelId}">Delete</button>
      </div>
    </div>`
    )
    .join('');

  document.querySelectorAll('[data-ticket-reopen]').forEach((btn) => {
    btn.addEventListener('click', () => reopenTicketAction(btn.dataset.ticketReopen));
  });
  document.querySelectorAll('[data-ticket-delete]').forEach((btn) => {
    btn.addEventListener('click', () => deleteTicketAction(btn.dataset.ticketDelete));
  });
}

async function closeTicketAction(channelId) {
  if (!confirm('Close this ticket? It will be hidden from the opener and moved to the closed-tickets category.')) return;
  const res = await api(`/api/tickets/${channelId}/close`, { method: 'POST' });
  if (res.ok) {
    refreshOpenTickets();
    refreshClosedTickets();
    refreshTicketStats();
    refreshAuditLog();
  } else {
    const data = await res.json();
    alert(`Could not close: ${data.error}`);
  }
}

async function reopenTicketAction(channelId) {
  const res = await api(`/api/tickets/${channelId}/reopen`, { method: 'POST' });
  if (res.ok) {
    refreshOpenTickets();
    refreshClosedTickets();
    refreshTicketStats();
    refreshAuditLog();
  } else {
    const data = await res.json();
    alert(`Could not reopen: ${data.error}`);
  }
}

async function deleteTicketAction(channelId) {
  if (!confirm('Permanently delete this ticket channel? This cannot be undone.')) return;
  const res = await api(`/api/tickets/${channelId}`, { method: 'DELETE' });
  if (res.ok) {
    refreshClosedTickets();
    refreshTicketStats();
    refreshAuditLog();
  } else {
    const data = await res.json();
    alert(`Could not delete: ${data.error}`);
  }
}

// ---------- Fun ----------

async function triggerFun(type) {
  const feedback = document.getElementById('fun-feedback');
  const channelId = document.getElementById('fun-channel').value;
  const targetUserId = document.getElementById('fun-target').value.trim() || undefined;

  if (!channelId) {
    setFeedback(feedback, 'Pick a channel first.', false);
    return;
  }

  const res = await api(`/api/fun/${type}`, { method: 'POST', body: JSON.stringify({ channelId, targetUserId }) });

  if (res.ok) {
    setFeedback(feedback, 'Posted!', true);
    refreshAuditLog();
  } else {
    const data = await res.json();
    setFeedback(feedback, `Failed: ${data.error}`, false);
  }
}

// ---------- Reaction roles ----------

async function refreshReactionRoles() {
  const res = await api('/api/reaction-roles');
  const el = document.getElementById('rr-list');
  if (!res.ok) return;
  const list = await res.json();

  if (list.length === 0) {
    el.innerHTML = '<span class="empty-hint">No reaction roles set up.</span>';
    return;
  }

  el.innerHTML = list
    .map(
      (r) => `
      <div class="list-row">
        <div class="list-main">
          <div class="list-title">${r.emoji} → role ${r.roleId}</div>
        </div>
        <div class="list-actions">
          <button class="danger-button" onclick="removeReactionRole('${r.messageId}')">Remove</button>
        </div>
      </div>
    `
    )
    .join('');
}

async function createReactionRole() {
  const feedback = document.getElementById('rr-feedback');
  const channelId = document.getElementById('rr-channel').value;
  const text = document.getElementById('rr-text').value.trim();
  const emoji = document.getElementById('rr-emoji').value.trim();
  const roleId = document.getElementById('rr-role').value;

  if (!channelId || !text || !emoji || !roleId) {
    setFeedback(feedback, 'All fields are required.', false);
    return;
  }

  const res = await api('/api/reaction-roles', { method: 'POST', body: JSON.stringify({ channelId, text, emoji, roleId }) });

  if (res.ok) {
    setFeedback(feedback, 'Reaction role created!', true);
    document.getElementById('rr-text').value = '';
    refreshReactionRoles();
    refreshAuditLog();
  } else {
    const data = await res.json();
    setFeedback(feedback, `Failed: ${data.error}`, false);
  }
}

async function removeReactionRole(messageId) {
  await api(`/api/reaction-roles/${messageId}`, { method: 'DELETE' });
  refreshReactionRoles();
  refreshAuditLog();
}

// ---------- Insights ----------

async function refreshInsights() {
  const [summaryRes, channelsRes, membersRes, growthRes] = await Promise.all([
    api('/api/stats/summary'),
    api('/api/stats/channels'),
    api('/api/stats/most-active'),
    api('/api/stats/growth'),
  ]);

  if (summaryRes.ok) {
    const summary = await summaryRes.json();
    document.getElementById('insights-new-members').textContent = summary.newMembersThisWeek;
    document.getElementById('insights-actions-total').textContent = summary.dashboardActionsTotal;
  }

  if (channelsRes.ok) {
    const channels = await channelsRes.json();
    const el = document.getElementById('insights-channels');
    el.innerHTML = channels.length
      ? channels.map((c) => `<div class="list-row"><div class="list-main"><div class="list-title">${escapeHtml(c.channel)}</div><div class="list-sub">${c.count} messages today</div></div></div>`).join('')
      : '<span class="empty-hint">No messages yet today.</span>';
  }

  if (membersRes.ok) {
    const members = await membersRes.json();
    const el = document.getElementById('insights-members');
    el.innerHTML = members.length
      ? members.map((m) => `<div class="list-row"><div class="list-main"><div class="list-title">${escapeHtml(m.tag)}</div><div class="list-sub">${m.count} messages all-time</div></div></div>`).join('')
      : '<span class="empty-hint">No activity recorded yet.</span>';
  }

  if (growthRes.ok) {
    const growth = await growthRes.json();
    const el = document.getElementById('insights-growth');
    el.innerHTML = growth.length
      ? growth
          .slice()
          .reverse()
          .map((g) => `<div class="list-row"><div class="list-main"><div class="list-title">${g.count} members</div><div class="list-sub">${new Date(g.time).toLocaleDateString()}</div></div></div>`)
          .join('')
      : '<span class="empty-hint">Not enough history yet — check back tomorrow.</span>';
  }
}

boot();
