--[[
  roblog.lua — a minimal Roblox host shim, used only for testing.

  The obfuscator's default target expects a real Luau/Roblox host: game, typeof,
  task, Enum, Instance. Off-platform we cannot borrow Roblox, so this file
  builds just enough of one to run an artifact and check that its behaviour still
  matches the original program.

  It is deliberately *faithful where the artifact probes*: DataModel identity,
  a Parent that is nil, GetService that raises on unknown services,
  Instance.new("Part") with a writable Name and a working Destroy, and a typeof
  that agrees with type() on primitives. All of that is what the loader's host
  gate checks, so this shim stands in for "a genuine Roblox host" — a sloppier
  fake is supposed to be rejected.

  Concatenate this file in front of an artifact (the artifact ends with a
  top-level return, so it must come last).

  Usage:  { cat tools/roblog.lua artifact.lua; } | luau -
      or  luau -  < <(cat tools/roblog.lua artifact.lua)
]]

do
  local type, getmetatable, setmetatable, select, error, tostring = type, getmetatable, setmetatable, select, error, tostring
  local raw_typeof = typeof or function(v)
    return type(v)
  end

  -- Instances are *userdata* here, not tables, because that is what they are in
  -- Roblox: `type(part)` is "userdata" and `typeof(part)` is "Instance", and
  -- `rawget` on one raises. A host that hands the loader plain tables - which is
  -- exactly what a dumped-and-replayed environment does - is distinguishable on
  -- the first line, and it should be: this host is meant to behave like the real
  -- one, not like a convenient stand-in.
  local Instance_mt = {}
  -- proxy -> the table that actually holds the fields and methods
  local backing = setmetatable({}, { __mode = "k" })
  -- the internal table -> the userdata the outside world holds, so that child
  -- lists are filled with proxies and identity comparisons work from both sides
  local proxyOf = setmetatable({}, { __mode = "k" })
  local function meOf(self) local p = proxyOf[self] if p ~= nil then return p end return self end
  local function isInstance(v)
    return type(v) == "userdata" and backing[v] ~= nil
  end
  -- field access that works whether `self` is the proxy or the table behind it
  local function rget(self, key)
    local t = backing[self]
    if t ~= nil then return t[key] end
    return rawget(self, key)
  end
  local function rgets(self, key, value)
    local t = backing[self]
    if t ~= nil then rawset(t, key, value) return end
    rawset(self, key, value)
  end

  local M = {}

  -- Instance.new raises on a class that does not exist; a host that answers every
  -- class name with a table will also answer an invented one, and an artifact that
  -- never checks this cannot tell a client from a catalogue.
  local KNOWN_CLASSES = {}
  for _, name in ipairs({
    "DataModel", "Part", "WedgePart", "SpawnLocation", "Folder", "Model", "Camera",
    "Attachment", "ScreenGui", "Frame", "TextLabel", "TextButton", "ImageLabel",
    "Sound", "ObjectValue", "StringValue", "NumberValue", "BoolValue",
    "BindableEvent", "BindableFunction", "RemoteEvent", "RemoteFunction",
    "Configuration", "Players", "RunService", "Workspace", "Lighting", "HttpService",
    "CoreGui", "TweenService", "UserInputService", "ReplicatedStorage",
    "ReplicatedFirst", "ServerStorage", "ServerScriptService", "StarterGui",
    "StarterPack", "StarterPlayer", "SoundService", "Chat", "Teams",
    "CollectionService", "MarketplaceService", "TeleportService", "PathfindingService",
    "PhysicsService", "PolicyService", "GuiService", "LocalizationService",
    "ContentProvider", "Debris", "BadgeService", "DataStoreService", "InsertService",
    "LogService", "ContextActionService", "ProximityPromptService", "TextService",
    "SocialService", "VRService", "HapticService", "GroupService", "AssetService",
    "ScriptContext", "Selection", "TestService", "UserService", "MaterialService",
  }) do
    KNOWN_CLASSES[name] = true
  end

  local function newInstance(className)
    local self = setmetatable({
      ClassName = className,
      Name = className,
      _children = {},
      _props = {},
    }, Instance_mt)
    local proxy = newproxy(true)
    local mt = getmetatable(proxy)
    mt.__index = function(_, key) return self[key] end
    mt.__newindex = function(_, key, value)
      if key == "ClassName" or key == "ClassName " then
        -- Roblox refuses this assignment, so the shim does too.
        error("Unable to assign property ClassName. Property is read only", 2)
      end
      self[key] = value
    end
    mt.__len = function() return #self._children end
    mt.__tostring = function() return tostring(self.Name or self.ClassName or "Instance") end
    backing[proxy] = self
    proxyOf[self] = proxy
    return proxy
  end

  local function service(name)
    return M._services[name]
  end

  local function signalStub()
    local c = { Disconnect = function() end, disconnect = function() end, Connected = true }
    local s = {}
    s.Connect = function(_, fn) if type(fn) == "function" then pcall(fn, nil) end return c end
    s.connect = s.Connect
    s.Wait = function() end
    s.wait = s.Wait
    return s
  end
  M.signalStub = signalStub

  -- Every service the artifact's catalogue can ask for, so that GetService answers
  -- for the whole client and not just for the handful this host happens to build
  -- eagerly. A name outside this list still raises, which is the point.
  local SERVICE_NAMES = {}
  for _, n in ipairs({"Players", "RunService", "Workspace", "Lighting", "TweenService", "UserInputService", "ReplicatedStorage", "ReplicatedFirst", "ServerStorage", "ServerScriptService", "StarterGui", "StarterPack", "StarterPlayer", "SoundService", "Chat", "Teams", "CollectionService", "HttpService", "MarketplaceService", "TeleportService", "PathfindingService", "PhysicsService", "PolicyService", "GuiService", "LocalizationService", "ContentProvider", "Debris", "BadgeService", "DataStoreService", "MemoryStoreService", "MessagingService", "GroupService", "InsertService", "AssetService", "VRService", "HapticService", "SocialService", "TextService", "LogService", "CoreGui", "ContextActionService", "ProximityPromptService", "VoiceChatService", "AvatarEditorService", "FriendService", "MaterialService", "SessionService", "UserService"}) do SERVICE_NAMES[n] = true end
  -- ...and the members those services expose, for the ones the catalogue checks.
  local SERVICE_MEMBERS = {
    Players = { GetPlayers = function() return {} end, PlayerAdded = signalStub, PlayerRemoving = signalStub },
    RunService = { Heartbeat = signalStub, RenderStepped = signalStub, Stepped = signalStub },
    TweenService = { Create = function() return { Play = function() end, Cancel = function() end } end },
    UserInputService = { InputBegan = signalStub, InputEnded = signalStub, IsKeyDown = function() return false end },
    CollectionService = { GetTagged = function() return {} end, GetTags = function() return {} end, AddTag = function() end },
  }

  local methods = {}

  function methods:GetChildren()
    local out = {}
    for i, child in ipairs(rget(self, "_children") or {}) do
      out[i] = child
    end
    return out
  end

  function methods:GetDescendants()
    local out = {}
    local function walk(node)
      for _, child in ipairs(node._children or {}) do
        out[#out + 1] = child
        walk(child)
      end
    end
    walk(self)
    return out
  end

  function methods:FindFirstChild(name)
    for _, child in ipairs(self._children or {}) do
      if child.Name == name then
        return child
      end
    end
    return nil
  end

  function methods:WaitForChild(name)
    return self:FindFirstChild(name)
  end

  function methods:IsA(className)
    if className == self.ClassName then
      return true
    end
    if className == "Instance" then
      return true
    end
    return false
  end

  function methods:Destroy()
    local parent = self.Parent
    if parent and parent._children then
      for i, child in ipairs(parent._children) do
        if child == self then
          table.remove(parent._children, i)
          break
        end
      end
    end
    self.Parent = nil
    self._destroyed = true
  end

  function methods:GetService(name)
    -- Host-side instrumentation, off by default: set the global
    -- __EAT_TRACE_GETSVC before the artifact runs and every service the artifact
    -- resolves is printed. The suite uses it to watch the atlas rotation; the
    -- artifact cannot see it, because it never reads that global.
    if __EAT_TRACE_GETSVC then print("GETSVC", tostring(name)) end
    if self.ClassName ~= "DataModel" then
      error(tostring(name) .. " is not a valid service of " .. tostring(self.ClassName), 2)
    end
    local found = M._services[name]
    if found then
      return found
    end
    if type(name) ~= "string" or not SERVICE_NAMES[name] then
      error("'" .. tostring(name) .. "' is not a valid Service name", 2)
    end
    -- a real client knows every service; this host materialises one on demand
    local svc = newInstance(name)
    rgets(svc, "Name", name)
    rgets(svc, "_parent", self)
    self._children[#self._children + 1] = svc
    local props = rget(svc, "_props")
    local extra = SERVICE_MEMBERS[name]
    if extra ~= nil then for k, v in pairs(extra) do props[k] = v end end
    M._services[name] = svc
    return svc
  end

  function methods:HttpGet()
    return nil
  end

  local props = {
    Name = true, Parent = true, Value = true, Text = true, Enabled = true,
  }

  Instance_mt.__index = function(self, key)
    local method = methods[key]
    if method then
      return method
    end
    local prop = rget(self, "_props")[key]
    if prop ~= nil then
      return prop
    end
    if key == "Parent" then
      -- a service's Parent is the DataModel, so reading Parent has to answer
      -- from the parent slot the writer maintains, not from a separate copy
      return rget(self, "_parent")
    end
    error(tostring(key) .. " is not a valid member of " .. tostring(rget(self, "ClassName")), 2)
  end

  Instance_mt.__newindex = function(self, key, value)
    if key == "Parent" then
      local me = meOf(self)
      local old = rget(self, "_parent")
      if old and old._children then
        for i, child in ipairs(old._children) do
          if child == me then
            table.remove(old._children, i)
            break
          end
        end
      end
      rgets(self, "_parent", value)
      if value and value._children then
        value._children[#value._children + 1] = me
      end
      return
    end
    rget(self, "_props")[key] = value
  end

  Instance_mt.__tostring = function(self)
    return rget(self, "Name") or rget(self, "ClassName") or "Instance"
  end

  -- Parent lives behind __index/__newindex, so mirror it into a table slot.
  Instance_mt.__index = (function(inner)
    return function(self, key)
      if key == "Parent" then
        return rget(self, "_parent")
      end
      return inner(self, key)
    end
  end)(Instance_mt.__index)

  M.newInstance = newInstance
  M._services = {}

  setmetatable(M, { __index = {} })

  local shimInstance = {}
  function shimInstance.new(className, parent)
    if type(className) ~= "string" or not KNOWN_CLASSES[className] then
      error(tostring(className) .. " is not a valid class name", 2)
    end
    local inst = newInstance(className)
    if parent then
      inst.Parent = parent
    end
    return inst
  end

  -- typeof: Roblox's flavour. Instances and EnumItems get their own names,
  -- everything else falls through to the host's typeof/type.
  local EnumItem_mt = { __tostring = function(self) return self.Name end }

  local function shimTypeof(value)
    if isInstance(value) then
      return "Instance"
    end
    if type(value) == "table" and getmetatable(value) == EnumItem_mt then
      return "EnumItem"
    end
    return raw_typeof(value)
  end

  -- Enum: only the shapes the gate and the tests touch.
  local function enumItem(enumName, name, value)
    return setmetatable({ EnumType = enumName, Name = name, Value = value }, EnumItem_mt)
  end
  local shimEnum = {
    PartType = {
      Ball = enumItem("PartType", "Ball", 0),
      Block = enumItem("PartType", "Block", 1),
      Cylinder = enumItem("PartType", "Cylinder", 2),
    },
    Material = {
      Plastic = enumItem("Material", "Plastic", 256),
      Neon = enumItem("Material", "Neon", 288),
    },
    EasingStyle = {
      Linear = enumItem("EasingStyle", "Linear", 0),
    },
  }

  -- task: on the CLI there is no scheduler, so spawn/defer run inline and wait
  -- does not yield. Artifacts must not depend on the timing.
  local shimTask = {
    spawn = function(fn, ...)
      return fn(...)
    end,
    defer = function(fn, ...)
      return fn(...)
    end,
    delay = function(_, fn, ...)
      return fn(...)
    end,
    wait = function()
      return 0
    end,
    cancel = function() end,
  }

  -- Build the DataModel and the services the artifact asks for.
  local shimGame = newInstance("DataModel")
  shimGame.Name = "Game"

  local function addService(name)
    local svc = newInstance(name)
    svc.Name = name
    rgets(svc, "_parent", shimGame)
    shimGame._children[#shimGame._children + 1] = svc
    M._services[name] = svc
    return svc
  end

  local Players = addService("Players")
  addService("RunService")
  addService("Workspace")
  addService("HttpService")
  addService("CoreGui")
  addService("TweenService")

  Players.LocalPlayer = nil
  -- The members the API atlas interrogates. A genuine client has them, so this
  -- host has them: a host that is missing its own service API is a host the
  -- artifact is entitled to distrust.
  Players.GetPlayers = function(self)
    return {}
  end
  -- written through _props: reading an absent member on an instance raises, the
  -- way it does in Roblox, so the host fills its own API in from the inside
  local function ensureMember(inst, key, value)
    if inst == nil then return end
    local props = rget(inst, "_props")
    if props[key] == nil then props[key] = value end
  end
  ensureMember(Players, "PlayerAdded", signalStub())
  ensureMember(Players, "PlayerRemoving", signalStub())
  ensureMember(M._services.RunService, "Heartbeat", signalStub())
  ensureMember(M._services.RunService, "RenderStepped", signalStub())
  ensureMember(M._services.TweenService, "Create", function() return { Play = function() end, Cancel = function() end, Completed = signalStub() } end)

  local shimWorkspace = M._services.Workspace
  shimWorkspace.Name = "Workspace"

  -- The Luau CLI exposes a readonly _G, so globals are assigned directly (they
  -- land in _ENV, which is what an artifact's global reads resolve against).
  game = shimGame
  workspace = shimWorkspace
  Instance = shimInstance
  Enum = shimEnum
  task = shimTask
  typeof = shimTypeof
  if warn == nil then
    warn = function(...)
      return print(...)
    end
  end
  if tick == nil then tick = os.clock end
  if time == nil then time = os.time end
  if wait == nil then
    wait = function()
      return 0
    end
  end
  if spawn == nil then spawn = shimTask.spawn end
  if delay == nil then delay = shimTask.delay end
  if Vector3 == nil then
    Vector3 = {
      new = function(x, y, z)
        local vx, vy, vz = x or 0, y or 0, z or 0
        local len = math.sqrt(vx * vx + vy * vy + vz * vz)
        return {
          X = vx,
          Y = vy,
          Z = vz,
          Magnitude = len,
          Unit = { X = vx, Y = vy, Z = vz, Magnitude = 1 },
        }
      end,
    }
    Vector3.zero = Vector3.new(0, 0, 0)
    Vector3.one = Vector3.new(1, 1, 1)
  end
  if Color3 == nil then
    Color3 = {
      new = function(r, g, b)
        return { R = r or 0, G = g or 0, B = b or 0 }
      end,
      fromRGB = function(r, g, b)
        return { R = r / 255, G = g / 255, B = b / 255 }
      end,
    }
  end
  if UDim2 == nil then
    UDim2 = {
      new = function()
        return {}
      end,
    }
  end
  if CFrame == nil then
    CFrame = {
      new = function(x, y, z)
        local pos = { X = x or 0, Y = y or 0, Z = z or 0 }
        return {
          X = pos.X,
          Y = pos.Y,
          Z = pos.Z,
          Position = Vector3.new(pos.X, pos.Y, pos.Z),
          LookVector = Vector3.new(0, 0, -1),
          p = pos,
        }
      end,
    }
    CFrame.identity = CFrame.new(0, 0, 0)
  end
  if Vector2 == nil then
    Vector2 = {
      new = function(x, y)
        return { X = x or 0, Y = y or 0 }
      end,
    }
  end
  if UDim == nil then
    UDim = {
      new = function(scale, offset)
        return { Scale = scale or 0, Offset = offset or 0 }
      end,
    }
  end
  if NumberRange == nil then
    NumberRange = {
      new = function(a, b)
        return { Min = a or 0, Max = b or a or 0 }
      end,
    }
  end
  if BrickColor == nil then
    BrickColor = {
      new = function()
        return { Number = 194, Name = "Medium stone grey", r = 0.64, g = 0.64, b = 0.64 }
      end,
      random = function()
        return BrickColor.new()
      end,
    }
  end
  if Random == nil then
    Random = {
      new = function(seed)
        local state = (seed or 1) + 0
        return {
          NextNumber = function()
            state = (state * 16807) % 2147483647
            return state / 2147483647
          end,
          NextInteger = function(lo, hi)
            return lo or 1
          end,
        }
      end,
    }
  end
  if tick == nil then tick = function() return 0 end end
  if time == nil then time = function() return 0 end end
  if warn == nil then
    warn = function(...)
      local parts = {}
      for i = 1, select("#", ...) do parts[i] = tostring((select(i, ...))) end
      print("warn", table.concat(parts, " "))
    end
  end
  if wait == nil then wait = function() return 0 end end
  if spawn == nil then spawn = function(f, ...) if type(f) == "function" then pcall(f, ...) end end end
  if delay == nil then delay = function(_, f, ...) if type(f) == "function" then pcall(f, ...) end end end
  if os == nil then os = {} end
  if os.time == nil then os.time = function() return 0 end end
  if os.clock == nil then os.clock = function() return 0 end end

  M.game = shimGame
  M.workspace = shimWorkspace
  M.Enum = shimEnum
  M.task = shimTask

  -- No `return` here: this file is a prelude that gets concatenated in front of
  -- an artifact, and the artifact's own top-level return has to be the chunk's.
end
