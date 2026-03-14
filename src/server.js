/**
 * MAIN SERVER — Express.js Application
 * 
 * This is the entry point. It wires together:
 * - Express (HTTP server & routing)
 * - Redis (state store for rate limit counters)
 * - Rate limiting middleware (token bucket + sliding window)
 * - Monitoring (metrics endpoint for Prometheus)
 * 
 * ARCHITECTURE:
 * [Client] → [Load Balancer] → [API Instance 1] ─┐
 *                             [API Instance 2] ─┼→ [Redis]
 *                             [API Instance 3] ─┘
 * 
 * All API instances are STATELESS — they store NO rate limit state locally.
 * All state lives in Redis. This enables horizontal scaling:
 * add more API instances without coordination complexity.
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const redisClient = require('./redis-client');
const { createRateLimiter, apiKeyGenerator } = require('./middleware/rate-limiter');
const metrics = require('./monitoring/metrics');
const logger = require('./monitoring/logger');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// MIDDLEWARE SETUP
// ============================================================

app.use(cors());
app.use(express.json());

// Request timing middleware — tracks HTTP duration for /metrics
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    metrics.httpRequestDuration.observe(
      { method: req.method, route: req.route?.path || req.path, status: res.statusCode },
      duration
    );
  });
  next();
});

// ============================================================
// RATE LIMITER CONFIGURATIONS
// ============================================================

/**
 * General API rate limiter — Sliding Window
 * Limit: 100 requests per minute per IP
 * Best for: General API endpoints where accuracy matters
 */
const generalLimiter = createRateLimiter({
  algorithm: 'sliding_window',
  maxRequests: 100,
  windowMs: 60 * 1000,      // 1 minute window
  name: 'general',
});

/**
 * Strict rate limiter — Sliding Window (tighter)
 * Limit: 10 requests per minute
 * Best for: Expensive operations (auth, payments, file uploads)
 */
const strictLimiter = createRateLimiter({
  algorithm: 'sliding_window',
  maxRequests: 10,
  windowMs: 60 * 1000,
  name: 'strict',
});

/**
 * Burst-friendly limiter — Token Bucket
 * Bucket: 50 tokens, refill at 5 tokens/sec
 * Best for: APIs where burst traffic is acceptable (e.g., search)
 * 
 * A user can use 50 tokens instantly, then gets 5/sec ongoing.
 * Total sustained rate: 5 req/sec (300/min)
 */
const burstLimiter = createRateLimiter({
  algorithm: 'token_bucket',
  maxRequests: 50,           // Bucket capacity
  refillRate: 5,             // 5 tokens/second refill
  name: 'burst',
});

/**
 * API key based limiter — Token Bucket (higher limits)
 * Limit: 1000 tokens, refill at 100/sec
 * Uses API key as identifier (different limit per client)
 */
const apiKeyLimiter = createRateLimiter({
  algorithm: 'token_bucket',
  maxRequests: 1000,
  refillRate: 100,
  keyGenerator: apiKeyGenerator,  // Use X-Api-Key header as identifier
  name: 'api_key',
});

// ============================================================
// ROUTES
// ============================================================

/**
 * Health check endpoint — no rate limiting.
 * Used by load balancers to check if this instance is alive.
 * Load balancer removes unhealthy instances from rotation.
 */
app.get('/health', async (req, res) => {
  try {
    const redisPing = await redisClient.ping();
    res.json({
      status: 'healthy',
      redis: redisPing === 'PONG' ? 'connected' : 'error',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(503).json({ status: 'unhealthy', error: err.message });
  }
});

/**
 * Prometheus metrics endpoint.
 * Scraped by Prometheus every 15 seconds.
 * Grafana reads from Prometheus to render dashboards.
 */
app.get('/metrics', async (req, res) => {
  res.setHeader('Content-Type', metrics.register.contentType);
  res.send(await metrics.register.metrics());
});

/**
 * General API route — sliding window rate limited (100/min)
 */
app.get('/api/data', generalLimiter, (req, res) => {
  res.json({
    message: 'Success! Data retrieved.',
    algorithm: 'sliding_window',
    timestamp: Date.now(),
    requestId: Math.random().toString(36).substr(2, 9),
  });
});

/**
 * Burst-friendly route — token bucket rate limited
 * Demonstrates burst capacity (50 req immediate, then 5/sec)
 */
app.get('/api/search', burstLimiter, (req, res) => {
  const query = req.query.q || '';
  res.json({
    message: 'Search results',
    query,
    results: [`Result for: ${query}`],
    algorithm: 'token_bucket',
  });
});

/**
 * Strict route — low limit, sliding window
 * Simulates an expensive or sensitive operation
 */
app.post('/api/auth/login', strictLimiter, (req, res) => {
  res.json({
    message: 'Login endpoint (rate limited to 10/min)',
    algorithm: 'sliding_window',
    note: 'Strict limits prevent brute force attacks',
  });
});

/**
 * API key route — high limits for authenticated clients
 * Pass X-Api-Key header to get per-key rate limiting
 */
app.get('/api/premium', apiKeyLimiter, (req, res) => {
  const apiKey = req.headers['x-api-key'] || 'anonymous';
  res.json({
    message: 'Premium API endpoint',
    client: apiKey,
    algorithm: 'token_bucket',
    note: 'Each API key gets its own token bucket',
  });
});

/**
 * Rate limiter status — inspect current state for a given identifier.
 * Useful for debugging and monitoring dashboards.
 */
app.get('/api/status/:identifier', async (req, res) => {
  const { identifier } = req.params;
  const TokenBucket = require('./algorithms/token-bucket');
  const SlidingWindow = require('./algorithms/sliding-window');

  const tb = new TokenBucket({ maxTokens: 100, refillRate: 10 });
  const sw = new SlidingWindow({ windowMs: 60000, maxRequests: 100 });

  const [tbStatus, swStatus] = await Promise.all([
    tb.getStatus(identifier),
    sw.getWindowCount(identifier),
  ]);

  res.json({
    identifier,
    tokenBucket: tbStatus,
    slidingWindow: swStatus,
  });
});

/**
 * Reset rate limit for an identifier (admin endpoint)
 */
app.delete('/api/admin/reset/:identifier', async (req, res) => {
  const { identifier } = req.params;
  const algorithm = req.query.algorithm || 'all';
  const TokenBucket = require('./algorithms/token-bucket');
  const SlidingWindow = require('./algorithms/sliding-window');

  const results = {};

  if (algorithm === 'all' || algorithm === 'token_bucket') {
    const tb = new TokenBucket();
    results.tokenBucket = await tb.reset(identifier);
  }

  if (algorithm === 'all' || algorithm === 'sliding_window') {
    const sw = new SlidingWindow();
    results.slidingWindow = await sw.reset(identifier);
  }

  res.json({ message: 'Rate limits reset', identifier, results });
});

// ============================================================
// STARTUP
// ============================================================

async function start() {
  try {
    logger.info('Connecting to Redis...');
    await redisClient.connect();

    app.listen(PORT, () => {
      logger.info(`🚀 Rate Limiter API running on port ${PORT}`);
      logger.info(`📊 Metrics available at http://localhost:${PORT}/metrics`);
      logger.info(`❤️  Health check at http://localhost:${PORT}/health`);
    });

  } catch (err) {
    logger.error('Failed to start server:', err);
    process.exit(1);
  }
}

// Graceful shutdown — close connections cleanly
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully...');
  await redisClient.quit();
  process.exit(0);
});

start();

module.exports = app; // Export for tests
