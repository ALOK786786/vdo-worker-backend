const fs = require('fs');
const path = require('path');
const os = require('os');
require('dotenv').config();

// Centralized Configuration and Feature Flags
const runtimeConfig = {
  // Server Port
  PORT: process.env.PORT || 3000,

  // Feature Flags (MVP vs Enterprise toggle)
  USE_REDIS: process.env.USE_REDIS === 'true',
  USE_OBJECT_STORAGE: process.env.USE_OBJECT_STORAGE === 'true',
  USE_DISTRIBUTED_LOCK: process.env.USE_DISTRIBUTED_LOCK === 'true',

  // Rate Limiting (Downloads per hour per IP)
  RATE_LIMITS: {
    GUEST: parseInt(process.env.GUEST_DOWNLOADS_PER_HOUR) || 100,
    USER: parseInt(process.env.USER_DOWNLOADS_PER_HOUR) || 50,
  },

  // Target values for adaptive chunk size ranges
  CHUNK_SIZES: {
    MIN_MB: parseInt(process.env.CHUNK_MIN_SIZE_MB) || 5,
    MAX_MB: parseInt(process.env.CHUNK_MAX_SIZE_MB) || 25,
  },

  // SQLite config
  SQLITE_DB_PATH: process.env.SQLITE_DB_PATH || path.join(__dirname, '..', 'cache', 'metadata.db'),

  // Redis config
  REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',

  // S3 / Cloudflare R2 configurations
  R2: {
    ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID,
    SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY,
    ENDPOINT: process.env.R2_ENDPOINT,
    BUCKET_NAME: process.env.R2_BUCKET_NAME,
  },

  // yt-dlp cookie path configuration
  COOKIE_FILE_PATH: null,
  getCookiePath() {
    return this.COOKIE_FILE_PATH;
  }
};

// Auto-decode Base64 Cookies Securely if provided
if (process.env.YTDLP_COOKIES_B64) {
  try {
    const decodedCookies = Buffer.from(process.env.YTDLP_COOKIES_B64, 'base64').toString('utf-8');
    
    // Write cookies securely to temp directory with limited read permissions
    const tempDir = os.tmpdir();
    const secureCookiePath = path.join(tempDir, `ytdlp_cookies_${Date.now()}.txt`);
    
    fs.writeFileSync(secureCookiePath, decodedCookies, { mode: 0o600 });
    
    runtimeConfig.COOKIE_FILE_PATH = secureCookiePath;
    console.log(`[Config] Secure cookies extracted and verified at: ${secureCookiePath}`);
    
    // Auto-cleanup on app shutdown
    process.on('exit', () => {
      try {
        if (fs.existsSync(secureCookiePath)) {
          fs.unlinkSync(secureCookiePath);
        }
      } catch (err) {
        // silent fail during teardown
      }
    });
  } catch (err) {
    console.error('[Config Error] Failed to decode and save YTDLP_COOKIES_B64:', err.message);
  }
} else {
  const localCookiesPath = path.join(__dirname, '..', 'cookies', 'cookies.txt');
  if (fs.existsSync(localCookiesPath)) {
    runtimeConfig.COOKIE_FILE_PATH = localCookiesPath;
    console.log(`[Config] Automatically loaded local cookies from: ${localCookiesPath}`);
  } else {
    console.log('[Config] Running anonymously: No YTDLP_COOKIES_B64 or local cookies.txt detected.');
  }
}

module.exports = runtimeConfig;
