local __BENCH_T0__ = os.clock()
local BULK_KB = 192           -- kilobytes encrypted in the bulk run
local PRNG_SEED = 20260611    -- seed for the plaintext generator

-- Cached hot functions
local band, bor, bxor = bit32.band, bit32.bor, bit32.bxor
local lshift, rshift = bit32.lshift, bit32.rshift
local lrotate, rrotate = bit32.lrotate, bit32.rrotate

-- The FIPS-197 S-box (SBOX[i+1] = S(i))
local SBOX = {
  0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76,
  0xca, 0x82, 0xc9, 0x7d, 0xfa, 0x59, 0x47, 0xf0, 0xad, 0xd4, 0xa2, 0xaf, 0x9c, 0xa4, 0x72, 0xc0,
  0xb7, 0xfd, 0x93, 0x26, 0x36, 0x3f, 0xf7, 0xcc, 0x34, 0xa5, 0xe5, 0xf1, 0x71, 0xd8, 0x31, 0x15,
  0x04, 0xc7, 0x23, 0xc3, 0x18, 0x96, 0x05, 0x9a, 0x07, 0x12, 0x80, 0xe2, 0xeb, 0x27, 0xb2, 0x75,
  0x09, 0x83, 0x2c, 0x1a, 0x1b, 0x6e, 0x5a, 0xa0, 0x52, 0x3b, 0xd6, 0xb3, 0x29, 0xe3, 0x2f, 0x84,
  0x53, 0xd1, 0x00, 0xed, 0x20, 0xfc, 0xb1, 0x5b, 0x6a, 0xcb, 0xbe, 0x39, 0x4a, 0x4c, 0x58, 0xcf,
  0xd0, 0xef, 0xaa, 0xfb, 0x43, 0x4d, 0x33, 0x85, 0x45, 0xf9, 0x02, 0x7f, 0x50, 0x3c, 0x9f, 0xa8,
  0x51, 0xa3, 0x40, 0x8f, 0x92, 0x9d, 0x38, 0xf5, 0xbc, 0xb6, 0xda, 0x21, 0x10, 0xff, 0xf3, 0xd2,
  0xcd, 0x0c, 0x13, 0xec, 0x5f, 0x97, 0x44, 0x17, 0xc4, 0xa7, 0x7e, 0x3d, 0x64, 0x5d, 0x19, 0x73,
  0x60, 0x81, 0x4f, 0xdc, 0x22, 0x2a, 0x90, 0x88, 0x46, 0xee, 0xb8, 0x14, 0xde, 0x5e, 0x0b, 0xdb,
  0xe0, 0x32, 0x3a, 0x0a, 0x49, 0x06, 0x24, 0x5c, 0xc2, 0xd3, 0xac, 0x62, 0x91, 0x95, 0xe4, 0x79,
  0xe7, 0xc8, 0x37, 0x6d, 0x8d, 0xd5, 0x4e, 0xa9, 0x6c, 0x56, 0xf4, 0xea, 0x65, 0x7a, 0xae, 0x08,
  0xba, 0x78, 0x25, 0x2e, 0x1c, 0xa6, 0xb4, 0xc6, 0xe8, 0xdd, 0x74, 0x1f, 0x4b, 0xbd, 0x8b, 0x8a,
  0x70, 0x3e, 0xb5, 0x66, 0x48, 0x03, 0xf6, 0x0e, 0x61, 0x35, 0x57, 0xb9, 0x86, 0xc1, 0x1d, 0x9e,
  0xe1, 0xf8, 0x98, 0x11, 0x69, 0xd9, 0x8e, 0x94, 0x9b, 0x1e, 0x87, 0xe9, 0xce, 0x55, 0x28, 0xdf,
  0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42, 0x68, 0x41, 0x99, 0x2d, 0x0f, 0xb0, 0x54, 0xbb, 0x16,
}
assert(#SBOX == 256, "S-box must have 256 entries")

-- Derive the four T-tables at startup.
-- Te0[x] packs (2*S, S, S, 3*S) MSB-first; Te1..Te3 are byte rotations.
local Te0 = table.create(256, 0)
local Te1 = table.create(256, 0)
local Te2 = table.create(256, 0)
local Te3 = table.create(256, 0)

local function xtime(x) -- GF(2^8) multiply by 2, modulo x^8+x^4+x^3+x+1
  x = x * 2
  if x >= 256 then x = bxor(x - 256, 0x1b) end
  return x
end

for i = 0, 255 do
  local s = SBOX[i + 1]
  local s2 = xtime(s)
  local s3 = bxor(s2, s)
  local w = bor(lshift(s2, 24), lshift(s, 16), lshift(s, 8), s3)
  Te0[i + 1] = w
  Te1[i + 1] = rrotate(w, 8)  -- (3S, 2S, S, S)
  Te2[i + 1] = rrotate(w, 16) -- (S, 3S, 2S, S)
  Te3[i + 1] = rrotate(w, 24) -- (S, S, 3S, 2S)
end

-- Key schedule: 16-byte key (as 4 big-endian words) -> 44 round-key words.
local RCON = { 0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36 }

local function expandKey(k0, k1, k2, k3)
  local w = table.create(44, 0)
  w[1], w[2], w[3], w[4] = k0, k1, k2, k3
  for i = 5, 44 do
    local t = w[i - 1]
    if (i - 1) % 4 == 0 then
      -- RotWord then SubWord then XOR rcon into the top byte
      t = lrotate(t, 8)
      t = bor(
        lshift(SBOX[rshift(t, 24) + 1], 24),
        lshift(SBOX[band(rshift(t, 16), 255) + 1], 16),
        lshift(SBOX[band(rshift(t, 8), 255) + 1], 8),
        SBOX[band(t, 255) + 1])
      t = bxor(t, lshift(RCON[(i - 1) / 4], 24))
    end
    w[i] = bxor(w[i - 4], t)
  end
  return w
end

-- Encrypt one block. State lives entirely in locals s0..s3 / u0..u3.
-- rk is the flat 44-word round-key array.
local function encryptBlock(rk, s0, s1, s2, s3)
  -- initial AddRoundKey
  s0 = bxor(s0, rk[1])
  s1 = bxor(s1, rk[2])
  s2 = bxor(s2, rk[3])
  s3 = bxor(s3, rk[4])

  -- 9 full rounds via T-table lookups
  local base = 4
  for _ = 1, 9 do
    local u0 = bxor(
      Te0[rshift(s0, 24) + 1],
      Te1[band(rshift(s1, 16), 255) + 1],
      Te2[band(rshift(s2, 8), 255) + 1],
      Te3[band(s3, 255) + 1], rk[base + 1])
    local u1 = bxor(
      Te0[rshift(s1, 24) + 1],
      Te1[band(rshift(s2, 16), 255) + 1],
      Te2[band(rshift(s3, 8), 255) + 1],
      Te3[band(s0, 255) + 1], rk[base + 2])
    local u2 = bxor(
      Te0[rshift(s2, 24) + 1],
      Te1[band(rshift(s3, 16), 255) + 1],
      Te2[band(rshift(s0, 8), 255) + 1],
      Te3[band(s1, 255) + 1], rk[base + 3])
    local u3 = bxor(
      Te0[rshift(s3, 24) + 1],
      Te1[band(rshift(s0, 16), 255) + 1],
      Te2[band(rshift(s1, 8), 255) + 1],
      Te3[band(s2, 255) + 1], rk[base + 4])
    s0, s1, s2, s3 = u0, u1, u2, u3
    base = base + 4
  end

  -- final round: SubBytes + ShiftRows + AddRoundKey (no MixColumns)
  local t0 = bxor(bor(
    lshift(SBOX[rshift(s0, 24) + 1], 24),
    lshift(SBOX[band(rshift(s1, 16), 255) + 1], 16),
    lshift(SBOX[band(rshift(s2, 8), 255) + 1], 8),
    SBOX[band(s3, 255) + 1]), rk[41])
  local t1 = bxor(bor(
    lshift(SBOX[rshift(s1, 24) + 1], 24),
    lshift(SBOX[band(rshift(s2, 16), 255) + 1], 16),
    lshift(SBOX[band(rshift(s3, 8), 255) + 1], 8),
    SBOX[band(s0, 255) + 1]), rk[42])
  local t2 = bxor(bor(
    lshift(SBOX[rshift(s2, 24) + 1], 24),
    lshift(SBOX[band(rshift(s3, 16), 255) + 1], 16),
    lshift(SBOX[band(rshift(s0, 8), 255) + 1], 8),
    SBOX[band(s1, 255) + 1]), rk[43])
  local t3 = bxor(bor(
    lshift(SBOX[rshift(s3, 24) + 1], 24),
    lshift(SBOX[band(rshift(s0, 16), 255) + 1], 16),
    lshift(SBOX[band(rshift(s1, 8), 255) + 1], 8),
    SBOX[band(s2, 255) + 1]), rk[44])

  return t0, t1, t2, t3
end

-- Correctness check: FIPS-197 Appendix C.1 single-block ECB vector.
-- key       000102030405060708090a0b0c0d0e0f
-- plaintext 00112233445566778899aabbccddeeff
-- cipher    69c4e0d86a7b0430d8cdb78070b4c55a
do
  local rk = expandKey(0x00010203, 0x04050607, 0x08090a0b, 0x0c0d0e0f)
  local c0, c1, c2, c3 = encryptBlock(rk,
    0x00112233, 0x44556677, 0x8899aabb, 0xccddeeff)
  assert(c0 == 0x69c4e0d8 and c1 == 0x6a7b0430 and
         c2 == 0xd8cdb780 and c3 == 0x70b4c55a,
    string.format("FIPS-197 vector FAILED: got %08x %08x %08x %08x",
      c0, c1, c2, c3))
end

-- Bulk workload: CTR-mode encrypt BULK_KB of seeded plaintext.
-- Counter block = fixed 96-bit nonce || 32-bit block counter.
local BLOCKS = BULK_KB * 64 -- 16 bytes per block
local NONCE0, NONCE1, NONCE2 = 0xdeadbeef, 0x01234567, 0x89abcdef
local roundKeys = expandKey(0x2b7e1516, 0x28aed2a6, 0xabf71588, 0x09cf4f3c)

local t0 = os.clock()

local seed = PRNG_SEED
local checksum = 0x811c9dc5
for ctr = 1, BLOCKS do
  -- keystream block: encrypt nonce||counter
  local k0, k1, k2, k3 = encryptBlock(roundKeys, NONCE0, NONCE1, NONCE2, ctr)

  -- four words of seeded plaintext (Park-Miller, exact in doubles)
  seed = seed * 48271 % 2147483647
  local p0 = seed
  seed = seed * 48271 % 2147483647
  local p1 = seed
  seed = seed * 48271 % 2147483647
  local p2 = seed
  seed = seed * 48271 % 2147483647
  local p3 = seed

  -- XOR keystream into plaintext, fold ciphertext into rotate-XOR checksum
  checksum = bxor(lrotate(checksum, 5), bxor(k0, p0))
  checksum = bxor(lrotate(checksum, 5), bxor(k1, p1))
  checksum = bxor(lrotate(checksum, 5), bxor(k2, p2))
  checksum = bxor(lrotate(checksum, 5), bxor(k3, p3))
end

local elapsed = os.clock() - t0

local EXPECTED_CHECKSUM = 0xe8fe84b4 -- discovered once for BULK_KB=192, baked in
assert(checksum == EXPECTED_CHECKSUM,
  string.format("checksum mismatch: got %08x, want %08x",
    checksum, EXPECTED_CHECKSUM))

print(string.format("aes128 checksum: %s", string.format("%08x", checksum)))
print("main work time", elapsed * 1000)
print("entire script time", (os.clock() - __BENCH_T0__) * 1000)
