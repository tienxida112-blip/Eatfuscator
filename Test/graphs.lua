local __BENCH_T0__ = os.clock()
local N = 8000 -- nodes in the big graph
local M = 4 * N -- directed edges in the big graph
local SEED = 1234567 -- Park-Miller PRNG seed

-- Section 0: graph container + deterministic generator

-- A graph is { n, m, eu, ev, ew, head, enext }:
--   eu/ev/ew[e]  endpoints and weight of edge e (directed u -> v)
--   head[v]      first outgoing edge id of v (0 = none)
--   enext[e]     next outgoing edge id after e from the same source
local function makeGraph(n, edges)
	local m = #edges
	local eu = table.create(m)
	local ev = table.create(m)
	local ew = table.create(m)
	local head = table.create(n, 0)
	local enext = table.create(m, 0)
	for e = 1, m do
		local t = edges[e]
		local u, v, w = t[1], t[2], t[3]
		eu[e], ev[e], ew[e] = u, v, w
		enext[e] = head[u]
		head[u] = e
	end
	return { n = n, m = m, eu = eu, ev = ev, ew = ew, head = head, enext = enext }
end

-- Big graph: M random directed edges, weights 1..100, no self-loops.
local function makeBigGraph()
	local s = SEED
	local function rnd()
		s = s * 48271 % 2147483647
		return s
	end
	local edges = table.create(M)
	for e = 1, M do
		local u = rnd() % N + 1
		local v = rnd() % N + 1
		if v == u then
			v = u % N + 1 -- deterministic self-loop fixup
		end
		edges[e] = { u, v, rnd() % 100 + 1 }
	end
	return makeGraph(N, edges)
end

-- Section A: Dijkstra with a binary min-heap (lazy decrease-key)

-- Returns dist[] with math.huge for unreachable nodes.
local function dijkstra(g, source)
	local n = g.n
	local head, enext, ev, ew = g.head, g.enext, g.ev, g.ew
	local dist = table.create(n, math.huge)
	dist[source] = 0

	-- heap of (priority, node) pairs in parallel arrays
	local hp = table.create(64) -- priorities
	local hn = table.create(64) -- node ids
	local hsize = 1
	hp[1], hn[1] = 0, source

	while hsize > 0 do
		-- pop minimum
		local d, v = hp[1], hn[1]
		hp[1], hn[1] = hp[hsize], hn[hsize]
		hsize = hsize - 1
		-- sift down
		local i = 1
		while true do
			local c = i * 2
			if c > hsize then
				break
			end
			if c < hsize and hp[c + 1] < hp[c] then
				c = c + 1
			end
			if hp[c] >= hp[i] then
				break
			end
			hp[i], hp[c] = hp[c], hp[i]
			hn[i], hn[c] = hn[c], hn[i]
			i = c
		end

		if d == dist[v] then -- skip stale (lazily superseded) entries
			local e = head[v]
			while e ~= 0 do
				local to = ev[e]
				local nd = d + ew[e]
				if nd < dist[to] then
					dist[to] = nd
					-- lazy insert + sift up
					hsize = hsize + 1
					hp[hsize], hn[hsize] = nd, to
					local j = hsize
					while j > 1 do
						local p = (j - j % 2) / 2
						if hp[p] <= hp[j] then
							break
						end
						hp[j], hp[p] = hp[p], hp[j]
						hn[j], hn[p] = hn[p], hn[j]
						j = p
					end
				end
				e = enext[e]
			end
		end
	end
	return dist
end

-- Section B: Tarjan SCC with an explicit DFS stack (no recursion)

-- Returns (sccCount, largestSccSize).
local function tarjanSCC(g)
	local n = g.n
	local head, enext, ev = g.head, g.enext, g.ev
	local num = table.create(n, 0) -- discovery index, 0 = unvisited
	local low = table.create(n, 0)
	local cur = table.create(n, 0) -- per-node resume pointer into adjacency
	local onstk = table.create(n, false)
	local sccStack = table.create(n) -- Tarjan's component stack
	local sccTop = 0
	local callStack = table.create(n) -- explicit DFS stack
	local callTop = 0
	local idx = 0
	local sccCount, largest = 0, 0

	for root = 1, n do
		if num[root] == 0 then
			callTop = 1
			callStack[1] = root
			while callTop > 0 do
				local v = callStack[callTop]
				if num[v] == 0 then -- first visit: open the frame
					idx = idx + 1
					num[v], low[v] = idx, idx
					cur[v] = head[v]
					sccTop = sccTop + 1
					sccStack[sccTop] = v
					onstk[v] = true
				end

				-- scan remaining out-edges; descend into the first
				-- unvisited target, folding back-edges into low[v]
				local descend = 0
				local e = cur[v]
				while e ~= 0 do
					local w = ev[e]
					if num[w] == 0 then
						cur[v] = enext[e] -- resume after this edge
						descend = w
						break
					end
					if onstk[w] and num[w] < low[v] then
						low[v] = num[w]
					end
					e = enext[e]
				end

				if descend ~= 0 then
					callTop = callTop + 1
					callStack[callTop] = descend
				else
					-- frame finished: pop, propagate low to parent
					callTop = callTop - 1
					if callTop > 0 then
						local parent = callStack[callTop]
						if low[v] < low[parent] then
							low[parent] = low[v]
						end
					end
					if low[v] == num[v] then -- v is an SCC root
						local size = 0
						while true do
							local w = sccStack[sccTop]
							sccTop = sccTop - 1
							onstk[w] = false
							size = size + 1
							if w == v then
								break
							end
						end
						sccCount = sccCount + 1
						if size > largest then
							largest = size
						end
					end
				end
			end
		end
	end
	return sccCount, largest
