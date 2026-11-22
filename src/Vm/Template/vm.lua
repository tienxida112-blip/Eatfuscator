local T_PERM1 = al_bank[0x1F]
local T_PERM2 = al_bank[0x1F + 1]
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
local T_TAGSTR, T_DESC = T_FOUR + T_ONE, T_FOUR + T_ONE + T_TWO
local T_DPOS, T_DLEN, T_DFLIP, T_DK, T_DNK, T_DIDX = T_ONE, T_TWO, T_THREE, T_FOUR, T_FOUR + T_ONE, T_TWO + T_FOUR
local T_MARK = T_TWO + T_FOUR + T_ONE
-- Descriptor slots after the mark: program length, string-cipher probe,
-- constant table. The slice count is written as a literal by the guard.
local T_TABLE = al_type(al_env)

local T_CODE_SALT = (al_code_salt + al_attest + al_atlas) % 16777216
local T_TICK = T_ONE * (1536 + (T_CODE_SALT % 5) * 512)
local T_STR_SALT = al_str_salt % 16777216
local T_K1 = al_isk % 16777216
local T_K2 = al_ik2 % 16777216
local T_SBOX_CODE = al_sboxfn(T_K1, T_K2, T_CODE_SALT)
local T_SBOX_STR = al_sboxfn(T_K1, T_K2, T_STR_SALT)
local T_CIPHER = al_schedfn(T_SBOX_CODE, 13, 0, 0)

-- The later host gate contributes to the instruction schedule. Suppressing the
-- trap alone must not turn an invalid host verdict into the normal key.
local function vm_gate(mix)
  T_CODE_SALT = (T_CODE_SALT + mix) % 16777216
  T_TICK = T_ONE * (1536 + (T_CODE_SALT % 5) * 512)
  T_SBOX_CODE = al_sboxfn(T_K1, T_K2, T_CODE_SALT)
  T_CIPHER = al_schedfn(T_SBOX_CODE, 13, 0, 0)
end

local function vm_plain(w, pi, pos)
  return (al_worddec(T_CIPHER, w) - (pos * 40503 + 12345 + pi * 65521) % 4294967296) % 4294967296
end

local function vm_plainstr(s, pi, ci)
  local t = al_schedfn(T_SBOX_STR, 11, pi, ci)
  local n = #s
  local state = t[4]
  local out = {}
  local i = T_ONE
  while i <= n do
    state = al_wordenc(t, state)
    local b1 = (state - state % 16777216) / 16777216
    local b2 = (state - state % 65536) / 65536 - b1 * 256
    local b3 = (state - state % 256) / 256 - b1 * 65536 - b2 * 256
    local b4 = state % 256
    out[i] = al_char((al_byte(s, i) - b1) % 256)
    if i + T_ONE <= n then out[i + T_ONE] = al_char((al_byte(s, i + T_ONE) - b2) % 256) end
    if i + T_TWO <= n then out[i + T_TWO] = al_char((al_byte(s, i + T_TWO) - b3) % 256) end
    if i + T_THREE <= n then out[i + T_THREE] = al_char((al_byte(s, i + T_THREE) - b4) % 256) end
    i = i + T_FOUR
  end
  return al_concat(out)
end

-- Interleave the sealed resident words across four prototype-rotated shards.
-- Logical PCs remain stable, including jumps into the middle of a block.
local function vm_laneoffset(pi)
  return (pi + T_SBOX_CODE[(pi * 37) % 256 + T_ONE]) % T_FOUR
end

local function vm_shard(code, pi)
  local offset = vm_laneoffset(pi)
  local shards = {{}, {}, {}, {}}
  local i = T_ONE
  while i <= #code do
    local lane = (i - T_ONE + offset) % T_FOUR + T_ONE
    local row = al_floor((i - T_ONE) / T_FOUR) + T_ONE
    shards[lane][row] = code[i]
    i = i + T_ONE
  end
  return shards
end

local function vm_shardget(shards, pc, pi)
  return shards[(pc - T_ONE + vm_laneoffset(pi)) % T_FOUR + T_ONE][al_floor((pc - T_ONE) / T_FOUR) + T_ONE]
end

-- The stack machine's two slots. Shared, not per-invocation: the decoded fields
-- are copied into locals before the instruction can re-enter the interpreter, so
-- nothing carries state across a call.
local T_ST = {}

