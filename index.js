// index.js — Interactive Inventory & Reminder Bot (full)
const { Bot, InlineKeyboard } = require("grammy");
const fs = require("fs");
const path = require("path");
const express = require("express");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");
dayjs.extend(utc);
dayjs.extend(timezone);

// --- ENV ---
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
    data.sessions = data.sessions || {};
    return data;
  } catch (e) {
    const init = {
      lastSent: {}, partners: [], schedules: [], pendingConfirmations: {}, inventory: [],
      heartbeats: {}, settings: { vegConfirm: { confirmTime: "23:30", followupMinutes1: 30, followupMinutes2: 60 }, inventory: { checkIntervalMinutes: 60 }, heartbeat: { thresholdMinutes: 10 } }, audit: [], sessions: {}
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
function findPartnerById(id) { reloadDb(); return db.partners.find(x => String(x.id) === String(id)); }
function logAudit(actor, action, details) {
  reloadDb();
  db.audit = db.audit || [];
  db.audit.push({ when: dayjs().toISOString(), actor: String(actor), action, details });
  writeDbSync(db);
}
function setSession(userId, sessionObj) {
  reloadDb();
  db.sessions = db.sessions || {};
  db.sessions[String(userId)] = sessionObj;
  writeDbSync(db);
}
function getSession(userId) {
  reloadDb();
  db.sessions = db.sessions || {};
  return db.sessions[String(userId)] || null;
}
function clearSession(userId) {
  reloadDb();
  if (db.sessions && db.sessions[String(userId)]) {
    delete db.sessions[String(userId)];
    writeDbSync(db);
  }
}

// inventory helpers
function findInventoryItem(id) { reloadDb(); return db.inventory.find(it => String(it.id) === String(id)); }
function calculateDaysLeft(item) { if (!item.dailyUsage || item.dailyUsage <= 0) return Infinity; return item.stock / item.dailyUsage; }

// --- bot + express ---
const bot = new Bot(TELEGRAM_TOKEN);
const app = express();

// --- Welcome (improved) ---
bot.command("start", async (ctx) => {
  try {
    const name = ctx.from?.first_name || ctx.from?.username || "friend";
    const message =
`Hello *${name}* 👋

Welcome to *GTA Food City — Operations Assistant*.

We make the kitchen calm and confident:
• Gentle closing-time checks so veg lists never miss.  
• Friendly Yes / No / Not yet buttons — no typing.  
• Simple interactive flows to add items and record purchases.  
• Smart low/critical inventory alerts so service is never interrupted.

Tap a button to learn how, see commands, or contact support.`;
    const kb = new InlineKeyboard()
      .text("How it works", "start:how")
      .text("Commands", "start:commands")
      .row()
      .text("Support", "start:support")
      .text("Quick Add Item", "start:quickadd");
    await ctx.reply(message, { parse_mode: "Markdown", reply_markup: kb });
    logAudit(ctx.from.id, "start", `${ctx.from.id}`);
  } catch (err) {
    console.error("start error", err.message);
  }
});

// callback handler includes start buttons and veg callbacks
bot.on("callback_query:data", async (ctx, next) => {
  try {
    const data = ctx.callbackQuery?.data || "";
    if (!data) return;
    // START actions
    if (data.startsWith("start:")) {
      const action = data.split(":")[1];
      if (action === "how") {
        await ctx.api.sendMessage(ctx.from.id, `*How it works*\n\n• At closing we ask: "Did you share the veg list?"\n• Buttons: Yes / No / Not yet — bot follows up automatically.\n• Manage inventory using interactive /additem and /purchase flows.`, { parse_mode: "Markdown" });
        await ctx.answerCallbackQuery({ text: "How it works — sent." });
        return;
      }
      if (action === "commands") {
        const cmds = `*Commands (interactive & simple)*\n\n` +
          `/whoami — get your chat id\n` +
          `/additem — interactive add item\n` +
          `/purchase — interactive record purchase\n` +
          `/setusage — interactive set daily usage\n` +
          `/inventory — inventory summary\n` +
          `/veggies <list> — forward veg list\n` +
          `/test <id> — test schedule\n` +
          `/addpartner <id> <name> <role> — admin only\n` +
          `/cancel — cancel any active action`;
        await ctx.api.sendMessage(ctx.from.id, cmds, { parse_mode: "Markdown" });
        await ctx.answerCallbackQuery({ text: "Commands sent." });
        return;
      }
      if (action === "support") {
        await ctx.api.sendMessage(ctx.from.id, "Support: message your co-owners or ask the owner to /addpartner you. For urgent help call owner.", { parse_mode: "Markdown" });
        await ctx.answerCallbackQuery({ text: "Support info sent." });
        return;
      }
      if (action === "quickadd") {
        // start additem interactive
        setSession(ctx.from.id, { action: "additem", step: 1, temp: {} });
        await ctx.api.sendMessage(ctx.from.id, "Interactive Add Item: What is the item id (short, no spaces)? (e.g. rice_kg)");
        await ctx.answerCallbackQuery({ text: "Let's add an item — check chat." });
        return;
      }
      return;
    }

    // veg confirmation callbacks: veg:YYYY-MM-DD:action
    if (data.startsWith("veg:")) {
      const [, date, action] = data.split(":");
      const pid = String(ctx.from.id);
      if (action === "yes") {
        reloadDb();
        db.pendingConfirmations = db.pendingConfirmations || {};
        db.pendingConfirmations[date] = db.pendingConfirmations[date] || {};
        db.pendingConfirmations[date][pid] = { status: "confirmed", lastUpdated: dayjs().toISOString(), nextCheck: null };
        writeDbSync(db);
        await ctx.api.sendMessage(pid, `Thanks — veg list confirmed for ${date}.`);
        await ctx.answerCallbackQuery({ text: "Marked confirmed ✅" });
        logAudit(pid, "veg_confirm", `yes:${date}`);
        return;
      }
      if (action === "no") {
        const s1 = dayjs().add(db.settings.vegConfirm.followupMinutes1, "minute").toISOString();
        setSession(ctx.from.id, null); // clear session-based flows
        reloadDb();
        db.pendingConfirmations = db.pendingConfirmations || {};
        db.pendingConfirmations[date] = db.pendingConfirmations[date] || {};
        db.pendingConfirmations[date][pid] = { status: "no", lastUpdated: dayjs().toISOString(), nextCheck: s1 };
        writeDbSync(db);
        await ctx.api.sendMessage(pid, `Noted — we'll remind you again in ${db.settings.vegConfirm.followupMinutes1} minutes.`);
        await ctx.answerCallbackQuery({ text: "Noted — followups scheduled." });
        logAudit(pid, "veg_confirm", `no:${date}`);
        return;
      }
      if (action === "notyet") {
        const s1 = dayjs().add(db.settings.vegConfirm.followupMinutes1, "minute").toISOString();
        reloadDb();
        db.pendingConfirmations = db.pendingConfirmations || {};
        db.pendingConfirmations[date] = db.pendingConfirmations[date] || {};
        db.pendingConfirmations[date][pid] = { status: "notyet", lastUpdated: dayjs().toISOString(), nextCheck: s1 };
        writeDbSync(db);
        await ctx.api.sendMessage(pid, `OK — we'll check again in ${db.settings.vegConfirm.followupMinutes1} minutes.`);
        await ctx.answerCallbackQuery({ text: "Will remind soon ⏳" });
        logAudit(pid, "veg_confirm", `notyet:${date}`);
        return;
      }
    }
    // pass through
    return next();
  } catch (err) {
    console.error("callback error", err);
  }
});

// --- Simple commands & interactive session flows ---

bot.command("whoami", ctx => ctx.reply(String(ctx.chat.id)));

bot.command("cancel", ctx => {
  clearSession(ctx.from.id);
  ctx.reply("Any active action has been cancelled.");
});

// START interactive /additem
bot.command("additem", async (ctx) => {
  // only admins can add items
  if (!isAdmin(ctx.from.id)) return ctx.reply("Not authorized. Owners/admins only.");
  setSession(ctx.from.id, { action: "additem", step: 1, temp: {} });
  await ctx.reply("Add Item — Step 1/4\nPlease enter the item id (a short key, e.g. rice_kg):");
});

// START interactive /purchase
bot.command("purchase", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply("Not authorized. Owners/admins only.");
  setSession(ctx.from.id, { action: "purchase", step: 1, temp: {} });
  await ctx.reply("Record Purchase — Step 1/3\nEnter the item id you purchased (e.g. rice_kg):");
});

// START interactive /setusage
bot.command("setusage", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply("Not authorized. Owners/admins only.");
  setSession(ctx.from.id, { action: "setusage", step: 1, temp: {} });
  await ctx.reply("Set Daily Usage — Step 1/2\nEnter the item id:");
});

