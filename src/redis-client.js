/**
 * Redis Client Setup
 * 
 * Uses ioredis — a robust Redis client with:
 * - Automatic reconnection
 * - Connection pooling
 * - Lua script support (EVALSHA for caching loaded scripts)
 * - Cluster mode support for horizontal scaling
 */

const Redis = require('ioredis');
const fs = require('fs');
const path = require('path');
const logger = require('./monitoring/logger');

// Load Lua scripts from disk
const SCRIPTS = {
  tokenBucket: {
    script: fs.readFileSync(
      path.join(__dirname, 'scripts/token_bucket.lua'),
      'utf8'
    ),
    sha: null, // Will be set after SCRIPT LOAD
    numkeys: 1,
  },
  slidingWindow: {
    script: fs.readFileSync(
      path.join(__dirname, 'scripts/sliding_window.lua'),
      'utf8'
    ),
    sha: null,
    numkeys: 1,
  },
};

class RedisClient {
  constructor() {
    this.client = null;
    this.isConnected = false;
  }

  /**
   * Creates and connects to Redis.
   * Using EVALSHA instead of EVAL: Redis caches the script by SHA hash,
   * so we only send the script once — every subsequent call uses the hash.
   * This reduces network payload and improves latency.
   */
  async connect() {
    const config = {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379'),
      password: process.env.REDIS_PASSWORD || undefined,
      db: parseInt(process.env.REDIS_DB || '0'),
      maxRetriesPerRequest: 3,
      retryStrategy(times) {
        // Exponential backoff: wait 50ms, 100ms, 200ms... up to 2s
        const delay = Math.min(times * 50, 2000);
        logger.warn(`Redis retry attempt ${times}, waiting ${delay}ms`);
        return delay;
      },
      lazyConnect: true,
    };

    this.client = new Redis(config);

    this.client.on('connect', () => {
      this.isConnected = true;
      logger.info('Redis connected');
    });

    this.client.on('error', (err) => {
      logger.error('Redis error:', err.message);
    });

    this.client.on('close', () => {
      this.isConnected = false;
      logger.warn('Redis connection closed');
    });

    await this.client.connect();

    // Pre-load Lua scripts into Redis cache
    // SCRIPT LOAD returns a SHA1 hash we use for future EVALSHA calls
    for (const [name, scriptObj] of Object.entries(SCRIPTS)) {
      scriptObj.sha = await this.client.script('LOAD', scriptObj.script);
      logger.info(`Script '${name}' loaded with SHA: ${scriptObj.sha}`);
    }

    return this.client;
  }

  /**
   * Execute a Lua script atomically on Redis.
   * 
   * Atomicity matters: Redis is single-threaded for script execution.
   * The entire Lua script runs without interruption — no other command
   * can slip in between reads and writes. This prevents race conditions
   * where two concurrent requests both see "tokens available" and both
   * proceed, exceeding the rate limit.
   */
  async evalScript(scriptName, keys, args) {
    const scriptObj = SCRIPTS[scriptName];
    if (!scriptObj) throw new Error(`Unknown script: ${scriptName}`);

    try {
      // Try EVALSHA first (uses cached script by SHA hash)
      return await this.client.evalsha(
        scriptObj.sha,
        scriptObj.numkeys,
        ...keys,
        ...args
      );
    } catch (err) {
      // If script not cached (e.g., Redis restart), reload and retry
      if (err.message.includes('NOSCRIPT')) {
        scriptObj.sha = await this.client.script('LOAD', scriptObj.script);
        return await this.client.evalsha(
          scriptObj.sha,
          scriptObj.numkeys,
          ...keys,
          ...args
        );
      }
      throw err;
    }
  }

  getClient() {
    return this.client;
  }

  async ping() {
    return await this.client.ping();
  }

  async quit() {
    await this.client.quit();
  }
}

// Export singleton instance
const redisClient = new RedisClient();
module.exports = redisClient;
