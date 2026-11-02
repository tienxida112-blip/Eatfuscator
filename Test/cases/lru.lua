-- lru: ordered cache on a hand-written linked list
local LRU = {}
LRU.__index = LRU
function LRU.new(cap)
  return setmetatable({ cap = cap, map = {}, head = nil, tail = nil, size = 0, hits = 0, misses = 0 }, LRU)
end
function LRU:unlink(node)
  if node.prev then node.prev.next = node.next else self.head = node.next end
  if node.next then node.next.prev = node.prev else self.tail = node.prev end
end
function LRU:pushFront(node)
  node.prev = nil
  node.next = self.head
  if self.head then self.head.prev = node end
  self.head = node
  if not self.tail then self.tail = node end
end
function LRU:get(key)
  local node = self.map[key]
  if not node then
    self.misses = self.misses + 1
    return nil
  end
  self.hits = self.hits + 1
  self:unlink(node)
  self:pushFront(node)
  return node.value
end
function LRU:put(key, value)
  local node = self.map[key]
  if node then
    node.value = value
    self:unlink(node)
    self:pushFront(node)
    return
  end
  node = { key = key, value = value }
  self.map[key] = node
  self:pushFront(node)
  self.size = self.size + 1
  if self.size > self.cap then
    local victim = self.tail
    self:unlink(victim)
    self.map[victim.key] = nil
    self.size = self.size - 1
  end
end
function LRU:keys()
  local out = {}
  local node = self.head
  while node do
    out[#out + 1] = tostring(node.key) .. "=" .. tostring(node.value)
    node = node.next
  end
  return table.concat(out, " ")
end

local c = LRU.new(3)
c:put("a", 1); c:put("b", 2); c:put("c", 3)
print(c:keys())
print(c:get("a"))
c:put("d", 4)
print(c:keys())
print(c:get("b"), c.hits, c.misses)
c:put("b", 22)
print(c:keys(), c.size)
for k = 1, 5 do c:put(k, k * k) end
print(c:keys(), c.size)
