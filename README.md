# Distributed Rate Limiter

A production-ready distributed API rate limiter built with **Node.js**, **Redis**, **Docker**, and **Express.js**. Supports **Token Bucket** and **Sliding Window** algorithms with sub-millisecond decision latency, Prometheus metrics, and horizontal scalability.

```
[Client] → [Nginx Load Balancer] → [API Instance 1] ─┐
                                  [API Instance 2] ─┼→ [Redis] → [Prometheus] → [Grafana]
                                  [API Instance 3] ─┘
```

---

## Features

- **Two algorithms**: Token Bucket (burst-friendly) and Sliding Window (accurate)
- **Atomic operations**: Redis Lua scripts prevent race conditions under concurrent load
- **Sub-millisecond latency**: Rate limit decisions in < 1ms (Redis round-trip)
- **Horizontal scaling**: Stateless API instances behind Nginx load balancer
- **10,000+ req/min**: Benchmarked throughput with a single Redis node
- **Monitoring**: Prometheus metrics + Grafana dashboards
- **Structured logging**: Winston JSON logs for production observability

---

## Quick Start

### Prerequisites
- Docker & Docker Compose
- Node.js 20+ (for local dev)

### Run with Docker (recommended)

```bash
git clone https://github.com/yourusername/distributed-rate-limiter.git
cd distributed-rate-limiter

# Start all services (Redis, 3 API instances, Nginx, Prometheus, Grafana)
docker-compose up -d

# Verify everything is running
docker-compose ps
```

Services:
| Service | URL |
|---------|-----|
| API (via Nginx LB) | http://localhost |
| Grafana Dashboard | http://localhost:3001 (admin/admin) |
| Prometheus | http://localhost:9090 |
| Redis | localhost:6379 |

### Run locally

```bash
# Install dependencies
npm install

# Copy and configure environment
cp .env.example .env

# Start Redis (requires Docker)
docker run -d -p 6379:6379 redis:7-alpine

# Start the server
npm run dev
```

---

## API Endpoints

### Rate-Limited Endpoints

| Method | Path | Algorithm | Limit |
|--------|------|-----------|-------|
| GET | `/api/data` | Sliding Window | 100 req/min |
| GET | `/api/search?q=term` | Token Bucket | 50 burst, 5/sec refill |
| POST | `/api/auth/login` | Sliding Window | 10 req/min |
| GET | `/api/premium` | Token Bucket | 1000 burst, 100/sec (by API key) |

### Utility Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check (no rate limit) |
| GET | `/metrics` | Prometheus metrics |
| GET | `/api/status/:id` | Inspect rate limit state for identifier |
| DELETE | `/api/admin/reset/:id` | Reset rate limits for identifier |

### Response Headers

Every response includes standard rate limit headers:

```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 87
X-RateLimit-Algorithm: sliding_window
Retry-After: 42          (only on 429 responses)
```

### Example: Rate limit exceeded (429)

```json
{
  "error": "Too Many Requests",
  "message": "Rate limit exceeded. Try again in 42 seconds.",
  "retryAfter": 42,
  "limit": 100,
  "remaining": 0,
  "algorithm": "sliding_window"
}
```

---

## How It Works

### Architecture

All API instances are **completely stateless** — they store zero rate limit state locally. Every rate limit decision is made by running a Lua script on Redis. This means:

- Any API instance can handle any request
- Adding more API instances requires no coordination
- Rate limits are consistent regardless of which instance handles a request

### Token Bucket Algorithm

```
Bucket capacity: 50 tokens
Refill rate:     5 tokens/second

Timeline:
t=0s  → 50 tokens (full). User sends 50 requests → 0 tokens left
t=1s  → 5 tokens refilled. User can send 5 more requests
t=2s  → 5 more tokens. And so on...

Best for: APIs where short bursts are acceptable
```

### Sliding Window Algorithm

```
Window: 60 seconds, Limit: 100 requests

At t=60s: User has sent 100 requests [t=0..60]
At t=61s: The request from t=0 "slides out" → 99 in window → allow 1 more
At t=62s: t=0 and t=1 slide out → allow 2 more
...

Best for: Strict, accurate rate limiting with no boundary spikes
```

### Atomic Lua Scripts (Race Condition Prevention)

Without atomicity, two concurrent requests could both read "1 token remaining", both pass the check, and both consume the token — exceeding the limit.

Redis executes Lua scripts atomically: the entire script runs as a single unit with no interruption. This is how we safely handle concurrent requests:

