// index.js — Full professional bot: veg confirm, inventory, heartbeats, admin
const { Bot, InlineKeyboard } = require("grammy");
const fs = require("fs");
const path = require("path");
const express = require("express");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");

dayjs.extend(utc);
dayjs.extend(timezone);

// --- Configuration from env ---
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const HEARTBEAT_SECRET = process.env.HEARTBEAT_SECRET || "";
if (!TELEGRAM_TOKEN) {
  console.error("Please set TELEGRAM_TOKEN env var.");
  process.exit(1);
}

const DB_FILE = path.join(__dirname, "db.json");
function loadDbSync() {
  try {
    const raw = fs.readFileSync(DB_FILE, "utf8");
    const data = JSON.parse(raw || "{}");
    data.lastSent = data.lastSent || {};
    data.partners = data.partners || [];
    data.schedules = data.schedules || [];
    data.pendingConfirmations = data.pendingConfirmations || {};
    data.inventory = data.inventory || [];
    data.heartbeats = data.heartbeats || {};
    data.settings = data.settings || { vegConfirm: { confirmTime: "23:30", followupMinutes1: 30, followupMinutes2: 60 }, inventory: { checkIntervalMinutes: 60 }, heartbeat: { thresholdMinutes: 10 } };
    data.audit = data.audit || [];
    return data;
  } catch (e) {
    const init = {
      lastSent: {},
      partners: [],
      schedules: [],
      pendingConfirmations: {},
      inventory: [],
      heartbeats: {},
      settings: {
        vegConfirm: { confirmTime: "23:30", followupMinutes1: 30, followupMinutes2: 60 },
        inventory: { checkIntervalMinutes: 60 },
        heartbeat: { thresholdMinutes: 10 }
      },
      audit: []
    };
    try { fs.writeFileSync(DB_FILE, JSON.stringify(init, null, 2)); } catch (err) {}
    return init;
  }
}
function writeDbSync(db) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
    return true;
  } catch (e) {
    console.error("Failed writing db.json:", e.message);
    return false;
  }
}

let db = loadDbSync();
function reloadDb() { db = loadDbSync(); }

// --- helpers ---
function isAdmin(userId) {
  reloadDb();
  const p = db.partners.find(x => String(x.id) === String(userId));
  return p && (p.role === "owner" || p.role === "admin");
}
function findPartnerById(id) {
  reloadDb();
  return db.partners.find(x => String(x.id) === String(id));
}
function pendingKey(date, partnerId) { return `${date}__${partnerId}`; }
function setPendingConfirmation(date, partnerId, status, nextCheckISO = null) {
  reloadDb();
  db.pendingConfirmations = db.pendingConfirmations || {};
  db.pendingConfirmations[date] = db.pendingConfirmations[date] || {};
  db.pendingConfirmations[date][partnerId] = { status, lastUpdated: dayjs().toISOString(), nextCheck: nextCheckISO };
  writeDbSync(db);
}
function clearPendingConfirmation(date, partnerId) {
  reloadDb();
  if (db.pendingConfirmations && db.pendingConfirmations[date]) {
    delete db.pendingConfirmations[date][partnerId];
    if (Object.keys(db.pendingConfirmations[date]).length === 0) delete db.pendingConfirmations[date];
    writeDbSync(db);
  }
}
function findInventoryItem(id) { reloadDb(); return db.inventory.find(it => it.id === id); }
function calculateDaysLeft(item) { if (!item.dailyUsage || item.dailyUsage <= 0) return Infinity; return item.stock / item.dailyUsage; }
function logAudit(actor, action, details) {
  reloadDb();
  db.audit = db.audit || [];
  db.audit.push({ when: dayjs().toISOString(), actor: String(actor), action, details });
  writeDbSync(db);
}

// --- Bot + Express ---
const bot = new Bot(TELEGRAM_TOKEN);
const app = express();

