/**
 * Eatfuscator Discord bot — full command set (legacy bot.py parity)
 * Prefix: ! . ?
 * Slash: mirrored for every command
 */
const path = require("path");

/**
 * Module resolution: the bot runs on the package that is installed *in the
 * Node runtime*, not on a copy that travels next to this file. The lookup
 * walks the global module roots of this Node binary first (a global
 * `npm install -g discord.js`, `%APPDATA%\npm`, or NODE_PATH) and only then
 * falls back to ordinary `require`, so a stale folder dropped beside the
 * script can never shadow the installed one.
 */
function globalRoots() {
  const roots = [];
  const execDir = path.dirname(process.execPath);
  roots.push(path.join(execDir, "..", "lib", "node_modules")); // unix prefix
  roots.push(path.join(execDir, "node_modules")); // windows prefix
  if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, "npm", "node_modules"));
  for (const p of String(process.env.NODE_PATH || "").split(path.delimiter)) if (p) roots.push(p);
  return roots;
}

function loadInstalled(name) {
  for (const root of globalRoots()) {
    try {
      return require(require.resolve(name, { paths: [root] }));
    } catch (err) {
      if (err.code !== "MODULE_NOT_FOUND") throw err;
    }
  }
  try {
    return require(name);
  } catch (err) {
    if (err.code !== "MODULE_NOT_FOUND") throw err;
  }
  console.error(
    "[bot] FATAL: " + name + " is not installed in this Node.\n" +
    "        install it once for the whole runtime:  npm install -g " + name + "\n" +
    "        (global roots checked: " + globalRoots().join(", ") + ")"
  );
  process.exit(1);
}

const discord = loadInstalled("discord.js");
const {
  Client, GatewayIntentBits, Partials, EmbedBuilder, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, AttachmentBuilder, SlashCommandBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  REST, Routes, PermissionFlagsBits, ChannelType,
} = discord;
const MessageFlags = discord.MessageFlags || {};
const FileBuilder = discord.FileBuilder;
const ContainerBuilder = discord.ContainerBuilder;
const TextDisplayBuilder = discord.TextDisplayBuilder;
const SeparatorBuilder = discord.SeparatorBuilder;
const HAS_V2 = !!(FileBuilder && ContainerBuilder && TextDisplayBuilder && MessageFlags.IsComponentsV2);
const fs = require("fs");
const https = require("https");
const http = require("http");
const os = require("os");
const { obfuscate, parseMinify, minify, inspect } = require("./index");

const TOKEN = process.env.DISCORD_TOKEN || "yourtoken";
if (!TOKEN) {
  console.error("[bot] FATAL: DISCORD_TOKEN environment variable is required.");
  process.exit(1);
}
const GUILD_ID = process.env.DISCORD_GUILD_ID || null;
const OWNER_IDS = new Set(String(process.env.OWNER_IDS || "").split(",").map(s => s.trim()).filter(Boolean));
const INVITE = "https://dsc.gg/yourinvite";
const CRINE_URL = "https://klipy.com/gifs/crine-im-crine";
const PASTEFY_KEY = process.env.PASTEFY_KEY || "yourkey";
const YT_KEY = process.env.YOUTUBE_API || "yourkey";
const DATA_FILE = path.join(__dirname, "bot_data.json");
const VF_FILE = path.join(__dirname, "vf_codes.json");
const OBF_COOLDOWN_MS = 10_000;
const MAX_SOURCE_BYTES = 2_000_000;
const STAFF_ROLES = new Set(["owner", "admin", "support", "moderator"]);
const OWNER_ROLES = new Set(["owner", "admin"]);

const RULES_TEXT = `||@everyone||
# 📜 Rules
> ## 1.No Spamming
> ### Likely Nuke or Self Bot
> ## 2.No Advertising
> ### DM me to collab, no advertising in public channels
> ## 3.No Malicious Message
> ### Do not send malicious Link, File, etc
> ## 4.No NWSD 🔞
> ### RESULT A PERMANENT BAN
> # What Will Result When Violate??
> ## Random From:
> ### Timeout · Kick · Ban`;

const TOS_TEXT = RULES_TEXT;
const TOU_TEXT = `**Terms of Use**\nEatfuscator is provided as-is. Do not use for malware/scams.\nInvite: ${INVITE}`;
const LICENSE_TEXT = `**License**\nEatfuscator · free for personal use.\nDo not resell as your own obfuscator.\n${INVITE}`;

const VERIFY_TUTORIAL = [
  "# ✅ How to Verify",
  "> **1.** Run `!vf` or `/verify` in this channel",
  "> **2.** Check your **DMs** for a 6-character code",
  "> **3.** Submit with `!vf YOURCODE` or `/verify code:YOURCODE`",
  "> **4.** You receive the **Verified** role",
  ">",
  "> Code expires in **5 minutes**. If DM is closed, the code appears here briefly.",
].join("\n");

const OBF_HELP_CHANNEL = [
  "# 🛡️ Obfuscator Help",
  "> Drop a `.lua` / `.luau` file and run `!obf`",
  "> Or paste code in a lua codeblock with `!obf`",
  "> Paste a **raw link** with `!obf <url>`",
  ">",
  "> minify: `false` | `Normal` | `Max` | `Both`",
  "> Slash: `/obf` · Max size **2MB** · Cooldown 10s",
  "> " + INVITE,
].join("\n");

try { process.cwd(); } catch {
  try { process.chdir(path.dirname(__filename)); } catch {
    console.error("[eatfuscator] cwd missing — cd into Eatfuscator first");
    process.exit(1);
  }
}
process.on("uncaughtException", e => console.error("[uncaughtException]", e?.stack || e));
process.on("unhandledRejection", e => console.error("[unhandledRejection]", e?.stack || e));

function loadJSON(p, def = {}) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return def; }
}
function saveJSON(p, d) {
  try { fs.writeFileSync(p, JSON.stringify(d, null, 2)); } catch (e) { console.error("[save]", e.message); }
}
let data = loadJSON(DATA_FILE, { guilds: {}, warns: {} });
let vfPending = loadJSON(VF_FILE, {});
const obfCooldown = new Map();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildModeration,
    GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.GuildMember, Partials.Message],
});
client.on("error", e => console.error("[client]", e?.message || e));
client.on("warn", m => console.warn("[warn]", m));

/* ---------- helpers ---------- */
function autoDelete(msg, ms = 60_000) {
  if (!msg || typeof msg.delete !== "function") return msg;
  setTimeout(() => msg.delete().catch(() => {}), ms);
  return msg;
}

