-- Release lock only if owner matches
-- KEYS[1] = lock key
-- ARGV[1] = ownerId
-- Returns: 1 if released, 0 if not owner / missing

local lockKey = KEYS[1]
local ownerId = ARGV[1]
local currentOwner = redis.call('GET', lockKey)
if currentOwner == ownerId then
  redis.call('DEL', lockKey)
  redis.call('DEL', 'lock_fencing_token:' .. lockKey)
  return 1
end
return 0
