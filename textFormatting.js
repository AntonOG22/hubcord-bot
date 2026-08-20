// Two text tricks admins can type into any supported message field:
//
// 1. Colored text via §color (e.g. "§red this is red §reset back to normal").
//    Discord has NO real per-word text color anywhere — the only thing that
//    renders any color at all is ANSI escape codes inside a ```ansi code
//    block, which only supports 8 fixed colors (no arbitrary hex), renders
//    in monospace font, and doesn't render on Discord mobile at all (shows
//    raw escape garbage instead). This only works in a message's plain
//    `content`, never inside an embed — Discord doesn't interpret ANSI
//    there at all.
//
// 2. Masked links via "label" (https://url) -> converted to real [label](url)
//    markdown. Discord only renders that as a clickable link INSIDE AN
//    EMBED (description/fields/title) — never in plain message content,
//    where it just shows as literal bracket/paren text.
//
// These two are each other's mirror image: color needs plain content, masked
// links need an embed. Every call site picks the right one for whichever
// path (embed vs plain) that particular message is actually taking.
const ESC = String.fromCharCode(27); // real ANSI escape byte — Discord only colors text preceded by this exact byte

const ANSI_COLORS = { red: 31, green: 32, yellow: 33, blue: 34, pink: 35, cyan: 36, white: 37, gray: 30 };
const COLOR_NAMES = [...Object.keys(ANSI_COLORS), 'reset'];
const LINK_MASK_RE = /"([^"]+)"\s*\((https?:\/\/[^\s)]+)\)/g;

// Fresh, non-global regex per call — a shared `g`-flagged RegExp's .test()
// is stateful (advances lastIndex), which would make repeated calls flip
// between true/false for the exact same input. Building it inline avoids that.
function colorCodeRegex(global) {
  return new RegExp('§(red|green|yellow|blue|pink|cyan|white|gray|reset)\\b', global ? 'gi' : 'i');
}

function hasColorCodes(text) {
  return !!text && colorCodeRegex(false).test(text);
}

// Strips §color tokens with no replacement — used when the text is headed
// somewhere colors can't render (an embed), so the raw §red doesn't show up
// as ugly literal text to whoever reads it.
function stripColorCodes(text) {
  if (!text) return text;
  return text.replace(colorCodeRegex(true), '');
}

// Wraps the text in an ansi code block with real escape codes — only ever
// call this for plain message `content`, never for embed text.
function applyColorCodes(text) {
  if (!hasColorCodes(text)) return text;
  const body = text.replace(colorCodeRegex(true), (match, name) => {
    name = name.toLowerCase();
    return name === 'reset' ? `${ESC}[0m` : `${ESC}[${ANSI_COLORS[name]}m`;
  });
  return '```ansi\n' + body + `${ESC}[0m` + '\n```';
}

// Converts "label" (url) into [label](url) — only ever call this for text
// headed into an embed, never plain message `content`.
function applyLinkMasking(text) {
  if (!text) return text;
  return text.replace(LINK_MASK_RE, '[$1]($2)');
}

module.exports = { COLOR_NAMES, hasColorCodes, stripColorCodes, applyColorCodes, applyLinkMasking };