function isBotMessage(msg) {
  if (!msg) return false;
  if (client.user && msg.author?.id === client.user.id) return true;
  if (msg.applicationId && client.user && msg.applicationId === client.user.id) return true;
  return false;
}
function roleNames(member) {
  try { return new Set([...member.roles.cache.values()].map(r => r.name.toLowerCase())); }
  catch { return new Set(); }
}
function isOwner(userId) {
  if (OWNER_IDS.has(String(userId))) return true;
  const o = client.application?.owner;
  if (!o) return false;
  if (o.id === userId) return true;
  if (o.members?.has?.(userId)) return true;
  return false;
}
function isStaffMember(member) {
  if (!member) return false;
  if (isOwner(member.id)) return true;
  const names = roleNames(member);
  for (const n of STAFF_ROLES) if (names.has(n)) return true;
  try {
    return member.permissions.has(PermissionFlagsBits.Administrator) ||
      member.permissions.has(PermissionFlagsBits.ModerateMembers) ||
      member.permissions.has(PermissionFlagsBits.ManageMessages);
  } catch { return false; }
}
function isOwnerAdminMember(member) {
  if (!member) return false;
  if (isOwner(member.id)) return true;
  const names = roleNames(member);
  for (const n of OWNER_ROLES) if (names.has(n)) return true;
  try { return member.permissions.has(PermissionFlagsBits.Administrator); }
  catch { return false; }
}
async function denied(target) {
  const msg = CRINE_URL;
  try {
    if (target.reply) return await target.reply({ content: msg });
    if (target.isRepliable?.()) {
      if (target.deferred || target.replied) return await target.followUp({ content: msg, ephemeral: true });
      return await target.reply({ content: msg, ephemeral: true });
    }
  } catch (e) { console.error("[denied]", e.message); }
}
async function safeReply(interaction, payload, delMs = 60_000) {
  try {
    if (!interaction) return null;
    let msg;
    if (interaction.deferred || interaction.replied) msg = await interaction.editReply(payload);
    else msg = await interaction.reply(payload);
    // ephemeral / keep → no auto-delete; search uses longer delMs
    const ephemeral = payload?.ephemeral || (typeof msg?.flags === "object" && msg.flags?.has?.(1 << 6));
    if (delMs > 0 && msg && !ephemeral) autoDelete(msg, delMs);
    return msg;
  } catch (e) {
    try {
      const msg = await interaction.followUp({ ...payload, ephemeral: true });
      return msg;
    } catch (e2) { console.error("[safeReply]", e2?.message || e?.message); }
    return null;
  }
}
async function safeDefer(interaction, ephemeral = false) {
  try {
    if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ ephemeral });
    return true;
  } catch (e) { console.error("[safeDefer]", e.message); return false; }
}
function parseDuration(s) {
  const m = String(s || "").match(/^(\d+)([smdh])$/i);
  if (!m) return null;
  const v = parseInt(m[1], 10);
  const u = m[2].toLowerCase();
  const mult = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  return v * (mult[u] || 0);
}
function fetchText(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, { timeout: 60000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return fetchText(res.headers.location).then(resolve, reject);
      if (res.statusCode >= 400) return reject(new Error("HTTP " + res.statusCode));
      const chunks = []; let size = 0;
      res.on("data", c => { size += c.length; if (size > MAX_SOURCE_BYTES) { req.destroy(); reject(new Error("file too large")); } chunks.push(c); });
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}
function httpJson(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(url, { method: opts.method || "GET", headers: opts.headers || {}, timeout: 20000 }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        try { resolve({ status: res.statusCode, json: JSON.parse(body), body }); }
        catch { resolve({ status: res.statusCode, json: null, body }); }
      });
    });
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}
function parseFlags(text) {
  let minify = "Normal", rest = text || "";
  const minM = rest.match(/\bminify\s*[:=]\s*(\S+)/i);
  if (minM) { minify = parseMinify(minM[1]); rest = rest.replace(minM[0], " "); }
  // strip leftover seed flags if user pastes old syntax
  rest = rest.replace(/\bseed\s*[:=]\s*\S+/gi, " ").trim();
  return { minify: parseMinify(minify), rest: rest.trim() };
}
function extractCode(text) {
  if (!text) return null;
  const block = text.match(/```(?:lua|luau)?\s*([\s\S]*?)```/i);
  if (block) return block[1];
  const tick = text.match(/`([^`]+)`/);
  if (tick) return tick[1];
  const url = text.match(/https?:\/\/\S+/);
  if (url) return { url: url[0].replace(/[)>.,]+$/, "") };
  return text.trim() || null;
}
function resultEmbed({ size, minify, ms }) {
  return new EmbedBuilder()
    .setTitle("Obfuscation Complete")
    .setDescription(`**Size** \`${size}\` · **Minify** \`${minify}\``)
    .setColor(0x57f287)
    .setFooter({ text: `Took ${(ms / 1000).toFixed(2)}s · Eatfuscator` })
    .setTimestamp();
}
function resultButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("eatf_help").setLabel("Help").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("eatf_modes").setLabel("Minify modes").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setLabel("Invite").setStyle(ButtonStyle.Link).setURL(INVITE),
  );
}
function checkObfCooldown(uid) {
  const now = Date.now(), last = obfCooldown.get(uid) || 0;
  if (now - last < OBF_COOLDOWN_MS) return Math.ceil((OBF_COOLDOWN_MS - (now - last)) / 1000);
  obfCooldown.set(uid, now); return 0;
}
async function runObf(source, minify, seed) {
  const t0 = Date.now();
  if (Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES) throw new Error("source too large");
  const code = await obfuscate(source, { minify, seed, verbose: false });
  const info = inspect(code);
  return {
    code,
    size: Buffer.byteLength(code, "utf8"),
    minify: String(minify),
    ms: Date.now() - t0,
    closures: info.closures,
    handlers: info.handlers,
    banks: info.banks,
    layers: info.layers,
  };
}
async function sendObfResult(replyFn, source, minify, filename) {
  const result = await runObf(source, minify);
  const tmp = path.join(os.tmpdir(), `eatf_${Date.now()}_${Math.random().toString(36).slice(2)}.lua`);
  fs.writeFileSync(tmp, result.code);
  try {
    const attachment = new AttachmentBuilder(tmp, { name: filename });
    // Components V2: file + buttons inside one Container (no classic embed)
    if (HAS_V2) {
      const container = new ContainerBuilder()
        .setAccentColor(0x57f287)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `### Obfuscation Complete\n**Size** \`${result.size}\` bytes · **Minify** \`${result.minify}\`\n**Upvalues** \`${result.closures}\` closures · **VM** \`${result.handlers}\` handlers · **Banks** \`${result.banks}\`\nTook **${(result.ms / 1000).toFixed(2)}s** · Eatfuscator`
          )
        );
      if (SeparatorBuilder) {
        container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
      }
      container.addFileComponents(new FileBuilder().setURL(`attachment://${filename}`));
      container.addActionRowComponents(resultButtons());
      const msg = await replyFn({
        components: [container],
        files: [attachment],
        flags: MessageFlags.IsComponentsV2,
      });
      autoDelete(msg, 60_000);
      return msg;
    }
    // Fallback: classic embed + file + buttons
    const msg = await replyFn({
      embeds: [resultEmbed(result)],
      files: [attachment],
      components: [resultButtons()],
    });
    autoDelete(msg, 60_000);
    return msg;
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}
function vfCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}
async function findRole(guild, name) {
  await guild.roles.fetch().catch(() => {});
  return guild.roles.cache.find(r => r.name.toLowerCase() === name.toLowerCase()) || null;
}
async function ensureRole(guild, name, color) {
  let r = await findRole(guild, name);
  if (r) return r;
  return guild.roles.create({ name, colors: [color], reason: "Eatfuscator setup" });
}
async function findTextChannel(guild, name) {
  await guild.channels.fetch().catch(() => {});
  return guild.channels.cache.find(c => c.type === ChannelType.GuildText && c.name.toLowerCase() === name.toLowerCase()) || null;
}

/** Full setup like bot.py: wipe channels/roles, rebuild categories */

async function setStatusVc(guild, online) {
  const st = data.guilds[guild.id];
  if (!st?.status_vc) return;
  try {
    const ch = await guild.channels.fetch(st.status_vc).catch(() => null);
    if (!ch) return;
    const name = online ? "Obfuscator: 🟢" : "Obfuscator: 🔴";
    if (ch.name !== name) await ch.edit({ name });
  } catch {}
}


