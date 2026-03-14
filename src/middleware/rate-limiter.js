/**
 * EXPRESS MIDDLEWARE — Rate Limiting Layer
 * 
 * Middleware sits between the incoming request and your route handler.
 * It intercepts every request, checks the rate limit, and either:
 * - Calls next() to pass the request through, or
 * - Sends a 429 Too Many Requests response
 * 
 * This is the core of the "rate limiting layer" mentioned in the resume.
 * It's algorithm-agnostic — works with token bucket or sliding window.
 */

const TokenBucketLimiter = require('../algorithms/token-bucket');
const SlidingWindowLimiter = require('../algorithms/sliding-window');
const metrics = require('../monitoring/metrics');
const logger = require('../monitoring/logger');

/**
 * Factory function — creates configured rate limiter middleware.
 * 
 * @param {object} options
 * @param {string} options.algorithm       - 'token_bucket' | 'sliding_window'
 * @param {number} options.maxRequests     - Max requests (or max tokens for TB)
 * @param {number} options.windowMs        - Time window in ms (sliding window)
 * @param {number} options.refillRate      - Tokens/sec (token bucket)
 * @param {Function} options.keyGenerator  - Function to extract identifier from req
 * @param {boolean} options.skipFailedRequests - Skip counting 4xx responses
 */
function createRateLimiter(options = {}) {
  const {
    algorithm = 'sliding_window',
    maxRequests = 100,
    windowMs = 60000,
    refillRate = 10,
    keyGenerator = defaultKeyGenerator,
    skipFailedRequests = false,
    name = 'default',
  } = options;

  // Initialize the chosen algorithm
  let limiter;
  if (algorithm === 'token_bucket') {
    limiter = new TokenBucketLimiter({
      maxTokens: maxRequests,
      refillRate,
      keyPrefix: `rl:tb:${name}`,
    });
  } else {
    limiter = new SlidingWindowLimiter({
      windowMs,
      maxRequests,
      keyPrefix: `rl:sw:${name}`,
    });
  }

  /**
   * The actual Express middleware function.
   * This runs on every request that passes through it.
   */
  return async function rateLimitMiddleware(req, res, next) {
    const identifier = keyGenerator(req);
    const startTime = Date.now();

    try {
      const result = await limiter.isAllowed(identifier);
      const latency = Date.now() - startTime;

      // Set standard rate limit headers (RFC 6585)
      // These headers tell clients their current limit status
      res.setHeader('X-RateLimit-Limit', result.limit);
      res.setHeader('X-RateLimit-Remaining', result.remaining);
      res.setHeader('X-RateLimit-Algorithm', result.algorithm);
      res.setHeader('X-RateLimit-Identifier', identifier);

      if (!result.allowed) {
        // Request is blocked — log it and return 429
        res.setHeader('Retry-After', result.retryAfter);
        res.setHeader('X-RateLimit-Reset', Date.now() + result.retryAfter * 1000);

        logger.warn('Rate limit exceeded', {
          identifier,
          algorithm,
          name,
          latency_ms: latency,
        });

        // Track blocked requests in Prometheus metrics
        metrics.rateLimitBlocked.inc({ algorithm, limiter: name });
        metrics.rateLimitDecisionLatency.observe({ algorithm }, latency);

        return res.status(429).json({
          error: 'Too Many Requests',
          message: `Rate limit exceeded. Try again in ${result.retryAfter} seconds.`,
          retryAfter: result.retryAfter,
          limit: result.limit,
          remaining: 0,
          algorithm: result.algorithm,
        });
      }

      // Request is allowed
      metrics.rateLimitAllowed.inc({ algorithm, limiter: name });
      metrics.rateLimitDecisionLatency.observe({ algorithm }, latency);

      logger.debug('Request allowed', {
        identifier,
        remaining: result.remaining,
        latency_ms: latency,
      });

      next();

    } catch (err) {
      // Redis error: fail open (allow request) to avoid outages
      // In production you might want to fail closed depending on security needs
      logger.error('Rate limiter error (failing open):', err.message);
      metrics.rateLimitErrors.inc({ algorithm, limiter: name });
      next();
    }
  };
}

/**
 * Default key generator: extracts client IP address.
 * 
 * Supports X-Forwarded-For header for requests behind load balancers.
 * The rate limit is applied per unique IP address.
 * 
 * Other common strategies:
 * - API key: req.headers['x-api-key']
 * - User ID: req.user?.id
 * - Combination: `${req.user?.id}:${req.path}`
 */
function defaultKeyGenerator(req) {
  // X-Forwarded-For is set by load balancers/proxies
  // It contains the original client IP, not the proxy's IP
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    // X-Forwarded-For can be a comma-separated list: "client, proxy1, proxy2"
    return forwarded.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || req.ip || 'unknown';
}

/**
 * Key generator by API key header.
 * Use this for API authentication-based rate limiting.
 */
function apiKeyGenerator(req) {
  return req.headers['x-api-key'] || defaultKeyGenerator(req);
}

/**
 * Key generator combining user ID + route.
 * Allows different limits per endpoint per user.
 */
function perRouteKeyGenerator(req) {
  const userId = req.user?.id || defaultKeyGenerator(req);
  return `${userId}:${req.method}:${req.route?.path || req.path}`;
}

module.exports = {
  createRateLimiter,
  defaultKeyGenerator,
  apiKeyGenerator,
  perRouteKeyGenerator,
};
