// Schedules a message to be sent at a future time, optionally repeating daily or
// weekly. Persisted so pending reminders survive a bot restart.
const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, 'reminders-state.json');
const MAX_DELAY = 2147483647; // setTimeout's max delay (~24.8 days)
const REPEAT_MS = { none: 0, daily: 24 * 60 * 60 * 1000, weekly: 7 * 24 * 60 * 60 * 1000 };

let reminders = []; // [{ id, channelId, message, sendAt, sent, repeat }]
let clientRef = null;
const timers = new Map();

function load() {
  try {
    reminders = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    reminders = [];
  }
}

function save() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(reminders, null, 2));
}

async function fireReminder(id) {
  const reminder = reminders.find((r) => r.id === id);
  if (!reminder || reminder.sent) return;

  try {
    const channel = await clientRef.channels.fetch(reminder.channelId);
    await channel.send({ content: `⏰ **Reminder:** ${reminder.message}` });
  } catch (err) {
    console.error('Failed to send reminder:', err.message);
  }

  const repeatMs = REPEAT_MS[reminder.repeat] || 0;
  if (repeatMs > 0) {
    reminder.sendAt = new Date(new Date(reminder.sendAt).getTime() + repeatMs).toISOString();
    save();
    scheduleTimer(reminder.id, repeatMs);
  } else {
    reminder.sent = true;
    save();
    timers.delete(id);
  }
}

function scheduleTimer(id, delayMs) {
  const timer = setTimeout(() => fireReminder(id), Math.min(delayMs, MAX_DELAY));
  timers.set(id, timer);
}

function setupReminders(client) {
  clientRef = client;
  load();

  client.once('ready', () => {
    for (const r of reminders) {
      if (r.sent) continue;
      const delay = new Date(r.sendAt).getTime() - Date.now();
      if (delay <= 0) {
        fireReminder(r.id);
      } else {
        scheduleTimer(r.id, delay);
      }
    }
  });

  console.log('Reminder system active.');
}

function createReminder(channelId, message, sendAtISO, repeat = 'none') {
  const entry = {
    id: Date.now().toString(36),
    channelId,
    message,
    sendAt: sendAtISO,
    sent: false,
    repeat,
  };
  reminders.push(entry);
  save();

  const delay = new Date(sendAtISO).getTime() - Date.now();
  scheduleTimer(entry.id, Math.max(delay, 0));

  return entry;
}

function cancelReminder(id) {
  const timer = timers.get(id);
  if (timer) clearTimeout(timer);
  timers.delete(id);
  reminders = reminders.filter((r) => r.id !== id);
  save();
}

function listReminders() {
  return reminders.filter((r) => !r.sent).sort((a, b) => new Date(a.sendAt) - new Date(b.sendAt));
}

module.exports = { setupReminders, createReminder, cancelReminder, listReminders };