/** Recycle: create missing roles/channels only — no wipe */
async function doRecycle(guild, actor) {
  const roles = {
    Owner: await ensureRole("Owner", 0xed4245),
    Admin: await ensureRole("Admin", 0x992d22),
    Moderator: await ensureRole("Moderator", 0x3498db),
    Support: await ensureRole("Support", 0x57f287),
    Booster: await ensureRole("Booster", 0xeb459e),
    Verified: await ensureRole("Verified", 0x1abc9c),
    Member: await ensureRole("Member", 0x95a5a6),
    Bot: await ensureRole("Bot", 0x2c3e50),
  };
  const ensureCat = async (name) => {
    let c = guild.channels.cache.find(x => x.type === ChannelType.GuildCategory && x.name === name);
    if (c) return c;
    return guild.channels.create({ name, type: ChannelType.GuildCategory, reason: "recycle" });
  };
  const cat_server = await ensureCat("📊 | Server");
  const cat_info = await ensureCat("📋 | Info");
  const cat_home = await ensureCat("🏡 | Home");
  const cat_priv = await ensureCat("🔒 | Staff");
  const everyone = guild.roles.everyone;
  const staffList = [roles.Owner, roles.Admin, roles.Moderator, roles.Support];
  const ver = roles.Verified;
  const staffOnly = () => {
    const ow = [{ id: everyone.id, deny: [PermissionFlagsBits.ViewChannel] }];
    for (const r of staffList) ow.push({ id: r.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
    return ow;
  };
  const pread = () => [{ id: everyone.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny: [PermissionFlagsBits.SendMessages] }];
  const pchat = () => [{ id: everyone.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }];
  const vchat = () => [
    { id: everyone.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny: [PermissionFlagsBits.SendMessages] },
    { id: ver.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
  ];
  const ensureTx = async (name, parent, overwrites, topic) => {
    let ch = guild.channels.cache.find(x => x.type === ChannelType.GuildText && x.name === name);
    if (ch) return ch;
    return guild.channels.create({ name, type: ChannelType.GuildText, parent, permissionOverwrites: overwrites || [], topic, reason: "recycle" });
  };
  const ensureVc = async (name, parent, overwrites) => {
    let ch = guild.channels.cache.find(x => x.type === ChannelType.GuildVoice && x.name.startsWith(name.split(":")[0]));
    if (ch && name.includes("Member:")) return ch;
    if (ch && name.includes("Bot:")) return ch;
    ch = guild.channels.cache.find(x => x.type === ChannelType.GuildVoice && x.name === name);
    if (ch) return ch;
    return guild.channels.create({ name, type: ChannelType.GuildVoice, parent, permissionOverwrites: overwrites || [], reason: "recycle" });
  };
  await guild.channels.fetch().catch(() => {});
  const member_vc = await ensureVc(`Member: ${guild.memberCount}`, cat_server, [{ id: everyone.id, allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.Connect] }]);
  const bot_vc = await ensureVc(`Bot: ${guild.members.cache.filter(m => m.user.bot).size}`, cat_server, [{ id: everyone.id, allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.Connect] }]);
  await ensureTx("👋│welcome", cat_server, pread(), "Welcome");
  await ensureTx("🚪│goodbye", cat_server, pread(), "Goodbye");
  await ensureTx("💎│booster", cat_server, pread(), "Boosters");
  const rules = await ensureTx("📜│rules", cat_info, pread(), "Rules");
  await ensureTx("📢│announcements", cat_info, pread(), "News");
  const verify = await ensureTx("✅│verify", cat_info, pchat(), "Verify");
  await ensureTx("💬│general", cat_home, pchat(), "General chat");
  await ensureTx("🤖│bot-commands", cat_home, pchat(), "Bot commands");
  const obf_ch = await ensureTx("🛡️│obfuscate", cat_home, vchat(), "Obfuscator");
  await ensureTx("🖼️│media", cat_home, pchat(), "Media");
  await ensureTx("🎥│clips", cat_home, pchat(), "Clips");
  await ensureTx("🆘│support", cat_home, pchat(), "Support");
  const status = await ensureVc("Obfuscator: 🟢", cat_home, [{ id: everyone.id, allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.Connect] }]);
  await ensureVc("🔊│Lounge", cat_home, pchat());
  await ensureVc("🎮│Gaming", cat_home, pchat());
  await ensureVc("🎵│Music", cat_home, pchat());
  await ensureVc("📞│Support VC", cat_home, pchat());
  const ban_log = await ensureTx("🔨│ban-log", cat_priv, staffOnly(), "Bans");
  await ensureTx("📝│bot-logs", cat_priv, staffOnly(), "Bot logs");
  await ensureTx("🧠│staff-chat", cat_priv, staffOnly(), "Staff");
  await ensureTx("📌│staff-notes", cat_priv, staffOnly(), "Notes");
  await ensureVc("🔒│Staff VC", cat_priv, staffOnly());
  const hp = await ensureTx("🎁│free-nitro", cat_priv, pchat(), "Do not post");
  if (actor) {
    try {
      const m = await guild.members.fetch(actor.id);
      await m.roles.add([roles.Owner, roles.Verified, roles.Member, roles.Support].filter(Boolean));
    } catch {}
  }
  const st = {
    ban_log: ban_log.id, status_vc: status.id, honeypot: hp.id,
    member_vc: member_vc.id, bot_vc: bot_vc.id,
    channelId: obf_ch.id, channelName: obf_ch.name,
    setup_by: actor?.id, setup_at: new Date().toISOString(), recycled: true,
  };
  data.guilds[guild.id] = { ...(data.guilds[guild.id] || {}), ...st };
  saveJSON(DATA_FILE, data);
  return st;
}

async function wipeGuild(guild) {
  const channels = [...guild.channels.cache.values()];
  for (const ch of channels) {
    try { await ch.delete("setup wipe"); } catch {}
  }
  const me = guild.members.me;
  const roles = [...guild.roles.cache.values()];
  for (const role of roles) {
    if (role.managed || role.id === guild.id) continue;
    if (me && role.comparePositionTo(me.roles.highest) >= 0) continue;
    try { await role.delete("setup wipe"); } catch {}
  }
}

