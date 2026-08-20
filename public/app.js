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

// ---------- Login error banner ----------
//
// /auth/login and /auth/callback redirect back here with ?auth_error=... on
// failure instead of showing a bare text page. The "cooldown" case also
// disables every Login with Discord link for the remaining wait, mirroring
// the real server-side lockout (see dashboard.js) so nobody keeps clicking
// through a block that's just going to redirect them right back here.
function checkAuthError() {
  const params = new URLSearchParams(window.location.search);
  const err = params.get('auth_error');
  if (!err) return;

  const banner = document.getElementById('auth-error-banner');
  const text = document.getElementById('auth-error-text');
  const loginLinks = document.querySelectorAll('a[href="/auth/login"]');
  if (!banner || !text) return;

  const MESSAGES = {
    state: 'Your login link expired or was already used — click "Login with Discord" to start a fresh one.',
    failed: "Login failed on Discord's side — this is usually temporary. Please try again in a moment.",
    blocked: 'This account has been blocked from accessing the dashboard.',
  };

  banner.classList.remove('hidden');

  if (err === 'cooldown') {
    let seconds = parseInt(params.get('retry'), 10) || 60;
    loginLinks.forEach((link) => {
      link.dataset.href = link.getAttribute('href');
      link.removeAttribute('href');
      link.classList.add('disabled-link');
    });

    const tick = () => {
      const mins = Math.floor(seconds / 60);
      const secs = String(seconds % 60).padStart(2, '0');
      text.textContent = `Too many login attempts — please wait ${mins}:${secs} before trying again.`;
      if (seconds <= 0) {
        clearInterval(interval);
        banner.classList.add('hidden');
        loginLinks.forEach((link) => {
          link.setAttribute('href', link.dataset.href);
          link.classList.remove('disabled-link');
        });
        return;
      }
      seconds -= 1;
    };
    tick();
    const interval = setInterval(tick, 1000);
  } else {
    text.textContent = MESSAGES[err] || 'Something went wrong logging in — please try again.';
  }

  history.replaceState(null, '', window.location.pathname);
}

checkAuthError();

// ---------- Image upload ----------
//
// Every "image URL" field also accepts a direct file upload as an
// alternative to pasting a link — links are fragile (hotlink protection,
// deleted images, expired CDN links), an uploaded file keeps working
// indefinitely. Uploading just fills in the same URL text field every
// other part of the page already reads, so nothing downstream needs to
// know the difference.
async function uploadImageFile(file, urlInputId, feedbackId, btnEl) {
  const feedback = document.getElementById(feedbackId);
  const urlInput = document.getElementById(urlInputId);
  const label = btnEl.querySelector('.upload-btn-text');
  const originalText = label.textContent;
  btnEl.classList.add('uploading');
  label.textContent = 'Uploading…';

  try {
    const formData = new FormData();
    formData.append('image', file);
    const headers = {};
    if (selectedGuildId) headers['x-guild-id'] = selectedGuildId;
    const res = await fetch('/api/upload-image', { method: 'POST', credentials: 'same-origin', headers, body: formData });
    const data = await res.json();
    if (res.ok) {
      urlInput.value = data.url;
      if (feedback) setFeedback(feedback, 'Uploaded!', true);
    } else {
      if (feedback) setFeedback(feedback, `Failed: ${data.error || 'unknown error'}`, false);
    }
  } catch {
    if (feedback) setFeedback(feedback, 'Upload failed — try again.', false);
  } finally {
    btnEl.classList.remove('uploading');
    label.textContent = originalText;
  }
}

function wireImageUpload(fileInputId, urlInputId, feedbackId) {
  const fileInput = document.getElementById(fileInputId);
  if (!fileInput) return;
  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (!file) return;
    uploadImageFile(file, urlInputId, feedbackId, fileInput.closest('.upload-btn'));
    fileInput.value = '';
  });
}

wireImageUpload('image-input-file', 'image-input', 'image-input-feedback');
wireImageUpload('customcmd-image-file', 'customcmd-image', 'customcmd-image-feedback');
wireImageUpload('joinmsg-image-file', 'joinmsg-image', 'joinmsg-image-feedback');
wireImageUpload('leavemsg-image-file', 'leavemsg-image', 'leavemsg-image-feedback');

// ---------- @mention member autocomplete ----------
//
// Works in every text field on the dashboard, not just dedicated "User ID"
// ones — type @ followed by part of a name to search this server's members
// AND roles live, tagged so it's obvious which is which, same as Discord's
// own message box.
//
// Two insertion modes, chosen per field:
//  - "id" fields (the handful that only ever hold a single raw ID, like the
//    Warnings User ID box) — selecting a result replaces the whole field
//    with that ID, since a mention token would break the API call it feeds.
//  - Every other field — a real Discord mention (<@id> / <@&id>) is spliced
//    in at the cursor, so it works fine mixed into a longer message.
const MENTION_ID_ONLY_FIELDS = new Set(['warn-user-id', 'dm-user-id', 'fun-target']);
const MENTION_EXCLUDED_FIELDS = new Set(['member-search', 'feature-search-input', 'cmd-search']);

let mentionRolesCache = { guildId: null, roles: [] };

async function getMentionRoles() {
  if (mentionRolesCache.guildId === selectedGuildId) return mentionRolesCache.roles;
  const res = await api('/api/roles');
  const roles = res.ok ? await res.json() : [];
  mentionRolesCache = { guildId: selectedGuildId, roles };
  return roles;
}