// ---------- WELCOME / START ----------
bot.command("start", async (ctx) => {
  try {
    const name = ctx.from?.first_name || ctx.from?.username || "there";
    const welcomeText =
`Hello *${name}* 👋

Welcome to *GTA Food City — Operations Assistant*.

I keep our kitchen & partners in sync:
• Daily veg-list reminders at closing time.  
• Simple *Yes / No / Not yet* buttons so nobody forgets.  
• Inventory tracking with clear low / critical alerts.  
• Easy commands for adding items and recording purchases.

Tap a button below to learn more, see commands, or contact support.`;
    const kb = new InlineKeyboard()
      .text("How it works", "start:how")
      .text("Commands", "start:commands")
      .row()
      .text("Support / Contact", "start:support");
    await ctx.reply(welcomeText, { parse_mode: "Markdown", reply_markup: kb });
    logAudit(ctx.from.id, "start", `welcome shown`);
  } catch (err) {
    console.error("start handler error:", err.message);
  }
});

// --- callback for start and veg confirmation (single handler that branches) ---
bot.on("callback_query:data", async (ctx, next) => {
  try {
    const data = ctx.callbackQuery?.data || "";
    if (!data) return;
    // START buttons
    if (data.startsWith("start:")) {
      const action = data.split(":")[1];
      if (action === "how") {
        const msg = `*How it works*\n\n1. At closing we ask: "Did you share the veg list for tomorrow?"\n2. Tap Yes / No / Not yet → bot follows up automatically.\n3. Inventory alerts are automatic when stock runs low.`;
        await ctx.api.sendMessage(ctx.from.id, msg, { parse_mode: "Markdown" });
        await ctx.answerCallbackQuery({ text: "How it works — sent." });
        return;
      }
      if (action === "commands") {
        const msg = `*Commands*\n\n` +
          `/whoami — get your chat id\n` +
          `/schedules — list schedules\n` +
          `/test <id> — test schedule\n` +
          `/veggies <list> — forward veg list\n` +
          `/additem <id> <name> <stock> <unit> <dailyUsage> <warnDays> <criticalDays>\n` +
          `/setstock <id> <qty>\n` +
          `/setusage <id> <dailyUsage>\n` +
          `/purchase <id> <qty> — record a purchase (adds stock)\n` +
          `/inventory — show inventory summary\n` +
          `/addpartner <id> <name> <role> — admin only\n` +
          `/removepartner <id> — admin only`;
        await ctx.api.sendMessage(ctx.from.id, msg, { parse_mode: "Markdown" });
        await ctx.answerCallbackQuery({ text: "Commands sent." });
        return;
      }
      if (action === "support") {
        const msg = `Support: contact your co-owners or message the owner.\nFor access changes, use /addpartner (owner only).`;
        await ctx.api.sendMessage(ctx.from.id, msg, { parse_mode: "Markdown" });
        await ctx.answerCallbackQuery({ text: "Support info sent." });
        return;
      }
      return;
    }

    // VEG confirmation callbacks: format veg:YYYY-MM-DD:action
    if (data.startsWith("veg:")) {
      const [, date, action] = data.split(":");
      const partnerId = String(ctx.from.id);
      if (action === "yes") {
        setPendingConfirmation(date, partnerId, "confirmed", null);
        await ctx.api.sendMessage(partnerId, `Thanks — veg list confirmed for ${date}.`);
        await ctx.answerCallbackQuery({ text: "Marked confirmed ✅" });
        clearPendingConfirmation(date, partnerId);
        logAudit(partnerId, "veg_confirm", `yes for ${date}`);
        return;
      }
      if (action === "no") {
        const s1 = dayjs().add(db.settings.vegConfirm.followupMinutes1, "minute").toISOString();
        setPendingConfirmation(date, partnerId, "no", s1);
        await ctx.api.sendMessage(partnerId, `You answered NO for ${date}. We'll remind again in ${db.settings.vegConfirm.followupMinutes1} minutes.`);
        await ctx.answerCallbackQuery({ text: "Noted — followups scheduled." });
        logAudit(partnerId, "veg_confirm", `no for ${date}`);
        return;
      }
      if (action === "notyet") {
        const s1 = dayjs().add(db.settings.vegConfirm.followupMinutes1, "minute").toISOString();
        setPendingConfirmation(date, partnerId, "notyet", s1);
        await ctx.api.sendMessage(partnerId, `OK — we'll check again in ${db.settings.vegConfirm.followupMinutes1} minutes.`);
        await ctx.answerCallbackQuery({ text: "Will remind soon ⏳" });
        logAudit(partnerId, "veg_confirm", `notyet for ${date}`);
        return;
      }
      await ctx.answerCallbackQuery();
      return;
    }

    // pass-through to next callback handlers if any
    return next();
  } catch (err) {
    console.error("callback handler error:", err);
    try { await ctx.answerCallbackQuery({ text: "Error handling your response." }); } catch (e) {}
  }
});

