local __BENCH_T0__ = os.clock()

local FIB_N = 26000 -- iterations of the Fibonacci loop (6 instr each)
local MIX_N = 26000 -- iterations of the mixing loop (~15 instr each)

-- Opcode numbers
local HALT, LOADK, LOADN, MOV = 1, 2, 3, 4
local ADD, SUB, MUL, ADDI, MODI = 5, 6, 7, 8, 9
local AND, OR, XOR, SHL, SHR = 10, 11, 12, 13, 14
local JMP, JLT, JLE, JEQ, JNE = 15, 16, 17, 18, 19
local CALL, RET = 20, 21
local LOAD, STORE = 22, 23

local MOD32 = 4294967296 -- 2^32
local MOD24 = 16777216 -- 2^24

-- Tiny assembler: emits a flat code array (4 slots per instruction)
-- and resolves string labels to absolute pc values in a second pass.
local function newAsm()
	local a = { code = {}, labels = {}, fixups = {} }

	function a.label(name: string)
		a.labels[name] = #a.code + 1
	end

	-- Branch/CALL targets may be passed as label strings.
	function a.emit(op: number, x: any, y: any, z: any)
		local code = a.code
		local base = #code
		code[base + 1] = op
		for i, v in { x or 0, y or 0, z or 0 } do
			if type(v) == "string" then
				table.insert(a.fixups, { base + 1 + i, v })
				code[base + 1 + i] = 0
			else
				code[base + 1 + i] = v
			end
		end
	end

	function a.done()
		for _, f in a.fixups do
			local pc = a.labels[f[2]]
			assert(pc ~= nil, "undefined label: " .. f[2])
			a.code[f[1]] = pc
		end
		return a.code
	end

	return a
end

-- The VM. Closure-based dispatch: every opcode is a closure sharing
-- the registers/heap/pc upvalues. Returns (R[1], instruction count).
local function runVM(code: { number }, consts: { number }, heapSize: number): (number, number)
	local R = table.create(16, 0) -- registers 1..16
	local heap = table.create(heapSize, 0) -- VM heap, addresses 1..heapSize
	local stack = {} -- return-address stack
	local sp = 0
	local pc = 1
	local running = true

	local ops = table.create(23)
	ops[HALT] = function()
		running = false
	end
	ops[LOADK] = function(r, k)
		R[r] = consts[k]
		pc += 4
	end
	ops[LOADN] = function(r, n)
		R[r] = n
		pc += 4
	end
	ops[MOV] = function(r, s)
		R[r] = R[s]
		pc += 4
	end
	ops[ADD] = function(r, x, y)
		R[r] = (R[x] + R[y]) % MOD32
		pc += 4
	end
	ops[SUB] = function(r, x, y)
		R[r] = (R[x] - R[y]) % MOD32
		pc += 4
	end
	ops[MUL] = function(r, x, y) -- 24-bit modular multiply (exact in doubles)
		R[r] = (R[x] % MOD24) * (R[y] % MOD24) % MOD24
		pc += 4
	end
	ops[ADDI] = function(r, x, imm)
		R[r] = (R[x] + imm) % MOD32
		pc += 4
	end
	ops[MODI] = function(r, x, imm)
		R[r] = R[x] % imm
		pc += 4
	end
	ops[AND] = function(r, x, y)
		R[r] = bit32.band(R[x], R[y])
		pc += 4
	end
	ops[OR] = function(r, x, y)
		R[r] = bit32.bor(R[x], R[y])
		pc += 4
	end
	ops[XOR] = function(r, x, y)
		R[r] = bit32.bxor(R[x], R[y])
		pc += 4
	end
	ops[SHL] = function(r, x, imm)
		R[r] = bit32.lshift(R[x], imm)
		pc += 4
	end
	ops[SHR] = function(r, x, imm)
		R[r] = bit32.rshift(R[x], imm)
		pc += 4
	end
	ops[JMP] = function(t)
		pc = t
	end
	ops[JLT] = function(x, y, t)
		pc = if R[x] < R[y] then t else pc + 4
	end
	ops[JLE] = function(x, y, t)
		pc = if R[x] <= R[y] then t else pc + 4
	end
	ops[JEQ] = function(x, y, t)
		pc = if R[x] == R[y] then t else pc + 4
	end
	ops[JNE] = function(x, y, t)
		pc = if R[x] ~= R[y] then t else pc + 4
	end
	ops[CALL] = function(t)
		sp += 1
		stack[sp] = pc + 4
		pc = t
	end
	ops[RET] = function()
		pc = stack[sp]
		sp -= 1
	end
	ops[LOAD] = function(r, aReg) -- R[r] = heap[R[aReg]] (1-based address)
		R[r] = heap[R[aReg]]
		pc += 4
	end
	ops[STORE] = function(aReg, r) -- heap[R[aReg]] = R[r]
		heap[R[aReg]] = R[r]
		pc += 4
	end

	local icount = 0
	while running do
		local p = pc
		ops[code[p]](code[p + 1], code[p + 2], code[p + 3])
		icount += 1
	end
	return R[1], icount
end

