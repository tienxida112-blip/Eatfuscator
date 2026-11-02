--[[ Eatfuscator bytecode interpreter

  The payload never exists as Lua text at run time. It is compiled to our own
  register instruction set and interpreted here, so no host loader
  (loadstring / load / compiler) is involved at any point.

  Values supplied by the surrounding runtime (all already aliased locals):
    al_p2      powers of two (1,2,4,...)   al_byte   string.byte
    al_sub     string.sub                  al_floor  math.floor
    al_unpack  table.unpack | unpack       al_select select
    al_tonum   tonumber                    al_env    environment table
    al_type    type                        al_next   next

  Proto layout: 1 code  2 consts  3 numparams  4 isvararg  5 upvals  6 children
]]

local T_ONE = al_p2[1]
local T_TWO = T_ONE + T_ONE
local T_THREE = T_TWO + T_ONE
local T_FOUR = T_TWO + T_TWO
local T_ZERO = T_ONE - T_ONE
local T_B8 = al_p2[9]
local T_B16 = al_p2[17]
local T_B24 = al_p2[25]
local T_BIAS = al_p2[16]
local T_CELL = T_ONE
local T_CODE, T_KONST, T_NP = T_ONE, T_TWO, T_THREE
local T_VA, T_UV, T_CHILD = T_FOUR, T_FOUR + T_ONE, T_FOUR + T_TWO
local T_NIL, T_FALSE, T_TRUE, T_NUM = T_ONE, T_TWO, T_THREE, T_FOUR
local T_TABLE = al_type(al_env) -- "table" without spelling it out

-- image ciphers ------------------------------------------------------------
-- Every instruction word left the compiler as (w * m + s) mod 2^32, with m
-- odd and both halves drawn from the build's instruction key. The artifact
-- carries m's inverse and the key; s is derived here, so no slot in the bank
-- spells out the full mapping. Words are un-mapped once, while the image is
-- being read, never in the dispatch loop.
-- 2^32 has to be computed in floating point: hosts whose integers are 32 bits
-- wide (fengari) wrap 65536*65536 to zero, and a modulo by zero would turn the
-- whole word cipher into NaN instead of erroring where it could be seen
local T_F1 = T_ONE / T_ONE
local T_B32 = (T_B16 * T_F1) * (T_B16 * T_F1)
local T_IADD = (al_ik2 * 40503 + 12345) % T_B32
local T_IMUL = al_iminv
local T_SKEY = al_isk
local T_SMULT = al_smult -- this build's Lehmer multiplier
local T_PRIME = 2147483647

local function vm_mul32(a, b)
  local lo = a % T_B16
  local hi = (a - lo) / T_B16
  return ((lo % T_B32) * b % T_B32 + ((hi * b) % T_B16) * T_B16) % T_B32
end

local function vm_plain(w)
  return vm_mul32(((w - T_IADD) % T_B32 + T_B32) % T_B32, T_IMUL)
end

-- constant strings travel offset by a Lehmer keystream seeded from the
-- string key, the prototype index, the constant index and the round. The pass
-- count is drawn per constant, so two literals in the same function do not
-- even take the same number of passes
local function vm_plainstr(s, pi, ci)
  local n = #s
  local bytes, parts = {}, {}
  local i = T_ONE
  while i <= n do
    bytes[i] = al_byte(s, i)
    i = i + T_ONE
  end
  local rounds = T_ONE + (T_SKEY * 65521 + pi * 4093 + ci * 97) % T_THREE
  local r = T_ONE
  while r <= rounds do
    local seed = (T_SKEY * 65537 + pi * 7919 + ci * 104729 + r * 15485863) % T_PRIME
    if seed == T_ZERO then seed = 12345 end
    i = T_ONE
    while i <= n do
      seed = (seed * T_SMULT) % T_PRIME
      bytes[i] = (bytes[i] + seed % 256) % 256
      i = i + T_ONE
    end
    r = r + T_ONE
  end
  i = T_ONE
  while i <= n do
    parts[i] = al_char(bytes[i])
    i = i + T_ONE
  end
  return al_concat(parts)
end

-- Hosts that freeze the globals table for indexed writes (modern Luau does)
-- still hand out a writable environment through getfenv; prefer it so that a
-- payload assigning a global behaves like it does in source form.
local T_ENV = al_env
if al_getfenv ~= nil then
  local writable = al_getfenv(0)
  if al_type(writable) == T_TABLE then
    -- only trust it when it really is this host's global table: probe the one
    -- entry every environment carries and a stand-in table does not. Indexed,
    -- because a host environment answers through a metatable, not `next`
    if writable[al_typekey] == al_type then
      T_ENV = writable
    end
  end