// ---------- Commands ----------

// quick id
bot.command("whoami", ctx => ctx.reply(String(ctx.chat.id)));

// list schedules
bot.command("schedules", async ctx => {
  reloadDb();
  const list = (db.schedules || []).map(s => `${s.label} (${s.id}) — every ${s.intervalDays} day(s) at ${s.time}`).join("\n");
  await ctx.reply("Schedules:\n" + (list || "None"));
});

// test schedule
bot.command("test", async ctx => {
  const parts = ctx.message.text.split(" ");
  if (parts.length < 2) return ctx.reply("Usage: /test <schedule_id>");
  const id = parts[1].trim();
  reloadDb();
  const s = db.schedules.find(x => x.id === id);
  if (!s) return ctx.reply("Schedule not found: " + id);
  const targets = db.partners.map(p => String(p.id));
  const now = dayjs();
  for (const pid of targets) {
    try {
      const p = findPartnerById(pid);
      const displayTime = now.tz(p?.tz || "Asia/Kolkata").format("YYYY-MM-DD HH:mm (z)");
      const text = `🔔 TEST — ${s.label}\n\n${s.message}\n\nTime for ${p?.name || pid}: ${displayTime}`;
      await bot.api.sendMessage(pid, text);
    } catch (e) {
      console.error("test send error", e.message);
    }
  }
  ctx.reply("Test reminders sent to all partners.");
});

// forward veg list (staff)
bot.command("veggies", async ctx => {
  const text = ctx.message.text.split(" ").slice(1).join(" ").trim();
  if (!text) return ctx.reply("Usage: /veggies <list of vegetables>");
  reloadDb();
  const targets = db.partners.map(p => String(p.id));
  for (const pid of targets) {
    try {
      await bot.api.sendMessage(pid, `🌽 *Vegetable list (from staff):*\n\n${text}`, { parse_mode: "Markdown" });
    } catch (e) {
      console.error("veggies forward error", e.message);
    }
  }
  logAudit(ctx.from.id, "veggies_forward", text);
  ctx.reply("Vegetable list forwarded to partners.");
});

// add partner (admin/owner only)
bot.command("addpartner", async ctx => {
  const caller = String(ctx.from.id);
  if (!isAdmin(caller)) return ctx.reply("Not authorized. Only owners/admins can add partners.");
  const parts = ctx.message.text.split(" ").slice(1);
  if (parts.length < 2) return ctx.reply("Usage: /addpartner <chat_id> <name> [role] (role: owner/admin/staff)");
  const id = parts[0];
  const name = parts[1];
  const role = parts[2] || "staff";
  reloadDb();
  if (db.partners.find(p => String(p.id) === String(id))) return ctx.reply("Partner already exists.");
  db.partners.push({ id: String(id), name, role, tz: "Asia/Kolkata" });
  writeDbSync(db);
  logAudit(caller, "addpartner", `${id}|${name}|${role}`);
  ctx.reply(`Partner ${name} (${id}) added as ${role}.`);
});