-- Program 1 (correctness check): sum of 1..5 via a loop,
-- then CALL a subroutine that stores the sum at heap[3], loads it
-- back and adds 2.  Hand-computed result: (1+2+3+4+5) + 2 = 17.
local function buildCheckProgram()
	local A = newAsm()
	A.emit(LOADN, 1, 0) -- r1 = sum = 0
	A.emit(LOADN, 2, 1) -- r2 = i = 1
	A.emit(LOADN, 3, 6) -- r3 = limit
	A.label("loop")
	A.emit(ADD, 1, 1, 2) -- sum += i
	A.emit(ADDI, 2, 2, 1) -- i += 1
	A.emit(JLT, 2, 3, "loop")
	A.emit(CALL, "bump")
	A.emit(HALT)
	A.label("bump") -- heap[3] = sum; sum = heap[3] + 2
	A.emit(LOADN, 4, 3) -- r4 = address 3
	A.emit(STORE, 4, 1)
	A.emit(LOAD, 5, 4) -- r5 = heap[3]
	A.emit(LOADN, 6, 2)
	A.emit(ADD, 1, 5, 6)
	A.emit(RET)
	return A.done()
end

do
	local result, icount = runVM(buildCheckProgram(), {}, 8)
	assert(result == 17, "VM check: expected 17, got " .. result)
	-- 3 setup + 5*3 loop + CALL + 6 subroutine + HALT = 26 instructions
	assert(icount == 26, "VM check: expected 26 instructions, got " .. icount)
end

-- Program 2: Fibonacci mod 2^24, then the heap-mixing loop
-- with a CALLed mix subroutine, then a heap-summing pass.
local function buildMainProgram(fibN: number, mixN: number)
	local A = newAsm()

	-- Phase A: r2 = fib(fibN) mod 2^24
	A.emit(LOADN, 1, 0) -- r1 = a
	A.emit(LOADN, 2, 1) -- r2 = b
	A.emit(LOADN, 3, 0) -- r3 = i
	A.emit(LOADK, 4, 1) -- r4 = fibN (from constant pool)
	A.label("fib")
	A.emit(ADD, 5, 1, 2) -- r5 = a + b
	A.emit(MODI, 5, 5, MOD24)
	A.emit(MOV, 1, 2)
	A.emit(MOV, 2, 5)
	A.emit(ADDI, 3, 3, 1)
	A.emit(JLT, 3, 4, "fib")

	-- Phase B: mixing loop over a 64-slot heap region
	A.emit(LOADN, 3, 0) -- r3 = i
	A.emit(LOADK, 4, 2) -- r4 = mixN
	A.emit(LOADN, 6, 12345) -- r6 = acc
	A.label("mix")
	A.emit(MODI, 7, 3, 64) -- r7 = i % 64
	A.emit(ADDI, 7, 7, 1) -- 1-based heap address
	A.emit(CALL, "mixsub")
	A.emit(STORE, 7, 6) -- heap[r7] = acc
	A.emit(LOAD, 8, 7) -- r8 = heap[r7]
	A.emit(XOR, 6, 6, 8) -- fold back (== 0 here, keeps acc bounded? no:
	A.emit(OR, 6, 6, 8) --   XOR zeroes acc, OR restores it -- both exercised)
	A.emit(ADDI, 3, 3, 1)
	A.emit(JLT, 3, 4, "mix")
	A.emit(JMP, "sum")

	A.label("mixsub") -- acc = mix(acc, i)
	A.emit(XOR, 6, 6, 3)
	A.emit(MUL, 9, 6, 6) -- low-24-bit square
	A.emit(ADD, 6, 6, 9)
	A.emit(SHR, 10, 6, 7)
	A.emit(XOR, 6, 6, 10)
	A.emit(SHL, 10, 6, 3)
	A.emit(XOR, 6, 6, 10)
	A.emit(RET)

	-- Phase C: sum the heap, combine with fib value and acc into r1
	A.label("sum")
	A.emit(LOADN, 3, 1) -- r3 = address
	A.emit(LOADN, 4, 65) -- r4 = limit
	A.emit(LOADN, 11, 0) -- r11 = total
	A.label("sl")
	A.emit(LOAD, 8, 3)
	A.emit(ADD, 11, 11, 8)
	A.emit(ADDI, 3, 3, 1)
	A.emit(JLT, 3, 4, "sl")
	A.emit(XOR, 1, 2, 6) -- r1 = fib ^ acc
	A.emit(ADD, 1, 1, 11) -- r1 += heap total (mod 2^32)
	A.emit(HALT)

	return A.done(), { fibN, mixN }
end

-- Bulk workload
local mainCode, mainConsts = buildMainProgram(FIB_N, MIX_N)

local t0 = os.clock()
local result, icount = runVM(mainCode, mainConsts, 64)
local elapsed = os.clock() - t0

-- checksum folds the VM result together with the executed-instruction
-- count, so both must reproduce exactly
local checksum = (result * 65599 + icount) % 4294967296

local EXPECTED = 2159502503 -- baked in from a reference run (icount 598270)
assert(checksum == EXPECTED, "bytecode_vm checksum mismatch: " .. checksum .. " (icount " .. icount .. ")")

print(string.format("bytecode_vm checksum: %s", tostring(checksum)))
print("main work time", elapsed * 1000)
print("entire script time", (os.clock() - __BENCH_T0__) * 1000)