// /inventory quick view
bot.command("inventory", async (ctx) => {
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

// addpartner & removepartner (admin/owner)
bot.command("addpartner", async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.reply("Not authorized.");
  const parts = ctx.message.text.split(" ").slice(1);
  if (parts.length < 2) return ctx.reply("Usage: /addpartner <chat_id> <name> [role]");
  const id = parts[0];
  const name = parts[1];
  const role = parts[2] || "staff";
  reloadDb();
  if (db.partners.find(p => String(p.id) === String(id))) return ctx.reply("Partner exists.");
  db.partners.push({ id: String(id), name, role, tz: "Asia/Kolkata" });
  writeDbSync(db);
  logAudit(ctx.from.id, "addpartner", `${id}|${name}|${role}`);
  ctx.reply(`Added partner ${name} (${id}) as ${role}.`);
});
bot.command("removepartner", async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.reply("Not authorized.");
  const parts = ctx.message.text.split(" ").slice(1);
  if (!parts.length) return ctx.reply("Usage: /removepartner <chat_id>");
  const id = parts[0];
  reloadDb();
  const idx = db.partners.findIndex(p => String(p.id) === String(id));
  if (idx === -1) return ctx.reply("Partner not found.");
  const removed = db.partners.splice(idx, 1)[0];
  writeDbSync(db);
  logAudit(ctx.from.id, "removepartner", JSON.stringify(removed));
  ctx.reply(`Removed partner ${removed.name} (${removed.id}).`);
});