function wireMentionAutocomplete(input) {
  const idOnly = MENTION_ID_ONLY_FIELDS.has(input.id);

  let dropdown = null;
  let debounceTimer = null;
  let atIndex = -1;

  function closeDropdown() {
    if (dropdown) {
      dropdown.remove();
      dropdown = null;
    }
  }

  function positionDropdown() {
    if (!dropdown) return;
    const rect = input.getBoundingClientRect();
    dropdown.style.left = `${rect.left}px`;
    dropdown.style.top = `${rect.bottom + 4}px`;
    dropdown.style.width = `${Math.max(rect.width, 220)}px`;
  }

  function selectResult(type, id) {
    if (idOnly) {
      input.value = id;
    } else {
      const value = input.value;
      const caret = input.selectionStart;
      const token = type === 'role' ? `<@&${id}> ` : `<@${id}> `;
      const newValue = value.slice(0, atIndex) + token + value.slice(caret);
      input.value = newValue;
      const newCaret = atIndex + token.length;
      input.focus();
      input.setSelectionRange(newCaret, newCaret);
    }
    closeDropdown();
  }

  function renderResults(members, roles) {
    closeDropdown();
    const rows = [
      ...roles.map((r) => ({ type: 'role', id: r.id, label: r.name, sub: 'Role', color: r.color })),
      ...members.map((m) => ({ type: 'user', id: m.id, label: m.tag, sub: 'User', avatar: m.avatar })),
    ].slice(0, 10);

    dropdown = document.createElement('div');
    dropdown.className = 'mention-dropdown';
    dropdown.innerHTML = rows.length
      ? rows
          .map(
            (r) => `
        <div class="mention-result" data-type="${r.type}" data-id="${r.id}">
          ${
            r.type === 'role'
              ? `<span class="mention-role-dot" style="background:${r.color || '#99aab5'}"></span>`
              : `<img src="${r.avatar}" alt="" />`
          }
          <span class="mention-label">${escapeHtml(r.label)}</span>
          <span class="mention-tag mention-tag-${r.type}">${r.sub}</span>
        </div>`
          )
          .join('')
      : '<div class="mention-empty">No matching members or roles</div>';

    document.body.appendChild(dropdown);
    positionDropdown();

    dropdown.querySelectorAll('[data-id]').forEach((row) => {
      // mousedown (not click) fires before the input's blur, so the
      // dropdown is still there to read from when the user clicks it.
      row.addEventListener('mousedown', (e) => {
        e.preventDefault();
        selectResult(row.dataset.type, row.dataset.id);
      });
    });
  }

  input.addEventListener('input', () => {
    const value = input.value;
    const caret = input.selectionStart;
    const textBeforeCaret = value.slice(0, caret);
    const foundAt = textBeforeCaret.lastIndexOf('@');
    if (foundAt === -1 || /\s/.test(textBeforeCaret.slice(foundAt + 1))) {
      closeDropdown();
      return;
    }
    atIndex = foundAt;
    const query = textBeforeCaret.slice(foundAt + 1);
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      const [membersRes, roles] = await Promise.all([api(`/api/members?search=${encodeURIComponent(query)}`), getMentionRoles()]);
      const members = membersRes.ok ? await membersRes.json() : [];
      const matchingRoles = query
        ? roles.filter((r) => r.name.toLowerCase().includes(query.toLowerCase()))
        : roles;
      renderResults(members, matchingRoles.slice(0, 5));
    }, 200);
  });

  input.addEventListener('blur', () => setTimeout(closeDropdown, 150));
  window.addEventListener('scroll', () => dropdown && positionDropdown(), true);
}

document.querySelectorAll('input[type="text"], textarea').forEach((el) => {
  if (MENTION_EXCLUDED_FIELDS.has(el.id)) return;
  wireMentionAutocomplete(el);
});

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
        <div class="guild-card-sub">${withBot ? `${g.memberCount ?? '—'} members` : 'Add Emerald →'}</div>
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
    : '<span class="picker-empty">Emerald is already in every server you manage. 🎉</span>';

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
  // Open the tab synchronously, inside the click's user-activation window —
  // opening it only after an `await` gets silently popup-blocked in most browsers.
  const tab = window.open('', '_blank', 'noopener');
  try {
    const res = await api(`/api/invite-url?guildId=${guildId}`);
    if (!res.ok) {
      if (tab) tab.close();
      return;
    }
    const { url } = await res.json();
    if (tab) {
      tab.location.href = url;
    } else {
      // Popup blocker still got us (e.g. blocked even the blank tab) — fall back
      // to navigating the current tab so the click always does *something* visible.
      window.location.href = url;
    }
  } catch {
    if (tab) tab.close();
  }
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

async function populateRoleSelect(selectEl, { withNone, withEveryone } = {}) {
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
  if (withEveryone) {
    const everyone = document.createElement('option');
    everyone.value = 'everyone';
    everyone.textContent = '@everyone';
    selectEl.appendChild(everyone);
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

      if (btn.dataset.tab === 'admin') {
        enterAdminTab();
      } else {
        leaveAdminTab();
      }
    });
  });
}

// ---------- Owner-only admin tab ----------
//
// The nav button and this tab are only ever shown client-side when the
// server already told us (via /api/me) that this session belongs to the
// owner account — that's pure UI convenience, not the security boundary.
// The real boundary is server-side: every /api/admin/* call is re-checked
// against the signed session cookie on every single request, regardless of
// what this tab does or doesn't show. The 5-second poll below exists so a
// revoked/expired session gets kicked out of this specific view quickly
// even if nothing else on the page happens to trigger a request meanwhile —
// it is a UX nicety layered on top of the real, always-on server check, not
// a replacement for it.
let adminPollTimer = null;

function enterAdminTab() {
  loadAdminOverview();
  refreshGlobalFeatures();
  refreshBlockedUsers();
  if (adminPollTimer) return;
  adminPollTimer = setInterval(async () => {
    try {
      const res = await api('/api/me');
      if (!res.ok) throw new Error('unauthorized');
      const fresh = await res.json();
      if (!fresh.isOwner) throw new Error('no longer owner');
    } catch {
      window.location.href = '/auth/logout';
    }
  }, 5000);
}

function leaveAdminTab() {
  if (adminPollTimer) {
    clearInterval(adminPollTimer);
    adminPollTimer = null;
  }
}

async function loadAdminOverview() {
  const res = await api('/api/admin/overview');
  if (!res.ok) {
    // Server-side gate said no — bounce out immediately, this session isn't
    // (or is no longer) the owner, no matter what the client-side UI showed.
    window.location.href = '/auth/logout';
    return;
  }
  const data = await res.json();

  document.getElementById('admin-total-guilds').textContent = data.totalGuilds;
  document.getElementById('admin-total-members').textContent = data.totalMembers.toLocaleString();
  document.getElementById('admin-bot-ping').textContent = data.botPing;
  document.getElementById('admin-bot-uptime').textContent = formatUptime(data.botUptimeMs);
  document.getElementById('admin-watermark-toggle').checked = !!data.watermarkDisabled;

  const announceGuildSelect = document.getElementById('admin-announce-guild');
  const previousChoice = announceGuildSelect.value;
  announceGuildSelect.innerHTML =
    '<option value="">— select a server —</option>' +
    data.guilds.map((g) => `<option value="${escapeHtml(g.id)}">${escapeHtml(g.name)}</option>`).join('');
  if (previousChoice && data.guilds.some((g) => g.id === previousChoice)) announceGuildSelect.value = previousChoice;

  const list = document.getElementById('admin-guild-list');
  list.innerHTML = data.guilds
    .map((g) => {
      const icon = g.icon
        ? `<img src="${g.icon}" class="list-avatar" alt="" />`
        : `<div class="list-avatar guild-fallback-icon" style="display:flex;align-items:center;justify-content:center;">${escapeHtml(g.name.slice(0, 1).toUpperCase())}</div>`;
      return `
        <div class="list-row">
          ${icon}
          <div class="list-main">
            <div class="list-title">${escapeHtml(g.name)}</div>
            <div class="list-sub"><span>${g.memberCount.toLocaleString()} members</span><span>Boost tier ${g.boostTier}</span></div>
          </div>
          <div class="list-actions">
            <button class="secondary-button" data-admin-manage="${g.id}">Manage</button>
            <button class="danger-button" data-admin-leave="${g.id}" data-admin-leave-name="${escapeHtml(g.name)}">Leave</button>
          </div>
        </div>`;
    })
    .join('');

  list.querySelectorAll('[data-admin-leave]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm(`Remove the bot from "${btn.dataset.adminLeaveName}"? It will need to be re-invited to come back.`)) return;
      const res = await api(`/api/admin/guilds/${btn.dataset.adminLeave}`, { method: 'DELETE' });
      if (res.ok) loadAdminOverview();
      else alert('Failed to leave that server — try again.');
    });
  });

  list.querySelectorAll('[data-admin-manage]').forEach((btn) => {
    btn.addEventListener('click', () => {
      leaveAdminTab();
      selectedGuildId = btn.dataset.adminManage;
      initialized = false;
      init();
      document.querySelector('.nav-button[data-tab="overview"]').click();
    });
  });
}