end

-- Section C: Kruskal MSF with union-find (compression + rank)

-- Treats edges as undirected.  Returns (totalWeight, edgesTaken).
local function kruskal(g)
	local n, m = g.n, g.m
	local eu, ev, ew = g.eu, g.ev, g.ew

	-- sort edge indices by (weight, index) with a closure comparator
	local order = table.create(m)
	for e = 1, m do
		order[e] = e
	end
	table.sort(order, function(a, b)
		local wa, wb = ew[a], ew[b]
		if wa ~= wb then
			return wa < wb
		end
		return a < b -- deterministic tie-break by edge index
	end)

	local parent = table.create(n)
	local rank = table.create(n, 0)
	for v = 1, n do
		parent[v] = v
	end
	local function find(x)
		local r = x
		while parent[r] ~= r do
			r = parent[r]
		end
		while parent[x] ~= r do -- path compression
			x, parent[x] = parent[x], r
		end
		return r
	end

	local total, taken = 0, 0
	for k = 1, m do
		local e = order[k]
		local ru, rv = find(eu[e]), find(ev[e])
		if ru ~= rv then
			if rank[ru] < rank[rv] then
				ru, rv = rv, ru
			end
			parent[rv] = ru -- union by rank
			if rank[ru] == rank[rv] then
				rank[ru] = rank[ru] + 1
			end
			total = total + ew[e]
			taken = taken + 1
		end
	end
	return total, taken
end

-- Correctness check: tiny hand-built graph, known answers
-- (the classic 6-node Wikipedia Dijkstra graph, made directed, plus a
-- closing edge 5->1 to create one big SCC and an isolated node 7)
do
	local tiny = makeGraph(7, {
		{ 1, 2, 7 },
		{ 1, 3, 9 },
		{ 1, 6, 14 },
		{ 2, 3, 10 },
		{ 2, 4, 15 },
		{ 3, 4, 11 },
		{ 3, 6, 2 },
		{ 4, 5, 6 },
		{ 6, 5, 9 },
		{ 5, 1, 100 },
	})

	local dist = dijkstra(tiny, 1)
	assert(dist[1] == 0 and dist[2] == 7 and dist[3] == 9, "tiny Dijkstra near")
	assert(dist[4] == 20 and dist[5] == 20 and dist[6] == 11, "tiny Dijkstra far")
	assert(dist[7] == math.huge, "node 7 must be unreachable")

	local sccCount, largest = tarjanSCC(tiny)
	assert(sccCount == 2, "tiny graph has 2 SCCs (the 6-cycle + node 7)")
	assert(largest == 6, "largest tiny SCC has 6 nodes")

	local mstW, mstE = kruskal(tiny)
	assert(mstW == 33, "tiny MSF weight is 2+6+7+9+9 = 33")
	assert(mstE == 5, "tiny MSF spans 7 nodes / 2 components = 5 edges")
end

-- Bulk workload: all three algorithms on the big graph
local big = makeBigGraph()

local t0 = os.clock()
local dist = dijkstra(big, 1)
local sccCount, largest = tarjanSCC(big)
local mstW, mstE = kruskal(big)
local elapsed = os.clock() - t0

-- Checksum: fold the result quantities with an FNV-style mixer
local distSum = 0
for v = 1, big.n do
	local d = dist[v]
	if d < math.huge then
		distSum = distSum + d
	end
end
distSum = distSum % 4294967296

local bxor = bit32.bxor
local lshift = bit32.lshift
local function mix(h, x)
	h = bxor(h, x % 4294967296)
	-- 32-bit FNV multiply (x16777619) as shift-adds, exact in doubles
	return (h + lshift(h, 1) + lshift(h, 4) + lshift(h, 7) + lshift(h, 8) + lshift(h, 24)) % 4294967296
end

local checksum = 2166136261
checksum = mix(checksum, distSum)
checksum = mix(checksum, sccCount)
checksum = mix(checksum, largest)
checksum = mix(checksum, mstW)
checksum = mix(checksum, mstE)

assert(checksum == 2800362882, "checksum mismatch")

print(string.format("graphs checksum: %s", tostring(checksum)))
print("main work time", elapsed * 1000)
print("entire script time", (os.clock() - __BENCH_T0__) * 1000)
