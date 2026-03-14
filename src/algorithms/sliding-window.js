/**
 * SLIDING WINDOW ALGORITHM
 * 
 * Concept: Track exact timestamps of all requests within a moving time window.
 * Unlike fixed windows (which reset every minute), the window continuously
 * "slides" — it always represents the last N milliseconds.
 * 
 * Problem with Fixed Windows:
 * Limit = 100 req/min. At 12:00:59 a user sends 100 requests.
 * At 12:01:00 the window resets — they can send 100 MORE immediately.
 * In 2 seconds: 200 requests. The fixed window is fooled.
 * 
 * Sliding Window Fix:
 * At any moment, the window covers [now - 60s, now].
 * Those 100 requests at 12:00:59 still count at 12:01:00.
 * The user must wait until 12:01:59 to make more requests.
 * 
 * Trade-off: Slightly higher Redis memory (stores each request timestamp),
 * but provides much more accurate rate limiting.
 */

const redisClient = require('../redis-client');
const { v4: uuidv4 } = require('uuid');

class SlidingWindowLimiter {
  /**
   * @param {object} options
   * @param {number} options.windowMs     - Window size in milliseconds
   * @param {number} options.maxRequests  - Max requests per window
   * @param {string} options.keyPrefix    - Redis key namespace
   */
  constructor(options = {}) {
    this.windowMs = options.windowMs || 60000; // Default: 1 minute
    this.maxRequests = options.maxRequests || 100;
    this.keyPrefix = options.keyPrefix || 'rl:sliding_window';
  }

  /**
   * Check if a request is allowed under the sliding window algorithm.
   * 
   * @param {string} identifier - Unique identifier (user ID, IP, API key)
   * @returns {object} { allowed, remaining, retryAfter, limit }
   */
  async isAllowed(identifier) {
    const key = `${this.keyPrefix}:${identifier}`;
    const now = Date.now();
    // Unique ID ensures no two requests collide in the sorted set
    // even if they arrive at the exact same millisecond
    const requestId = `${now}-${uuidv4()}`;

    const result = await redisClient.evalScript('slidingWindow', [key], [
      this.windowMs,
      this.maxRequests,
      now,
      requestId,
    ]);

    // Lua returns: [allowed, remaining, retry_after_ms, max_requests]
    const [allowed, remaining, retryAfter, limit] = result;

    return {
      allowed: allowed === 1,
      remaining: Math.max(0, remaining),
      retryAfter: retryAfter > 0 ? Math.ceil(retryAfter / 1000) : 0,
      limit: limit,
      windowMs: this.windowMs,
      algorithm: 'sliding_window',
      identifier,
    };
  }

  /**
   * Get the current request count in the window (for monitoring).
   */
  async getWindowCount(identifier) {
    const key = `${this.keyPrefix}:${identifier}`;
    const client = redisClient.getClient();
    const now = Date.now();
    const windowStart = now - this.windowMs;

    // Count entries in the sorted set within the current window
    const count = await client.zcount(key, windowStart, now);

    return {
      count,
      remaining: Math.max(0, this.maxRequests - count),
      windowMs: this.windowMs,
      maxRequests: this.maxRequests,
    };
  }

  /**
   * Reset the sliding window for a specific identifier.
   */
  async reset(identifier) {
    const key = `${this.keyPrefix}:${identifier}`;
    await redisClient.getClient().del(key);
    return { reset: true, identifier };
  }
}

module.exports = SlidingWindowLimiter;