document.getElementById('admin-watermark-toggle').addEventListener('change', async (e) => {
  const feedback = document.getElementById('admin-watermark-feedback');
  const disabled = e.target.checked;
  const res = await api('/api/admin/watermark', { method: 'POST', body: JSON.stringify({ disabled }) });
  if (res.ok) {
    setFeedback(feedback, disabled ? 'Watermark hidden bot-wide until you switch this back off.' : 'Watermark restored on every server.', true);
  } else {
    e.target.checked = !disabled; // revert the visual toggle, the server didn't accept it
    setFeedback(feedback, 'Failed to save — try again.', false);
  }
});

// ---------- Admin: global feature kill-switch ----------

async function refreshGlobalFeatures() {
  const res = await api('/api/admin/global-features');
  if (!res.ok) return;
  const list = await res.json();
  const el = document.getElementById('admin-global-features');

  el.innerHTML = list
    .map(
      (f) => `
      <div class="toggle-row">
        <div>
          <div class="toggle-label">${escapeHtml(f.label)}</div>
          <div class="muted small">${escapeHtml(f.description)}</div>
        </div>
        <label class="toggle-switch">
          <input type="checkbox" data-global-feature-key="${f.key}" ${f.enabled ? 'checked' : ''} />
          <span class="toggle-slider"></span>
        </label>
      </div>`
    )
    .join('');

  el.querySelectorAll('[data-global-feature-key]').forEach((input) => {
    input.addEventListener('change', async () => {
      const key = input.dataset.globalFeatureKey;
      const enabled = input.checked;
      const res = await api(`/api/admin/global-features/${key}/toggle`, { method: 'POST', body: JSON.stringify({ enabled }) });
      if (!res.ok) input.checked = !enabled; // revert on failure
    });
  });
}

// ---------- Admin: blocked users ----------

async function refreshBlockedUsers() {
  const res = await api('/api/admin/blocked-users');
  if (!res.ok) return;
  const { blockedUserIds } = await res.json();
  const el = document.getElementById('admin-blocked-users-list');

  if (blockedUserIds.length === 0) {
    el.innerHTML = '<span class="empty-hint">No one is blocked.</span>';
    return;
  }

  el.innerHTML = blockedUserIds
    .map(
      (id) => `
      <div class="list-row">
        <div class="list-main"><div class="list-title">User ID: ${escapeHtml(id)}</div></div>
        <div class="list-actions">
          <button class="secondary-button" data-unblock-user-id="${escapeHtml(id)}">Unblock</button>
        </div>
      </div>`
    )
    .join('');

  el.querySelectorAll('[data-unblock-user-id]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await api(`/api/admin/blocked-users/${btn.dataset.unblockUserId}`, { method: 'DELETE' });
      refreshBlockedUsers();
    });
  });
}

document.getElementById('admin-block-user-btn').addEventListener('click', async () => {
  const feedback = document.getElementById('admin-block-user-feedback');
  const input = document.getElementById('admin-block-user-id');
  const userId = input.value.trim();

  if (!/^\d{15,25}$/.test(userId)) {
    setFeedback(feedback, 'Enter a valid Discord user ID (right-click their name in Discord → Copy User ID, Developer Mode must be on).', false);
    return;
  }
  if (!confirm(`Block user ID ${userId} from logging into the dashboard?`)) return;

  const res = await api('/api/admin/blocked-users', { method: 'POST', body: JSON.stringify({ userId }) });
  if (res.ok) {
    setFeedback(feedback, 'Blocked.', true);
    input.value = '';
    refreshBlockedUsers();
  } else {
    const data = await res.json();
    setFeedback(feedback, `Failed: ${data.error}`, false);
  }
});

document.getElementById('admin-announce-guild').addEventListener('change', async (e) => {
  const channelSelect = document.getElementById('admin-announce-channel');
  const guildId = e.target.value;
  if (!guildId) {
    channelSelect.innerHTML = '<option value="">— select a server first —</option>';
    return;
  }
  channelSelect.innerHTML = '<option value="">Loading channels…</option>';
  const res = await api(`/api/admin/guilds/${guildId}/channels`);
  if (!res.ok) {
    channelSelect.innerHTML = '<option value="">Failed to load channels</option>';
    return;
  }
  const { channels } = await res.json();
  channelSelect.innerHTML =
    '<option value="">— select a channel —</option>' +
    channels.map((c) => `<option value="${escapeHtml(c.id)}">#${escapeHtml(c.name)}</option>`).join('');
});

document.getElementById('admin-announce-send').addEventListener('click', async () => {
  const feedback = document.getElementById('admin-announce-feedback');
  const guildId = document.getElementById('admin-announce-guild').value;
  const channelId = document.getElementById('admin-announce-channel').value;
  const title = document.getElementById('admin-announce-title').value.trim();
  const message = document.getElementById('admin-announce-message').value.trim();

  if (!guildId || !channelId || !title || !message) {
    setFeedback(feedback, 'Pick a server and channel, and fill in both title and message.', false);
    return;
  }
  const guildName = document.getElementById('admin-announce-guild').selectedOptions[0]?.textContent || 'this server';
  const channelName = document.getElementById('admin-announce-channel').selectedOptions[0]?.textContent || 'the selected channel';
  if (!confirm(`Send this official announcement to ${channelName} in ${guildName}? This posts immediately and can't be unsent automatically.`)) return;

  const btn = document.getElementById('admin-announce-send');
  btn.disabled = true;
  const res = await api('/api/admin/announcement', { method: 'POST', body: JSON.stringify({ guildId, channelId, title, message }) });
  btn.disabled = false;
  if (res.ok) {
    setFeedback(feedback, 'Official announcement sent.', true);
    document.getElementById('admin-announce-title').value = '';
    document.getElementById('admin-announce-message').value = '';
  } else {
    const err = await res.json().catch(() => ({}));
    setFeedback(feedback, err.error || 'Failed to send — try again.', false);
  }
});