async function doSetup(guild, actor) {
  await wipeGuild(guild);

  const mkRole = async (name, color) =>
    guild.roles.create({ name, colors: [color], reason: "setup" });

  const roles = {
    Owner: await mkRole("Owner", 0xed4245),
    Admin: await mkRole("Admin", 0x992d22),
    Moderator: await mkRole("Moderator", 0x3498db),
    Support: await mkRole("Support", 0x57f287),
    Booster: await mkRole("Booster", 0xeb459e),
    Verified: await mkRole("Verified", 0x1abc9c),
    Member: await mkRole("Member", 0x95a5a6),
    Bot: await mkRole("Bot", 0x2c3e50),
  };

  const cat_server = await guild.channels.create({ name: "📊 | Server", type: ChannelType.GuildCategory, reason: "setup" });
  const cat_info = await guild.channels.create({ name: "📋 | Info", type: ChannelType.GuildCategory, reason: "setup" });
  const cat_home = await guild.channels.create({ name: "🏡 | Home", type: ChannelType.GuildCategory, reason: "setup" });
  const cat_priv = await guild.channels.create({ name: "🔒 | Staff", type: ChannelType.GuildCategory, reason: "setup" });

  const everyone = guild.roles.everyone;
  const staffList = [roles.Owner, roles.Admin, roles.Moderator, roles.Support];
  const ver = roles.Verified;

  const staffOnly = () => {
    const ow = [{ id: everyone.id, deny: [PermissionFlagsBits.ViewChannel] }];
    for (const r of staffList) {
      ow.push({ id: r.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
    }
    return ow;
  };
  const pread = () => [{ id: everyone.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny: [PermissionFlagsBits.SendMessages] }];
  const pchat = () => [{ id: everyone.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }];
  const vchat = () => [
    { id: everyone.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny: [PermissionFlagsBits.SendMessages] },
    { id: ver.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
  ];

  const tx = (name, parent, overwrites, topic) =>
    guild.channels.create({ name, type: ChannelType.GuildText, parent, permissionOverwrites: overwrites || [], topic: topic || undefined, reason: "setup" });
  const vc = (name, parent, overwrites) =>
    guild.channels.create({ name, type: ChannelType.GuildVoice, parent, permissionOverwrites: overwrites || [], reason: "setup" });

  const member_vc = await vc(`Member: ${guild.memberCount}`, cat_server, [
    { id: everyone.id, allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.Connect] },
  ]);
  const bot_count = guild.members.cache.filter(m => m.user.bot).size;
  const bot_vc = await vc(`Bot: ${bot_count}`, cat_server, [
    { id: everyone.id, allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.Connect] },
  ]);
  const welcome = await tx("👋│welcome", cat_server, pread(), "Welcome");
  const goodbye = await tx("🚪│goodbye", cat_server, pread(), "Goodbye");
  const booster_ch = await tx("💎│booster", cat_server, pread(), "Boosters");

  const rules = await tx("📜│rules", cat_info, pread(), "Rules");
  try { await rules.send({ content: RULES_TEXT, allowedMentions: { parse: [] } }); } catch {}
  await tx("📢│announcements", cat_info, pread(), "News");
  const verify = await tx("✅│verify", cat_info, pchat(), "Verify");
  try { await verify.send(VERIFY_TUTORIAL); } catch {}

  await tx("💬│general", cat_home, pchat(), "General chat");
  await tx("🤖│bot-commands", cat_home, pchat(), "Bot commands");
  const obf_ch = await tx("🛡️│obfuscate", cat_home, vchat(), "Obfuscator help + verified use");
  try { await obf_ch.send(OBF_HELP_CHANNEL); } catch {}
  await tx("🖼️│media", cat_home, pchat(), "Media");
  await tx("🎥│clips", cat_home, pchat(), "Clips");
  await tx("🆘│support", cat_home, pchat(), "Support");
  const status = await vc("Obfuscator: 🟢", cat_home, [
    { id: everyone.id, allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.Connect] },
  ]);
  await vc("🔊│Lounge", cat_home, pchat());
  await vc("🎮│Gaming", cat_home, pchat());
  await vc("🎵│Music", cat_home, pchat());
  await vc("📞│Support VC", cat_home, pchat());

  const ban_log = await tx("🔨│ban-log", cat_priv, staffOnly(), "Bans");
  await tx("📝│bot-logs", cat_priv, staffOnly(), "Bot logs");
  await tx("🧠│staff-chat", cat_priv, staffOnly(), "Staff");
  await tx("📌│staff-notes", cat_priv, staffOnly(), "Notes");
  await vc("🔒│Staff VC", cat_priv, staffOnly());
  const hp = await tx("🎁│free-nitro", cat_priv, pchat(), "Do not post");

  // Grant actor Owner + Verified + Member + Support
  if (actor) {
    try {
      const m = await guild.members.fetch(actor.id);
      await m.roles.add([roles.Owner, roles.Verified, roles.Member, roles.Support].filter(Boolean));
    } catch {}
  }

  const st = {
    ban_log: ban_log.id,
    status_vc: status.id,
    honeypot: hp.id,
    welcome: welcome.id,
    goodbye: goodbye.id,
    booster_ch: booster_ch.id,
    member_vc: member_vc.id,
    bot_vc: bot_vc.id,
    channelId: obf_ch.id,
    channelName: obf_ch.name,
    setup_by: actor?.id,
    setup_at: new Date().toISOString(),
  };
  data.guilds[guild.id] = st;
  saveJSON(DATA_FILE, data);
  return st;
}

