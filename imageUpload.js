// Handles image uploads from the dashboard (join/leave messages, Send a
// Message, custom commands) by storing the file in a public Supabase
// Storage bucket and handing back a permanent public URL — the same string
// every other part of the app already expects wherever it takes an
// "image URL". This exists because pasting external links is fragile
// (hotlink protection, deleted images, expired links); an uploaded file
// keeps working indefinitely.
const { createClient } = require('@supabase/supabase-js');

const BUCKET = 'emerald-uploads';
const MAX_BYTES = 8 * 1024 * 1024; // matches the bucket's own file_size_limit
const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

let supabase = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_KEY) {
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
}

function extensionFor(mimetype) {
  return { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[mimetype] || 'bin';
}

// file: { buffer, mimetype, size } — from multer's memory storage.
async function uploadImage(guildId, file) {
  if (!supabase) throw new Error('Image uploads are not configured on this server (missing Supabase credentials).');
  if (!file) throw new Error('No file provided.');
  if (file.size > MAX_BYTES) throw new Error('Image is too large — 8 MB max.');
  if (!ALLOWED_MIME.has(file.mimetype)) throw new Error('Only PNG, JPEG, GIF, or WEBP images are allowed.');

  const path = `${guildId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${extensionFor(file.mimetype)}`;

  const { error } = await supabase.storage.from(BUCKET).upload(path, file.buffer, {
    contentType: file.mimetype,
    cacheControl: '31536000', // 1 year — uploaded images are treated as immutable
  });
  if (error) throw new Error(`Upload failed: ${error.message}`);

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

module.exports = { uploadImage };