// ---------- Init ----------

let initialized = false;

function init() {
  document.getElementById('topbar-avatar').src = me.avatar;
  document.getElementById('topbar-username').textContent = me.username;
  document.getElementById('admin-nav-button').classList.toggle('hidden', !me.isOwner);
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
  populateChannelSelect(document.getElementById('stream-alert-channel'));
  populateRoleSelect(document.getElementById('stream-alert-role'), { withNone: true, withEveryone: true });
  populateChannelSelect(document.getElementById('fun-channel'));
  populateChannelSelect(document.getElementById('rr-channel'));
  populateChannelSelect(document.getElementById('verification-channel'));
  populateRoleSelect(document.getElementById('rr-role'));
  Promise.all([
    populateChannelSelect(document.getElementById('settings-counting-channel'), { withNone: true }),
    populateChannelSelect(document.getElementById('settings-modlogs-channel'), { withNone: true }),
    populateChannelSelect(document.getElementById('settings-announcements-channel'), { withNone: true }),
    populateChannelSelect(document.getElementById('settings-levelup-channel'), { withNone: true }),
    populateRoleSelect(document.getElementById('settings-member-role'), { withNone: true }),
    populateRoleSelect(document.getElementById('settings-giveaway-ping-role'), { withNone: true }),
    populateRoleSelect(document.getElementById('settings-announcement-ping-role'), { withNone: true }),
  ]).then(refreshGuildSettings);

  Promise.all([
    populateChannelSelect(document.getElementById('joinmsg-channel'), { withNone: true }),
    populateChannelSelect(document.getElementById('leavemsg-channel'), { withNone: true }),
  ]).then(refreshJoinLeaveConfig);

  populateChannelSelect(document.getElementById('ticket-post-channel'));
  Promise.all([
    populateCategorySelect(document.getElementById('ticket-closed-category'), { withNone: true }),
    populateCategorySelect(document.getElementById('ticket-panel-category'), { withNone: true }),
    populateRoleSelect(document.getElementById('ticket-support-role-1'), { withNone: true }),
    populateRoleSelect(document.getElementById('ticket-support-role-2'), { withNone: true }),
    populateRoleSelect(document.getElementById('ticket-support-role-3'), { withNone: true }),
  ]).then(refreshTicketConfig);

  refreshEverything();

  setInterval(refreshStatus, 5000);
  setInterval(refreshActivity, 8000);
  setInterval(refreshAuditLog, 6000);
  setInterval(refreshCountingState, 6000);
  setInterval(refreshLeaderboard, 15000);
  setInterval(refreshGiveaways, 10000);
  setInterval(refreshReminders, 10000);
  setInterval(refreshStreamAlerts, 20000);
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
  document.getElementById('stream-alert-btn').addEventListener('click', addStreamAlert);
  document.getElementById('stream-alert-platform').addEventListener('change', updateStreamAlertPlatformFields);
  document.getElementById('automod-save-btn').addEventListener('click', saveAutomod);
  document.getElementById('lockdown-on-btn').addEventListener('click', () => setLockdown(true));
  document.getElementById('lockdown-off-btn').addEventListener('click', () => setLockdown(false));
  document.getElementById('verification-save-btn').addEventListener('click', saveVerification);
  document.getElementById('verification-post-btn').addEventListener('click', postVerification);
  document.getElementById('rr-btn').addEventListener('click', createReactionRole);
  document.getElementById('cmd-prefix-save-btn').addEventListener('click', saveCommandPrefix);
  document.getElementById('cmd-search').addEventListener('input', () => renderCommandList());
  document.getElementById('settings-save-btn').addEventListener('click', saveGuildSettings);
  document.getElementById('joinleave-save-btn').addEventListener('click', saveJoinLeaveConfig);
  document.getElementById('ticket-config-save-btn').addEventListener('click', saveTicketConfig);
  document.getElementById('ticket-panel-add-btn').addEventListener('click', addTicketPanel);
  document.getElementById('ticket-post-btn').addEventListener('click', postTicketPanel);
  document.getElementById('rate-command-add-btn').addEventListener('click', addRateCommand);
  document.getElementById('customcmd-add-btn').addEventListener('click', addCustomCommand);
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
  refreshBotNickname();
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
  refreshStreamAlerts();
  refreshAutomod();
  refreshVerification();
  refreshReactionRoles();
  refreshInsights();
  refreshCommands();
  refreshTicketStats();
  refreshOpenTickets();
  refreshClosedTickets();
  refreshRateCommands();
  refreshCustomCommands();
  refreshRolePanels();
  refreshGuildSettings();
  refreshJoinLeaveConfig();
  refreshFeatureToggles();
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
          <button class="secondary-button" data-member-action="roles" data-member-id="${escapeHtml(m.id)}">Roles</button>
          <button class="secondary-button" data-member-action="timeout" data-member-id="${escapeHtml(m.id)}" data-member-tag="${escapeHtml(m.tag)}">Timeout</button>
          <button class="danger-button" data-member-action="kick" data-member-id="${escapeHtml(m.id)}" data-member-tag="${escapeHtml(m.tag)}">Kick</button>
          <button class="danger-button" data-member-action="ban" data-member-id="${escapeHtml(m.id)}" data-member-tag="${escapeHtml(m.tag)}">Ban</button>
        </div>
      </div>
    `;
    })
    .join('');

  // data-* attributes instead of inline onclick="fn('${tag}')" — a Discord
  // display name containing a quote character could otherwise break out of
  // the inline handler's JS string and run arbitrary script. dataset reads
  // back the raw text safely, no re-parsing as code.
  el.querySelectorAll('[data-member-action]').forEach((btn) => {
    const { memberAction, memberId, memberTag } = btn.dataset;
    btn.addEventListener('click', () => {
      if (memberAction === 'roles') openRoleMenu(memberId);
      else if (memberAction === 'timeout') timeoutMember(memberId, memberTag);
      else if (memberAction === 'kick') kickMember(memberId, memberTag);
      else if (memberAction === 'ban') banMember(memberId, memberTag);
    });
  });
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
          <button class="secondary-button" data-unban-id="${escapeHtml(b.id)}">Unban</button>
        </div>
      </div>
    `
    )
    .join('');

  el.querySelectorAll('[data-unban-id]').forEach((btn) => {
    btn.addEventListener('click', () => unbanUser(btn.dataset.unbanId));
  });
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
  const imageUrl = document.getElementById('image-input').value.trim();
  const message = document.getElementById('message-input').value.trim();

  if (!channelId || !message) {
    setFeedback(feedback, 'Pick a channel and write a message first.', false);
    return;
  }

  button.disabled = true;
  button.textContent = 'Sending…';

  try {
    const res = await api('/api/send', { method: 'POST', body: JSON.stringify({ channelId, message, title: title || undefined, color, imageUrl: imageUrl || undefined }) });
    const data = await res.json();

    if (res.ok) {
      setFeedback(feedback, 'Sent!', true);
      document.getElementById('message-input').value = '';
      document.getElementById('title-input').value = '';
      document.getElementById('image-input').value = '';
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
          <button class="secondary-button" data-clear-warnings-id="${escapeHtml(w.userId)}">Clear</button>
        </div>
      </div>
    `
    )
    .join('');

  el.querySelectorAll('[data-clear-warnings-id]').forEach((btn) => {
    btn.addEventListener('click', () => clearWarnings(btn.dataset.clearWarningsId));
  });
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
          <button class="danger-button" data-remove-sticky-id="${escapeHtml(s.channelId)}">Remove</button>
        </div>
      </div>
    `
    )
    .join('');

  el.querySelectorAll('[data-remove-sticky-id]').forEach((btn) => {
    btn.addEventListener('click', () => removeSticky(btn.dataset.removeStickyId));
  });
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
          <button class="danger-button" data-remove-autoresponse-id="${escapeHtml(r.id)}">Remove</button>
        </div>
      </div>
    `
    )
    .join('');

  el.querySelectorAll('[data-remove-autoresponse-id]').forEach((btn) => {
    btn.addEventListener('click', () => removeAutoResponse(btn.dataset.removeAutoresponseId));
  });
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
        ${g.ended ? '' : `<div class="list-actions"><button class="danger-button" data-end-giveaway-id="${escapeHtml(g.messageId)}">End Now</button></div>`}
      </div>
    `
    )
    .join('');

  el.querySelectorAll('[data-end-giveaway-id]').forEach((btn) => {
    btn.addEventListener('click', () => endGiveaway(btn.dataset.endGiveawayId));
  });
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
          <button class="danger-button" data-cancel-reminder-id="${escapeHtml(r.id)}">Cancel</button>
        </div>
      </div>
    `
    )
    .join('');

  el.querySelectorAll('[data-cancel-reminder-id]').forEach((btn) => {
    btn.addEventListener('click', () => cancelReminder(btn.dataset.cancelReminderId));
  });
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

// ---------- Automation: stream alerts (Twitch live / YouTube new video) ----------

function updateStreamAlertPlatformFields() {
  const platform = document.getElementById('stream-alert-platform').value;
  const label = document.getElementById('stream-alert-identifier-label');
  const input = document.getElementById('stream-alert-identifier');
  if (platform === 'youtube') {
    label.textContent = 'YouTube channel ID';
    input.placeholder = 'e.g. UCxxxxxxxxxxxxxxxxxxxxxx';
  } else {
    label.textContent = 'Twitch username';
    input.placeholder = 'e.g. shroud';
  }
}

async function refreshStreamAlerts() {
  const res = await api('/api/stream-alerts');
  const el = document.getElementById('stream-alert-list');
  const note = document.getElementById('stream-alerts-twitch-note');
  if (!res.ok) return;
  const { tracked, twitchConfigured } = await res.json();

  if (!twitchConfigured) {
    note.textContent = 'Twitch live alerts aren\'t configured on the bot yet (YouTube alerts still work) — ask the bot owner to add Twitch API credentials.';
    note.classList.remove('hidden');
  } else {
    note.classList.add('hidden');
  }

  if (tracked.length === 0) {
    el.innerHTML = '<span class="empty-hint">Not tracking any channels yet.</span>';
    return;
  }

  el.innerHTML = tracked
    .map((s) => {
      const icon = s.platform === 'twitch' ? '🟣' : '🔴';
      const label = s.platform === 'twitch' ? 'Twitch' : 'YouTube';
      return `
      <div class="list-row">
        <div class="list-main">
          <div class="list-title">${icon} ${escapeHtml(s.identifier)}</div>
          <div class="list-sub">${label} · Channel ID: ${escapeHtml(s.notifyChannelId)}${s.pingRoleId === 'everyone' ? ' · pings @everyone' : s.pingRoleId ? ' · pings a role' : ''}</div>
        </div>
        <div class="list-actions">
          <button class="danger-button" data-remove-stream-alert-id="${escapeHtml(s.id)}">Remove</button>
        </div>
      </div>
    `;
    })
    .join('');

  el.querySelectorAll('[data-remove-stream-alert-id]').forEach((btn) => {
    btn.addEventListener('click', () => removeStreamAlert(btn.dataset.removeStreamAlertId));
  });
}

async function addStreamAlert() {
  const feedback = document.getElementById('stream-alert-feedback');
  const platform = document.getElementById('stream-alert-platform').value;
  const identifier = document.getElementById('stream-alert-identifier').value.trim();
  const notifyChannelId = document.getElementById('stream-alert-channel').value;
  const pingRoleId = document.getElementById('stream-alert-role').value || null;

  if (!identifier || !notifyChannelId) {
    setFeedback(feedback, 'Fill in the channel/username and pick a notification channel.', false);
    return;
  }

  const res = await api('/api/stream-alerts', { method: 'POST', body: JSON.stringify({ platform, identifier, notifyChannelId, pingRoleId }) });

  if (res.ok) {
    setFeedback(feedback, 'Tracking!', true);
    document.getElementById('stream-alert-identifier').value = '';
    refreshStreamAlerts();
    refreshAuditLog();
  } else {
    const data = await res.json();
    setFeedback(feedback, `Failed: ${data.error}`, false);
  }
}

async function removeStreamAlert(id) {
  await api(`/api/stream-alerts/${id}`, { method: 'DELETE' });
  refreshStreamAlerts();
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

// ---------- Custom commands ----------

async function refreshCustomCommands() {
  const res = await api('/api/custom-commands');
  if (!res.ok) return;
  const list = await res.json();
  const el = document.getElementById('customcmd-list');

  if (list.length === 0) {
    el.innerHTML = '<span class="empty-hint">No custom commands yet.</span>';
    return;
  }

  el.innerHTML = list
    .map(
      (c) => `
    <div class="list-row">
      <div class="list-main">
        <div class="list-title"><code>!${escapeHtml(c.name)}</code></div>
        <div class="list-sub">${escapeHtml(c.response.slice(0, 80))}${c.response.length > 80 ? '…' : ''}</div>
      </div>
      <div class="list-actions">
        <button class="danger-button" data-customcmd-remove="${escapeHtml(c.name)}">Remove</button>
      </div>
    </div>`
    )
    .join('');

  document.querySelectorAll('[data-customcmd-remove]').forEach((btn) => {
    btn.addEventListener('click', () => removeCustomCommand(btn.dataset.customcmdRemove));
  });
}

async function addCustomCommand() {
  const feedback = document.getElementById('customcmd-feedback');
  const name = document.getElementById('customcmd-name').value.trim();
  const response = document.getElementById('customcmd-response').value.trim();
  const imageUrl = document.getElementById('customcmd-image').value.trim();
  if (!name || !response) return setFeedback(feedback, 'Give it a name and a response.', false);

  const res = await api('/api/custom-commands', { method: 'POST', body: JSON.stringify({ name, response, imageUrl: imageUrl || undefined }) });
  if (res.ok) {
    document.getElementById('customcmd-name').value = '';
    document.getElementById('customcmd-response').value = '';
    document.getElementById('customcmd-image').value = '';
    setFeedback(feedback, 'Added!', true);
    refreshCustomCommands();
    refreshAuditLog();
  } else {
    const data = await res.json();
    setFeedback(feedback, `Failed: ${data.error}`, false);
  }
}

async function removeCustomCommand(name) {
  await api(`/api/custom-commands/${encodeURIComponent(name)}`, { method: 'DELETE' });
  refreshCustomCommands();
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
            <a href="#" data-rp-remove-role="${p.id}:${r.roleId}" style="margin-left:6px; color:var(--red);">×</a></span>`
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

