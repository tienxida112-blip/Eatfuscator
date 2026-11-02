-- Smoke test for Eatfuscator env hardening
local function add(a, b)
    return a + b
end

local x = Vector3.new(10, 20, 30)
local y = CFrame.new(0, 0, 0)

print("Hello from smoke test")
print(add(5, 3))

if x.Magnitude > 0 then
    warn("Vector3 works")
end

return add