// /veggies quick send by staff
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

// --- message handler for interactive sessions ---
bot.on("message", async (ctx, next) => {
  try {
    const text = (ctx.message.text || "").trim();
    const session = getSession(ctx.from.id);
    if (!session) return next(); // allow other handlers to process
    // If user typed /cancel, handle earlier via /cancel handler
    // Handle additem flow
    if (session.action === "additem") {
      if (session.step === 1) {
        // item id
        const id = text.replace(/\s+/g, "_").toLowerCase();
        session.temp.id = id;
        session.step = 2;
        setSession(ctx.from.id, session);
        await ctx.reply(`Got it. Item id: ${id}\nStep 2/4: Enter the full item name (e.g. "Rice (kg)")`);
        return;
      } else if (session.step === 2) {
        const name = text;
        session.temp.name = name;
        session.step = 3;
        setSession(ctx.from.id, session);
        await ctx.reply("Step 3/4: Enter daily usage (number, e.g. 5)");
        return;
      } else if (session.step === 3) {
        const daily = Number(text);
        if (isNaN(daily) || daily < 0) return ctx.reply("Please enter a valid number for daily usage.");
        session.temp.dailyUsage = daily;
        session.step = 4;
        setSession(ctx.from.id, session);
        await ctx.reply("Step 4/4: Enter current stock and unit separated by space (e.g. 50 packets)");
        return;
      } else if (session.step === 4) {
        const parts = text.split(" ");
        const stock = Number(parts[0]);
        const unit = parts.slice(1).join(" ") || "units";
        if (isNaN(stock)) return ctx.reply("Please provide stock as a number followed by unit, e.g. '50 packets'");
        // commit item
        reloadDb();
        if (db.inventory.find(it => String(it.id) === String(session.temp.id))) {
          clearSession(ctx.from.id);
          return ctx.reply("Item id already exists. Use /setstock or /purchase to update.");
        }
        db.inventory.push({
          id: session.temp.id,
          name: session.temp.name,
          stock: stock,
          unit: unit,
          dailyUsage: session.temp.dailyUsage,
          warnDays: 4,
          criticalDays: 2,
          lastUpdated: dayjs().toISOString()
        });
        writeDbSync(db);
        logAudit(ctx.from.id, "additem", `${session.temp.id}|${session.temp.name}|${stock}${unit}`);
        clearSession(ctx.from.id);
        await ctx.reply(`Item added: ${session.temp.name} (${session.temp.id}) — ${stock} ${unit}, daily ${session.temp.dailyUsage}`);
        return;
      }
    }

    // purchase flow
    if (session.action === "purchase") {
      if (session.step === 1) {
        session.temp.id = text;
        session.step = 2;
        setSession(ctx.from.id, session);
        await ctx.reply("Step 2/3: Enter quantity purchased (number)");
        return;
      } else if (session.step === 2) {
        const qty = Number(text);
        if (isNaN(qty)) return ctx.reply("Please enter a number for quantity.");
        session.temp.qty = qty;
        session.step = 3;
        setSession(ctx.from.id, session);
        await ctx.reply("Step 3/3: Enter unit (e.g. kg, packets) or type 'same' to keep item unit");
        return;
      } else if (session.step === 3) {
        const unit = text === "same" ? null : text;
        reloadDb();
        const it = db.inventory.find(x => String(x.id) === String(session.temp.id));
        if (!it) {
          clearSession(ctx.from.id);
          return ctx.reply("Item not found. Use /additem to create it first.");
        }
        it.stock = (it.stock || 0) + Number(session.temp.qty);
        if (unit) it.unit = unit;
        it.lastUpdated = dayjs().toISOString();
        writeDbSync(db);
        logAudit(ctx.from.id, "purchase", `${it.id}|${session.temp.qty}`);
        clearSession(ctx.from.id);
        await ctx.reply(`Recorded purchase: +${session.temp.qty} ${it.unit} to ${it.name}. Current stock: ${it.stock} ${it.unit}.`);
        return;
      }
    }

    // setusage flow
    if (session.action === "setusage") {
      if (session.step === 1) {
        session.temp.id = text;
        session.step = 2;
        setSession(ctx.from.id, session);
        await ctx.reply("Step 2/2: Enter daily usage number (e.g. 5)");
        return;
      } else if (session.step === 2) {
        const usage = Number(text);
        if (isNaN(usage)) return ctx.reply("Enter a valid number for daily usage.");
        reloadDb();
        const it = db.inventory.find(x => String(x.id) === String(session.temp.id));
        if (!it) { clearSession(ctx.from.id); return ctx.reply("Item not found."); }
        it.dailyUsage = usage;
        it.lastUpdated = dayjs().toISOString();
        writeDbSync(db);
        logAudit(ctx.from.id, "setusage", `${it.id}|${usage}`);
        clearSession(ctx.from.id);
        await ctx.reply(`Daily usage for ${it.name} set to ${usage}.`);
        return;
      }
    }

    // remindme interactive simple flow (owner/admins & staff)
    if (session.action === "remindme") {
      // could implement but not started; cancel for safety
      clearSession(ctx.from.id);
      return ctx.reply("Remindme flow will be added next — use /test or /veggies for now.");
    }

    return; // end session handling
  } catch (err) {
    console.error("session handler error", err);
    try { await ctx.reply("Error handling your input. Use /cancel to stop."); } catch(e){}
  }
});