async function pastefyUpload(content, title = "eatfuscator") {
  const body = JSON.stringify({ title, content, visibility: "unlisted" });
  const r = await httpJson("https://pastefy.app/api/v2/paste", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + PASTEFY_KEY, "Content-Length": Buffer.byteLength(body) },
    body,
  });
  if (r.json?.paste?.id) return "https://pastefy.app/" + r.json.paste.id;
  if (r.json?.id) return "https://pastefy.app/" + r.json.id;
  throw new Error("pastefy failed");
}
async function ytSearch(query) {
  const q = encodeURIComponent(query || "cat");
  const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${q}&type=video&maxResults=5&key=${YT_KEY}`;
  const r = await httpJson(url);
  const items = r.json?.items || [];
  if (!items.length) return null;
  const v = items[0];
  return { title: v.snippet?.title || "", id: v.id?.videoId };
}

/* ---------- slash registration ---------- */
async function registerCommands() {
  const cmds = [
    new SlashCommandBuilder().setName("help").setDescription("Help menu"),
    new SlashCommandBuilder().setName("obf").setDescription("Obfuscate Lua/Luau (popup panel)")
      .addAttachmentOption(o => o.setName("file").setDescription(".lua file (optional)"))
      .addStringOption(o => o.setName("code").setDescription("Code or raw URL (optional)"))
      .addStringOption(o => o.setName("minify").setDescription("Minify mode").setRequired(false)
        .addChoices({ name: "Normal", value: "Normal" }, { name: "Max", value: "Max" }, { name: "Both", value: "Both" })),
    new SlashCommandBuilder().setName("minify").setDescription("Minify only (Normal | Max | Both)")
      .addAttachmentOption(o => o.setName("file").setDescription(".lua / .luau / .txt file"))
      .addStringOption(o => o.setName("code").setDescription("Code or raw URL"))
      .addStringOption(o => o.setName("mode").setDescription("Minify mode").setRequired(true)
        .addChoices(
          { name: "Normal", value: "Normal" },
          { name: "Max", value: "Max" },
          { name: "Both", value: "Both" }
        )),
    new SlashCommandBuilder().setName("setup").setDescription("Setup roles/channels (reuse by name)")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder().setName("clear").setDescription("Purge USER messages (bot kept)")
      .addIntegerOption(o => o.setName("amount").setDescription("Count").setRequired(false))
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
    new SlashCommandBuilder().setName("clr").setDescription("Alias of clear")
      .addIntegerOption(o => o.setName("amount").setDescription("Count"))
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
    new SlashCommandBuilder().setName("lock").setDescription("Lock channel")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
    new SlashCommandBuilder().setName("unlock").setDescription("Unlock channel")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
    new SlashCommandBuilder().setName("del").setDescription("Delete this channel")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder().setName("mute").setDescription("Timeout member")
      .addUserOption(o => o.setName("user").setRequired(true))
      .addStringOption(o => o.setName("duration").setDescription("e.g. 10m"))
      .addStringOption(o => o.setName("reason"))
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
    new SlashCommandBuilder().setName("kick").setDescription("Kick member")
      .addUserOption(o => o.setName("user").setRequired(true))
      .addStringOption(o => o.setName("reason"))
      .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers),
    new SlashCommandBuilder().setName("ban").setDescription("Ban member")
      .addUserOption(o => o.setName("user").setRequired(true))
      .addStringOption(o => o.setName("reason"))
      .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),
    new SlashCommandBuilder().setName("warn").setDescription("Warn member")
      .addUserOption(o => o.setName("user").setRequired(true))
      .addStringOption(o => o.setName("reason"))
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
    new SlashCommandBuilder().setName("give").setDescription("Give role")
      .addRoleOption(o => o.setName("role").setRequired(true))
      .addUserOption(o => o.setName("user").setRequired(true))
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),
    new SlashCommandBuilder().setName("remove").setDescription("Remove role")
      .addRoleOption(o => o.setName("role").setRequired(true))
      .addUserOption(o => o.setName("user").setRequired(true))
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),
    new SlashCommandBuilder().setName("kill").setDescription("Shutdown bot (Owner/Admin)"),
    new SlashCommandBuilder().setName("reboot").setDescription("Restart bot process (Owner/Admin)"),
    new SlashCommandBuilder().setName("verify").setDescription("Get/submit verification code")
      .addStringOption(o => o.setName("code").setDescription("Code to submit")),
    new SlashCommandBuilder().setName("up").setDescription("Upload text to Pastefy")
      .addStringOption(o => o.setName("content").setRequired(true)),
    new SlashCommandBuilder().setName("tos").setDescription("Terms / rules"),
    new SlashCommandBuilder().setName("tou").setDescription("Terms of use"),
    new SlashCommandBuilder().setName("license").setDescription("License"),
    new SlashCommandBuilder().setName("search").setDescription("YouTube search")
      .addStringOption(o => o.setName("query").setRequired(true)),
  ].map(c => c.toJSON());

  const rest = new REST({ version: "10" }).setToken(TOKEN);
  const app = await client.application.fetch();
  if (GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(app.id, GUILD_ID), { body: cmds });
    console.log("[bot] guild slash registered");
  } else {
    await rest.put(Routes.applicationCommands(app.id), { body: cmds });
    console.log("[bot] global slash registered");
  }
}

client.once("ready", async () => {
  console.log(`[bot] logged in as ${client.user.tag}`);
  try { await client.application.fetch(); } catch {}
  try { await registerCommands(); } catch (e) { console.error("[slash]", e.message); }
});

/* ---------- interactions ---------- */
client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isButton()) {
      if (interaction.customId === "eatf_help") {
        await interaction.reply({ ephemeral: true, content: helpText() });
        return;
      }
      if (interaction.customId === "eatf_modes") {
        await interaction.reply({ ephemeral: true, content: "**Minify:** `false` · `Normal` · `Max` · `Both`" });
        return;
      }
      if (interaction.customId === "setup_cancel") {
        await interaction.update({ content: "> Cancelled.", components: [] }).catch(() => {});
        return;
      }
      if (interaction.customId === "setup_confirm" || interaction.customId === "setup_recycle") {
        if (!interaction.guild || !isOwnerAdminMember(interaction.member)) {
          await interaction.reply({ ephemeral: true, content: CRINE_URL }).catch(() => {});
          return;
        }
        const recycle = interaction.customId === "setup_recycle";
        await interaction.update({
          content: recycle ? "> Recycling missing channels/roles ..." : "> Wiping & building 🏡 | Home ...",
          components: [],
        }).catch(() => {});
        try {
          const st = recycle
            ? await doRecycle(interaction.guild, interaction.user)
            : await doSetup(interaction.guild, interaction.user);
          const msg = `# ${recycle ? "Recycle" : "Setup"} done\n> obfuscate <#${st.channelId}> · ban-log <#${st.ban_log}>`;
          try { await interaction.user.send(msg); }
          catch { await interaction.followUp({ ephemeral: true, content: msg }).catch(() => {}); }
        } catch (e) {
          console.error("[setup]", e);
          try { await interaction.user.send("Setup error: " + e.message); } catch {}
        }
        return;
      }
      return;
    }

    // Modal submit handler for obf popup panel
    if (interaction.isModalSubmit()) {
      if (interaction.customId === "eatf_obf_modal") {
        const cd = checkObfCooldown(interaction.user.id);
        if (cd > 0) {
          await interaction.reply({ content: `Cooldown **${cd}s**`, ephemeral: true });
          return;
        }
        await safeDefer(interaction);
        try {
          const source = interaction.fields.getTextInputValue("obf_code");
          const minifyStr = interaction.fields.getTextInputValue("obf_minify");
          const minify = parseMinify(minifyStr || "Normal");
          if (!source || !source.trim()) {
            await interaction.editReply({ content: "Need code in the obfuscation field." });
            return;
          }
          if (Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES) {
            await interaction.editReply({ content: "Source too large (max 2MB)." });
            return;
          }
          const t0 = Date.now();
          const code = await obfuscate(source, { minify, verbose: false });
          const size = Buffer.byteLength(code, "utf8");
          const ms = Date.now() - t0;
          const tmp = path.join(os.tmpdir(), `eatf_modal_${Date.now()}_${Math.random().toString(36).slice(2)}.lua`);
          fs.writeFileSync(tmp, code);
          try {
            const attachment = new AttachmentBuilder(tmp, { name: "obfuscated.lua" });
            await interaction.editReply({
              content: `### Obfuscation Complete\n**Size** \`${size}\` bytes · **Minify** \`${minify}\`\nTook **${(ms / 1000).toFixed(2)}s** · Eatfuscator`,
              files: [attachment],
            });
          } finally {
            try { fs.unlinkSync(tmp); } catch {}
          }
        } catch (e) {
          console.error("[obf modal]", e);
          try { await interaction.editReply({ content: `**Error** \`${e.message}\``, ephemeral: true }); } catch {}
        }
        return;
      }
      return;
    }
    if (!interaction.isChatInputCommand()) return;
    const name = interaction.commandName;
    const member = interaction.member;

    if (name === "help") {
      await safeReply(interaction, { embeds: [helpEmbed()], components: [resultButtons()], ephemeral: true });
      return;
    }
    if (name === "tos" || name === "tou" || name === "license") {
      const t = name === "tos" ? TOS_TEXT : name === "tou" ? TOU_TEXT : LICENSE_TEXT;
      await safeReply(interaction, { content: t, ephemeral: true });
      return;
    }
    if (name === "setup") {
      if (!interaction.guild || !isOwnerAdminMember(member)) return denied(interaction);
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("setup_confirm").setLabel("Wipe & rebuild").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId("setup_recycle").setLabel("Recycle channels/roles").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("setup_cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary),
      );
      await safeReply(interaction, {
        content: "# Setup\n> **Wipe & rebuild** — deletes all channels/roles then full layout\n> **Recycle** — keep existing, only create missing channels/roles\nConfirm?",
        components: [row],
        ephemeral: true,
      }, 0);
      return;
    }
    if (name === "clear" || name === "clr") {
      if (!interaction.guild || !isStaffMember(member)) return denied(interaction);
      await safeDefer(interaction, true);
      const amount = Math.min(200, Math.max(1, interaction.options.getInteger("amount") || 50));
      try {
        const msgs = await interaction.channel.messages.fetch({ limit: amount });
        const targets = msgs.filter(m => !isBotMessage(m) && !m.pinned);
        let deleted = 0;
        const bulk = targets.filter(m => Date.now() - m.createdTimestamp < 14 * 86400000);
        if (bulk.size) {
          try { deleted += (await interaction.channel.bulkDelete(bulk, true)).size; }
          catch { for (const m of bulk.values()) { try { await m.delete(); deleted++; } catch {} } }
        }
        await safeReply(interaction, { content: `Cleared **${deleted}** user message(s). Bot kept.` });
      } catch (e) { await safeReply(interaction, { content: `clear failed: ${e.message}` }); }
      return;
    }
    if (name === "lock") {
      if (!isStaffMember(member)) return denied(interaction);
      try {
        await interaction.channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { SendMessages: false });
        await safeReply(interaction, { content: "# Locked" });
      } catch (e) { await safeReply(interaction, { content: `\`${e.message}\``, ephemeral: true }); }
      return;
    }
    if (name === "unlock") {
      if (!isStaffMember(member)) return denied(interaction);
      try {
        await interaction.channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { SendMessages: null });
        await safeReply(interaction, { content: "# Unlocked" });
      } catch (e) { await safeReply(interaction, { content: `\`${e.message}\``, ephemeral: true }); }
      return;
    }
    if (name === "del") {
      if (!isOwnerAdminMember(member)) return denied(interaction);
      await safeReply(interaction, { content: "> Deleting..." });
      setTimeout(() => interaction.channel.delete("del by " + interaction.user.tag).catch(() => {}), 1000);
      return;
    }
    if (name === "mute") {
      if (!isStaffMember(member)) return denied(interaction);
      const user = interaction.options.getUser("user", true);
      const durStr = interaction.options.getString("duration") || "10m";
      const reason = interaction.options.getString("reason") || "No reason";
      const ms = parseDuration(durStr) || 10 * 60000;
      try {
        const m = await interaction.guild.members.fetch(user.id);
        await m.timeout(ms, reason);
        await safeReply(interaction, { embeds: [new EmbedBuilder().setTitle("Muted").setDescription(`${user.tag} · ${durStr} · ${reason}`).setColor(0xfee75c)], components: [resultButtons()] });
      } catch (e) { await safeReply(interaction, { content: `mute failed: ${e.message}`, ephemeral: true }); }
      return;
    }
    if (name === "kick") {
      if (!isStaffMember(member)) return denied(interaction);
      const user = interaction.options.getUser("user", true);
      const reason = interaction.options.getString("reason") || "No reason";
      try {
        await (await interaction.guild.members.fetch(user.id)).kick(reason);
        await safeReply(interaction, { content: `# Kicked ${user.tag}` });
      } catch (e) { await safeReply(interaction, { content: `\`${e.message}\``, ephemeral: true }); }
      return;
    }
    if (name === "ban") {
      if (!isStaffMember(member)) return denied(interaction);
      const user = interaction.options.getUser("user", true);
      const reason = interaction.options.getString("reason") || "No reason";
      try {
        await interaction.guild.members.ban(user.id, { reason });
        await safeReply(interaction, { content: `# Banned ${user.tag}` });
      } catch (e) { await safeReply(interaction, { content: `\`${e.message}\``, ephemeral: true }); }
      return;
    }
    if (name === "warn") {
      if (!isStaffMember(member)) return denied(interaction);
      const user = interaction.options.getUser("user", true);
      const reason = interaction.options.getString("reason") || "No reason";
      const gid = interaction.guild.id;
      if (!data.warns[gid]) data.warns[gid] = {};
      if (!data.warns[gid][user.id]) data.warns[gid][user.id] = [];
      data.warns[gid][user.id].push({ reason, at: Date.now(), mod: interaction.user.id });
      saveJSON(DATA_FILE, data);
      const n = data.warns[gid][user.id].length;
      await safeReply(interaction, { embeds: [new EmbedBuilder().setTitle("Warned").setDescription(`${user.tag} · #${n}\n${reason}`).setColor(0xfaa61a)], components: [resultButtons()] });
      return;
    }
    if (name === "give" || name === "remove") {
      if (!isStaffMember(member)) return denied(interaction);
      const role = interaction.options.getRole("role", true);
      const user = interaction.options.getUser("user", true);
      try {
        const m = await interaction.guild.members.fetch(user.id);
        if (name === "give") await m.roles.add(role, "give by " + interaction.user.tag);
        else await m.roles.remove(role, "remove by " + interaction.user.tag);
        await safeReply(interaction, { content: name === "give" ? `Gave ${role} to ${user.tag}` : `Removed ${role} from ${user.tag}`, ephemeral: true });
      } catch (e) { await safeReply(interaction, { content: `\`${e.message}\``, ephemeral: true }); }
      return;
    }
    if (name === "kill" || name === "reboot") {
      if (!isOwnerAdminMember(member) && !isOwner(interaction.user.id)) return denied(interaction);
      if (interaction.guild) await setStatusVc(interaction.guild, false);
      await safeReply(interaction, { content: name === "kill" ? "> Shutdown." : "> Rebooting...", ephemeral: true });
      setTimeout(async () => {
        try { await client.destroy(); } catch {}
        if (name === "reboot") {
          const { spawn } = require("child_process");
          spawn(process.argv[0], process.argv.slice(1), { detached: true, stdio: "ignore" }).unref();
        }
        process.exit(0);
      }, 800);
      return;
    }
    if (name === "verify") {
      const code = interaction.options.getString("code");
      if (!code) {
        const c = vfCode();
        vfPending[interaction.user.id] = { code: c, at: Date.now() };
        saveJSON(VF_FILE, vfPending);
        try { await interaction.user.send(`Your verify code: \`${c}\` · use \`/verify code:${c}\``); await safeReply(interaction, { content: "Code sent in DM.", ephemeral: true }); }
        catch { await safeReply(interaction, { content: `DM closed. Code: \`${c}\``, ephemeral: true }); }
        return;
      }
      const pend = vfPending[interaction.user.id];
      if (!pend || pend.code !== code.toUpperCase()) {
        await safeReply(interaction, { content: "Invalid code.", ephemeral: true });
        return;
      }
      delete vfPending[interaction.user.id]; saveJSON(VF_FILE, vfPending);
      try {
        let role = await findRole(interaction.guild, "Verified");
        if (!role) role = await ensureRole(interaction.guild, "Verified", 0x1abc9c);
        await interaction.member.roles.add(role);
        await safeReply(interaction, { content: "Verified.", ephemeral: true });
      } catch (e) { await safeReply(interaction, { content: `\`${e.message}\``, ephemeral: true }); }
      return;
    }
    if (name === "up") {
      await safeDefer(interaction, true);
      try {
        const url = await pastefyUpload(interaction.options.getString("content", true));
        await safeReply(interaction, { content: url });
      } catch (e) { await safeReply(interaction, { content: `\`${e.message}\`` }); }
      return;
    }
    if (name === "search") {
      await safeDefer(interaction);
      try {
        const r = await ytSearch(interaction.options.getString("query", true));
        if (!r) await safeReply(interaction, { content: "> No results" }, 15_000);
        else await safeReply(interaction, { content: `> **${r.title}**\nhttps://www.youtube.com/watch?v=${r.id}` }, 120_000);
      } catch (e) { await safeReply(interaction, { content: `\`${e.message}\`` }); }
      return;
    }
    if (name === "obf") {
      // Popup panel (modal) — no requirements, anyone can use
      const modal = new ModalBuilder()
        .setCustomId("eatf_obf_modal")
        .setTitle("Obfuscate Lua/Luau");
      const codeInput = new TextInputBuilder()
        .setCustomId("obf_code")
        .setLabel("Lua/Luau source code")
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder("Paste your Lua code here...")
        .setRequired(true);
      const minifyInput = new TextInputBuilder()
        .setCustomId("obf_minify")
        .setLabel("Minify mode (Normal, Max, Both)")
        .setStyle(TextInputStyle.Short)
        .setPlaceholder("Normal")
        .setRequired(false)
        .setValue("Normal");
      modal.addComponents(
        new ActionRowBuilder().addComponents(codeInput),
        new ActionRowBuilder().addComponents(minifyInput),
      );
      await interaction.showModal(modal).catch(async (e) => {
        console.error("[obf modal show]", e.message);
        await safeReply(interaction, { content: "Failed to show panel. Try again.", ephemeral: true });
      });
      return;
    }

    if (name === "minify") {
      const cd = checkObfCooldown(interaction.user.id);
      if (cd > 0) { await safeReply(interaction, { content: `Cooldown **${cd}s**`, ephemeral: true }); return; }
      await safeDefer(interaction);
      try {
        let source = null, filename = "minified.lua";
        const file = interaction.options.getAttachment("file");
        if (file) {
          if (file.size > MAX_SOURCE_BYTES) { await safeReply(interaction, { content: "File too large." }); return; }
          source = await fetchText(file.url);
          filename = (file.name || "file").replace(/\.[^.]+$/, "") + ".min.lua";
        } else {
          const ex = extractCode(interaction.options.getString("code") || "");
          if (ex?.url) { source = await fetchText(ex.url); filename = "link.min.lua"; }
          else if (typeof ex === "string" && ex) { source = ex; filename = "text.min.lua"; }
        }
        if (!source?.trim()) { await safeReply(interaction, { content: "Need file / link / code for minify." }); return; }
        const mode = parseMinify(interaction.options.getString("mode") || "Normal");
        if (mode === "false") {
          await safeReply(interaction, { content: "Use mode **Normal**, **Max**, or **Both**." });
          return;
        }
        const t0 = Date.now();
        const code = minify(source, mode);
        const size = Buffer.byteLength(code, "utf8");
        const ms = Date.now() - t0;
        const buf = Buffer.from(code, "utf8");
        const att = new AttachmentBuilder(buf, { name: filename });
        await safeReply(interaction, {
          content: `### Minify Complete (no obfuscation)\n**Size** \`${size}\` bytes · **Mode** \`${mode}\`\nTook **${(ms / 1000).toFixed(2)}s** · densify only`,
          files: [att],
        });
      } catch (e) {
        console.error("[minify]", e);
        await safeReply(interaction, { content: `**Error** \`${e.message}\`` });
      }
      return;
    }
  } catch (e) {
    console.error("[interaction]", e?.stack || e);
  }
});

