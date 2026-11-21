local __BENCH_T0__ = os.clock()
local W, H = 128, 128
local GENS = 32
local DENSITY = 350 -- per 1000
local SEED = 12345

local EXPECTED_CHECKSUM = 669876783

-- Seeded PRNG (Park-Miller minimal standard)
local prng_state = SEED
local function prng()
	prng_state = prng_state * 48271 % 2147483647
	return prng_state
end

-- Grid helpers (generic over width/height so the checks can use
-- small boards with the exact same stepping code as the bulk run)

-- Precompute wrapped left/right column indices for a given width.
local function makeWrap(w)
	local left = table.create(w)
	local right = table.create(w)
	for x = 1, w do
		left[x] = (x == 1) and w or (x - 1)
		right[x] = (x == w) and 1 or (x + 1)
	end
	return left, right
end

-- Advance `cur` one generation into `nxt`. Flat arrays, indices 1..w*h.
local function step(cur, nxt, w, h, left, right)
	for y = 0, h - 1 do
		local row = y * w
		local up = (y == 0 and h - 1 or y - 1) * w
		local down = (y == h - 1 and 0 or y + 1) * w
		for x = 1, w do
			local l = left[x]
			local r = right[x]
			local n = cur[up + l] + cur[up + x] + cur[up + r]
				+ cur[row + l] + cur[row + r]
				+ cur[down + l] + cur[down + x] + cur[down + r]
			if n == 3 then
				nxt[row + x] = 1
			elseif n == 2 then
				nxt[row + x] = cur[row + x]
			else
				nxt[row + x] = 0
			end
		end
	end
end

local function newGrid(w, h)
	return table.create(w * h, 0)
end

-- Stamp a pattern (list of {x, y} 0-based offsets) onto a grid.
local function stamp(grid, w, ox, oy, cells)
	for _, c in ipairs(cells) do
		grid[(oy + c[2]) * w + (ox + c[1]) + 1] = 1
	end
end

local function liveCount(grid, n)
	local s = 0
	for i = 1, n do
		s += grid[i]
	end
	return s
end

-- Patterns (0-based offsets)
local BLINKER = { { 0, 0 }, { 1, 0 }, { 2, 0 } } -- horizontal bar
local GLIDER = { { 1, 0 }, { 2, 1 }, { 0, 2 }, { 1, 2 }, { 2, 2 } }

-- Correctness checks

-- 1) Blinker on a 5x5 torus oscillates with period 2: generation 2 must
--    equal generation 0, and generation 1 must differ.
do
	local w, h = 5, 5
	local left, right = makeWrap(w)
	local g0 = newGrid(w, h)
	stamp(g0, w, 1, 2, BLINKER)
	local a = table.clone(g0)
	local b = newGrid(w, h)
	step(a, b, w, h, left, right) -- gen 1 in b
	local differs = false
	for i = 1, w * h do
		if b[i] ~= g0[i] then
			differs = true
			break
		end
	end
	assert(differs, "blinker: generation 1 should differ from generation 0")
	assert(liveCount(b, w * h) == 3, "blinker: population must stay 3")
	step(b, a, w, h, left, right) -- gen 2 in a
	for i = 1, w * h do
		assert(a[i] == g0[i], "blinker: generation 2 must equal generation 0")
	end
end

-- 2) Glider on an 8x8 torus: after 4 generations the glider is an exact
--    copy of itself translated by (+1, +1), with population 5 throughout.
do
	local w, h = 8, 8
	local left, right = makeWrap(w)
	local g0 = newGrid(w, h)
	stamp(g0, w, 1, 1, GLIDER)
	local a = table.clone(g0)
	local b = newGrid(w, h)
	for gen = 1, 4 do
		step(a, b, w, h, left, right)
		a, b = b, a
		assert(liveCount(a, w * h) == 5, "glider: population must stay 5 at gen " .. gen)
	end
	-- a now holds generation 4; compare against g0 translated by (1, 1)
	for y = 0, h - 1 do
		for x = 1, w do
			local tx = (x % w) + 1 -- x+1 wrapped (1-based)
			local ty = (y + 1) % h
			assert(
				a[ty * w + tx] == g0[y * w + x],
				"glider: gen 4 must equal gen 0 translated by (+1,+1)"
			)
		end
	end
end

-- Bulk setup: PRNG soup + injected known patterns
local cur = newGrid(W, H)
local nxt = newGrid(W, H)
for i = 1, W * H do
	cur[i] = (prng() % 1000) < DENSITY and 1 or 0
end

-- Clear two small windows and inject a glider and a blinker so known
-- structure is present in the soup.
for y = 0, 4 do
	for x = 1, 5 do
		cur[(2 + y) * W + (2 + x)] = 0
		cur[(60 + y) * W + (60 + x)] = 0
	end
end
stamp(cur, W, 3, 3, GLIDER)
stamp(cur, W, 61, 62, BLINKER)

local leftW, rightW = makeWrap(W)

-- Bulk workload
local t0 = os.clock()
for _ = 1, GENS do
	step(cur, nxt, W, H, leftW, rightW)
	cur, nxt = nxt, cur
end
local elapsed = os.clock() - t0

-- Checksum: live count + positional hash (sum of live-cell indices),
-- folded together mod 2^32 and compared against a baked-in expectation.
local live = 0
local posSum = 0
for i = 1, W * H do
	if cur[i] == 1 then
		live += 1
		posSum += i
	end
end
local checksum = (posSum % 4294967296) * 31 % 4294967296
checksum = (checksum + live) % 4294967296

assert(
	checksum == EXPECTED_CHECKSUM,
	string.format("life: checksum mismatch (got %d, live=%d, posSum=%d)", checksum, live, posSum)
)

print(string.format("life checksum: %s", tostring(checksum)))
print("main work time", elapsed * 1000)
print("entire script time", (os.clock() - __BENCH_T0__) * 1000)
