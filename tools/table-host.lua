--[[
  A dumped environment.

  This is what an environment log turns into when it is replayed somewhere else:
  every API call the artifact makes is answered, with the right names, the right
  class names, the right parents and the right identities - but the objects are
  Lua tables, because a log records *answers*, not an engine. Nothing here is a
  deliberate lie: a logger that records `game:GetService("Players")` and hands the
  recording back produces exactly this shape.

  specs: the artifact must refuse to run here (spec/hosts.json "dumped-env"), and
  it must run on tools/roblog.lua, which models the same API out of userdata.
]]
do
  local type, setmetatable, tostring, pcall, error, ipairs, pairs = type, setmetatable, tostring, pcall, error, ipairs, pairs
  local Instance_mt = {}
  local services = {}
  local byClass = {}

  local function inst(className)
    local self = { ClassName = className, Name = className, Parent = nil, _kids = {} }
    return setmetatable(self, Instance_mt)
  end

  local methods = {}
  function methods:IsA(name) return name == self.ClassName or name == "Instance" end
  function methods:GetChildren()
    local out = {}
    for i, v in ipairs(self._kids) do out[i] = v end
    return out
  end
  function methods:GetDescendants() return self:GetChildren() end
  function methods:FindFirstChild(name)
    for _, v in ipairs(self._kids) do if v.Name == name then return v end end
    return nil
  end
  function methods:WaitForChild(name) return self:FindFirstChild(name) end
  function methods:Destroy()
    self.Parent = nil
  end
  function methods:GetService(name)
    return services[name]
  end

  Instance_mt.__index = function(self, key)
    local m = methods[key]
    if m ~= nil then return m end
    local v = rawget(self, key)
    if v ~= nil then return v end
    if key == "Parent" then return rawget(self, "_parent") end
    return nil
  end
  Instance_mt.__newindex = function(self, key, value)
    if key == "Parent" then
      rawset(self, "_parent", value)
      if value ~= nil and value._kids ~= nil then value._kids[#value._kids + 1] = self end
      return
    end
    rawset(self, key, value)
  end
  Instance_mt.__tostring = function(self) return tostring(self.Name) end

  local game = inst("DataModel")
  game.Name = "Game"

  local SERVICE_NAMES = {
    "Players", "RunService", "Workspace", "Lighting", "TweenService", "UserInputService",
    "ReplicatedStorage", "ReplicatedFirst", "ServerStorage", "ServerScriptService",
    "StarterGui", "StarterPack", "StarterPlayer", "SoundService", "Chat", "Teams",
    "CollectionService", "HttpService", "MarketplaceService", "TeleportService",
    "PathfindingService", "PhysicsService", "PolicyService", "GuiService",
    "LocalizationService", "ContentProvider", "Debris", "BadgeService", "DataStoreService",
    "MemoryStoreService", "MessagingService", "GroupService", "InsertService",
    "AssetService", "VRService", "HapticService", "SocialService", "TextService",
    "LogService", "CoreGui", "ContextActionService", "ProximityPromptService",
    "VoiceChatService", "AvatarEditorService", "FriendService", "MaterialService",
    "SessionService", "UserService",
  }
  for _, name in ipairs(SERVICE_NAMES) do
    local s = inst(name)
    s.Name = name
    s.Parent = game
    s.GetPlayers = function() return {} end
    s.PlayerAdded = { Connect = function() return { Disconnect = function() end } end }
    s.Heartbeat = { Connect = function() return { Disconnect = function() end } end }
    s.Create = function() return { Play = function() end } end
    s.InputBegan = { Connect = function() return { Disconnect = function() end } end }
    s.IsKeyDown = function() return false end
    services[name] = s
  end

  local CLASSES = {}
  for _, c in ipairs({
    "Part", "WedgePart", "SpawnLocation", "Folder", "Model", "Camera", "Attachment",
    "ScreenGui", "Frame", "TextLabel", "TextButton", "ImageLabel", "Sound",
    "ObjectValue", "StringValue", "NumberValue", "BoolValue", "BindableEvent",
    "RemoteEvent", "Configuration",
  }) do CLASSES[c] = true end

  local shimInstance = {}
  function shimInstance.new(className, parent)
    if not CLASSES[className] then error(tostring(className) .. " is not a valid class name", 2) end
    local o = inst(className)
    if parent ~= nil then o.Parent = parent end
    return o
  end

  local realTypeof = typeof or type
  local function shimTypeof(v)
    if type(v) == "table" and getmetatable(v) == Instance_mt then return "Instance" end
    return realTypeof(v)
  end

  local env = getfenv(1)
  env.game = game
  env.workspace = services.Workspace
  env.Workspace = services.Workspace
  env.Instance = shimInstance
  env.typeof = shimTypeof
  env.Enum = { PartType = { Ball = setmetatable({ Name = "Ball" }, { __tostring = function() return "Ball" end }) } }
end