function helpText() {
  return `**Eatfuscator** · ${INVITE}
\`!obf\` / \`/obf\` · obfuscate
\`!minify\` / \`/minify\` · minify only (Normal|Max|Both)
\`!setup\` · roles/channels (reuse by name)
\`!clear\`/\`!clr\` · user msgs only (bot kept)
\`!lock\` \`!unlock\` \`!del\`
\`!mute\` \`!kick\` \`!ban\` \`!warn\`
\`!give\` \`!remove\`
\`!kill\` \`!reboot\` · owner
\`!vf\`/\`!verify\` \`!up\` \`!tos\` \`!tou\` \`!license\` \`!search\`
Staff roles: Owner Admin Moderator Support`;
}
function helpEmbed() {
  return new EmbedBuilder().setTitle("Eatfuscator").setDescription(helpText()).setColor(0x5865f2);
}

/* ---------- prefix ---------- */
client.on("messageCreate", async (message) => {
  try {
    if (!message || message.author?.bot) return;
    const content = (message.content || "").trim();
    if (!content) return;
    const low = content.toLowerCase();
    if (!/^[!?.]/.test(low)) return;

    const reply = async (p, delMs = 60_000) => {
      try {
        const m = await message.reply(typeof p === "string" ? { content: p } : p);
        if (delMs > 0) autoDelete(m, delMs);
        return m;
      } catch (e) { console.error("[reply]", e.message); return null; }
    };
    const args = content.replace(/^[!?.]\S+\s*/, "").trim();
    const member = message.member;

    // help
    if (/^[!?.](help|cmd|cmds)\b/.test(low)) {
      await reply({ embeds: [helpEmbed()], components: [resultButtons()] });
      return;
    }
    // tos / tou / license
    if (/^[!?.](tos|policy|rules)\b/.test(low)) { await reply(TOS_TEXT); return; }
    if (/^[!?.]tou\b/.test(low)) { await reply(TOU_TEXT); return; }
    if (/^[!?.]license\b/.test(low)) { await reply(LICENSE_TEXT); return; }

    // setup — confirm button then wipe+rebuild (bot.py parity)
    if (/^[!?.]setup\b/.test(low)) {
      if (!message.guild || !isOwnerAdminMember(member)) return denied(message);
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("setup_confirm").setLabel("Wipe & rebuild").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId("setup_recycle").setLabel("Recycle channels/roles").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("setup_cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary),
      );
      await reply({
        content: "# Setup\n> **Wipe & rebuild** — full wipe · **Recycle** — missing only · Cancel",
        components: [row],
      }, 0);
      return;
    }

    // clear / clr
    if (/^[!?.](clear|clr)\b/.test(low)) {
      if (!message.guild || !isStaffMember(member)) return denied(message);
      const amount = Math.min(200, Math.max(1, parseInt(args, 10) || 50));
      try {
        const msgs = await message.channel.messages.fetch({ limit: amount });
        const targets = msgs.filter(m => !isBotMessage(m) && !m.pinned);
        let deleted = 0;
        const bulk = targets.filter(m => Date.now() - m.createdTimestamp < 14 * 86400000);
        if (bulk.size) {
          try { deleted += (await message.channel.bulkDelete(bulk, true)).size; }
          catch { for (const m of bulk.values()) { try { await m.delete(); deleted++; } catch {} } }
        }
        await reply(`Cleared **${deleted}** user message(s). Bot kept.`);
      } catch (e) { await reply(`clear failed: ${e.message}`); }
      return;
    }

    // lock / unlock
    if (/^[!?.]lock\b/.test(low)) {
      if (!isStaffMember(member)) return denied(message);
      try {
        await message.channel.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: false });
        await reply("# Locked");
      } catch (e) { await reply("`" + e.message + "`"); }
      return;
    }
    if (/^[!?.]unlock\b/.test(low)) {
      if (!isStaffMember(member)) return denied(message);
      try {
        await message.channel.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: null });
        await reply("# Unlocked");
      } catch (e) { await reply("`" + e.message + "`"); }
      return;
    }

    // del channel
    if (/^[!?.]del\b/.test(low)) {
      if (!isOwnerAdminMember(member)) return denied(message);
      await reply("> Deleting...");
      setTimeout(() => message.channel.delete("del by " + message.author.tag).catch(() => {}), 1000);
      return;
    }

    // mute
    if (/^[!?.]mute\b/.test(low)) {
      if (!isStaffMember(member)) return denied(message);
      const target = message.mentions.users.first();
      if (!target) { await reply("`!mute @user 10m reason`"); return; }
      const rest = args.replace(/<@!?\d+>/g, "").trim();
      const parts = rest.split(/\s+/);
      let durStr = "10m", reason = "No reason";
      if (parts[0] && parseDuration(parts[0])) { durStr = parts[0]; reason = parts.slice(1).join(" ") || reason; }
      else if (rest) reason = rest;
      const ms = parseDuration(durStr) || 600000;
      try {
        await (await message.guild.members.fetch(target.id)).timeout(ms, reason);
        await reply({ embeds: [new EmbedBuilder().setTitle("Muted").setDescription(`${target.tag} · ${durStr} · ${reason}`).setColor(0xfee75c)], components: [resultButtons()] });
      } catch (e) { await reply("mute failed: " + e.message); }
      return;
    }

    // kick / ban / warn
    if (/^[!?.]kick\b/.test(low)) {
      if (!isStaffMember(member)) return denied(message);
      const target = message.mentions.users.first();
      if (!target) { await reply("`!kick @user reason`"); return; }
      const reason = args.replace(/<@!?\d+>/g, "").trim() || "No reason";
      try { await (await message.guild.members.fetch(target.id)).kick(reason); await reply("# Kicked " + target.tag); }
      catch (e) { await reply("`" + e.message + "`"); }
      return;
    }
    if (/^[!?.]ban\b/.test(low)) {
      if (!isStaffMember(member)) return denied(message);
      const target = message.mentions.users.first();
      if (!target) { await reply("`!ban @user reason`"); return; }
      const reason = args.replace(/<@!?\d+>/g, "").trim() || "No reason";
      try { await message.guild.members.ban(target.id, { reason }); await reply("# Banned " + target.tag); }
      catch (e) { await reply("`" + e.message + "`"); }
      return;
    }
    if (/^[!?.]warn\b/.test(low)) {
      if (!isStaffMember(member)) return denied(message);
      const target = message.mentions.users.first();
      if (!target) { await reply("`!warn @user reason`"); return; }
      const reason = args.replace(/<@!?\d+>/g, "").trim() || "No reason";
      const gid = message.guild.id;
      if (!data.warns[gid]) data.warns[gid] = {};
      if (!data.warns[gid][target.id]) data.warns[gid][target.id] = [];
      data.warns[gid][target.id].push({ reason, at: Date.now(), mod: message.author.id });
      saveJSON(DATA_FILE, data);
      await reply({ embeds: [new EmbedBuilder().setTitle("Warned").setDescription(`${target.tag} · #${data.warns[gid][target.id].length}\n${reason}`).setColor(0xfaa61a)], components: [resultButtons()] });
      return;
    }

    // give / remove
    if (/^[!?.]give\b/.test(low) || /^[!?.]remove\b/.test(low)) {
      if (!isStaffMember(member)) return denied(message);
      const role = message.mentions.roles.first();
      const user = message.mentions.users.first();
      if (!role || !user) { await reply("`!give/@remove @Role @User`"); return; }
      try {
        const m = await message.guild.members.fetch(user.id);
        if (/^[!?.]give\b/.test(low)) await m.roles.add(role); else await m.roles.remove(role);
        await reply(/^[!?.]give\b/.test(low) ? `Gave ${role.name} to ${user.tag}` : `Removed ${role.name} from ${user.tag}`);
      } catch (e) { await reply("`" + e.message + "`"); }
      return;
    }

    // kill / reboot
    if (/^[!?.](kill|reboot)\b/.test(low)) {
      if (!isOwnerAdminMember(member) && !isOwner(message.author.id)) return denied(message);
      const isKill = /^[!?.]kill\b/.test(low);
      if (message.guild) await setStatusVc(message.guild, false);
      await reply(isKill ? "> Shutdown." : "> **Rebooting**...");
      setTimeout(async () => {
        try { await client.destroy(); } catch {}
        if (!isKill) {
          const { spawn } = require("child_process");
          spawn(process.argv[0], process.argv.slice(1), { detached: true, stdio: "ignore" }).unref();
        }
        process.exit(0);
      }, 800);
      return;
    }

    // verify / vf
    if (/^[!?.](vf|verify)\b/.test(low)) {
      const code = args.split(/\s+/)[0];
      if (!code) {
        const c = vfCode();
        vfPending[message.author.id] = { code: c, at: Date.now() };
        saveJSON(VF_FILE, vfPending);
        try { await message.author.send(`Code: \`${c}\``); await reply("Code sent in DM."); }
        catch { await reply(`DM closed. Code: \`${c}\``); }
        return;
      }
      const pend = vfPending[message.author.id];
      if (!pend || pend.code !== code.toUpperCase()) { await reply("Invalid code."); return; }
      delete vfPending[message.author.id]; saveJSON(VF_FILE, vfPending);
      try {
        let role = await findRole(message.guild, "Verified");
        if (!role) role = await ensureRole(message.guild, "Verified", 0x1abc9c);
        await message.member.roles.add(role);
        await reply("Verified.");
      } catch (e) { await reply("`" + e.message + "`"); }
      return;
    }

    
    // minify ONLY (densify — no obfuscation)
    if (/^[!?.]minify\b/.test(low)) {
      const cd = checkObfCooldown(message.author.id);
      if (cd > 0) { await reply(`Cooldown **${cd}s**`); return; }
      try {
        let source = null, filename = "minified.lua";
        if (message.attachments.size) {
          const att = message.attachments.first();
          if (att.size > MAX_SOURCE_BYTES) { await reply("File too large."); return; }
          source = await fetchText(att.url);
          filename = (att.name || "file").replace(/\.[^.]+$/, "") + ".min.lua";
        }
        const flags = parseFlags(args);
        if (!source) {
          const ex = extractCode(flags.rest || "");
          if (ex?.url) { source = await fetchText(ex.url); filename = "link.min.lua"; }
          else if (typeof ex === "string" && ex) { source = ex; filename = "text.min.lua"; }
        }
        let mode = flags.minify;
        if (!mode || mode === "false") {
          const m = (args || "").match(/\b(Normal|Max|Both)\b/i);
          mode = m ? parseMinify(m[1]) : "Normal";
        }
        if (mode === "false") mode = "Normal";
        if (!source?.trim()) { await reply("Need file, link, or code · `!minify Normal`"); return; }
        const t0 = Date.now();
        const code = minify(source, mode);
        const size = Buffer.byteLength(code, "utf8");
        const ms = Date.now() - t0;
        const att = new AttachmentBuilder(Buffer.from(code, "utf8"), { name: filename });
        await reply({
          content: `### Minify Complete (no obfuscation)\n**Size** \`${size}\` bytes · **Mode** \`${mode}\`\nTook **${(ms / 1000).toFixed(2)}s** · densify only`,
          files: [att],
        });
      } catch (e) {
        console.error("[minify]", e);
        await reply(`**Error** \`${e.message}\``);
      }
      return;
    }

    // up
    if (/^[!?.]up\b/.test(low)) {
      let content = args;
      if (message.attachments.size) {
        try { content = await fetchText(message.attachments.first().url); } catch {}
      }
      if (!content) { await reply("`!up text` or attach file"); return; }
      try { await reply(await pastefyUpload(content)); }
      catch (e) { await reply("`" + e.message + "`"); }
      return;
    }

    // search
    if (/^[!?.]search\b/.test(low)) {
      try {
        const r = await ytSearch(args || "cat");
        if (!r) await reply("> No results", 15_000);
        else await reply(`> **${r.title}**\nhttps://www.youtube.com/watch?v=${r.id}`, 120_000);
      } catch (e) { await reply("`" + e.message + "`"); }
      return;
    }

    // obf
    if (!/^[!?.](obf|obfuscate)\b/.test(low)) return;
    const cd = checkObfCooldown(message.author.id);
    if (cd > 0) { await reply(`Cooldown **${cd}s**`); return; }
    let rest = content.replace(/^[!?.](obfuscate|obf)\s*/i, "");
    let minify = "Normal", body = rest;
    try {
      const flags = parseFlags(rest);
      minify = flags.minify;
      body = flags.rest;
    } catch (e) {
      await reply("`" + e.message + "`", 15_000);
      return;
    }
    let source = null, filename = "obfuscated.lua";
    try {
      if (message.attachments.size) {
        const att = message.attachments.first();
        if (att.size && att.size > MAX_SOURCE_BYTES) { await reply("File too large."); return; }
        source = await fetchText(att.url);
        filename = (att.name || "file").replace(/\.[^.]+$/, "") + ".obfuscated.lua";
      } else {
        const ex = extractCode(body);
        if (ex?.url) { source = await fetchText(ex.url); filename = "link.obfuscated.lua"; }
        else if (typeof ex === "string" && ex) source = ex;
      }
      if (!source?.trim()) { await reply("Need file, link, or code · `minify:Normal`"); return; }
      await message.channel.sendTyping().catch(() => {});
      await sendObfResult(p => message.reply(p), source, minify, filename);
    } catch (e) {
      console.error("[obf msg]", e);
      await reply(`**Error** \`${e.message}\``);
    }
  } catch (e) {
    console.error("[messageCreate]", e?.stack || e);
  }
});

client.login(TOKEN).catch(e => {
  console.error("[bot] login failed:", e.message);
  process.exit(1);
});
