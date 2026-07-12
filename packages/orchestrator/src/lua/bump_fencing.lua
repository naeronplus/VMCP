-- Increment fencing token without granting ownership (stale recovery / reclaim)
-- KEYS[1] = lock key
-- ARGV[1] = instanceId key
-- Returns: new token string, or error

local lockKey = KEYS[1]
local instanceKey = ARGV[1]
local instanceId = redis.call('GET', instanceKey)
if not instanceId then
  return { -1, 'NO_INSTANCE_ID' }
end
local counter = redis.call('INCR', 'lock_fencing_seq:' .. lockKey)
local token = instanceId .. ':' .. counter
redis.call('SET', 'lock_fencing_token:' .. lockKey, token)
redis.call('DEL', lockKey)
return { 1, token }
