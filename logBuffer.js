// Keeps the last N console lines in memory so the dashboard can show a live log feed,
// without changing how logs look in the actual terminal.
const MAX_LINES = 200;
const lines = [];

function push(level, args) {
  const text = args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ');
  lines.push({ time: new Date().toISOString(), level, text });
  if (lines.length > MAX_LINES) lines.shift();
}

function patchConsole() {
  const originalLog = console.log.bind(console);
  const originalError = console.error.bind(console);

  console.log = (...args) => {
    push('info', args);
    originalLog(...args);
  };

  console.error = (...args) => {
    push('error', args);
    originalError(...args);
  };
}

function getLines() {
  return lines;
}

module.exports = { patchConsole, getLines };
