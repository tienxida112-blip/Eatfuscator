local __BENCH_T0__ = os.clock()
local COEFFS = 4096 -- terms per input polynomial; FFT size is 2*COEFFS
local REPS = 3 -- full polynomial multiplies per run
local SEED = 20260611 -- Park-Miller PRNG seed for the coefficients

-- Hardcoded expected FNV-1a checksum over all rounded product coefficients
-- (discovered by running once with the constants above).
local EXPECTED_CHECKSUM = 331403045

local floor = math.floor
local cos = math.cos
local sin = math.sin
local pi = math.pi
local band = bit32.band
local bor = bit32.bor
local bxor = bit32.bxor
local lshift = bit32.lshift
local rshift = bit32.rshift

-- Park-Miller PRNG: s = s * 48271 % 2147483647 (exact in doubles).
local prngState = SEED
local function nextDigit()
	prngState = prngState * 48271 % 2147483647
	return prngState % 10
end

-- FNV-1a (32-bit) folding one nonnegative 32-bit value per step.
-- The multiply is split 16/16 so it stays exact in doubles.
local function fnvStep(h, v)
	h = bxor(h, v)
	local lo = h % 65536
	local hi = (h - lo) / 65536
	return (lo * 16777619 + (hi * 16777619 % 65536) * 65536) % 4294967296
end

-- FFT machinery

-- Bit-reversal table for size n = 2^bits: rev[i+1] is i with its low
-- `bits` bits reversed (0-based values).
local function makeRevTable(n, bits)
	local rev = table.create(n, 0)
	for i = 0, n - 1 do
		local r = 0
		local x = i
		for _ = 1, bits do
			r = bor(lshift(r, 1), band(x, 1))
			x = rshift(x, 1)
		end
		rev[i + 1] = r
	end
	return rev
end

-- Per-stage twiddle factors for size n: cosT[s][j+1] = cos(2*pi*j/len),
-- sinT[s][j+1] = sin(2*pi*j/len), where len = 2^s and j = 0 .. len/2-1.
local function makeTwiddles(n)
	local cosT, sinT = {}, {}
	local len = 2
	local stage = 1
	while len <= n do
		local half = len / 2
		local cs = table.create(half, 0)
		local sn = table.create(half, 0)
		local step = 2 * pi / len
		for j = 0, half - 1 do
			cs[j + 1] = cos(step * j)
			sn[j + 1] = sin(step * j)
		end
		cosT[stage] = cs
		sinT[stage] = sn
		len = len * 2
		stage = stage + 1
	end
	return cosT, sinT
end

-- In-place FFT of (re, im), length n. sign = -1 for forward, +1 for
-- inverse (inverse also scales by 1/n). rev/cosT/sinT must match n.
local function fft(re, im, n, rev, cosT, sinT, sign)
	-- Bit-reversal permutation.
	for i = 0, n - 1 do
		local j = rev[i + 1]
		if i < j then
			local i1, j1 = i + 1, j + 1
			re[i1], re[j1] = re[j1], re[i1]
			im[i1], im[j1] = im[j1], im[i1]
		end
	end

	-- Butterfly stages with increasing span.
	local len = 2
	local stage = 1
	while len <= n do
		local half = len / 2
		local cs = cosT[stage]
		local sn = sinT[stage]
		for base = 0, n - 1, len do
			for j = 0, half - 1 do
				local wr = cs[j + 1]
				local wi = sign * sn[j + 1]
				local a = base + j + 1
				local b = a + half
				local yr, yi = re[b], im[b]
				local tr = yr * wr - yi * wi
				local ti = yr * wi + yi * wr
				local xr, xi = re[a], im[a]
				re[a] = xr + tr
				im[a] = xi + ti
				re[b] = xr - tr
				im[b] = xi - ti
			end
		end
		len = len * 2
		stage = stage + 1
	end

	if sign > 0 then
		local inv = 1 / n
		for i = 1, n do
			re[i] = re[i] * inv
			im[i] = im[i] * inv
		end
	end