// remove partner (admin)
bot.command("removepartner", async ctx => {
  const caller = String(ctx.from.id);
  if (!isAdmin(caller)) return ctx.reply("Not authorized.");
  const parts = ctx.message.text.split(" ").slice(1);
  if (parts.length < 1) return ctx.reply("Usage: /removepartner <chat_id>");
  const id = parts[0];
  reloadDb();
  const idx = db.partners.findIndex(p => String(p.id) === String(id));
  if (idx === -1) return ctx.reply("Partner not found.");
  const removed = db.partners.splice(idx, 1)[0];
  writeDbSync(db);
  logAudit(caller, "removepartner", JSON.stringify(removed));
  ctx.reply(`Removed partner ${removed.name} (${removed.id}).`);
});

// add inventory item (admin)
bot.command("additem", async ctx => {
  const caller = String(ctx.from.id);
  if (!isAdmin(caller)) return ctx.reply("Not authorized.");
  // usage: /additem id name stock unit dailyUsage warnDays criticalDays
  const parts = ctx.message.text.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  // remove command
  parts.shift();
  if (parts.length < 6) return ctx.reply('Usage: /additem <id> <name> <stock> <unit> <dailyUsage> <warnDays> <criticalDays>\nWrap multi-word name in quotes, e.g. "Cooking Oil"');
  const id = parts[0];
  const rawName = parts[1];
  const name = rawName.startsWith('"') ? rawName.replace(/(^")|("$)/g, "") : rawName;
  const stock = Number(parts[2]) || 0;
  const unit = parts[3];
  const dailyUsage = Number(parts[4]) || 0;
  const warnDays = Number(parts[5]) || 4;
  const criticalDays = Number(parts[6]) || 2;
  reloadDb();
  if (db.inventory.find(it => it.id === id)) return ctx.reply("Item id exists. Use /setstock or /setusage or /purchase.");
  db.inventory.push({ id, name, stock, unit, dailyUsage, warnDays, criticalDays, lastUpdated: dayjs().toISOString() });
  writeDbSync(db);
  logAudit(caller, "additem", `${id}|${name}|${stock}`);
  ctx.reply(`Added item ${name} (${id}) with ${stock} ${unit}.`);
});

// set stock
bot.command("setstock", async ctx => {
  const caller = String(ctx.from.id);
  if (!isAdmin(caller)) return ctx.reply("Not authorized.");
  const parts = ctx.message.text.split(" ");
  if (parts.length < 3) return ctx.reply("Usage: /setstock <id> <stock>");
  const id = parts[1];
  const qty = Number(parts[2]);
  reloadDb();
  const it = db.inventory.find(x => x.id === id);
  if (!it) return ctx.reply("Item not found.");
  it.stock = qty;
  it.lastUpdated = dayjs().toISOString();
  writeDbSync(db);
  logAudit(caller, "setstock", `${id}|${qty}`);
  ctx.reply(`Stock for ${it.name} updated to ${qty} ${it.unit}.`);
});

// set usage
bot.command("setusage", async ctx => {
  const caller = String(ctx.from.id);
  if (!isAdmin(caller)) return ctx.reply("Not authorized.");
  const parts = ctx.message.text.split(" ");
  if (parts.length < 3) return ctx.reply("Usage: /setusage <id> <dailyUsage>");
  const id = parts[1];
  const usage = Number(parts[2]);
  reloadDb();
  const it = db.inventory.find(x => x.id === id);
  if (!it) return ctx.reply("Item not found.");
  it.dailyUsage = usage;
  it.lastUpdated = dayjs().toISOString();
  writeDbSync(db);
  logAudit(caller, "setusage", `${id}|${usage}`);
  ctx.reply(`Daily usage for ${it.name} updated to ${usage}.`);
});

