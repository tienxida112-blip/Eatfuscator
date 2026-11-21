--[[
  env_logger.lua — run an obfuscated artifact inside a logged environment.

  usage: lua env_logger.lua <artifact.lua> [clean|hook|proxy|luau|all]

    clean   plain run                       (expects: the payload output)
    hook    debug.sethook installed         (expects: nothing at all)
    proxy   _G metatable __index installed  (expects: nothing at all)
    luau    Luau-shaped env                 (expects: the payload output)

  The artifact carries no marker string and no visible trap loop, so a tripped
  build simply never finishes: it parks inside one of its own checksum walks.
  This harness only reports the two outcomes it can observe itself --

    "ENV-LOGGER: <kind> -> ran normally"   exit 0   the chunk returned
    "ENV-LOGGER: <kind> -> refused"        exit 3   the chunk raised

  -- and says nothing for a build that stalls, which is the trap working. A
  caller watching this process should treat silence past the deadline as a
  refusal too.
]]

local target, mode = ...
if type(mode) ~= "string" then mode = "all" end

if not target then
  io.stderr:write("usage: lua env_logger.lua <artifact.lua> [clean|hook|proxy|luau|all]\n")
  os.exit(64)
end

local function install(kind)
  if kind == "hook" and debug and debug.sethook then
    debug.sethook(function() end, "", 1000000)
  elseif kind == "proxy" then
    setmetatable(_G, { __index = function() return nil end })
  elseif kind == "luau" then
    local rl = load
    getfenv = function() return { loadstring = rl, load = rl } end
    _G.load = nil
    _G.loadstring = nil
  end
end

local function verdict(kind, ok, err)
  if ok then
    io.stderr:write("ENV-LOGGER: ", kind, " -> ran normally\n")
    return 0
  end
  io.stderr:write("ENV-LOGGER: ", kind, " -> refused\n")
  io.stderr:write("ENV-LOGGER: ", kind, " -> detail: ", tostring(err), "\n")
  return 3
end

local function run(kind)
  install(kind)
  local chunk, loadErr = loadfile(target)
  if not chunk then
    io.stderr:write("ENV-LOGGER: cannot load target: ", tostring(loadErr), "\n")
    os.exit(65)
  end
  local ok, runErr = pcall(chunk)
  if debug and debug.sethook then debug.sethook() end
  return verdict(kind, ok, runErr)
end

if mode == "all" then
  run("clean")
  os.exit(run("hook"))
else
  os.exit(run(mode))
end