// ---------- Join / leave messages ----------

async function refreshJoinLeaveConfig() {
  const res = await api('/api/join-leave-config');
  if (!res.ok) return;
  const config = await res.json();

  document.getElementById('joinmsg-enabled').checked = !!config.join.enabled;
  document.getElementById('joinmsg-channel').value = config.join.channelId || '';
  document.getElementById('joinmsg-title').value = config.join.title || '';
  document.getElementById('joinmsg-description').value = config.join.description || '';
  document.getElementById('joinmsg-image').value = config.join.imageUrl || '';
  document.getElementById('joinmsg-color').value = config.join.color || '#3ecf8e';

  document.getElementById('leavemsg-enabled').checked = !!config.leave.enabled;
  document.getElementById('leavemsg-channel').value = config.leave.channelId || '';
  document.getElementById('leavemsg-title').value = config.leave.title || '';
  document.getElementById('leavemsg-description').value = config.leave.description || '';
  document.getElementById('leavemsg-image').value = config.leave.imageUrl || '';
  document.getElementById('leavemsg-color').value = config.leave.color || '#f0655f';
}

async function saveJoinLeaveConfig() {
  const feedback = document.getElementById('joinleave-feedback');
  const patch = {
    join: {
      enabled: document.getElementById('joinmsg-enabled').checked,
      channelId: document.getElementById('joinmsg-channel').value || null,
      title: document.getElementById('joinmsg-title').value,
      description: document.getElementById('joinmsg-description').value,
      imageUrl: document.getElementById('joinmsg-image').value,
      color: document.getElementById('joinmsg-color').value,
    },
    leave: {
      enabled: document.getElementById('leavemsg-enabled').checked,
      channelId: document.getElementById('leavemsg-channel').value || null,
      title: document.getElementById('leavemsg-title').value,
      description: document.getElementById('leavemsg-description').value,
      imageUrl: document.getElementById('leavemsg-image').value,
      color: document.getElementById('leavemsg-color').value,
    },
  };
  const res = await api('/api/join-leave-config', { method: 'POST', body: JSON.stringify(patch) });
  if (res.ok) {
    setFeedback(feedback, 'Saved!', true);
    refreshAuditLog();
  } else {
    setFeedback(feedback, 'Failed to save.', false);
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
  document.getElementById('settings-levelup-channel').value = config.levelUpChannelId || '';
  document.getElementById('settings-giveaway-ping-role').value = config.giveawayPingRoleId || '';
  document.getElementById('settings-announcement-ping-role').value = config.announcementPingRoleId || '';
  document.getElementById('settings-language').value = config.language || 'en';
}

async function refreshBotNickname() {
  const res = await api('/api/bot-nickname');
  if (!res.ok) return;
  const { nickname } = await res.json();
  document.getElementById('bot-nickname-input').value = nickname || '';
}

document.getElementById('bot-nickname-save-btn').addEventListener('click', async () => {
  const feedback = document.getElementById('bot-nickname-feedback');
  const nickname = document.getElementById('bot-nickname-input').value.trim();
  const res = await api('/api/bot-nickname', { method: 'POST', body: JSON.stringify({ nickname: nickname || null }) });
  if (res.ok) {
    setFeedback(feedback, nickname ? `Nickname on this server set to "${nickname}".` : 'Reset to the bot\'s default name.', true);
    refreshAuditLog();
  } else {
    const data = await res.json();
    setFeedback(feedback, data.error || 'Failed to save — try again.', false);
  }
});

async function refreshFeatureToggles() {
  const res = await api('/api/features');
  if (!res.ok) return;
  const list = await res.json();
  const el = document.getElementById('feature-toggles');

  el.innerHTML = list
    .map(
      (f) => `
      <div class="toggle-row">
        <div>
          <div class="toggle-label">${escapeHtml(f.label)}</div>
          <div class="muted small">${escapeHtml(f.description)}${f.globallyDisabled ? ' <strong>· turned off bot-wide by the owner right now, this switch has no effect until they turn it back on</strong>' : ''}</div>
        </div>
        <label class="toggle-switch">
          <input type="checkbox" data-feature-key="${f.key}" ${f.enabled ? 'checked' : ''} ${f.globallyDisabled ? 'disabled' : ''} />
          <span class="toggle-slider"></span>
        </label>
      </div>`
    )
    .join('');

  el.querySelectorAll('[data-feature-key]').forEach((input) => {
    input.addEventListener('change', async () => {
      const key = input.dataset.featureKey;
      const enabled = input.checked;
      const res = await api(`/api/features/${key}/toggle`, { method: 'POST', body: JSON.stringify({ enabled }) });
      if (!res.ok) input.checked = !enabled; // revert on failure
      refreshAuditLog();
    });
  });
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
    language: document.getElementById('settings-language').value || 'en',
  };
  const res = await api('/api/guild-config', { method: 'POST', body: JSON.stringify(patch) });
  if (res.ok) {
    setFeedback(feedback, 'Saved!', true);
    refreshAuditLog();
  } else {
    setFeedback(feedback, 'Failed to save.', false);
  }
}

