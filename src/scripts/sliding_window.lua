-- SLIDING WINDOW ALGORITHM (Redis Lua Script)
-- More accurate than fixed windows — eliminates boundary burst spikes
--
-- How it works:
-- Uses a Redis Sorted Set where each member = request timestamp.
-- On every request:
--   1. Remove timestamps older than the window (they've "slid" out)
--   2. Count remaining entries = current request count
--   3. If under limit → add new timestamp, allow request
--   4. If at/over limit → reject request
--
-- KEYS[1] = rate limit key (e.g., "rl:sliding_window:ip:1.2.3.4")
-- ARGV[1] = window duration in milliseconds (e.g., 60000 = 1 minute)
-- ARGV[2] = max requests allowed in window
-- ARGV[3] = current timestamp (milliseconds)
-- ARGV[4] = unique request ID (for sorted set member uniqueness)

local key = KEYS[1]
local window_ms = tonumber(ARGV[1])
local max_requests = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local request_id = ARGV[4]

-- The window starts at (now - window_ms)
local window_start = now - window_ms

-- Step 1: Remove all entries older than the sliding window
-- ZREMRANGEBYSCORE removes members with score < window_start
redis.call('ZREMRANGEBYSCORE', key, '-inf', window_start)

-- Step 2: Count how many requests exist within the current window
local current_count = redis.call('ZCARD', key)

-- Step 3: Decide to allow or deny
local allowed = 0
local remaining = 0

if current_count < max_requests then
  -- Add this request timestamp to the sorted set
  -- Score = timestamp (used for range queries)
  -- Member = unique ID (to avoid collisions at same millisecond)
  redis.call('ZADD', key, now, request_id)
  allowed = 1
  remaining = max_requests - current_count - 1
else
  allowed = 0
  remaining = 0
end

-- Set TTL so the key auto-expires if no activity
redis.call('PEXPIRE', key, window_ms)

-- Get oldest request time (to calculate retry-after)
local retry_after = 0
if allowed == 0 then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  if oldest[2] then
    -- How long until the oldest request slides out of the window
    retry_after = math.ceil((tonumber(oldest[2]) + window_ms - now))
  end
end

-- Return: [allowed (0/1), remaining, retry_after_ms, max_requests]
return {allowed, remaining, retry_after, max_requests}
