--[[
  robloxhost.lua — a fatter Roblox host for running *other people's* scripts.

  roblog.lua is deliberately thin: it implements exactly the surface the loader's
  host gate probes, so a sloppy fake gets rejected. That makes it the wrong host
  for asking "does an obfuscated copy of this third-party script still behave like
  the original?" — a real script touches signals, instances, datatypes and a dozen
  services, and a thin shim dies on the first of those, which tells you nothing
  about the transformation.

  This file is the opposite trade-off. It is wide rather than strict: enough of
  the engine that a real script runs to completion, with a permissive fallback for
  members nobody modelled, so the run reaches the parts that matter instead of
  stopping at the first unknown name.

  It is only ever used to compare a script against its obfuscated copy on the same
  host, so fidelity that both sides see equally is optional; *determinism* is not.
  Everything here is deterministic: no clock, no random, no I/O.

  Usage: concatenate in front of the script, then the script.
]]

do
  local rawtype, rawget, rawset = type, rawget, rawset
  local setmetatable, getmetatable, tostring, tonumber = setmetatable, getmetatable, tostring, tonumber
  local select, pcall, error, unpack = select, pcall, error, unpack or table.unpack
  local floor, abs, max, min = math.floor, math.abs, math.max, math.min
  local concat = table.concat
  local insert, remove = table.insert, table.remove
  local sort = table.sort

  local realtypeof = typeof or function(v) return rawtype(v) end
  local M = {}

  -- ---------------------------------------------------------------- values ---
  -- A ScriptSignature-ish universal value: truthy, callable, indexable, and
  -- printable. Anything the host does not model degrades to one of these instead
  -- of raising, so an unmodelled corner of the API does not end the run.
  local Universal = {}
  Universal.__index = function(t, k)
    if k == "ClassName" then return "Instance" end
    if k == "Name" then return "Universal" end
    if k == "Parent" then return nil end
    local v = Universal.new()
    rawset(t, k, v)
    return v
  end
  Universal.__call = function(t, ...) return t end
  Universal.__tostring = function() return "Universal" end
  Universal.__concat = function(a, b) return tostring(a) .. tostring(b) end
  Universal.__len = function() return 0 end
  Universal.__eq = function() return false end
  Universal.__lt = function() return false end
  Universal.__le = function() return false end
  Universal.__add = function() return 0 end
  Universal.__sub = function() return 0 end
  Universal.__mul = function() return 0 end
  Universal.__div = function() return 1 end
  Universal.__mod = function() return 0 end
  Universal.__unm = function() return 0 end
  Universal.__newindex = function(t, k, v) rawset(t, k, v) end
  function Universal.new()
    local u = setmetatable({}, Universal)
    return u
  end
  local UNIVERSAL = Universal.new()

  -- ----------------------------------------------------------------- signal ---
  local Connection = {}
  Connection.__index = Connection
  function Connection:Disconnect() self.connected = false end
  function Connection:disconnect() self.connected = false end

  local Signal = {}
  Signal.__index = Signal
  function Signal.new(name)
    return setmetatable({ name = name or "Signal", _handlers = {}, _fired = 0 }, Signal)
  end
  function Signal:Connect(fn)
    local c = setmetatable({ connected = true, fn = fn, signal = self }, Connection)
    insert(self._handlers, c)
    return c
  end
  function Signal:connect(fn) return self:Connect(fn) end
  function Signal:Once(fn)
    local c
    c = self:Connect(function(...)
      if c.connected then c.connected = false end
      return fn(...)
    end)
    return c
  end
  function Signal:once(fn) return self:Once(fn) end
  function Signal:Wait()
    -- a blocked script would hang the comparison, so waiting yields the last
    -- fired arguments (or nothing) instead of suspending forever
    self._fired = self._fired + 1
    return table.unpack(self._last or {})
  end
  function Signal:wait() return self:Wait() end
  function Signal:Fire(...)
    self._fired = self._fired + 1
    self._last = { ... }
    local snapshot = {}
    for i = 1, #self._handlers do snapshot[i] = self._handlers[i] end
    for i = 1, #snapshot do
      local c = snapshot[i]
      if c.connected then pcall(c.fn, ...) end
    end
  end
  function Signal:fire(...) return self:Fire(...) end
  function Signal:DisconnectAll() self._handlers = {} end

  -- --------------------------------------------------------------- instance ---
  -- The service members the API atlas interrogates, so that a service which has
  -- them in Roblox has them here.
  local function hostSignal()
    local c = { Disconnect = function() end, disconnect = function() end, Connected = true }
    local s = {}
    s.Connect = function(_, fn) if type(fn) == "function" then pcall(fn, nil) end return c end
    s.connect = s.Connect
    s.Wait = function() end
    s.wait = s.Wait
    return s
  end
  local SERVICE_MEMBERS = {
    Players = {
      GetPlayers = function() return {} end,
      PlayerAdded = hostSignal,
      PlayerRemoving = hostSignal,
    },
    RunService = {
      Heartbeat = hostSignal,
      RenderStepped = hostSignal,
      Stepped = hostSignal,
    },
    TweenService = {
      Create = function() return { Play = function() end, Cancel = function() end, Completed = hostSignal() } end,
    },
    UserInputService = {
      InputBegan = hostSignal,
      InputEnded = hostSignal,
      IsKeyDown = function() return false end,
    },
    CollectionService = {
      GetTagged = function() return {} end,
      GetTags = function() return {} end,
      AddTag = function() end,
    },
  }
  local Instance_mt = {}
  local SIGNAL_MEMBERS = {
    Changed = true, ChildAdded = true, ChildRemoved = true, DescendantAdded = true,
    DescendantRemoving = true, AncestryChanged = true, AttributeChanged = true,
    Touched = true, TouchEnded = true, Destroying = true,
  }

  -- Instances are userdata in Roblox (`type(part)` is "userdata", `rawget` on one
  -- raises, `ClassName` is read only), so this host models them that way too: a
  -- proxy over the table that holds the fields. See tools/roblog.lua for the same
  -- argument.
  local backing = setmetatable({}, { __mode = "k" })
  local proxyOf = setmetatable({}, { __mode = "k" })
  local function meOf(self) local p = proxyOf[self] if p ~= nil then return p end return self end
  local function isInstance(v)
    return rawtype(v) == "userdata" and backing[v] ~= nil
  end

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

  local function newInstance(className, name)
    local self = setmetatable({
      ClassName = className,
      Name = name or className,
      _children = {},
      _props = {},
      _signals = {},
    }, Instance_mt)
    local proxy = newproxy(true)
    local mt = getmetatable(proxy)
    mt.__index = function(_, key) return self[key] end
    mt.__newindex = function(_, key, value)
      if key == "ClassName" then
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

  local function instanceSignal(self, key)
    local s = rget(self, "_signals")[key]
    if s == nil then
      s = Signal.new(key)
      rget(self, "_signals")[key] = s
    end
    return s
  end

  local instanceMethods = {}

  function instanceMethods:IsA(cls)
    if cls == "Instance" then return true end
    local c = rget(self, "ClassName")
    if c == cls then return true end
    -- the handful of superclasses a script actually asks about
    local chains = {
      Part = { "BasePart", "PVInstance" },
      MeshPart = { "BasePart", "PVInstance" },
      Script = { "BaseScript", "LuaSourceContainer" },
      LocalScript = { "BaseScript", "LuaSourceContainer" },
      ModuleScript = { "LuaSourceContainer" },
      Workspace = { "Model", "PVInstance" },
      Model = { "PVInstance" },
      Folder = {},
      Humanoid = {},
      Player = {},
      Tool = { "BackpackItem" },
    }
    local chain = chains[c]
    if chain then
      for i = 1, #chain do if chain[i] == cls then return true end end
    end
    return false
  end
  function instanceMethods:GetChildren()
    local out = {}
    local kids = rget(self, "_children")
    for i = 1, #kids do out[i] = kids[i] end
    return out
  end
  function instanceMethods:GetDescendants()
    local out = {}
    local function walk(node)
      local kids = rget(node, "_children") or {}
      for i = 1, #kids do
        out[#out + 1] = kids[i]
        walk(kids[i])
      end
    end
    walk(self)
    return out
  end
  function instanceMethods:FindFirstChild(name, recursive)
    local kids = rget(self, "_children")
    for i = 1, #kids do
      if kids[i].Name == name then return kids[i] end
    end
    if recursive then
      for i = 1, #kids do
        local hit = kids[i]:FindFirstChild(name, true)
        if hit then return hit end
      end
    end
    return nil
  end
  function instanceMethods:FindFirstChildOfClass(cls)
    local kids = rget(self, "_children")
    for i = 1, #kids do
      if kids[i].ClassName == cls then return kids[i] end
    end
    return nil
  end
  function instanceMethods:FindFirstChildWhichIsA(cls)
    local kids = rget(self, "_children")
    for i = 1, #kids do
      if kids[i]:IsA(cls) then return kids[i] end
    end
    return nil
  end
  function instanceMethods:FindFirstAncestorOfClass(cls)
    local p = rget(self, "Parent")
    while p do
      if p.ClassName == cls then return p end
      p = p.Parent
    end
    return nil
  end
  function instanceMethods:WaitForChild(name, timeout)
    local hit = self:FindFirstChild(name)
    if hit then return hit end
    -- never block: a wait would hang the comparison
    return self:FindFirstChild(name) or nil
  end
  function instanceMethods:GetAttribute(name) return rget(self, "_props")[name] end
  function instanceMethods:SetAttribute(name, value) rget(self, "_props")[name] = value end
  function instanceMethods:GetAttributes()
    local out = {}
    for k, v in next, rget(self, "_props") do out[k] = v end
    return out
  end
  function instanceMethods:GetFullName()
    local parts = {}
    local node = self
    while node do
      insert(parts, 1, node.Name)
      node = rget(node, "Parent")
    end
    return concat(parts, ".")
  end
  function instanceMethods:Destroy()
    local p = rget(self, "Parent")
    if p then
      local kids = rget(p, "_children")
      for i = #kids, 1, -1 do
        if kids[i] == self then remove(kids, i) end
      end
    end
    rgets(self, "Parent", nil)
    rgets(self, "_destroyed", true)
  end
  function instanceMethods:Remove() return self:Destroy() end
  function instanceMethods:ClearAllChildren()
    local kids = rget(self, "_children")
    for i = #kids, 1, -1 do kids[i]:Destroy() end
  end
  function instanceMethods:Clone()
    local copy = newInstance(rget(self, "ClassName"), rget(self, "Name"))
    for k, v in next, rget(self, "_props") do rget(copy, "_props")[k] = v end
    local kids = rget(self, "_children")
    for i = 1, #kids do
      local c = kids[i]:Clone()
      c.Parent = copy
    end
    return copy
  end
  function instanceMethods:Raycast(origin, direction, params)
    return nil
  end
  function instanceMethods:FindPartOnRay(ray, ignore)
    return nil, vec3(0, 0, 0), vec3(0, 1, 0)
  end
  function instanceMethods:GetPartBoundsInBox(cf, size, params)
    return {}
  end
  function instanceMethods:GetPartBoundsInRadius(pos, radius, params)
    return {}
  end
  function instanceMethods:GetPropertyChangedSignal(name) return instanceSignal(self, "prop:" .. tostring(name)) end

  Instance_mt.__index = function(self, key)
    local v = rget(self, key)
    if v ~= nil then return v end
    local m = instanceMethods[key]
    if m then return m end
    if SIGNAL_MEMBERS[key] then return instanceSignal(self, key) end
    -- an unset property is nil, not a signal: `game.Parent` must read nil the way
    -- a DataModel's does, and a PascalCase fallback that invents one for every
    -- unknown name got exactly that wrong
    if key == "Parent" then return nil end
    -- Roblox signals are PascalCase and so are properties; a name that looks like
    -- a signal is served as one, because `x.Changed:Connect(f)` is the shape that
    -- appears in real scripts far more often than anything else unknown.
    -- A *service* is looked up by name, and Roblox raises for a member it does
    -- not have; the wide host keeps its forgiving UNIVERSAL behaviour for plain
    -- instances (third-party scripts probe optional properties there) but not for
    -- the services an artifact interrogates.
    if rget(self, "_service") then
      local extra = SERVICE_MEMBERS[rget(self, "ClassName")]
      if extra ~= nil and extra[key] ~= nil then
        local v = extra[key](self)
        rawset(rget(self, "_props"), key, v)
        return v
      end
      error(tostring(key) .. " is not a valid member of " .. tostring(rget(self, "ClassName")), 2)
    end
    local first = string.sub(tostring(key), 1, 1)
    if first == first:upper() then
      local sig = instanceSignal(self, key)
      rawset(self, key, sig)
      return sig
    end
    return UNIVERSAL
  end

  Instance_mt.__newindex = function(self, key, value)
    if key == "Parent" then
      local me = meOf(self)
      local old = rget(self, "Parent")
      if old and isInstance(old) then
        local kids = rget(old, "_children")
        for i = #kids, 1, -1 do if kids[i] == me then remove(kids, i) end end
      end
      rgets(self, "Parent", value)
      if value and isInstance(value) then insert(rget(value, "_children"), me) end
      return
    end
    rawset(self, key, value)
  end

  Instance_mt.__tostring = function(self)
    return rget(self, "Name") or rget(self, "ClassName") or "Instance"
  end

  -- -------------------------------------------------------------- datatypes ---
  local function vec3(x, y, z)
    local v = { X = x or 0, Y = y or 0, Z = z or 0 }
    local mt = { __name = "Vector3" }
    mt.__index = function(t, k)
      if k == "Magnitude" then
        return math.sqrt(t.X * t.X + t.Y * t.Y + t.Z * t.Z)
      elseif k == "Unit" then
        local m = t.Magnitude
        if m == 0 then return vec3(0, 0, 0) end
        return vec3(t.X / m, t.Y / m, t.Z / m)
      end
      return function(a, b)
        if k == "Dot" then return a.X * b.X + a.Y * b.Y + a.Z * b.Z end
        if k == "Cross" then
          return vec3(a.Y * b.Z - a.Z * b.Y, a.Z * b.X - a.X * b.Z, a.X * b.Y - a.Y * b.X)
        end
        if k == "Lerp" then
          return vec3(a.X + (b.X - a.X) * b, a.Y + (b.Y - a.Y) * b, a.Z + (b.Z - a.Z) * b)
        end
        return 0
      end
    end
    mt.__add = function(a, b) return vec3(a.X + b.X, a.Y + b.Y, a.Z + b.Z) end
    mt.__sub = function(a, b) return vec3(a.X - b.X, a.Y - b.Y, a.Z - b.Z) end
    mt.__mul = function(a, b)
      if rawtype(b) == "number" then return vec3(a.X * b, a.Y * b, a.Z * b) end
      if rawtype(a) == "number" then return vec3(b.X * a, b.Y * a, b.Z * a) end
      return vec3(a.X * b.X, a.Y * b.Y, a.Z * b.Z)
    end
    mt.__div = function(a, b) return vec3(a.X / b, a.Y / b, a.Z / b) end
    mt.__unm = function(a) return vec3(-a.X, -a.Y, -a.Z) end
    mt.__eq = function(a, b) return a.X == b.X and a.Y == b.Y and a.Z == b.Z end
    mt.__tostring = function(a) return concat({ a.X, a.Y, a.Z }, ", ") end
    return setmetatable(v, mt)
  end

  local function color3(r, g, b)
    return setmetatable({ R = r or 0, G = g or 0, B = b or 0 }, {
      __index = function(t, k)
        if k == "fromRGB" or k == "FromRGB" then
          return function(a, c, d) return color3((a or 0) / 255, (c or 0) / 255, (d or 0) / 255) end
        end
        if k == "fromHSV" then return function() return color3(0, 0, 0) end end
        if k == "ToHSV" then return function() return 0, 0, 0 end end
        if k == "Lerp" then return function(x, y, a) return x end end
        return UNIVERSAL
      end,
      __tostring = function(t) return concat({ t.R, t.G, t.B }, ", ") end,
      __eq = function(a, b) return a.R == b.R and a.G == b.G and a.B == b.B end,
    })
  end

  local function cframe() return setmetatable({}, {
    __index = function(t, k)
      if k == "new" then return cframe end
      if k == "p" then return vec3(0, 0, 0) end
      if k == "Position" then return vec3(0, 0, 0) end
      return function() return t end
    end,
    __mul = function(a, b) return a end,
    __tostring = function() return "CFrame" end,
  }) end

  local function udim(s, o) return setmetatable({ Scale = s or 0, Offset = o or 0 }, {
    __name = "UDim",
    __add = function(a, b) return udim(a.Scale + b.Scale, a.Offset + b.Offset) end,
    __tostring = function(a) return tostring(a.Scale) end,
  }) end

  local function udim2(xs, xo, ys, yo)
    return setmetatable({ X = udim(xs, xo), Y = udim(ys, yo) }, {
      __name = "UDim2",
      __index = function(t, k)
        if k == "fromScale" then return function(a, c) return udim2(a, 0, c, 0) end end
        if k == "fromOffset" then return function(a, c) return udim2(0, a, 0, c) end end
        if k == "new" then return function(a, c, d, e) return udim2(a, c, d, e) end end
        return UNIVERSAL
      end,
      __tostring = function() return "UDim2" end,
    })
  end

  local function enumItem(name, value)
    return setmetatable({ Name = name, Value = value, EnumType = name }, {
      __tostring = function(t) return "Enum." .. tostring(t.Name) end,
    })
  end

  local function enumFamily(names)
    local family = {}
    local mt = {
      __index = function(t, k)
        local e = enumItem(k, #names + 1)
        rawset(t, k, e)
        return e
      end,
      __tostring = function() return "Enum" end,
    }
    for i = 1, #names do family[names[i]] = enumItem(names[i], i) end
    return setmetatable(family, mt)
  end

  -- -------------------------------------------------------------- instances ---
  local KNOWN_SERVICES = {
    Players = true, RunService = true, Workspace = true, Lighting = true,
    ReplicatedStorage = true, ReplicatedFirst = true, ServerStorage = true,
    ServerScriptService = true, StarterGui = true, StarterPack = true,
    SoundService = true, TweenService = true, Debris = true, HttpService = true,
    UserInputService = true, ContextActionService = true, CollectionService = true,
    GuiService = true, TextService = true, ContentProvider = true, TeleportService = true,
    BadgeService = true, MarketplaceService = true, DataStoreService = true,
    MemoryStoreService = true, PathfindingService = true, PhysicsService = true,
    ProximityPromptService = true, InsertService = true, LocalizationService = true,
    LogService = true, Chat = true, Teams = true, Stats = true, NetworkClient = true,
  }
  local services = {}
  -- declared before serviceOf so the closure captures this local instead of
  -- reading a global named gameRoot that is still nil
  local gameRoot
  local function serviceOf(name)
    local s = services[name]
    if s == nil then
      s = newInstance(name, name)
      rgets(s, "_service", true)
      s.Parent = gameRoot
      services[name] = s
    end
    return s
  end

  gameRoot = newInstance("DataModel", "Game")
  gameRoot._services = services
  local workspaceInstance = serviceOf("Workspace")
  -- ClassName is read only on a real instance, so the host does not write it
  -- either: serviceOf created the instance with the right class to begin with.
  workspaceInstance.Name = "Workspace"
  workspaceInstance.Parent = gameRoot

  Instance_mt.__index = (function(inner)
    return function(self, key)
      if key == "GetService" then
        return function(this, name)
          if rawtype(name) ~= "string" then error("GetService expects a string", 2) end
          if name == "Workspace" then return workspaceInstance end
          local known = services[name]
          if known then return known end
          if KNOWN_SERVICES[name] then
            local created = serviceOf(name)
            created.Parent = gameRoot
            return created
          end
          -- indexing a DataModel with a name it does not have raises, and so does
          -- GetService: a host that invents services is not a Roblox host
          error(name .. " is not a valid Service name", 2)
        end
      end
      if key == "FindService" then
        return function(this, name) return services[name] end
      end
      return inner(self, key)
    end
  end)(Instance_mt.__index)

  -- A class this host does not model is not a class it silently invents: the real
  -- Instance.new raises, and an artifact that never checks this cannot tell a
  -- client from a catalogue of table constructors.
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
    "Stats", "NetworkClient", "MemoryStoreService", "MessagingService",
  }) do
    KNOWN_CLASSES[name] = true
  end

  local Instance_new = function(cls, parent)
    if rawtype(cls) ~= "string" then error("Instance.new expects a class name", 2) end
    if not KNOWN_CLASSES[cls] then error(cls .. " is not a valid class name", 2) end
    local inst = newInstance(cls, cls)
    if cls == "Part" then
      inst.Size = vec3(1, 1, 1)
      inst.Position = vec3(0, 0, 0)
      inst.Anchored = false
    end
    if parent ~= nil then inst.Parent = parent end
    return inst
  end

  -- A datatype table: `.new` is the constructor, calling it is sugar for `.new`,
  -- and any unmodelled member degrades to the universal value instead of raising.
  local function dtable(name, methods)
    local t = methods or {}
    return setmetatable(t, {
      __call = function(self, ...)
        local ctor = rget(self, "new")
        if rawtype(ctor) == "function" then return ctor(...) end
        return UNIVERSAL
      end,
      __index = function() return UNIVERSAL end,
      __tostring = function() return name end,
    })
  end

  -- ---------------------------------------------------------------- globals ---
  local startTime = 0
  local clock = 0
  local function tick() clock = clock + 1 / 60 return 1700000000 + clock end

  local taskLib = {
    wait = function(t) clock = clock + (tonumber(t) or 0) return clock, tick() end,
    spawn = function(fn, ...) return pcall(fn, ...) end,
    defer = function(fn, ...) return pcall(fn, ...) end,
    delay = function(_, fn, ...) return pcall(fn, ...) end,
    cancel = function() end,
    synchronize = function() end,
    desynchronize = function() end,
  }

  local typeofShim = function(v)
    if isInstance(v) then return "Instance" end
    local t = rawtype(v)
    if t == "table" then
      local mt = getmetatable(v)
      if mt == Universal then return "Instance" end
      if mt and mt.__name then return mt.__name end
      return "table"
    end
    return realtypeof(v)
  end

  local Players = serviceOf("Players")
  Players.LocalPlayer = newInstance("Player", "Player1")
  Players.LocalPlayer.Parent = Players
  function Players:GetPlayers() return { self.LocalPlayer } end

  local RunService = serviceOf("RunService")
  local heartbeat = Signal.new("Heartbeat")
  RunService.Heartbeat = heartbeat
  RunService.Stepped = Signal.new("Stepped")
  RunService.RenderStepped = Signal.new("RenderStepped")

  local Lighting = serviceOf("Lighting")
  Lighting.ClockTime = 14
  Lighting.Brightness = 2

  local env = {
    game = gameRoot,
    workspace = workspaceInstance,
    Workspace = workspaceInstance,
    script = newInstance("LocalScript", "Script"),
    Instance = setmetatable({ new = Instance_new }, { __index = function() return Instance_new end }),
    Vector3 = dtable("Vector3", { new = vec3, zero = vec3(0, 0, 0), one = vec3(1, 1, 1), xAxis = vec3(1, 0, 0) }),
    Vector2 = dtable("Vector2", { new = function(x, y) return setmetatable({ X = x or 0, Y = y or 0 }, { __name = "Vector2" }) end }),
    CFrame = dtable("CFrame", { new = cframe, identity = cframe() }),
    Color3 = dtable("Color3", {
      new = color3,
      fromRGB = function(a, c, d) return color3((a or 0) / 255, (c or 0) / 255, (d or 0) / 255) end,
      fromHSV = function() return color3(0, 0, 0) end,
    }),
    ColorSequence = dtable("ColorSequence", { new = function() return {} end }),
    NumberSequence = dtable("NumberSequence", { new = function(a, b) return { Min = a, Max = b or a } end }),
    NumberSequenceKeypoint = dtable("NumberSequenceKeypoint", { new = function(t, v) return { Time = t, Value = v } end }),
    BrickColor = dtable("BrickColor", {
      new = function(x)
        if rawtype(x) == "number" then return color3(0.5, 0.5, 0.5) end
        return setmetatable({ Name = tostring(x), Number = 1, Color = color3(0.5, 0.5, 0.5) }, {
          __index = function() return color3(0.5, 0.5, 0.5) end,
        })
      end,
      palette = function(i) return color3(0.5, 0.5, 0.5) end,
      random = function() return color3(0.5, 0.5, 0.5) end,
    }),
    UDim = dtable("UDim", { new = udim }),
    UDim2 = dtable("UDim2", {
      new = function(...) return udim2(...) end,
      fromScale = function(a, c) return udim2(a, 0, c, 0) end,
      fromOffset = function(a, c) return udim2(0, a, 0, c) end,
    }),
    TweenInfo = dtable("TweenInfo", { new = function(...) return { args = { ... } } end }),
    NumberRange = dtable("NumberRange", { new = function(a, b) return { Min = a, Max = b or a } end }),
    Ray = dtable("Ray", { new = function(o, d) return { Origin = o or vec3(0, 0, 0), Direction = d or vec3(0, 0, 1) } end }),
    Region3 = dtable("Region3", { new = function(a, b) return { CFrame = cframe(), Size = vec3(0, 0, 0) } end }),
    Rect = dtable("Rect", { new = function(...) return { args = { ... } } end }),
    Font = dtable("Font", { new = function() return {} end, fromEnum = function() return {} end }),
    Random = dtable("Random", {
      new = function(seed)
        local state = (tonumber(seed) or 1) % 2147483647
        if state == 0 then state = 1 end
        local function step() state = (state * 16807) % 2147483647 return state end
        return setmetatable({
          NextNumber = function(_, a, b)
            local x = step() / 2147483647
            if a then return a + (b - a) * x end
            return x
          end,
          NextInteger = function(_, a, b) return a + floor(step() / 2147483647 * (b - a + 1)) end,
          NextUnitVector = function() return vec3(0, 0, 1) end,
          Shuffle = function(_, t) return t end,
        }, { __name = "Random" })
      end,
    }),
    DateTime = dtable("DateTime", {
      now = function()
        return dtable("DateTimeValue", { UnixTimestamp = 1700000000, FormatLocalTime = function() return "2026-01-01" end })
      end,
      fromUnixTimestamp = function() return dtable("DateTimeValue", { UnixTimestamp = 1700000000 }) end,
    }),
    OverlapParams = dtable("OverlapParams", {
      new = function() return { FilterDescendantsInstances = {}, FilterType = 0, MaxParts = 0 } end,
    }),
    RaycastParams = dtable("RaycastParams", {
      new = function() return { FilterDescendantsInstances = {}, FilterType = 0, IgnoreWater = false } end,
    }),
    PhysicalProperties = dtable("PhysicalProperties", { new = function() return {} end }),
    Enum = setmetatable({
      PartType = enumFamily({ "Ball", "Block", "Cylinder" }),
      KeyCode = enumFamily({ "A", "B", "C", "E", "Escape", "F", "Q", "Unknown" }),
      UserInputType = enumFamily({ "Keyboard", "MouseButton1", "Touch" }),
      EasingStyle = enumFamily({ "Linear", "Quad", "Sine" }),
      Font = enumFamily({ "SourceSans", "Arial" }),
      HumanoidStateType = enumFamily({ "Running", "Jumping" }),
      Material = enumFamily({ "Plastic", "Neon" }),
      RunContext = enumFamily({ "Client", "Server" }),
      TextXAlignment = enumFamily({ "Left", "Center", "Right" }),
    }, { __index = function(t, k)
      local fam = enumFamily({})
      rawset(t, k, fam)
      return fam
    end }),
    task = taskLib,
    typeof = typeofShim,
    warn = function(...) print("WARN", ...) end,
    print = print,
    wait = function(t) return taskLib.wait(t) end,
    spawn = function(fn, ...) return taskLib.spawn(fn, ...) end,
    delay = function(t, fn, ...) return taskLib.delay(t, fn, ...) end,
    tick = tick,
    time = function() return clock end,
    elapsedTime = function() return clock end,
    settings = function() return setmetatable({}, { __index = function() return UNIVERSAL end }) end,
    UserSettings = function() return setmetatable({}, { __index = function() return UNIVERSAL end }) end,
    DateTime = { now = function() return { UnixTimestamp = 1700000000, FormatLocalTime = function() return "2026-01-01" end } end },
    shared = {},
    os = { time = function() return 1700000000 end, clock = function() return clock end,
      date = function(f) return "2026-01-01" end,
      difftime = function(a, b) return a - b end },
    require = function(x) return x end,
    getgenv = function() return env end,
    getgc = function() return {} end,
    hookfunction = function(a) return a end,

  }

  -- Publish into the chunk environment. `_G` is readonly in the Luau CLI (and is
  -- a mirror of the globals rather than the environment itself), but the
  -- environment table is writable, and that is the table an artifact's global
  -- reads resolve against.
  env.gethui = function() return Instance_new("Folder") end
  local ENVT = (getfenv and getfenv(1)) or _ENV
  if ENVT then
    for k, v in next, env do ENVT[k] = v end
  end

  -- Unknown globals resolve to the universal value so a script that reaches for
  -- an executor function (or anything else this host does not model) keeps
  -- going instead of dying on a nil call. HOST_TRACE names them on stdout, once
  -- each, which is how this file grew its list.
  local seen = {}
  local trace = HOST_TRACE == true
  if ENVT then
    -- Chain, do not replace: the CLI's environment has a metatable of its own
    -- that serves the standard library, and overwriting it turned every global
    -- into the universal value, which made scripts "run" and do nothing.
    local prevMeta = getmetatable(ENVT)
    local prevIndex = prevMeta and prevMeta.__index
    setmetatable(ENVT, {
      __index = function(self, key)
        local got
        if rawtype(prevIndex) == "function" then
          got = prevIndex(self, key)
        elseif rawtype(prevIndex) == "table" then
          got = prevIndex[key]
        end
        if got ~= nil then return got end
        if not seen[key] then
          seen[key] = true
          if trace then print("HOST_MISSING " .. tostring(key)) end
        end
        return UNIVERSAL
      end,
    })
  end
end
