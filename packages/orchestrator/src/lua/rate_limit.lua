-- Sliding window rate limit
-- KEYS[1] = rate key
-- ARGV[1] = window ms
-- ARGV[2] = max requests
-- ARGV[3] = now ms
-- ARGV[4] = unique member
-- Returns: { allowed (1/0), current_count }

local key = KEYS[1]
local window = tonumber(ARGV[1])
local max = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local member = ARGV[4]

redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
local count = redis.call('ZCARD', key)
if count >= max then
  return { 0, count }
end
redis.call('ZADD', key, now, member)
redis.call('PEXPIRE', key, window)
return { 1, count + 1 }
