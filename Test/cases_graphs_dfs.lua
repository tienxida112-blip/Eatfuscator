-- graphs_dfs: depth-first and breadth-first walks, cycle detection, topo order
local graph = {
  a = { "b", "c" },
  b = { "d" },
  c = { "d", "e" },
  d = { "f" },
  e = { "f" },
  f = {},
}
local function sortedNeighbours(node)
  local list = {}
  for i, v in ipairs(graph[node] or {}) do list[i] = v end
  table.sort(list)
  return list
end

local visited, order = {}, {}
local function dfs(node)
  if visited[node] then return end
  visited[node] = true
  order[#order + 1] = node
  for _, next in ipairs(sortedNeighbours(node)) do dfs(next) end
end
dfs("a")
print(table.concat(order, ""))
print(visited.f, visited.e)

local queue, seen, bfs = { "a" }, { a = true }, {}
local head = 1
while head <= #queue do
  local node = queue[head]
  head = head + 1
  bfs[#bfs + 1] = node
  for _, next in ipairs(sortedNeighbours(node)) do
    if not seen[next] then
      seen[next] = true
      queue[#queue + 1] = next
    end
  end
end
print(table.concat(bfs, ""))

-- topological order via post-order reversal
local post, mark = {}, {}
local function visit(node)
  if mark[node] == "done" then return end
  mark[node] = "open"
  for _, next in ipairs(sortedNeighbours(node)) do visit(next) end
  mark[node] = "done"
  post[#post + 1] = node
end
visit("a")
local topo = {}
for i = #post, 1, -1 do topo[#topo + 1] = post[i] end
print(table.concat(topo, ""))

local cyclic = { x = { "y" }, y = { "x" } }
local state, found = {}, false
local function detect(node)
  if state[node] == "open" then found = true return end
  if state[node] == "done" then return end
  state[node] = "open"
  for _, next in ipairs(cyclic[node] or {}) do detect(next) end
  state[node] = "done"
end
detect("x")
print("cycle", found)