// purchase (increase stock)
bot.command("purchase", async ctx => {
  const caller = String(ctx.from.id);
  if (!isAdmin(caller)) return ctx.reply("Not authorized.");
  const parts = ctx.message.text.split(" ");
  if (parts.length < 3) return ctx.reply("Usage: /purchase <id> <qty>");
  const id = parts[1];
  const qty = Number(parts[2]);
  reloadDb();
  const it = db.inventory.find(x => x.id === id);
  if (!it) return ctx.reply("Item not found.");
  it.stock = (it.stock || 0) + qty;
  it.lastUpdated = dayjs().toISOString();
  writeDbSync(db);
  logAudit(caller, "purchase", `${id}|${qty}`);
  ctx.reply(`Recorded purchase: ${qty} ${it.unit} added to ${it.name}. Current stock: ${it.stock} ${it.unit}.`);
});

// inventory list
bot.command("inventory", async ctx => {
  reloadDb();
  const items = db.inventory || [];
  if (!items.length) return ctx.reply("No inventory items set.");
  const lines = items.map(it => {
    const days = calculateDaysLeft(it);
    const daysText = isFinite(days) ? `${Math.floor(days)} day(s)` : "N/A";
    return `${it.name} (${it.id}) — ${it.stock} ${it.unit}, daily ${it.dailyUsage} — ~${daysText} left`;
  });
  await ctx.reply(lines.join("\n"));
});

// show audit (owner only)
bot.command("audit", async ctx => {
  const caller = String(ctx.from.id);
  if (!isAdmin(caller)) return ctx.reply("Not authorized.");
  reloadDb();
  const lines = (db.audit || []).slice(-50).map(a => `${a.when} — ${a.actor} — ${a.action} — ${a.details}`);
  ctx.reply(lines.join("\n") || "No audit records.");
});

// ---------- EXPRESS: heartbeat route ----------
app.get("/heartbeat/:id", (req, res) => {
  try {
    const id = String(req.params.id || "unknown");
    const secret = req.query.secret || "";
    if (!HEARTBEAT_SECRET || secret !== HEARTBEAT_SECRET) {
      return res.status(403).send("Forbidden");
    }
    reloadDb();
    db.heartbeats = db.heartbeats || {};
    db.heartbeats[id] = db.heartbeats[id] || {};
    db.heartbeats[id].lastSeen = dayjs().toISOString();
    db.heartbeats[id].status = "ok";
    writeDbSync(db);
    return res.send("OK");
  } catch (err) {
    console.error("heartbeat error", err);
    return res.status(500).send("error");
  }
});

// ---------- SEND VEG CONFIRM FOR DATE ----------
function vegConfirmKeyboard(date) {
  const kb = new InlineKeyboard()
    .text("✅ Yes", `veg:${date}:yes`)
    .text("❌ No", `veg:${date}:no`)
    .row()
    .text("⏳ Not yet", `veg:${date}:notyet`);
  return kb;
}
async function sendVegConfirmForDate(date) {
  reloadDb();
  const s = db.schedules.find(x => x.id === "vegetables");
  if (!s) return;
  for (const p of (db.partners || [])) {
    try {
      const existing = db.pendingConfirmations && db.pendingConfirmations[date] && db.pendingConfirmations[date][p.id];
      if (existing && existing.status === "confirmed") continue;
      const text = `🔔 *Vegetable check for ${date}*\n\n${s.message}\n\nPlease confirm below if you've shared the veg list for tomorrow.`;
      await bot.api.sendMessage(String(p.id), text, { parse_mode: "Markdown", reply_markup: vegConfirmKeyboard(date) });
      if (!existing) setPendingConfirmation(date, p.id, "pending", null);
    } catch (e) {
      console.error("sendVegConfirm error", p.id, e.message);
    }
  }
}

// ---------- SCHEDULER LOOP ----------
bot.start({ onStart: () => console.log("Bot started (polling).") });