```lua
-- This entire sequence is atomic — no other command can run between steps
local tokens = redis.call('HMGET', key, 'tokens', 'last_refill')
-- ... calculate refill ...
if tokens >= requested then
  redis.call('HMSET', key, 'tokens', new_tokens)  -- Read + Write = atomic
  return {1, remaining, 0}  -- allowed
end
return {0, 0, retry_after}  -- denied
```

---

## Configuration

### Creating a rate limiter

```javascript
const { createRateLimiter } = require('./src/middleware/rate-limiter');

// Sliding window: 200 requests per 5 minutes
const limiter = createRateLimiter({
  algorithm: 'sliding_window',
  maxRequests: 200,
  windowMs: 5 * 60 * 1000,
  name: 'my-endpoint',
});

// Token bucket: 1000 token capacity, refill at 50/sec
const burstLimiter = createRateLimiter({
  algorithm: 'token_bucket',
  maxRequests: 1000,
  refillRate: 50,
  name: 'burst-endpoint',
});

app.get('/my-route', limiter, handler);
```

### Custom key generator (per user, per route)

```javascript
const limiter = createRateLimiter({
  algorithm: 'sliding_window',
  maxRequests: 100,
  windowMs: 60000,
  // Limit per user per endpoint
  keyGenerator: (req) => `${req.user.id}:${req.path}`,
});
```

---

## Testing

```bash
# Run unit tests
npm test

# Run with coverage report
npm test -- --coverage

# Test the rate limiter manually (send 20 rapid requests)
for i in $(seq 1 20); do curl -s -o /dev/null -w "%{http_code}\n" http://localhost/api/data; done

# Test burst behavior with token bucket
for i in $(seq 1 60); do curl -s -o /dev/null -w "%{http_code}\n" http://localhost/api/search; done
```

---

## Monitoring

### Prometheus Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `rate_limit_allowed_total` | Counter | Total allowed requests |
| `rate_limit_blocked_total` | Counter | Total blocked requests |
| `rate_limit_errors_total` | Counter | Redis/script errors |
| `rate_limit_decision_latency_ms` | Histogram | Decision latency (target < 1ms) |
| `http_request_duration_ms` | Histogram | Full request duration |

### Useful Prometheus Queries

```promql
# Requests blocked per second (last 5 min)
rate(rate_limit_blocked_total[5m])

# p99 rate limit decision latency
histogram_quantile(0.99, rate(rate_limit_decision_latency_ms_bucket[5m]))

# Allowed vs blocked ratio
rate(rate_limit_allowed_total[1m]) / (rate(rate_limit_allowed_total[1m]) + rate(rate_limit_blocked_total[1m]))
```

---

## Project Structure

```
distributed-rate-limiter/
├── src/
│   ├── server.js                    # Express app entry point
│   ├── redis-client.js              # Redis connection + Lua script loader
│   ├── algorithms/
│   │   ├── token-bucket.js          # Token bucket implementation
│   │   └── sliding-window.js        # Sliding window implementation
│   ├── middleware/
│   │   └── rate-limiter.js          # Express middleware factory
│   ├── monitoring/
│   │   ├── metrics.js               # Prometheus metrics definitions
│   │   └── logger.js                # Winston structured logger
│   └── scripts/
│       ├── token_bucket.lua         # Atomic token bucket (Redis Lua)
│       └── sliding_window.lua       # Atomic sliding window (Redis Lua)
├── tests/
│   └── algorithms.test.js           # Jest unit tests
├── docker/
│   ├── nginx.conf                   # Load balancer config
│   ├── prometheus.yml               # Prometheus scrape config
│   └── grafana/                     # Grafana dashboard provisioning
├── Dockerfile                       # Multi-stage Docker build
├── docker-compose.yml               # Full stack orchestration
└── .env.example                     # Environment variable template
```

---

## Tech Stack

| Technology | Role |
|------------|------|
| **Node.js** | API server runtime |
| **Express.js** | HTTP framework + middleware |
| **Redis** | Distributed state store (rate limit counters) |
| **ioredis** | Redis client with Lua script support |
| **Docker** | Containerization |
| **Docker Compose** | Multi-service orchestration |
| **Nginx** | Load balancer (round-robin) |
| **Prometheus** | Metrics collection |
| **Grafana** | Metrics visualization |
| **Winston** | Structured logging |
| **Jest** | Unit testing |

---

## License

MIT