end

-- Multiply polynomials a (na terms) and b (nb terms) via FFT; writes the
-- na+nb-1 rounded integer product coefficients into out and returns it.
-- Scratch arrays are caller-provided so the hot path never allocates.
local function fftPolyMul(a, na, b, nb, n, rev, cosT, sinT, are, aim, bre, bim, out)
	for i = 1, n do
		are[i] = if i <= na then a[i] else 0
		aim[i] = 0
		bre[i] = if i <= nb then b[i] else 0
		bim[i] = 0
	end
	fft(are, aim, n, rev, cosT, sinT, -1)
	fft(bre, bim, n, rev, cosT, sinT, -1)
	for i = 1, n do
		local xr, xi = are[i], aim[i]
		local yr, yi = bre[i], bim[i]
		are[i] = xr * yr - xi * yi
		aim[i] = xr * yi + xi * yr
	end
	fft(are, aim, n, rev, cosT, sinT, 1)
	for i = 1, na + nb - 1 do
		out[i] = floor(are[i] + 0.5) -- quantize: products are exact integers
	end
	return out
end

-- Correctness check: degree-7 polynomials, FFT product must match
-- the direct O(n^2) convolution exactly.
do
	local na, nb = 8, 8
	local a, b = table.create(na, 0), table.create(nb, 0)
	for i = 1, na do
		a[i] = nextDigit()
	end
	for i = 1, nb do
		b[i] = nextDigit()
	end

	-- Direct convolution reference.
	local ref = table.create(na + nb - 1, 0)
	for i = 1, na do
		for j = 1, nb do
			local k = i + j - 1
			ref[k] = ref[k] + a[i] * b[j]
		end
	end

	local n, bits = 16, 4
	local rev = makeRevTable(n, bits)
	local cosT, sinT = makeTwiddles(n)
	local got = fftPolyMul(
		a, na, b, nb, n, rev, cosT, sinT,
		table.create(n, 0), table.create(n, 0),
		table.create(n, 0), table.create(n, 0),
		table.create(na + nb - 1, 0)
	)
	for k = 1, na + nb - 1 do
		assert(got[k] == ref[k], "small product mismatch at term " .. k)
	end
end

-- Bulk workload: large polynomial multiply, REPS times.
local N = 2 * COEFFS -- FFT size (power of two, holds the full product)
local BITS = math.log(N, 2)
assert(N == 2 ^ BITS and BITS % 1 == 0, "COEFFS must be a power of two")

-- Deterministic inputs and preallocated scratch.
local polyA, polyB = table.create(COEFFS, 0), table.create(COEFFS, 0)
for i = 1, COEFFS do
	polyA[i] = nextDigit()
end
for i = 1, COEFFS do
	polyB[i] = nextDigit()
end
local revN = makeRevTable(N, BITS)
local cosN, sinN = makeTwiddles(N)
local sAre, sAim = table.create(N, 0), table.create(N, 0)
local sBre, sBim = table.create(N, 0), table.create(N, 0)
local product = table.create(2 * COEFFS - 1, 0)

local checksum = 2166136261 -- FNV-1a offset basis

local t0 = os.clock()
for _ = 1, REPS do
	fftPolyMul(polyA, COEFFS, polyB, COEFFS, N, revN, cosN, sinN, sAre, sAim, sBre, sBim, product)
	for i = 1, 2 * COEFFS - 1 do
		checksum = fnvStep(checksum, product[i])
	end
end
local elapsed = os.clock() - t0

assert(
	checksum == EXPECTED_CHECKSUM,
	"checksum expected " .. EXPECTED_CHECKSUM .. ", got " .. checksum
)

print(string.format("fft checksum: %s", tostring(checksum)))
print("main work time", elapsed * 1000)
print("entire script time", (os.clock() - __BENCH_T0__) * 1000)
