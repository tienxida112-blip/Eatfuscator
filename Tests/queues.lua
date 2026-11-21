-- queues: a ring buffer, a stack, and a queue built from two stacks
local Ring = {}
Ring.__index = Ring
function Ring.new(cap)
  return setmetatable({ cap = cap, items = {}, head = 1, size = 0 }, Ring)
end
function Ring:push(v)
  if self.size == self.cap then self:pop() end
  local tail = (self.head + self.size - 1) % self.cap + 1
  self.items[tail] = v
  self.size = self.size + 1
end
function Ring:pop()
  if self.size == 0 then return nil end
  local v = self.items[self.head]
  self.items[self.head] = nil
  self.head = self.head % self.cap + 1
  self.size = self.size - 1
  return v
end
local r = Ring.new(3)
for i = 1, 5 do r:push(i) end
print(r.size, r:pop(), r:pop(), r.size)

local stack = { top = 0 }
function stack:push(v) self.top = self.top + 1 self[self.top] = v end
function stack:pop() if self.top == 0 then return nil end local v = self[self.top] self[self.top] = nil self.top = self.top - 1 return v end
for _, c in ipairs({ "(", "[", "{" }) do stack:push(c) end
print(stack:pop(), stack:pop(), stack.top)

local inb, outb = {}, {}
local function enqueue(v) inb[#inb + 1] = v end
local function dequeue()
  if #outb == 0 then
    while #inb > 0 do outb[#outb + 1] = table.remove(inb) end
  end
  return table.remove(outb)
end
for i = 1, 6 do enqueue(i * i) end
print(dequeue(), dequeue())
enqueue(49)
print(dequeue(), dequeue(), dequeue(), dequeue(), dequeue())