end

-- helpers for the register machine

local vm_invoke

local function vm_box(v)
  return {[T_CELL] = v}
end

local function vm_closure(proto, ups)
  return function(...)
    return vm_invoke(proto, ups, ...)
  end
end

-- A call can return trailing nils, and `#` on a table with holes cannot count
-- them: `{f()}` of `function() return 1, nil end` looks like one value. The
-- count is taken from select("#", ...) at the call site instead, so a host
-- function returning (nil) or (1, nil) is forwarded exactly as Lua would.
local function vm_packn(...)
  local t = {...}
  t[T_ZERO] = al_select("#", ...)
  return t
end

local function vm_nextfn(t, k)
  return al_next(t, k)
end

-- mixed-radix (factoradic) permutation decoder — the exact twin of
-- Image/perm.js:decode. Two bank slots carry one code each: the order the seven
-- image header fields were written in, and which tag byte means which constant
-- type. Both are decided per build, so a reader that guesses either one reads
-- the image wrong instead of reading it.
local function vm_perm(code, n)
  local digits = {}
  local c = code
  local i = n
  while i >= T_ONE do
    local radix = n - i + T_ONE
    digits[i] = c % radix
    c = (c - digits[i]) / radix
    i = i - T_ONE
  end
  local out, used = {}, {}
  i = T_ONE
  while i <= n do
    local want = digits[i] + T_ONE
    local seen, pick = T_ZERO, T_ZERO
    local j = T_ZERO
    while j < n do
      j = j + T_ONE
      if used[j] ~= true then
        seen = seen + T_ONE
        if seen == want then pick = j end
      end
    end
    used[pick] = true
    out[i] = pick - T_ONE
    i = i + T_ONE
  end
  return out
end

local function vm_image(img)
  local pos = T_ONE
  local u8 = function()
    local v = al_byte(img, pos)
    pos = pos + T_ONE
    return v
  end
  local u16 = function()
    local lo, hi = al_byte(img, pos, pos + T_ONE)
    pos = pos + T_TWO
    return lo + hi * T_B8
  end
  local u32 = function()
    local a, b, c, d = al_byte(img, pos, pos + T_THREE)
    pos = pos + T_FOUR
    return a + b * T_B8 + c * T_B16 + d * T_B24
  end

  -- the build's image layout, straight out of the constant bank
  local forder = vm_perm(al_bank[0x1F], 7)
  local torder = vm_perm(al_bank[0x20], 5)
  local ttype = {}
  local t = T_ONE
  while t <= 5 do
    ttype[torder[t] + T_ONE] = t
    t = t + T_ONE
  end

  local total = u16()
  local protos = {}
  local i = T_ONE
  while i <= total do
    protos[i] = {}
    i = i + T_ONE
  end

  i = T_ONE
  while i <= total do
    local pr = protos[i]
    local field = {}
    local h = T_ONE
    while h <= 7 do
      local f = forder[h] + T_ONE
      if f <= T_FOUR then
        field[f] = u8()
      else
        field[f] = u16()
      end
      h = h + T_ONE
    end
    pr[T_NP] = field[T_ONE]
    pr[T_VA] = field[T_TWO]
    local nup = field[T_THREE]
    local ncode = field[T_FOUR + T_ONE]
    local nk = field[T_FOUR + T_TWO]
    local nchild = field[T_FOUR + T_THREE]

    local code = {}
    local j = T_ONE
    while j <= ncode do
      code[j] = vm_plain(u32())
      j = j + T_ONE
    end
    pr[T_CODE] = code

    -- constants are read in the clear *except* strings, which are not
    -- decrypted here at all: each one leaves a ciphertext slice behind and the
    -- plaintext only exists from the moment the prototype actually reads that
    -- slot. A dumped image therefore holds no readable literal it was not
    -- already running with, and a literal that is never reached is never
    -- decrypted in the process at all.
    local ks, lazy = {}, {}
    local pi = i
    j = T_ONE
    while j <= nk do
      local kind = ttype[u8()]
      if kind == T_FOUR then
        -- a number: its decimal spelling was enciphered like any string, so the
        -- digits exist only between this read and the tonum call
        local len = u16()
        ks[j] = al_tonum(vm_plainstr(al_sub(img, pos, pos + len - T_ONE), i, j))
        pos = pos + len
      elseif kind == T_THREE then
        ks[j] = true
      elseif kind == T_TWO then
        ks[j] = false
      elseif kind == T_ONE then
        ks[j] = nil
      else
        local len = u16()
        lazy[j] = al_sub(img, pos, pos + len - T_ONE)
        pos = pos + len
      end
      j = j + T_ONE
    end
    if al_next(lazy) ~= nil then
      -- one metatable per prototype, closed over its own index: the closure is
      -- created inside this loop, so the index is captured by value here
      al_setmeta(ks, {[al_index] = function(t, key)
        local raw = lazy[key]
        if raw == nil then return nil end
        lazy[key] = nil
        local plain = vm_plainstr(raw, pi, key)
        t[key] = plain
        return plain
      end})
    end
    pr[T_KONST] = ks

    local ups = {}
    j = T_ONE
    while j <= nup do
      ups[j] = {u8(), u8()}
      j = j + T_ONE
    end
    pr[T_UV] = ups

    local kids = {}
    j = T_ONE
    while j <= nchild do
      kids[j] = u16() + T_ONE
      j = j + T_ONE
    end
    pr[T_CHILD] = kids

    i = i + T_ONE
  end

  i = T_ONE
  while i <= total do
    local kids = protos[i][T_CHILD]
    local j = T_ONE
    while j <= #kids do
      kids[j] = protos[kids[j]]
      j = j + T_ONE
    end
    i = i + T_ONE
  end

  return protos[T_ONE]