// Remindme quick starter (interactive) — simplified
bot.command("remindme", async ctx => {
  setSession(ctx.from.id, { action: "remindme", step: 1, temp: {} });
  await ctx.reply("Remind Me — (simple) What should I remind you about? (short text)");
});

// --- heartbeat route ---
app.get("/heartbeat/:id", (req, res) => {
  try {
    const id = String(req.params.id || "unknown");
    const secret = req.query.secret || "";
    if (!HEARTBEAT_SECRET || secret !== HEARTBEAT_SECRET) return res.status(403).send("Forbidden");
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

// --- veg keyboard and send function ---
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
      if (!existing) {
        reloadDb();
        db.pendingConfirmations = db.pendingConfirmations || {};
        db.pendingConfirmations[date] = db.pendingConfirmations[date] || {};
        db.pendingConfirmations[date][p.id] = { status: "pending", lastUpdated: dayjs().toISOString(), nextCheck: null };
        writeDbSync(db);
      }
    } catch (e) {
      console.error("sendVegConfirm error", p.id, e.message);
    }
  }
}

// --- scheduler (every 30s) ---
bot.start({ onStart: () => console.log("Bot started (polling).") });

setInterval(async () => {
  try {
    reloadDb();
    const partners = db.partners || [];
    const schedules = db.schedules || [];

    // schedule triggers per partner (uses partner tz)
    for (const s of schedules) {
      for (const p of partners) {
        try {
          const partnerTz = p.tz || "Asia/Kolkata";
          const nowTz = dayjs().tz(partnerTz);
          const [hh, mm] = (s.time || "00:00").split(":").map(Number);
          if (nowTz.hour() === hh && nowTz.minute() === mm) {
            const key = `${s.id}__${p.id}`;
            const lastSentIso = db.lastSent[key];
            const lastSentDay = lastSentIso ? dayjs(lastSentIso).tz(partnerTz).format("YYYY-MM-DD") : null;
            const today = nowTz.format("YYYY-MM-DD");
            if (lastSentDay === today) continue;
            if (s.id === "vegetables") {
              const bizDate = dayjs().tz("Asia/Kolkata").format("YYYY-MM-DD");
              await sendVegConfirmForDate(bizDate);
              for (const pp of partners) db.lastSent[`${s.id}__${pp.id}`] = dayjs().toISOString();
              writeDbSync(db);
            } else {
              const text = `🔔 *${s.label}*\n\n${s.message}\n\nLocal: ${nowTz.format("YYYY-MM-DD HH:mm (z)")} — Business IST: ${dayjs().tz("Asia/Kolkata").format("YYYY-MM-DD HH:mm (z)")}`;
              await bot.api.sendMessage(String(p.id), text, { parse_mode: "Markdown" });
              db.lastSent[key] = dayjs().toISOString();
              writeDbSync(db);
            }
          }
        } catch (e) { console.error("schedule error", e.message); }
      }
    }

    // pending confirm followups
    reloadDb();
    const pending = db.pendingConfirmations || {};
    for (const date of Object.keys(pending)) {
      for (const pid of Object.keys(pending[date])) {
        const rec = pending[date][pid];
        if (!rec) continue;
        if (rec.status === "confirmed") { delete pending[date][pid]; writeDbSync(db); continue; }
        if (!rec.nextCheck) {
          const next = dayjs().add(db.settings.vegConfirm.followupMinutes1, "minute").toISOString();
          db.pendingConfirmations[date][pid].nextCheck = next;
          writeDbSync(db);
          continue;
        }
        if (dayjs(rec.nextCheck).isBefore(dayjs())) {
          const partner = findPartnerById(pid);
          if (!partner) { delete pending[date][pid]; writeDbSync(db); continue; }
          if (rec.status === "notyet") {
            await bot.api.sendMessage(String(pid), `Reminder: please confirm veg list for ${date}.`, { reply_markup: vegConfirmKeyboard(date) });
            const next = dayjs().add(db.settings.vegConfirm.followupMinutes1, "minute").toISOString();
            db.pendingConfirmations[date][pid].nextCheck = next;
            writeDbSync(db);
          } else if (rec.status === "no") {
            const last = dayjs(rec.lastUpdated);
            const minutesSince = dayjs().diff(last, "minute");
            if (minutesSince < db.settings.vegConfirm.followupMinutes2) {
              await bot.api.sendMessage(String(pid), `Reminder: still no veg list for ${date}. Please send now or confirm when sent.`);
              const next = dayjs().add(db.settings.vegConfirm.followupMinutes2, "minute").toISOString();
              db.pendingConfirmations[date][pid].nextCheck = next;
              writeDbSync(db);
            } else {
              // escalate
              for (const o of db.partners) {
                await bot.api.sendMessage(String(o.id), `⚠️ URGENT: Veg list still NOT received for ${date} from ${partner.name || pid}. Please take action.`);
              }
              delete pending[date][pid];
              writeDbSync(db);
            }
          } else if (rec.status === "pending") {
            const next = dayjs().add(db.settings.vegConfirm.followupMinutes1, "minute").toISOString();
            db.pendingConfirmations[date][pid].nextCheck = next;
            writeDbSync(db);
          }
        }
      }
    }

    // heartbeats
    reloadDb();
    const hb = db.heartbeats || {};
    const thresholdMinutes = Number(db.settings.heartbeat?.thresholdMinutes || 10);
    for (const devId of Object.keys(hb)) {
      const rec = hb[devId] || {};
      const last = rec.lastSeen ? dayjs(rec.lastSeen) : null;
      if (!last) continue;
      const minutesAgo = dayjs().diff(last, "minute");
      if (minutesAgo >= thresholdMinutes && rec.status !== "down") {
        db.heartbeats[devId].status = "down";
        writeDbSync(db);
        const text = `⚠️ *Internet/Power Alert*\nDevice: ${devId}\nStatus: *OFFLINE* (no heartbeat for ${minutesAgo} minutes)\nPlease check shop Wi-Fi/power.`;
        for (const p of db.partners) await bot.api.sendMessage(String(p.id), text, { parse_mode: "Markdown" });
        logAudit("system", "heartbeat_down", `${devId}|${minutesAgo}`);
      } else if (minutesAgo < thresholdMinutes && rec.status === "down") {
        db.heartbeats[devId].status = "ok";
        writeDbSync(db);
        const text = `✅ *Internet Restored*\nDevice: ${devId}\nStatus: *ONLINE* — heartbeat resumed.`;
        for (const p of db.partners) await bot.api.sendMessage(String(p.id), text, { parse_mode: "Markdown" });
        logAudit("system", "heartbeat_up", devId);
      }
    }

    // inventory checks
    reloadDb();
    for (const item of db.inventory || []) {
      const daysLeft = calculateDaysLeft(item);
      if (!isFinite(daysLeft)) continue;
      if (daysLeft <= (item.warnDays || 4) && !item._warned) {
        const text = `⚠️ Low stock: *${item.name}*\nStock: ${item.stock} ${item.unit}\nDaily: ${item.dailyUsage}\n~${Math.floor(daysLeft)} day(s) left.`;
        for (const p of db.partners) await bot.api.sendMessage(String(p.id), text, { parse_mode: "Markdown" });
        item._warned = true; writeDbSync(db);
        logAudit("system", "low_warning", `${item.id}|${Math.floor(daysLeft)}d`);
      }
      if (daysLeft <= (item.criticalDays || 2) && !item._critical) {
        const text = `🚨 CRITICAL: *${item.name}*\nStock: ${item.stock} ${item.unit}\nImmediate action required.`;
        for (const p of db.partners) await bot.api.sendMessage(String(p.id), text, { parse_mode: "Markdown" });
        item._critical = true; writeDbSync(db);
        logAudit("system", "critical_alert", `${item.id}|${Math.floor(daysLeft)}d`);
      }
      if (isFinite(daysLeft) && daysLeft > (item.warnDays || 4) && item._warned) { item._warned = false; writeDbSync(db); }
      if (isFinite(daysLeft) && daysLeft > (item.criticalDays || 2) && item._critical) { item._critical = false; writeDbSync(db); }
    }

  } catch (err) {
    console.error("scheduler error:", err.message);
  }
}, 30 * 1000); // 30s

// Express root
const PORT = process.env.PORT || 3000;
app.get("/", (req, res) => res.send("Inventory Reminder Bot running"));
app.listen(PORT, () => console.log(`HTTP server listening on port ${PORT}`));