document.getElementById('levelup-channel-save-btn').addEventListener('click', async () => {
  const feedback = document.getElementById('levelup-channel-feedback');
  const levelUpChannelId = document.getElementById('settings-levelup-channel').value || null;
  const res = await api('/api/guild-config', { method: 'POST', body: JSON.stringify({ levelUpChannelId }) });
  if (res.ok) {
    setFeedback(feedback, 'Saved!', true);
    refreshAuditLog();
  } else {
    setFeedback(feedback, 'Failed to save.', false);
  }
});

// ---------- Tickets ----------

let ticketPanelsCache = [];

async function refreshTicketConfig() {
  const res = await api('/api/tickets/config');
  if (!res.ok) return;
  const config = await res.json();

  const supportRoleIds = config.supportRoleIds || [];
  document.getElementById('ticket-support-role-1').value = supportRoleIds[0] || '';
  document.getElementById('ticket-support-role-2').value = supportRoleIds[1] || '';
  document.getElementById('ticket-support-role-3').value = supportRoleIds[2] || '';
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
  const supportRoleIds = [...new Set(
    [
      document.getElementById('ticket-support-role-1').value,
      document.getElementById('ticket-support-role-2').value,
      document.getElementById('ticket-support-role-3').value,
    ].filter(Boolean)
  )];
  const patch = {
    supportRoleIds,
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
          <div class="list-title">${escapeHtml(r.emoji)} → role ${escapeHtml(r.roleId)}</div>
        </div>
        <div class="list-actions">
          <button class="danger-button" data-remove-reactionrole-id="${escapeHtml(r.messageId)}">Remove</button>
        </div>
      </div>
    `
    )
    .join('');

  el.querySelectorAll('[data-remove-reactionrole-id]').forEach((btn) => {
    btn.addEventListener('click', () => removeReactionRole(btn.dataset.removeReactionroleId));
  });
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

// ---------- Feature search ----------
//
// A static index of "feature label -> which tab it lives on", searched
// client-side with a plain substring match — no backend involved, this is
// purely a faster way to find a setting than clicking through every tab.

const FEATURE_INDEX = [
  { label: 'Bot Ping', tab: 'overview' },
  { label: 'Members count', tab: 'overview' },
  { label: 'Dashboard Uptime', tab: 'overview' },
  { label: 'Boost Tier', tab: 'overview' },
  { label: 'Server Info', tab: 'overview' },
  { label: 'Recent Activity', tab: 'overview' },

  { label: 'Members (search/list)', tab: 'moderation' },
  { label: 'Warnings', tab: 'moderation' },
  { label: 'Purge Messages', tab: 'moderation' },
  { label: 'Slowmode', tab: 'moderation' },
  { label: 'Banned Users', tab: 'moderation' },
  { label: 'Roles', tab: 'moderation' },

  { label: 'Send a Message', tab: 'messaging' },
  { label: 'Announcement Templates', tab: 'messaging' },
  { label: 'Direct Message a Member', tab: 'messaging' },
  { label: 'Create a Poll', tab: 'messaging' },

  { label: 'Auto-Moderation', tab: 'security' },
  { label: 'Server Lockdown', tab: 'security' },
  { label: 'Verification Gate', tab: 'security' },

  { label: 'Command Prefix', tab: 'commands' },
  { label: 'Command List', tab: 'commands' },
  { label: 'Custom Commands', tab: 'commands' },

  { label: 'Ticket Global Settings', tab: 'tickets' },
  { label: 'Ticket Panels', tab: 'tickets' },
  { label: 'Post a Ticket Panel', tab: 'tickets' },
  { label: 'Open Tickets', tab: 'tickets' },
  { label: 'Closed Tickets', tab: 'tickets' },

  { label: 'Quick Fun', tab: 'fun' },
  { label: 'Custom Rate Commands', tab: 'fun' },
  { label: 'Role Panels', tab: 'fun' },
  { label: 'Reaction Roles', tab: 'fun' },

  { label: 'New Members (7 days)', tab: 'insights' },
  { label: 'Dashboard Actions Total', tab: 'insights' },
  { label: 'Most Active Channels', tab: 'insights' },
  { label: 'Most Active Members', tab: 'insights' },
  { label: 'Member Growth', tab: 'insights' },

  { label: 'Sticky Messages', tab: 'automation' },
  { label: 'Auto-Responses', tab: 'automation' },
  { label: 'Giveaways', tab: 'automation' },
  { label: 'Reminders', tab: 'automation' },
  { label: 'Join & Leave Messages', tab: 'automation' },
  { label: 'Stream Alerts (Twitch/YouTube)', tab: 'automation' },

  { label: 'Leaderboard / XP', tab: 'leveling' },
  { label: 'Level-Up Announcement Channel', tab: 'leveling' },

  { label: 'Bot Nickname', tab: 'server' },
  { label: 'Server Settings', tab: 'server' },
  { label: 'Bot Language', tab: 'server' },
  { label: 'Feature Toggles (XP, automod, anti-raid, etc.)', tab: 'server' },
  { label: 'Counting Game', tab: 'server' },
  { label: 'Dashboard Audit Log', tab: 'server' },

  { label: 'Guides / Variables Reference', tab: 'guides' },
  { label: 'Ticket variables ({count}, {username}, {user})', tab: 'guides' },
  { label: 'Join/Leave variables', tab: 'guides' },
  { label: 'Every Server (owner)', tab: 'admin' },
  { label: 'Branding / Watermark toggle (owner)', tab: 'admin' },
];

const featureSearchInput = document.getElementById('feature-search-input');
const featureSearchResults = document.getElementById('feature-search-results');

function renderFeatureSearch(query) {
  const q = query.trim().toLowerCase();
  if (!q) {
    featureSearchResults.classList.add('hidden');
    featureSearchResults.innerHTML = '';
    return;
  }

  const matches = FEATURE_INDEX.filter((f) => f.label.toLowerCase().includes(q)).slice(0, 8);
  featureSearchResults.innerHTML = matches.length
    ? matches
        .map(
          (f) => `<div class="feature-search-result" data-search-tab="${f.tab}">
            <span>${escapeHtml(f.label)}</span>
            <span class="feature-search-result-tab">${escapeHtml(f.tab)}</span>
          </div>`
        )
        .join('')
    : '<div class="feature-search-empty">No matching feature.</div>';
  featureSearchResults.classList.remove('hidden');

  featureSearchResults.querySelectorAll('[data-search-tab]').forEach((row) => {
    row.addEventListener('click', () => {
      const btn = document.querySelector(`.nav-button[data-tab="${row.dataset.searchTab}"]`);
      if (btn && !btn.classList.contains('hidden')) btn.click();
      featureSearchInput.value = '';
      featureSearchResults.classList.add('hidden');
      featureSearchInput.blur();
    });
  });
}

if (featureSearchInput) {
  featureSearchInput.addEventListener('input', () => renderFeatureSearch(featureSearchInput.value));
  featureSearchInput.addEventListener('focus', () => {
    if (featureSearchInput.value.trim()) renderFeatureSearch(featureSearchInput.value);
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.appbar-search')) featureSearchResults.classList.add('hidden');
  });
  featureSearchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      featureSearchInput.value = '';
      featureSearchResults.classList.add('hidden');
      featureSearchInput.blur();
    }
  });
}

// ---------- AI agent widget ----------
//
// Everything here is UI plumbing only. The actual API key and every tool
// call live entirely server-side (see aiAgent.js) — this code just sends
// plain text to /api/ai/chat (guild-scoped like every other call, via the
// api() helper's x-guild-id header) and renders whatever comes back.

let aiHistory = [];
let aiBusy = false;

const aiToggleBtn = document.getElementById('ai-toggle-btn');
const aiPanel = document.getElementById('ai-panel');
const aiCloseBtn = document.getElementById('ai-close-btn');
const aiForm = document.getElementById('ai-form');
const aiInput = document.getElementById('ai-input');
const aiMessages = document.getElementById('ai-messages');
const aiSendBtn = document.getElementById('ai-send-btn');

aiToggleBtn.addEventListener('click', () => {
  aiPanel.classList.toggle('hidden');
  if (!aiPanel.classList.contains('hidden')) aiInput.focus();
});

aiCloseBtn.addEventListener('click', () => aiPanel.classList.add('hidden'));

function addAiMessage(role, text) {
  const div = document.createElement('div');
  div.className = `ai-msg ai-msg-${role}`;
  div.textContent = text;
  aiMessages.appendChild(div);
  aiMessages.scrollTop = aiMessages.scrollHeight;
  return div;
}

// Every action chip names the concrete thing that happened, not just a raw
// tool identifier — e.g. "Created ticket panel" rather than "create_ticket_panel" —
// so a normal user can actually tell the work was done correctly without
// needing to know what the tools are called internally.
const AI_ACTION_LABELS = {
  create_ticket_panel: 'Created ticket panel',
  post_ticket_panel: 'Posted ticket panel',
  update_ticket_config: 'Updated ticket settings',
  close_ticket: 'Closed ticket',
  create_role_panel: 'Created role panel',
  add_role_to_panel: 'Added role to panel',
  post_role_panel: 'Posted role panel',
  create_reaction_role: 'Created reaction role',
  create_category: 'Created category',
  create_channel: 'Created channel',
  send_message: 'Sent message',
  send_announcement_template: 'Sent announcement',
  create_poll: 'Created poll',
  send_dm: 'Sent DM',
  timeout_member: 'Timed out member',
  warn_member: 'Warned member',
  clear_warnings: 'Cleared warnings',
  add_role_to_member: 'Added role',
  remove_role_from_member: 'Removed role',
  set_slowmode: 'Set slowmode',
  update_automod_settings: 'Updated automod settings',
  set_verification_gate: 'Updated verification gate',
  post_verification_button: 'Posted verification button',
  set_sticky_message: 'Set sticky message',
  add_autoresponse: 'Added auto-response',
  start_giveaway: 'Started giveaway',
  schedule_reminder: 'Scheduled reminder',
  add_rate_command: 'Added rate command',
  create_custom_command: 'Created custom command',
  remove_custom_command: 'Removed custom command',
  update_guild_config: 'Updated server settings',
  set_command_prefix: 'Changed command prefix',
  toggle_command: 'Toggled command',
  reset_counting_game: 'Reset counting game',
  post_fun_content: 'Posted fun content',
};

function aiActionLabel(toolName) {
  return AI_ACTION_LABELS[toolName] || toolName.replace(/_/g, ' ');
}

function addAiActions(actions) {
  if (!actions || !actions.length) return;
  const wrap = document.createElement('div');
  wrap.className = 'ai-actions';
  wrap.innerHTML = actions
    .map((a) => `<span class="ai-action-chip ${a.ok ? 'ok' : 'fail'}">${a.ok ? '✓' : '✕'} ${escapeHtml(aiActionLabel(a.tool))}</span>`)
    .join('');
  aiMessages.appendChild(wrap);
  aiMessages.scrollTop = aiMessages.scrollHeight;
}

// Sensitive tool calls (ban, kick, purge, lockdown, bulk role changes) come
// back as *proposals*, never already executed — this renders each one with
// its own Confirm/Cancel buttons. Nothing happens until the user clicks
// Confirm, which is a fresh, separately-authorized request to the server;
// this UI is just a prompt, not the thing enforcing the pause.
function addAiPendingActions(pendingActions) {
  if (!pendingActions || !pendingActions.length) return;
  pendingActions.forEach((pending) => {
    const div = document.createElement('div');
    div.className = 'ai-msg ai-msg-confirm';
    div.innerHTML = `
      <div class="ai-confirm-text">⚠️ ${escapeHtml(pending.description)}</div>
      <div class="ai-confirm-buttons">
        <button class="danger-button ai-confirm-yes">Confirm</button>
        <button class="secondary-button ai-confirm-no">Cancel</button>
      </div>`;
    aiMessages.appendChild(div);
    aiMessages.scrollTop = aiMessages.scrollHeight;

    div.querySelector('.ai-confirm-yes').addEventListener('click', async () => {
      div.querySelectorAll('button').forEach((b) => (b.disabled = true));
      try {
        const res = await api('/api/ai/confirm', {
          method: 'POST',
          body: JSON.stringify({ tool: pending.tool, args: pending.args }),
        });
        const data = await res.json();
        div.querySelector('.ai-confirm-buttons').innerHTML = res.ok && data.ok
          ? `<span class="ai-action-chip ok">✓ ${escapeHtml(aiActionLabel(pending.tool))}</span>`
          : `<span class="ai-action-chip fail">✕ Failed — try again</span>`;
        if (res.ok && data.ok) refreshEverything();
      } catch {
        div.querySelector('.ai-confirm-buttons').innerHTML = `<span class="ai-action-chip fail">✕ Failed — try again</span>`;
      }
    });

    div.querySelector('.ai-confirm-no').addEventListener('click', () => {
      div.querySelector('.ai-confirm-buttons').innerHTML = `<span class="ai-action-chip fail">Cancelled</span>`;
    });
  });
}

aiForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = aiInput.value.trim();
  if (!text || aiBusy || !selectedGuildId) return;

  addAiMessage('user', text);
  aiInput.value = '';
  aiBusy = true;
  aiSendBtn.disabled = true;
  const thinking = addAiMessage('thinking', 'Working on it…');
  thinking.classList.add('ai-thinking');
  thinking.classList.remove('ai-msg', 'ai-msg-thinking');

  try {
    const res = await api('/api/ai/chat', {
      method: 'POST',
      body: JSON.stringify({ message: text, history: aiHistory }),
    });
    thinking.remove();
    if (!res.ok) {
      addAiMessage('error', 'Failed — try again.');
      return;
    }
    const data = await res.json();
    addAiMessage('assistant', data.reply);
    addAiActions(data.actions);
    addAiPendingActions(data.pendingActions);
    if (data.actions && data.actions.length) refreshEverything();
    aiHistory.push({ role: 'user', content: text }, { role: 'assistant', content: data.reply });
    if (aiHistory.length > 20) aiHistory = aiHistory.slice(-20);
  } catch (err) {
    thinking.remove();
    addAiMessage('error', 'Failed — try again.');
  } finally {
    aiBusy = false;
    aiSendBtn.disabled = false;
  }
});

boot();