end

local function vm_upvals(proto, ups, reg)
  local desc = proto[T_UV]
  local out = {}
  local j = T_ONE
  while j <= #desc do
    local d = desc[j]
    local kind = d[T_ONE]
    if kind == T_ONE then
      out[j] = reg[d[T_TWO]]
    elseif kind == T_TWO then
      out[j] = ups[d[T_TWO] + T_ONE]
    elseif kind == T_THREE then
      -- read-only capture: the closure keeps a copy, no shared cell
      out[j] = reg[d[T_TWO]]
    else
      out[j] = ups[d[T_TWO] + T_ONE]
    end
    j = j + T_ONE
  end
  return out
end

vm_invoke = function(proto, ups, ...)
  local code = proto[T_CODE]
  local konst = proto[T_KONST]
  local reg = {}
  local nargs = al_select("#", ...)
  local i = T_ONE
  while i <= nargs do
    reg[i] = al_select(i, ...)
    i = i + T_ONE
  end

  local vargs = nil
  local nvargs = T_ZERO
  if proto[T_VA] ~= T_ZERO then
    vargs = {}
    local n = T_ZERO
    i = proto[T_NP] + T_ONE
    while i <= nargs do
      n = n + T_ONE
      vargs[n] = al_select(i, ...)
      i = i + T_ONE
    end
    nvargs = n
  end

  local pc = T_ONE
  local top = T_ZERO

  while true do
    local ins = code[pc]
    pc = pc + T_ONE
    -- one division-free peel: a host call per field costs more than the
    -- arithmetic it replaces, and every field is exact below 2^53
    local o = ins % T_B8
    local q = (ins - o) / T_B8
    local a = q % T_B8
    q = (q - a) / T_B8
    local b = q % T_B8
    -- hosts whose instruction words fold above 2^31 (fengari) hand us a
    -- negative residue here, so the top field is wrapped like the others
    local c = ((q - b) / T_B8) % T_B8
    local ds = b + c * T_B8 - T_BIAS

    if o == __OP_BOXGET__ then
      reg[a] = reg[b][T_CELL]
    elseif o == __OP_LOADK__ then
      reg[a] = konst[ds + T_ONE]
    elseif o == __OP_MOVE__ then
      reg[a] = reg[b]
    elseif o == __OP_BOXSET__ then
      reg[a][T_CELL] = reg[b]
    elseif o == __OP_BOX__ then
      reg[a] = vm_box(reg[a])
    elseif o == __OP_ADD__ then
      reg[a] = reg[b] + reg[c]
    elseif o == __OP_SUB__ then
      reg[a] = reg[b] - reg[c]
    elseif o == __OP_MUL__ then
      reg[a] = reg[b] * reg[c]
    elseif o == __OP_DIV__ then
      reg[a] = reg[b] / reg[c]
    elseif o == __OP_MOD__ then
      reg[a] = reg[b] % reg[c]
    elseif o == __OP_GETTABLE__ then
      reg[a] = reg[b][reg[c]]
    elseif o == __OP_SETTABLE__ then
      reg[a][reg[b]] = reg[c]
    elseif o == __OP_FORLOOP__ then
      local step = reg[a + T_TWO]
      local idx = reg[a] + step
      local limit = reg[a + T_ONE]
      local go = false
      if step > T_ZERO then
        if idx <= limit then
          go = true
        end
      elseif idx >= limit then
        go = true
      end
      if go then
        reg[a] = idx
        reg[a + T_THREE] = idx
        pc = pc + ds
      end
    elseif o == __OP_GETUPVAL__ then
      reg[a] = ups[b + T_ONE][T_CELL]
    elseif o == __OP_GETUPVALV__ then
      reg[a] = ups[b + T_ONE]
    elseif o == __OP_SETUPVAL__ then
      ups[b + T_ONE][T_CELL] = reg[a]
    elseif o == __OP_CALL__ then
      local na = b - T_ONE
      if b == T_ZERO then
        na = top - a - T_ONE
      end
      -- one fixed result with a small argument window is the shape almost
      -- every call in real code has: run it straight into the target slot and
      -- skip both the argument and the result table
      if c == T_TWO and na <= T_THREE then
        if na == T_ONE then
          reg[a] = reg[a](reg[a + T_ONE])
        elseif na == T_TWO then
          reg[a] = reg[a](reg[a + T_ONE], reg[a + T_TWO])
        elseif na == T_THREE then
          reg[a] = reg[a](reg[a + T_ONE], reg[a + T_TWO], reg[a + T_THREE])
        else
          reg[a] = reg[a]()
        end
      else
        local args = {}
        local j = T_ONE
        while j <= na do
          args[j] = reg[a + j]
          j = j + T_ONE
        end
        local res = vm_packn(reg[a](al_unpack(args, T_ONE, na)))
        local m = res[T_ZERO]
        if c == T_ZERO then
          top = a + m
          j = T_ONE
          while j <= m do
            reg[a + j - T_ONE] = res[j]
            j = j + T_ONE
          end
          -- trailing slots of the call window must not keep stale arguments
          j = m
          while j <= na do
            reg[a + j] = nil
            j = j + T_ONE
          end
        else
          local want = c - T_ONE
          j = T_ONE
          while j <= want do
            reg[a + j - T_ONE] = res[j]
            j = j + T_ONE
          end
        end
      end
    elseif o == __OP_TESTSET__ then
      local v = reg[b]
      local truth = T_ONE
      if v == nil or v == false then
        truth = T_ZERO
      end
      if truth == c then
        reg[a] = v
      else
        pc = pc + T_ONE
      end
    elseif o == __OP_TEST__ then
      local f = T_ZERO
      if reg[a] == nil or reg[a] == false then
        f = T_ONE
      end
      if f == c then
        pc = pc + T_ONE
      end
    elseif o == __OP_LOADBOOL__ then
      if b == T_ZERO then
        reg[a] = false
      else
        reg[a] = true
      end
      if c ~= T_ZERO then
        pc = pc + T_ONE
      end
    elseif o == __OP_JMP__ then
      pc = pc + ds
    elseif o == __OP_RETURN__ then
      if b == T_ZERO then
        return al_unpack(reg, a, top - T_ONE)
      end
      if b == T_ONE then
        return
      end
      return al_unpack(reg, a, a + b - T_TWO)
    elseif o == __OP_EQ__ then
      local ok = T_ZERO
      if reg[b] == reg[c] then
        ok = T_ONE
      end
      if ok ~= a then
        pc = pc + T_ONE
      end
    elseif o == __OP_NE__ then
      local ok = T_ZERO
      if reg[b] ~= reg[c] then
        ok = T_ONE
      end
      if ok ~= a then
        pc = pc + T_ONE
      end
    elseif o == __OP_LT__ then
      local ok = T_ZERO
      if reg[b] < reg[c] then
        ok = T_ONE
      end
      if ok ~= a then
        pc = pc + T_ONE
      end
    elseif o == __OP_LE__ then
      local ok = T_ZERO
      if reg[b] <= reg[c] then
        ok = T_ONE
      end
      if ok ~= a then
        pc = pc + T_ONE
      end
    elseif o == __OP_GT__ then
      local ok = T_ZERO
      if reg[b] > reg[c] then
        ok = T_ONE
      end
      if ok ~= a then
        pc = pc + T_ONE
      end
    elseif o == __OP_GE__ then
      local ok = T_ZERO
      if reg[b] >= reg[c] then
        ok = T_ONE
      end
      if ok ~= a then
        pc = pc + T_ONE
      end
    elseif o == __OP_CONCAT__ then
      -- two explicit operands, not a register range: the compiler is then free
      -- to read either side straight out of a live local
      reg[a] = reg[b] .. reg[c]
    elseif o == __OP_UNM__ then
      reg[a] = -reg[b]
    elseif o == __OP_NOT__ then
      if reg[b] == nil or reg[b] == false then
        reg[a] = true
      else
        reg[a] = false
      end
    elseif o == __OP_LEN__ then
      reg[a] = #reg[b]
    elseif o == __OP_POW__ then
      reg[a] = reg[b] ^ reg[c]
    elseif o == __OP_NEWTABLE__ then
      reg[a] = {}
    elseif o == __OP_SETLIST__ then
      local tbl = reg[a]
      local n = b
      if n == T_ZERO then
        n = top - a - T_ONE
      end
      local j = T_ONE
      while j <= n do
        tbl[c + j] = reg[a + j]
        j = j + T_ONE
      end

    elseif o == __OP_SELF__ then
      local obj = reg[b]
      local key = reg[c]
      reg[a + T_ONE] = obj
      reg[a] = obj[key]
    elseif o == __OP_LOADNIL__ then
      local j = a
      while j <= a + ds do
        reg[j] = nil
        j = j + T_ONE
      end
    elseif o == __OP_CLOSURE__ then
      local kid = proto[T_CHILD][ds + T_ONE]
      reg[a] = vm_closure(kid, vm_upvals(kid, ups, reg))
    elseif o == __OP_VARARG__ then
      if b == T_ZERO then
        local j = T_ONE
        while j <= nvargs do
          reg[a + j - T_ONE] = vargs[j]
          j = j + T_ONE
        end
        top = a + nvargs
      else
        local want = b - T_ONE
        local j = T_ONE
        while j <= want do
          reg[a + j - T_ONE] = vargs[j]
          j = j + T_ONE
        end
      end
    elseif o == __OP_GETGLOBAL__ then
      reg[a] = T_ENV[konst[ds + T_ONE]]
    elseif o == __OP_SETGLOBAL__ then
      T_ENV[konst[ds + T_ONE]] = reg[a]
    elseif o == __OP_TAILCALL__ then
      local na = b - T_ONE
      if b == T_ZERO then
        na = top - a - T_ONE
      end
      local args = {}
      local j = T_ONE
      while j <= na do
        args[j] = reg[a + j]
        j = j + T_ONE
      end
      return reg[a](al_unpack(args, T_ONE, na))
    elseif o == __OP_FORPREP__ then
      local init = reg[a]
      local limit = reg[a + T_ONE]
      local step = reg[a + T_TWO]
      local skip = false
      if step > T_ZERO then
        if init > limit then
          skip = true
        end
      elseif init < limit then
        skip = true
      end
      if skip then
        pc = pc + ds
      else
        reg[a] = init
        reg[a + T_THREE] = init
      end
    elseif o == __OP_TFORPREP__ then
      pc = pc + ds
    elseif o == __OP_TFORCALL__ then
      local it = reg[a]
      local res
      if al_type(it) == T_TABLE then
        res = {al_next(it, reg[a + T_TWO])}
      else
        res = {it(reg[a + T_ONE], reg[a + T_TWO])}
      end
      local j = T_ONE
      while j <= b do
        reg[a + T_TWO + j] = vm_box(res[j])
        j = j + T_ONE
      end

    elseif o == __OP_GETTABLEC__ then
      reg[a] = reg[b][konst[c + T_ONE]]

    elseif o == __OP_SETTABLEC__ then
      reg[a][konst[c + T_ONE]] = reg[b]

    elseif o == __OP_ADDK__ then
      reg[a] = reg[b] + konst[c + T_ONE]

    elseif o == __OP_SUBK__ then
      reg[a] = reg[b] - konst[c + T_ONE]

    elseif o == __OP_MULK__ then
      reg[a] = reg[b] * konst[c + T_ONE]

    elseif o == __OP_DIVK__ then
      reg[a] = reg[b] / konst[c + T_ONE]

    elseif o == __OP_MODK__ then
      reg[a] = reg[b] % konst[c + T_ONE]
    elseif o == __OP_TFORLOOP__ then
      local v = reg[a + T_THREE][T_CELL]
      if v ~= nil then
        reg[a + T_TWO] = v
        pc = pc + ds
      end    else
      return __V0709__()
    end
  end
end

local function vm_run(img)
  local root = vm_image(img)
  return function(...)
    return vm_invoke(root, {}, ...)
  end
end