local T_ENV = al_env
local T_SHADOW = {}
local function vm_gset(k, v)
  T_SHADOW[k] = v
end
local function vm_gget(k)
  local v = T_SHADOW[k]
  if v == nil then v = T_ENV[k] end
  return v
end

local vm_invoke

local function vm_box(v)
  return {[T_CELL] = v}
end

local function vm_closure(proto, ups)
  return function(...)
    return vm_invoke(proto, ups, ...)
  end
end

local function vm_packn(...)
  local t = {...}
  t[T_ZERO] = al_select("#", ...)
  return t
end

local function vm_nextfn(t, k)
  return al_next(t, k)
end

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

local vm_load

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

  local forder = vm_perm(T_PERM1, 7)
  local torder = vm_perm(T_PERM2, 5)
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
    local ncode = field[T_ONE + T_FOUR]
    local nk = field[T_TWO + T_FOUR]
    local nchild = field[T_THREE + T_FOUR]

    local codePos = pos
    -- The code region is a stack program now: skip it by its own token count
    -- (second token), not by the register word count in the header.
    pos = codePos
    local head0 = u32()
    local ntok = u32()
    pos = codePos + ntok * T_FOUR + T_FOUR

    local kdesc = {}
    local j = T_ONE
    while j <= nk do
      local kind = ttype[u8()]
      local rec = {kind, pos, T_ZERO}
      if kind == T_NUM or kind == T_TAGSTR then
        -- numbers keep a 16-bit text length (they are short); strings carry 32
        -- bits, because a real payload literal can be hundreds of kilobytes
        local len = (kind == T_NUM) and u16() or u32()
        rec[T_TWO] = pos
        rec[T_THREE] = len
        pos = pos + len
      end
      kdesc[j] = rec
      j = j + T_ONE
    end

    local uvPos = pos
    pos = uvPos + nup * T_TWO
    local childPos = pos
    pos = childPos + nchild * T_TWO

    local keep = pos
    pos = uvPos
    local ups = {}
    j = T_ONE
    while j <= nup do
      ups[j] = {u8(), u8()}
      j = j + T_ONE
    end
    pr[T_UV] = ups

    pos = childPos
    local kids = {}
    j = T_ONE
    while j <= nchild do
      kids[j] = u16() + T_ONE
      j = j + T_ONE
    end
    pr[T_CHILD] = kids
    pos = keep

    pr[T_DESC] = {codePos, ncode, T_ONE + (T_SBOX_CODE[(i * 37) % 256 + T_ONE] % 255), kdesc, nk, i}
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

  -- Layer 3: run the stack program that rebuilds the sealed word table. Every
  -- token is four bytes, so `pos` walks it exactly like the flat region it
  -- replaced; the words themselves are never stored in the file.
  local vm_forge = function()
    local head = u32()
    local nwords = (head - head % 256) / 256
    local ntok = u32()
    local phead = u32()
    local npair = (phead - phead % 256) / 256
    local pairs = {}
    local i = T_ONE
    while i <= npair do
      pairs[i] = {u32(), u32()}
      i = i + T_ONE
    end
    local st = {}
    local sp = T_ZERO
    local code = {}
    local got = T_ZERO
    while got < nwords do
      local tok = u32()
      local op = tok % 256
      local val = (tok - op) / 256
      if op == __FORGE_LIT__ then
        sp = sp + T_ONE
        st[sp] = val
      elseif op == __FORGE_LIT_HI__ then
        st[sp] = st[sp] + val * 16777216
      elseif op == __FORGE_MAD__ then
        local pr = pairs[val + T_ONE]
        local v = st[sp]
        local ah = (v - v % 65536) / 65536
        st[sp] = ((ah * pr[T_ONE]) % 4294967296 * 65536 + (v % 65536) * pr[T_ONE] + pr[T_TWO]) % 4294967296
      elseif op == __FORGE_ADD__ then
        st[sp] = (st[sp] + val) % 4294967296
      elseif op == __FORGE_SWAP__ then
        local v = st[sp]
        st[sp] = (v % 65536) * 65536 + (v - v % 65536) / 65536
      elseif op == __FORGE_STORE__ then
        got = got + T_ONE
        code[got] = st[sp]
        sp = sp - T_ONE
      else
        return {}, ntok
      end
    end
    return code, ntok
  end

  vm_load = function(pr)
    if pr[T_CODE] ~= nil then return end
    local d = pr[T_DESC]
    local pi = d[T_DIDX]
    pr[(T_MARK + T_FOUR)] = pi
    local code = {}
    pos = d[T_DPOS]
    local forgebank, forgedTokens = vm_forge()
    -- The digest of the whole instruction stream, written at build time over the
    -- words as they will look here. A corrupted forge token, a corrupted word or
    -- a rewritten digest all land on the same verdict, and the verdict is reached
    -- before the first instruction runs: the proto is replaced with a single
    -- RETURN. That is deliberately not a raise - the artifact stops, the host
    -- keeps its frame, and a patcher who only wanted to read the file gets a
    -- program that does nothing.
    local stamp = u32()
    local j = T_ONE
    local chain = (T_CIPHER[4] % T_B16) * 65537 + pi
    chain = chain % 4294967296
    while j <= d[T_DLEN] do
      local sealed = forgebank[j]
      local w = (al_worddec(T_CIPHER, (sealed - chain) % 4294967296) - (j * 40503 + 12345 + pi * 65521) % 4294967296) % 4294967296
      __FLIP__ = 0
      chain = ((chain % T_B16) * 65537 + w) % 4294967296
      j = j + T_ONE
    end
    local dh = T_ZERO
    local di = T_ONE
    while di <= #code do
      dh = (dh * 31 + code[di]) % 16777216
      di = di + T_ONE
    end
    -- Keep cached instructions sealed; only the current instruction is opened
    -- by the execution loop. This does not prevent runtime instrumentation.
    local resident = al_schedfn(T_SBOX_CODE, 29, pi, 0)
    if dh ~= stamp then
      pr[T_CODE] = vm_shard({al_wordenc(resident, (__BADRETURN__ + 40503 + pi * 65521) % 4294967296)}, pi)
      pr[T_MARK] = {__OP_RETURN__}
      pr[T_KONST] = {}
      return
    end
    local ri = T_ONE
    while ri <= #code do
      code[ri] = al_wordenc(resident, (code[ri] + ri * 40503 + pi * 65521) % 4294967296)
      ri = ri + T_ONE
    end
    pr[T_CODE] = vm_shard(code, pi)
    local n = #code
    pr[(T_MARK + T_ONE)] = n
    local mark = {}
    local q = T_ONE
    while q <= 12 do
      local h = T_ZERO
      local i = q
      while i <= n do
        h = (h * 3 + code[i]) % 16777216
        i = i + 12
      end
      mark[q] = h
      q = q + T_ONE
    end
    pr[T_MARK] = mark
    __GUARDPROBE__ = 0

    local kd = d[T_DK]
    local ks, lazy, lnum = {}, {}, {}
    j = T_ONE
    while j <= d[T_DNK] do
      local rec = kd[j]
      local kind = rec[T_ONE]
      if kind == T_NUM then
        lazy[j] = al_sub(img, rec[T_TWO], rec[T_TWO] + rec[T_THREE] - T_ONE)
        lnum[j] = T_ONE
      elseif kind == T_TRUE then
        ks[j] = true
      elseif kind == T_FALSE then
        ks[j] = false
      elseif kind == T_NIL then
        ks[j] = nil
      else
        lazy[j] = al_sub(img, rec[T_TWO], rec[T_TWO] + rec[T_THREE] - T_ONE)
      end
      j = j + T_ONE
    end
    if al_next(lazy) ~= nil then
      al_setmeta(ks, {[al_index] = function(t, key)
        local raw = lazy[key]
        if raw == nil then return nil end
        local plain = vm_plainstr(raw, pi, key)
        if lnum[key] ~= nil then plain = al_tonum(plain) t[key] = plain end
        return plain
      end})
    end
    pr[T_KONST] = ks
    -- The table itself, not its length: `ks` is filled lazily, so a count taken
    -- at load and compared later would drift on an honest run.
    pr[(T_MARK + T_THREE)] = ks
    -- A fixed synthetic string decoded through the real string cipher: if the
    -- cipher, its schedule or its state is patched to read strings out, this no
    -- longer matches what the build recorded.
    pr[(T_MARK + T_TWO)] = vm_plainstr("tp", T_ONE, T_ZERO)
  end

  return protos[T_ONE]
