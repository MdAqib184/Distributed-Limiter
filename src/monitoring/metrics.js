/**
 * MONITORING — Prometheus Metrics
 * 
 * Prometheus is an industry-standard monitoring system.
 * It "scrapes" your /metrics endpoint at regular intervals
 * and stores time-series data you can graph in Grafana.
 * 
 * Metric Types Used:
 * - Counter: Only goes up (requests allowed, requests blocked)
 * - Histogram: Distribution of values (latency in buckets)
 * - Gauge: Can go up or down (active connections, current token count)
 */

const promClient = require('prom-client');

// Enable default Node.js metrics (CPU, memory, event loop lag, etc.)
promClient.collectDefaultMetrics({
  prefix: 'rate_limiter_',
  gcDurationBuckets: [0.001, 0.01, 0.1, 1, 2, 5],
});

const metrics = {

  // ============================================================
  // REQUEST COUNTERS
  // ============================================================

  /**
   * Total allowed requests. Labels allow filtering by algorithm/limiter.
   * Example query: rate(rate_limit_allowed_total[5m]) → throughput
   */
  rateLimitAllowed: new promClient.Counter({
    name: 'rate_limit_allowed_total',
    help: 'Total number of requests that passed the rate limit check',
    labelNames: ['algorithm', 'limiter'],
  }),

  /**
   * Total blocked requests — the key "spike" metric.
   * A sudden jump here means someone is hitting limits.
   * Example query: rate(rate_limit_blocked_total[1m]) → blocking rate
   */
  rateLimitBlocked: new promClient.Counter({
    name: 'rate_limit_blocked_total',
    help: 'Total number of requests blocked by the rate limiter',
    labelNames: ['algorithm', 'limiter'],
  }),

  /**
   * Errors (Redis failures, script errors).
   * Alerts you to infrastructure problems.
   */
  rateLimitErrors: new promClient.Counter({
    name: 'rate_limit_errors_total',
    help: 'Total number of rate limiter errors (Redis failures, etc.)',
    labelNames: ['algorithm', 'limiter'],
  }),

  // ============================================================
  // LATENCY HISTOGRAMS
  // ============================================================

  /**
   * Time taken to make a rate limit decision (Redis round-trip + Lua execution).
   * Target: sub-millisecond. Alert if p99 > 5ms.
   * 
   * Histogram buckets define resolution:
   * [0.1ms, 0.5ms, 1ms, 5ms, 10ms, 50ms]
   */
  rateLimitDecisionLatency: new promClient.Histogram({
    name: 'rate_limit_decision_latency_ms',
    help: 'Time taken to make a rate limit decision (milliseconds)',
    labelNames: ['algorithm'],
    buckets: [0.1, 0.5, 1, 2, 5, 10, 25, 50, 100],
  }),

  /**
   * Full HTTP request duration.
   * Helps correlate rate limiter overhead with total response time.
   */
  httpRequestDuration: new promClient.Histogram({
    name: 'http_request_duration_ms',
    help: 'HTTP request duration in milliseconds',
    labelNames: ['method', 'route', 'status'],
    buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000],
  }),

  // ============================================================
  // GAUGES (real-time state)
  // ============================================================

  /**
   * Current active Redis connections.
   * Tracks connection pool health.
   */
  redisConnections: new promClient.Gauge({
    name: 'redis_active_connections',
    help: 'Number of active Redis connections',
  }),

  /**
   * Number of unique rate-limited identifiers currently tracked.
   * High numbers = high traffic diversity (many different users/IPs).
   */
  activeIdentifiers: new promClient.Gauge({
    name: 'rate_limit_active_identifiers',
    help: 'Number of unique identifiers currently tracked in Redis',
    labelNames: ['algorithm'],
  }),

  // Expose Prometheus registry for /metrics endpoint
  register: promClient.register,
};

module.exports = metrics;
