// Downloads a standalone yt-dlp binary for the current platform into bin/ —
// same idea as ffmpeg-static's own install step. This replaces the
// yt-dlp-exec npm package, which had its own postinstall requiring a
// `python` binary just to run a version-check left over from the old
// youtube-dl days (nothing to do with what yt-dlp actually needs at
// runtime — it's a self-contained binary) — that check has no python3 to
// find on Railway's Node build image and broke the build outright. This
// script has no such dependency: plain Node https, nothing else.
const fs = require('fs');
const path = require('path');
const https = require('https');

const BIN_DIR = path.join(__dirname, '..', 'bin');
const isWindows = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const releaseAsset = isWindows ? 'yt-dlp.exe' : isMac ? 'yt-dlp_macos' : 'yt-dlp';
const dest = path.join(BIN_DIR, isWindows ? 'yt-dlp.exe' : 'yt-dlp');
const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${releaseAsset}`;

function download(fromUrl, toPath, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    https
      .get(fromUrl, { headers: { 'User-Agent': 'hubcord-bot-music-setup' } }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
          res.resume();
          resolve(download(res.headers.location, toPath, redirectsLeft - 1));
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`Download failed: HTTP ${res.statusCode} for ${fromUrl}`));
          return;
        }
        const file = fs.createWriteStream(toPath);
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
        file.on('error', reject);
      })
      .on('error', reject);
  });
}

(async () => {
  try {
    fs.mkdirSync(BIN_DIR, { recursive: true });
    if (fs.existsSync(dest)) {
      console.log('yt-dlp binary already present, skipping download.');
      return;
    }
    console.log(`Downloading yt-dlp (${releaseAsset}) for music playback...`);
    await download(url, dest);
    if (!isWindows) fs.chmodSync(dest, 0o755);
    console.log('yt-dlp binary ready:', dest);
  } catch (err) {
    // Fail the install loudly — deploying with music silently non-functional
    // (every !musik erroring at runtime) is worse than a failed build.
    console.error('Failed to download the yt-dlp binary:', err.message);
    process.exit(1);
  }
})();
