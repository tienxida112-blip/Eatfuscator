local __BENCH_T0__ = os.clock()
local NUM_BASES = 11 -- Fermat bases tested in the bulk run

-- Library: base-2^24 limbs, little-endian arrays
local B = 16777216  -- 2^24
local HALF_B = 8388608 -- 2^23, normalization threshold for division
local floor = math.floor

-- POW2[k+1] = 2^k, used for bit extraction in modexp
local POW2 = table.create(24)
do
  local v = 1
  for k = 0, 23 do
    POW2[k + 1] = v
    v = v * 2
  end
end

local Big = {}

-- strip high zero limbs (always keep at least one limb)
function Big.trim(a)
  local n = #a
  while n > 1 and a[n] == 0 do
    a[n] = nil
    n = n - 1
  end
  return a
end

function Big.copy(a)
  local r = table.create(#a)
  for i = 1, #a do r[i] = a[i] end
  return r
end

-- build from a non-negative Lua integer (must be < 2^53)
function Big.fromNumber(n)
  local r = {}
  repeat
    local lo = n % B
    r[#r + 1] = lo
    n = (n - lo) / B
  until n == 0
  return r
end

-- compare trimmed numbers: -1, 0, or 1
function Big.cmp(a, b)
  local na, nb = #a, #b
  if na ~= nb then
    return (na < nb) and -1 or 1
  end
  for i = na, 1, -1 do
    if a[i] ~= b[i] then
      return (a[i] < b[i]) and -1 or 1
    end
  end
  return 0
end

function Big.add(a, b)
  local na, nb = #a, #b
  local n = (na > nb) and na or nb
  local r = table.create(n + 1)
  local carry = 0
  for i = 1, n do
    local s = (a[i] or 0) + (b[i] or 0) + carry
    if s >= B then
      r[i] = s - B
      carry = 1
    else
      r[i] = s
      carry = 0
    end
  end
  if carry == 1 then r[n + 1] = 1 end
  return r
end

-- a - b, requires a >= b
function Big.sub(a, b)
  local na = #a
  local r = table.create(na)
  local borrow = 0
  for i = 1, na do
    local s = a[i] - (b[i] or 0) - borrow
    if s < 0 then
      r[i] = s + B
      borrow = 1
    else
      r[i] = s
      borrow = 0
    end
  end
  assert(borrow == 0, "Big.sub underflow: a < b")
  return Big.trim(r)
end

-- schoolbook multiplication, row-wise with immediate carry propagation
function Big.mul(a, b)
  local na, nb = #a, #b
  local r = table.create(na + nb, 0)
  for i = 1, na do
    local ai = a[i]
    if ai == 0 then continue end
    local carry = 0
    local k = i - 1
    for j = 1, nb do
      local t = r[k + j] + ai * b[j] + carry -- < 2^48 + 2^24 + 2^24, exact
      local lo = t % B
      r[k + j] = lo
      carry = (t - lo) / B
    end
    r[i + nb] = carry -- position untouched so far, carry < B
  end
  return Big.trim(r)
end

-- dedicated squaring: cross terms doubled, roughly half the limb products
function Big.sqr(a)
  local n = #a
  local r = table.create(2 * n, 0)
  for i = 1, n do
    local ai = a[i]
    local d = r[2 * i - 1] + ai * ai
    local lo = d % B
    r[2 * i - 1] = lo
    local carry = (d - lo) / B
    local k = i - 1
    for j = i + 1, n do
      -- t < 2^24 + 2*2^48 + 2^26, still exact in a double
      local t = r[k + j] + 2 * ai * a[j] + carry
      lo = t % B
      r[k + j] = lo
      carry = (t - lo) / B
    end
    local p = i + n
    while carry > 0 do
      local t = r[p] + carry
      lo = t % B
      r[p] = lo
      carry = (t - lo) / B
      p = p + 1
    end
  end
  return Big.trim(r)
end

-- divide by a small scalar d (1 < d < 2^24); returns quotient, remainder
function Big.divmodSmall(a, d)
  local n = #a
  local q = table.create(n)
  local r = 0
  for i = n, 1, -1 do
    local cur = r * B + a[i] -- r < d < 2^24, so cur < 2^48, exact
    local qi = floor(cur / d)
    q[i] = qi
    r = cur - qi * d
  end
  return Big.trim(q), r
end

-- shift left by s bits (0 <= s < 24)
local function shlBits(a, s)
  if s == 0 then return Big.copy(a) end
  local m = POW2[s + 1]
  local r = table.create(#a + 1)
  local carry = 0
  for i = 1, #a do
    local t = a[i] * m + carry -- < 2^47 + 2^24, exact
    local lo = t % B
    r[i] = lo
    carry = (t - lo) / B
  end
  r[#a + 1] = carry
  return r -- caller trims if needed
end

-- full division: Knuth Algorithm D. Returns quotient, remainder.
function Big.divmod(u, v)
  local n = #v
  assert(n >= 1 and (n > 1 or v[1] ~= 0), "division by zero")
  if n == 1 then
    local q, r = Big.divmodSmall(u, v[1])
    return q, { r }
  end
  if Big.cmp(u, v) < 0 then
    return { 0 }, Big.copy(u)
  end

  -- D1: normalize so the top divisor limb has its high bit set
  local s = 0
  local vt = v[n]
  while vt < HALF_B do
    vt = vt * 2
    s = s + 1
  end
  local un = shlBits(u, s) -- #u + 1 limbs (top may be zero -- required slot)
  local vn = Big.trim(shlBits(v, s)) -- still n limbs, vn[n] >= 2^23
  local m = #u - n
  local vhi, vlo = vn[n], vn[n - 1]
  local q = table.create(m + 1, 0)

  for j = m, 0, -1 do
    -- D3: estimate quotient digit from the top two dividend limbs
    local top2 = un[j + n + 1] * B + un[j + n] -- < 2^48, exact
    local qhat = floor(top2 / vhi)
    if qhat >= B then qhat = B - 1 end -- clamp (Knuth: u[j+n]==v[n] case)
    local rhat = top2 - qhat * vhi
    while rhat < B and qhat * vlo > rhat * B + un[j + n - 1] do
      qhat = qhat - 1
      rhat = rhat + vhi
    end

    -- D4: multiply and subtract qhat * vn from un[j+1 .. j+n+1].
    -- The running borrow (<= B) is folded into the product before the
    -- split, keeping every value exact and each digit fix-up a single +B.
    local borrow = 0
    for i = 1, n do
      local p = qhat * vn[i] + borrow -- < 2^48 + 2^24, exact
      local plo = p % B
      local phi = (p - plo) / B -- <= B - 1
      local t = un[i + j] - plo
      if t < 0 then
        t = t + B
        borrow = phi + 1
      else
        borrow = phi
      end
      un[i + j] = t
    end
    local top = un[j + n + 1] - borrow

    -- D5/D6: qhat was one too big -- add the divisor back (rare)
    if top < 0 then
      qhat = qhat - 1
      local carry = 0
      for i = 1, n do
        local t = un[i + j] + vn[i] + carry
        if t >= B then
          un[i + j] = t - B
          carry = 1
        else
          un[i + j] = t
          carry = 0
        end
      end
      un[j + n + 1] = top + carry -- always 0
    else
      un[j + n + 1] = top
    end
    q[j + 1] = qhat
  end

  -- D8: denormalize the remainder (un[1..n] >> s)
  local r = table.create(n)
  if s == 0 then
    for i = 1, n do r[i] = un[i] end
  else
    local m2 = POW2[s + 1]
    local carry = 0
    for i = n, 1, -1 do
      local cur = carry * B + un[i] -- carry < 2^s, cur < 2^47, exact
      local ri = floor(cur / m2)
      r[i] = ri
      carry = cur - ri * m2
    end
  end
  return Big.trim(q), Big.trim(r)
end

-- a^e mod m via left-to-right square-and-multiply.
-- cs (a running checksum) is folded with the low limb of every intermediate
-- residue; returns result, updated checksum.
function Big.modexp(a, e, m, cs)
  local _, base = Big.divmod(a, m)
  local r = { 1 }
  local divmod, sqr, mul = Big.divmod, Big.sqr, Big.mul

  -- locate the most significant bit of the exponent
  local L = #e
  local topbits = 0
  local t = e[L]
  while t > 0 do
    t = floor(t / 2)
    topbits = topbits + 1
  end
  assert(topbits > 0, "modexp: zero exponent unsupported here")

  for i = L, 1, -1 do
    local limb = e[i]
    local startBit = (i == L) and (topbits - 1) or 23
    for bit = startBit, 0, -1 do
      _, r = divmod(sqr(r), m)
      if floor(limb / POW2[bit + 1]) % 2 == 1 then
        _, r = divmod(mul(r, base), m)
      end
      cs = (cs * 31 + r[1] + #r) % 2147483647 -- < 2^36 + 2^24, exact
    end
  end
  return r, cs
end

-- decimal string conversion via repeated division by 10^7
function Big.toDecimal(a)
  local chunks = {}
  local cur = Big.copy(a)
  repeat
    local q, r = Big.divmodSmall(cur, 10000000)
    chunks[#chunks + 1] = r
    cur = q
  until #cur == 1 and cur[1] == 0
  local parts = { tostring(chunks[#chunks]) }
  for i = #chunks - 1, 1, -1 do
    parts[#parts + 1] = string.format("%07d", chunks[i])
  end
  return table.concat(parts)
end

-- Correctness checks (fail loudly)
do
  -- 2^100 -> known decimal expansion. 100 = 4*24 + 4, so limb 5 holds 2^4.
  local p100 = { 0, 0, 0, 0, 16 }
  assert(Big.toDecimal(p100) == "1267650600228229401496703205376",
    "2^100 decimal conversion FAILED: got " .. Big.toDecimal(p100))

  -- add/sub round trip on multi-limb values with carries across every limb
  local x = { 16777215, 16777215, 16777215, 12345 } -- forces full carry chain
  local y = { 1, 16777215, 7, 999 }
  local z = Big.add(x, y)
  assert(Big.cmp(Big.sub(z, y), x) == 0, "add/sub round trip FAILED")
  assert(Big.cmp(Big.sub(z, x), Big.trim(y)) == 0, "add/sub round trip FAILED")

  -- squaring must agree with general multiplication
  local sq = Big.sqr(x)
  assert(Big.cmp(sq, Big.mul(x, x)) == 0, "sqr vs mul mismatch")

  -- 2^50+1 squared = 2^100 + 2^51 + 1; 50 = 2*24+2 -> limb 3 holds 4
  local t = { 1, 0, 4 }
  local expect = Big.add(Big.add(p100, { 0, 0, 8 }), { 1 }) -- 2^51: limb3 = 8
  assert(Big.cmp(Big.sqr(t), expect) == 0, "(2^50+1)^2 FAILED")

  -- Knuth division: u = 2^100 + 999999, v = 2^40 + 12345 (multi-limb divisor)
  local u = { 999999, 0, 0, 0, 16 }
  local v = { 12345, 65536 } -- 2^40 = 2^16 * 2^24
  local q, r = Big.divmod(u, v)
  assert(Big.cmp(r, v) < 0, "divmod: remainder >= divisor")
  assert(Big.cmp(Big.add(Big.mul(q, v), r), u) == 0,
    "divmod: q*v + r ~= u")

  -- modexp: 3^200 mod 1000003 = 333986 (precomputed independently)
  local me, _ = Big.modexp({ 3 }, { 200 }, { 1000003 }, 0)
  assert(#me == 1 and me[1] == 333986,
    "modexp 3^200 mod 1000003 FAILED: got " .. tostring(me[1]))
end

-- Bulk workload: Fermat check a^(p-1) mod p == 1 for the secp256k1
-- field prime p = 2^256 - 2^32 - 977 (limbs hardcoded, little-endian 2^24).
-- p hex: FFFFFFFF FFFFFFFF FFFFFFFF FFFFFFFF FFFFFFFF FFFFFFFF FFFFFFFE FFFFFC2F
-- 24-bit limbs from the low end: FFFC2F, FFFEFF, then 8 x FFFFFF, top FFFF.
local P = {
  16776239, 16776959, 16777215, 16777215, 16777215, 16777215,
  16777215, 16777215, 16777215, 16777215, 65535,
}
local P_MINUS_1 = {
  16776238, 16776959, 16777215, 16777215, 16777215, 16777215,
  16777215, 16777215, 16777215, 16777215, 65535,
}
local BASES = {
  2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53,
  59, 61, 67, 71, 73, 79, 83, 89, 97, 101, 103, 107, 109, 113, 127, 131,
}

-- sanity check on the hardcoded prime: 2^256 mod p = 2^32 + 977
do
  local two256 = { 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 65536 }
  local q, r = Big.divmod(two256, P)
  assert(Big.cmp(q, { 1 }) == 0 and Big.cmp(r, { 977, 256 }) == 0,
    "2^256 mod p sanity check FAILED")
  local me = Big.modexp({ 2 }, { 256 }, P, 0)
  assert(Big.cmp(me, { 977, 256 }) == 0, "modexp 2^256 mod p FAILED")
end

local t0 = os.clock()

local checksum = 0
for i = 1, NUM_BASES do
  local r, cs = Big.modexp({ BASES[i] }, P_MINUS_1, P, checksum)
  assert(#r == 1 and r[1] == 1,
    string.format("Fermat check FAILED for base %d (p not prime?!)", BASES[i]))
  checksum = (cs * 31 + BASES[i]) % 2147483647
end

local elapsed = os.clock() - t0

local EXPECTED_CHECKSUM = 528505362 -- discovered once for NUM_BASES=11, baked in
assert(checksum == EXPECTED_CHECKSUM,
  string.format("checksum mismatch: got %d, want %d",
    checksum, EXPECTED_CHECKSUM))

print(string.format("bignum checksum: %s", tostring(checksum)))
print("main work time", elapsed * 1000)
print("entire script time", (os.clock() - __BENCH_T0__) * 1000)
