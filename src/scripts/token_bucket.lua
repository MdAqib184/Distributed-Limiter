-- TOKEN BUCKET ALGORITHM (Redis Lua Script)
-- Atomic execution prevents race conditions in concurrent environments
--
-- How it works:
-- A bucket holds a max number of tokens. Each request consumes 1 token.
-- Tokens refill at a steady rate over time (e.g., 100 tokens per minute).
-- If the bucket is empty, the request is rejected.
--
-- KEYS[1] = rate limit key (e.g., "rl:token_bucket:user:123")
-- ARGV[1] = max tokens (bucket capacity)
-- ARGV[2] = refill rate (tokens per second)
-- ARGV[3] = current timestamp (milliseconds)
-- ARGV[4] = tokens requested (usually 1)

local key = KEYS[1]
local max_tokens = tonumber(ARGV[1])
local refill_rate = tonumber(ARGV[2])  -- tokens per second
local now = tonumber(ARGV[3])
local requested = tonumber(ARGV[4]) or 1

-- Retrieve current bucket state from Redis
local bucket = redis.call('HMGET', key, 'tokens', 'last_refill')
local tokens = tonumber(bucket[1])
local last_refill = tonumber(bucket[2])

-- First request for this key: initialize a full bucket
if tokens == nil then
  tokens = max_tokens
  last_refill = now
end

-- Calculate how many tokens to add based on elapsed time
local elapsed_seconds = (now - last_refill) / 1000
local tokens_to_add = elapsed_seconds * refill_rate

-- Refill the bucket (but don't exceed max capacity)
tokens = math.min(max_tokens, tokens + tokens_to_add)
last_refill = now

-- Check if enough tokens exist to serve the request
local allowed = 0
local remaining = 0

if tokens >= requested then
  tokens = tokens - requested
  allowed = 1
  remaining = math.floor(tokens)
else
  allowed = 0
  remaining = 0
end

-- Persist updated state with TTL (auto-cleanup after inactivity)
local ttl = math.ceil(max_tokens / refill_rate) * 2
redis.call('HMSET', key, 'tokens', tokens, 'last_refill', last_refill)
redis.call('EXPIRE', key, ttl)

-- Return: [allowed (0/1), remaining_tokens, retry_after_ms]
local retry_after = 0
if allowed == 0 then
  retry_after = math.ceil((requested - tokens) / refill_rate * 1000)
end

return {allowed, remaining, retry_after, math.floor(max_tokens)}