setInterval(async () => {
  try {
    reloadDb();
    const partners = db.partners || [];
    const schedules = db.schedules || [];

    // 1) run schedule triggers (time matches in partner tz)
    for (const s of schedules) {
      for (const p of partners) {
        try {
          const partnerTz = p.tz || "Asia/Kolkata";
          const nowTz = dayjs().tz(partnerTz);
          const [hh, mm] = (s.time || "00:00").split(":").map(Number);
          if (nowTz.hour() === hh && nowTz.minute() === mm) {
            // avoid duplicate sends: lastSent key per schedule
            const key = `${s.id}__${p.id}`;
            const lastSentIso = db.lastSent[key];
            const lastSentDay = lastSentIso ? dayjs(lastSentIso).tz(partnerTz).format("YYYY-MM-DD") : null;
            const today = nowTz.format("YYYY-MM-DD");
            if (lastSentDay === today) continue; // already sent today to this partner
            // handle vegetables schedule specially
            if (s.id === "vegetables") {
              // send veg confirm for business date (IST)
              const bizDate = dayjs().tz("Asia/Kolkata").format("YYYY-MM-DD");
              await sendVegConfirmForDate(bizDate);
              // record lastSent for each partner
              for (const pp of partners) {
                db.lastSent[`${s.id}__${pp.id}`] = dayjs().toISOString();
              }
              writeDbSync(db);
            } else {
              const text = `🔔 *${s.label}*\n\n${s.message}\n\n_Local: ${nowTz.format("YYYY-MM-DD HH:mm (z)")} — Business IST: ${dayjs().tz("Asia/Kolkata").format("YYYY-MM-DD HH:mm (z)")}`;
              await bot.api.sendMessage(String(p.id), text, { parse_mode: "Markdown" });
              db.lastSent[key] = dayjs().toISOString();
              writeDbSync(db);
            }
          }
        } catch (e) {
          console.error("schedule send error", e.message);
        }
      }
    }

    // 2) handle pending confirmation followups
    reloadDb();
    const nowIso = dayjs().toISOString();
    const pending = db.pendingConfirmations || {};
    for (const date of Object.keys(pending)) {
      for (const pid of Object.keys(pending[date])) {
        const rec = pending[date][pid];
        if (!rec) continue;
        if (rec.status === "confirmed") { clearPendingConfirmation(date, pid); continue; }
        if (!rec.nextCheck) {
          // schedule first followup
          const next = dayjs().add(db.settings.vegConfirm.followupMinutes1, "minute").toISOString();
          setPendingConfirmation(date, pid, rec.status === "pending" ? "notyet" : rec.status, next);
          continue;
        }
        if (dayjs(rec.nextCheck).isBefore(dayjs())) {
          const partner = findPartnerById(pid);
          if (!partner) { clearPendingConfirmation(date, pid); continue; }
          if (rec.status === "notyet") {
            // re-prompt with keyboard
            await bot.api.sendMessage(String(pid), `Reminder: please confirm veg list for ${date}.`, { reply_markup: vegConfirmKeyboard(date) });
            // schedule next
            const next = dayjs().add(db.settings.vegConfirm.followupMinutes1, "minute").toISOString();
            setPendingConfirmation(date, pid, "notyet", next);
          } else if (rec.status === "no") {
            const last = dayjs(rec.lastUpdated);
            const minutesSince = dayjs().diff(last, "minute");
            if (minutesSince < db.settings.vegConfirm.followupMinutes2) {
              await bot.api.sendMessage(String(pid), `Reminder: still no veg list for ${date}. Please send now or confirm when sent.`);
              const next = dayjs().add(db.settings.vegConfirm.followupMinutes2, "minute").toISOString();
              setPendingConfirmation(date, pid, "no", next);
            } else {
              // escalate to all partners (owners/co-owners)
              const owners = db.partners.map(p => p.id.toString());
              for (const o of owners) {
                await bot.api.sendMessage(o, `⚠️ *URGENT*: Veg list still NOT received for ${date} from ${partner.name || pid}. Please take action.`, { parse_mode: "Markdown" });
              }
              clearPendingConfirmation(date, pid);
            }
          } else if (rec.status === "pending") {
            const next = dayjs().add(db.settings.vegConfirm.followupMinutes1, "minute").toISOString();
            setPendingConfirmation(date, pid, "notyet", next);
          }
        }
      }
    }

    // 3) heartbeat checks
    reloadDb();
    const hb = db.heartbeats || {};
    const thresholdMinutes = Number(db.settings.heartbeat?.thresholdMinutes || 10);
    for (const devId of Object.keys(hb)) {
      const rec = hb[devId] || {};
      const last = rec.lastSeen ? dayjs(rec.lastSeen) : null;
      const now = dayjs();
      if (!last) continue;
      const minutesAgo = now.diff(last, "minute");
      if (minutesAgo >= thresholdMinutes && rec.status !== "down") {
        db.heartbeats[devId].status = "down";
        writeDbSync(db);
        const text = `⚠️ *Internet/Power Alert*\nDevice: ${devId}\nStatus: *OFFLINE* (no heartbeat for ${minutesAgo} minutes)\nPlease check shop Wi-Fi/power.`;
        for (const p of db.partners) {
          await bot.api.sendMessage(String(p.id), text, { parse_mode: "Markdown" });
        }
        logAudit("system", "heartbeat_down", `${devId}|${minutesAgo}min`);
      } else if (minutesAgo < thresholdMinutes && rec.status === "down") {
        db.heartbeats[devId].status = "ok";
        writeDbSync(db);
        const text = `✅ *Internet Restored*\nDevice: ${devId}\nStatus: *ONLINE* — heartbeat resumed.`;
        for (const p of db.partners) {
          await bot.api.sendMessage(String(p.id), text, { parse_mode: "Markdown" });
        }
        logAudit("system", "heartbeat_up", devId);
      }
    }

    // 4) inventory checks
    reloadDb();
    for (const item of db.inventory || []) {
      const daysLeft = calculateDaysLeft(item);
      if (!isFinite(daysLeft)) continue;
      // warn
      if (daysLeft <= (item.warnDays || 4) && !item._warned) {
        const text = `⚠️ Low stock warning: *${item.name}*\nStock: ${item.stock} ${item.unit}\nDaily use: ${item.dailyUsage}\nEstimated days left: ${Math.floor(daysLeft)} day(s).`;
        for (const p of db.partners) {
          await bot.api.sendMessage(String(p.id), text, { parse_mode: "Markdown" });
        }
        item._warned = true;
        writeDbSync(db);
        logAudit("system", "low_warning", `${item.id}|${Math.floor(daysLeft)}d`);
      }
      // critical
      if (daysLeft <= (item.criticalDays || 2) && !item._critical) {
        const text = `🚨 CRITICAL stock: *${item.name}*\nStock: ${item.stock} ${item.unit}\nImmediate action required — please order now.`;
        for (const p of db.partners) {
          await bot.api.sendMessage(String(p.id), text, { parse_mode: "Markdown" });
        }
        item._critical = true;
        writeDbSync(db);
        logAudit("system", "critical_alert", `${item.id}|${Math.floor(daysLeft)}d`);
      }
      // clear flags if stock replenished
      if (isFinite(daysLeft) && daysLeft > (item.warnDays || 4) && item._warned) {
        item._warned = false; writeDbSync(db);
      }
      if (isFinite(daysLeft) && daysLeft > (item.criticalDays || 2) && item._critical) {
        item._critical = false; writeDbSync(db);
      }
    }

  } catch (err) {
    console.error("scheduler error:", err.message);
  }
}, 30 * 1000); // 30 seconds

// Start Express HTTP server for uptime and heartbeats
const PORT = process.env.PORT || 3000;
app.get("/", (req, res) => res.send("Inventory Reminder Bot running"));
app.listen(PORT, () => console.log(`HTTP server listening on port ${PORT}`));

// End of file