end

local vm_poison = function()
  return al_setmeta({}, {[al_index] = function() return nil end})
end

-- The string-cipher probe allocates a schedule, so it runs every fourth tick
-- instead of every tick; the code slices still run on every one.
local T_SPROBE = T_ZERO

local function vm_guard(proto, pc)
  if al_recheck() ~= T_ONE then al_trap() return false end
  if T_ENV[al_typekey] ~= al_type then return false end
  local code = proto[T_CODE]
  local mark = proto[T_MARK]
  local len = proto[(T_MARK + T_ONE)]
  -- The program's length is pinned: appending words to jump somewhere else, or
  -- truncating the tail a patched branch would run, is a mismatch.
  if al_type(len) ~= al_type(T_ONE) or #code ~= T_FOUR then return false end
  local pi = proto[(T_MARK + T_FOUR)]
  local lane = T_ONE
  local offset = vm_laneoffset(pi)
  while lane <= T_FOUR do
    local first = (lane - T_ONE - offset) % T_FOUR + T_ONE
    local expected = first <= len and (al_floor((len - first) / T_FOUR) + T_ONE) or T_ZERO
    if al_type(code[lane]) ~= T_TABLE or #code[lane] ~= expected then return false end
    lane = lane + T_ONE
  end
  if len < T_ONE then return true end
  -- One slice per call, chosen by the program counter, so a patcher cannot pin
  -- the guard to a slice they have left alone: the same tick that reads this
  -- instruction moves the window.
  local k = pc % 12 + T_ONE
  local want = mark[k]
  if al_type(want) ~= al_type(T_ZERO) then return false end
  local h = T_ZERO
  local i = k
  while i <= len do
    h = (h * 3 + vm_shardget(code, i, pi)) % 16777216
    i = i + 12
  end
  if h ~= want then return false end
  -- The constant table is counted, so swapping it for one of a different size is
  -- visible even when the code is untouched.
  if proto[T_KONST] ~= proto[(T_MARK + T_THREE)] then return false end
  -- The string decoder still answers its probe. This is the check that a reader
  -- who patches the string path to dump payload strings runs into.
  T_SPROBE = T_SPROBE + T_ONE
  if T_SPROBE >= T_FOUR then
    T_SPROBE = T_ZERO
    if vm_plainstr("tp", T_ONE, T_ZERO) ~= proto[(T_MARK + T_TWO)] then return false end
  end
  return true
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

      out[j] = reg[d[T_TWO]]
    else
      out[j] = ups[d[T_TWO] + T_ONE]
    end
    j = j + T_ONE
  end
  return out
