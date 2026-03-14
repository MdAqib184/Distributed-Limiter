/**
 * TOKEN BUCKET ALGORITHM
 * 
 * Concept: Imagine a bucket that can hold N tokens.
 * - Tokens are added at a fixed rate (e.g., 10/sec)
 * - Each request consumes 1 token
 * - If the bucket is full, new tokens are discarded
 * - If the bucket is empty, requests are rejected
 * 
 * Key property: Allows short bursts (if bucket has accumulated tokens)
 * while enforcing an average rate limit over time.
 * 
 * Example: maxTokens=100, refillRate=10/sec
 * - A user can burst 100 requests immediately
 * - Then must wait for tokens to refill at 10/sec
 * - Average throughput is capped at 10 req/sec
 */

const redisClient = require('../redis-client');
const { v4: uuidv4 } = require('uuid');

class TokenBucketLimiter {
  /**
   * @param {object} options
   * @param {number} options.maxTokens     - Bucket capacity (burst limit)
   * @param {number} options.refillRate    - Tokens added per second
   * @param {string} options.keyPrefix     - Redis key namespace
   */
  constructor(options = {}) {
    this.maxTokens = options.maxTokens || 100;
    this.refillRate = options.refillRate || 10;
    this.keyPrefix = options.keyPrefix || 'rl:token_bucket';
  }

  /**
   * Check if a request is allowed under the token bucket algorithm.
   * 
   * @param {string} identifier - Unique identifier (user ID, IP, API key)
   * @param {number} tokensRequested - Tokens to consume (default: 1)
   * @returns {object} { allowed, remaining, retryAfter, limit }
   */
  async isAllowed(identifier, tokensRequested = 1) {
    const key = `${this.keyPrefix}:${identifier}`;
    const now = Date.now();

    const result = await redisClient.evalScript('tokenBucket', [key], [
      this.maxTokens,
      this.refillRate,
      now,
      tokensRequested,
    ]);

    // Lua returns: [allowed, remaining, retry_after_ms, max_tokens]
    const [allowed, remaining, retryAfter, limit] = result;

    return {
      allowed: allowed === 1,
      remaining: Math.floor(remaining),
      retryAfter: retryAfter > 0 ? Math.ceil(retryAfter / 1000) : 0, // convert to seconds
      limit: limit,
      algorithm: 'token_bucket',
      identifier,
    };
  }

  /**
   * Get the current bucket state without consuming a token.
   * Useful for monitoring dashboards.
   */
  async getStatus(identifier) {
    const key = `${this.keyPrefix}:${identifier}`;
    const client = redisClient.getClient();
    const bucket = await client.hmget(key, 'tokens', 'last_refill');

    return {
      tokens: parseFloat(bucket[0]) || this.maxTokens,
      lastRefill: parseInt(bucket[1]) || Date.now(),
      maxTokens: this.maxTokens,
      refillRate: this.refillRate,
    };
  }

  /**
   * Reset a user's bucket (e.g., for admin override or testing)
   */
  async reset(identifier) {
    const key = `${this.keyPrefix}:${identifier}`;
    await redisClient.getClient().del(key);
    return { reset: true, identifier };
  }
}

module.exports = TokenBucketLimiter;
