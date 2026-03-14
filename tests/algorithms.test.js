/**
 * TESTS — Jest Unit Tests
 * 
 * Tests verify the core logic of both algorithms.
 * Uses mocked Redis to test without a real Redis instance.
 */

jest.mock('../src/redis-client', () => ({
  evalScript: jest.fn(),
  getClient: jest.fn(() => ({
    hmget: jest.fn(),
    del: jest.fn(),
    zcount: jest.fn(),
  })),
  connect: jest.fn(),
  ping: jest.fn().mockResolvedValue('PONG'),
}));

const redisClient = require('../src/redis-client');
const TokenBucketLimiter = require('../src/algorithms/token-bucket');
const SlidingWindowLimiter = require('../src/algorithms/sliding-window');

describe('Token Bucket Algorithm', () => {
  let limiter;

  beforeEach(() => {
    limiter = new TokenBucketLimiter({ maxTokens: 10, refillRate: 1 });
    jest.clearAllMocks();
  });

  test('allows request when tokens are available', async () => {
    // Simulate Redis returning: [allowed=1, remaining=9, retryAfter=0, limit=10]
    redisClient.evalScript.mockResolvedValue([1, 9, 0, 10]);

    const result = await limiter.isAllowed('user:123');

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(9);
    expect(result.algorithm).toBe('token_bucket');
  });

  test('blocks request when bucket is empty', async () => {
    // Simulate empty bucket: [allowed=0, remaining=0, retryAfter=5000, limit=10]
    redisClient.evalScript.mockResolvedValue([0, 0, 5000, 10]);

    const result = await limiter.isAllowed('user:123');

    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.retryAfter).toBe(5); // 5000ms → 5 seconds
  });

  test('calls Redis with correct parameters', async () => {
    redisClient.evalScript.mockResolvedValue([1, 5, 0, 10]);

    await limiter.isAllowed('user:456');

    expect(redisClient.evalScript).toHaveBeenCalledWith(
      'tokenBucket',
      expect.arrayContaining([expect.stringContaining('user:456')]),
      expect.arrayContaining([10, 1]) // maxTokens, refillRate
    );
  });
});

describe('Sliding Window Algorithm', () => {
  let limiter;

  beforeEach(() => {
    limiter = new SlidingWindowLimiter({ windowMs: 60000, maxRequests: 5 });
    jest.clearAllMocks();
  });

  test('allows request within limit', async () => {
    redisClient.evalScript.mockResolvedValue([1, 4, 0, 5]);

    const result = await limiter.isAllowed('ip:1.2.3.4');

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
    expect(result.algorithm).toBe('sliding_window');
  });

  test('blocks request when limit exceeded', async () => {
    redisClient.evalScript.mockResolvedValue([0, 0, 30000, 5]);

    const result = await limiter.isAllowed('ip:1.2.3.4');

    expect(result.allowed).toBe(false);
    expect(result.retryAfter).toBe(30); // 30000ms → 30 seconds
  });

  test('uses correct window and limit parameters', async () => {
    redisClient.evalScript.mockResolvedValue([1, 3, 0, 5]);

    await limiter.isAllowed('ip:9.9.9.9');

    expect(redisClient.evalScript).toHaveBeenCalledWith(
      'slidingWindow',
      expect.any(Array),
      expect.arrayContaining([60000, 5]) // windowMs, maxRequests
    );
  });
});

describe('Algorithm comparison', () => {
  test('token bucket returns algorithm label', async () => {
    redisClient.evalScript.mockResolvedValue([1, 5, 0, 10]);
    const tb = new TokenBucketLimiter({ maxTokens: 10, refillRate: 1 });
    const result = await tb.isAllowed('user:1');
    expect(result.algorithm).toBe('token_bucket');
  });

  test('sliding window returns algorithm label', async () => {
    redisClient.evalScript.mockResolvedValue([1, 5, 0, 10]);
    const sw = new SlidingWindowLimiter({ windowMs: 60000, maxRequests: 10 });
    const result = await sw.isAllowed('user:1');
    expect(result.algorithm).toBe('sliding_window');
  });
});