end

vm_invoke = function(proto, ups, ...)
  if proto[T_CODE] == nil then vm_load(proto) end
  local code = proto[T_CODE]
  local pi = proto[(T_MARK + T_FOUR)]
  local resident = al_schedfn(T_SBOX_CODE, 29, pi, 0)
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

  local shardOffset = vm_laneoffset(pi)
  local pc = T_ONE
  local top = T_ZERO
  local tick = T_TICK
  local st = T_ST

  while true do
    local ins = (al_worddec(resident, code[(pc - T_ONE + shardOffset) % T_FOUR + T_ONE][al_floor((pc - T_ONE) / T_FOUR) + T_ONE]) - pc * 40503 - pi * 65521) % 4294967296
    pc = pc + T_ONE
    tick = tick - T_ONE
    if tick <= T_ZERO then
      tick = T_TICK
      if not vm_guard(proto, pc) then
        -- Fail closed and stop: the constants go, the frame is poisoned, and the
        -- program counter is moved past the end so the next iteration dies
        -- instead of running a wiped program. A logger that pcalls the artifact
        -- gets an error and no result to replay.
        proto[T_KONST] = {}
        proto[T_MARK] = {}
        reg = vm_poison()
        pc = #code + T_ONE
        tick = T_TICK
      end
    end

    -- Two machines, one loop. The stack machine below takes the instruction word
    -- apart on a two-slot value stack - push the word, take it apart field by
    -- field, the remainder lands in the top slot - and the register machine is
    -- what acts on the result. Neither is a separate pass, so there is no "the
    -- interpreter" for a reader to jump to: the operands of every register opcode
    -- are produced by the stack in the same iteration that consumes them.
    __FIELDS__ = 0

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
      reg[a] = vm_gget(konst[ds + T_ONE])
    elseif o == __OP_SETGLOBAL__ then
      vm_gset(konst[ds + T_ONE], reg[a])
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
