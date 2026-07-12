-- Atomic lock acquire with composite fencing token {instanceId}:{counter}
-- KEYS[1] = lock key
-- ARGV[1] = ownerId
-- ARGV[2] = ttl seconds
-- ARGV[3] = instanceId key (well-known)
--
-- Returns: { status, token }
-- status: 1=acquired, 2=reentrant, 0=locked by another

local lockKey = KEYS[1]
local ownerId = ARGV[1]
local ttl = tonumber(ARGV[2])
local instanceKey = ARGV[3]

local instanceId = redis.call('GET', instanceKey)
if not instanceId then
  -- Bootstrap instance id if missing (first master)
  instanceId = redis.call('GET', 'lock_instance_bootstrap')
  if not instanceId then
    -- Caller should SET instance id; use placeholder that will be replaced
    return { -1, 'NO_INSTANCE_ID' }
  end
end

local currentOwner = redis.call('GET', lockKey)
if currentOwner == false then
  local counter = redis.call('INCR', 'lock_fencing_seq:' .. lockKey)
  local token = instanceId .. ':' .. counter
  redis.call('SET', lockKey, ownerId, 'EX', ttl)
  redis.call('SET', 'lock_fencing_token:' .. lockKey, token, 'EX', ttl)
  return { 1, token }
elseif currentOwner == ownerId then
  local token = redis.call('GET', 'lock_fencing_token:' .. lockKey)
  if not token then
    local counter = redis.call('INCR', 'lock_fencing_seq:' .. lockKey)
    token = instanceId .. ':' .. counter
    redis.call('SET', 'lock_fencing_token:' .. lockKey, token, 'EX', ttl)
  end
  redis.call('EXPIRE', lockKey, ttl)
  redis.call('EXPIRE', 'lock_fencing_token:' .. lockKey, ttl)
  return { 2, token }
else
  return { 0, '0' }
end
