const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const config = require('../config/runtimeConfig');

// In-Memory Fallback Driver (Tier 3)
const memoryCache = {
  store: new Map(),
  get(key) {
    const item = this.store.get(key);
    if (!item) return null;
    if (Date.now() > item.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return item.value;
  },
  set(key, value, ttlSeconds) {
    this.store.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  },
  has(key) {
    return this.get(key) !== null;
  }
};

class CacheProvider {
  constructor() {
    this.activeDriver = 'memory'; // Default worst-case
    this.sqliteDb = null;
    this.redisClient = null;
  }

  async init() {
    // 1. Try Production Redis (Tier 1)
    if (config.USE_REDIS) {
      try {
        console.log('[Cache] Initializing Production Redis Connection...');
        const Redis = require('ioredis');
        this.redisClient = new Redis(config.REDIS_URL, {
          maxRetriesPerRequest: 1,
          connectTimeout: 2000,
        });

        // Set quick error event listener to catch disconnects
        this.redisClient.on('error', (err) => {
          console.warn(`[Cache Fallback] Redis error encountered: ${err.message}. Degrading to SQLite...`);
          this.activeDriver = 'sqlite';
        });

        await this.redisClient.ping();
        this.activeDriver = 'redis';
        console.log('[Cache] Production Redis connected successfully (Tier 1 Active).');
        return;
      } catch (err) {
        console.warn(`[Cache Fallback] Redis failed to connect: ${err.message}. Falling back to SQLite (Tier 2)...`);
      }
    }

    // 2. Try SQLite Local Cache (Tier 2 - Default MVP)
    try {
      // Ensure folder exists
      const dbDir = path.dirname(config.SQLITE_DB_PATH);
      if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
      }

      console.log(`[Cache] Initializing local SQLite cache database at: ${config.SQLITE_DB_PATH}`);
      this.sqliteDb = new sqlite3.Database(config.SQLITE_DB_PATH);

      // Create cache schema
      this.sqliteDb.serialize(() => {
        this.sqliteDb.run(`
          CREATE TABLE IF NOT EXISTS cache (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            expires_at INTEGER NOT NULL
          )
        `);
        // Index on expiry for fast cleanups
        this.sqliteDb.run(`CREATE INDEX IF NOT EXISTS idx_expires_at ON cache (expires_at)`);
      });

      this.activeDriver = 'sqlite';
      console.log('[Cache] SQLite DB connected and ready (Tier 2 Active).');

      // Start automatic SQLite cache garbage collector (Runs every 10 minutes)
      setInterval(() => this.cleanupExpiredSQLite(), 10 * 60 * 1000);

    } catch (err) {
      console.error(`[Cache Fallback] SQLite failed to initialize: ${err.message}. Downgrading to Local In-Memory Cache (Tier 3)...`);
      this.activeDriver = 'memory';
    }
  }

  // --- API CRUD Interface ---

  get(key) {
    return new Promise((resolve) => {
      // Tier 1: Redis
      if (this.activeDriver === 'redis' && this.redisClient) {
        this.redisClient.get(key)
          .then((val) => resolve(val ? JSON.parse(val) : null))
          .catch((err) => {
            console.warn(`[Cache Error] Redis GET failed: ${err.message}. Querying SQLite fallback...`);
            resolve(this.getSQLiteFallback(key));
          });
        return;
      }

      // Tier 2: SQLite
      if (this.activeDriver === 'sqlite' && this.sqliteDb) {
        this.getSQLite(key, resolve);
        return;
      }

      // Tier 3: Memory
      resolve(memoryCache.get(key));
    });
  }

  set(key, value, ttlSeconds = 3600) { // Default 1 hour TTL
    const stringifiedValue = JSON.stringify(value);

    // Tier 1: Redis
    if (this.activeDriver === 'redis' && this.redisClient) {
      this.redisClient.set(key, stringifiedValue, 'EX', ttlSeconds)
        .catch((err) => {
          console.warn(`[Cache Error] Redis SET failed: ${err.message}. Saving to SQLite fallback...`);
          this.setSQLite(key, stringifiedValue, ttlSeconds);
        });
      return;
    }

    // Tier 2: SQLite
    if (this.activeDriver === 'sqlite' && this.sqliteDb) {
      this.setSQLite(key, stringifiedValue, ttlSeconds);
      return;
    }

    // Tier 3: Memory
    memoryCache.set(key, value, ttlSeconds);
  }

  // --- SQLite specific implementations ---

  getSQLite(key, callbackResolve) {
    const now = Date.now();
    this.sqliteDb.get(
      'SELECT value, expires_at FROM cache WHERE key = ?',
      [key],
      (err, row) => {
        if (err || !row) {
          return callbackResolve(null);
        }
        if (now > row.expires_at) {
          // Expired. Delete asynchronously
          this.sqliteDb.run('DELETE FROM cache WHERE key = ?', [key]);
          return callbackResolve(null);
        }
        try {
          callbackResolve(JSON.parse(row.value));
        } catch (parseErr) {
          callbackResolve(null);
        }
      }
    );
  }

  setSQLite(key, stringifiedValue, ttlSeconds) {
    const expiresAt = Date.now() + ttlSeconds * 1000;
    this.sqliteDb.run(
      'INSERT OR REPLACE INTO cache (key, value, expires_at) VALUES (?, ?, ?)',
      [key, stringifiedValue, expiresAt],
      (err) => {
        if (err) {
          console.error('[Cache Error] Failed to write into SQLite:', err.message);
        }
      }
    );
  }

  getSQLiteFallback(key) {
    // If Redis is active but failed, try reading from SQLite if connection is opened
    if (this.sqliteDb) {
      return new Promise((res) => this.getSQLite(key, res));
    }
    return Promise.resolve(memoryCache.get(key));
  }

  cleanupExpiredSQLite() {
    if (this.sqliteDb) {
      const now = Date.now();
      this.sqliteDb.run('DELETE FROM cache WHERE expires_at < ?', [now], (err) => {
        if (!err) {
          console.log('[Cache GC] Expired SQLite cache entries cleared.');
        }
      });
    }
  }
}

// Export Singleton Instance
module.exports = new CacheProvider();
