// index.js
// Full bot: inventory, custom reminders, attendance, payroll, inline buttons, emoji UI.
// IMPORTANT: set TELEGRAM_TOKEN and HEARTBEAT_SECRET in Render env vars.

const { Bot, InlineKeyboard } = require("grammy");
const fs = require("fs");
const path = require("path");
const express = require("express");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");
dayjs.extend(utc);
dayjs.extend(timezone);

// ENV
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const HEARTBEAT_SECRET = process.env.HEARTBEAT_SECRET || "";
if (!TELEGRAM_TOKEN) { console.error("Please set TELEGRAM_TOKEN env var."); process.exit(1); }

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
    data.reminders = data.reminders || [];
    data.reminderHistory = data.reminderHistory || [];
    data.staff = data.staff || [];
    data.payments = data.payments || [];
    data.heartbeats = data.heartbeats || {};
    data.settings = data.settings || { vegConfirm: { confirmTime: "23:30", followupMinutes1: 30, followupMinutes2: 60 }, inventory: { checkIntervalMinutes: 60 }, heartbeat: { thresholdMinutes: 10 }, attendancePromptTime: "12:00", endOfDayPaymentCheck: "00:05", monthlyReminderDaysBefore: 7 };
    data.audit = data.audit || [];
    data.sessions = data.sessions || {};
    return data;
  } catch (e) {
    const init = {
      lastSent: {}, partners: [], schedules: [], pendingConfirmations: {}, inventory: [], reminders: [], reminderHistory: [], staff: [], payments: [], heartbeats: {},
      settings: { vegConfirm: { confirmTime: "23:30", followupMinutes1: 30, followupMinutes2: 60 }, inventory: { checkIntervalMinutes: 60 }, heartbeat: { thresholdMinutes: 10 }, attendancePromptTime: "12:00", endOfDayPaymentCheck: "00:05", monthlyReminderDaysBefore: 7 },
      audit: [], sessions: {}
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(init, null, 2));
    return init;
  }
}
function writeDbSync(db) { try { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); return true; } catch (e) { console.error("Failed writing db.json:", e.message); return false; } }
let db = loadDbSync();
function reloadDb() { db = loadDbSync(); }

// helpers
function logAudit(actor, action, details) { reloadDb(); db.audit = db.audit || []; db.audit.push({ when: dayjs().toISOString(), actor: String(actor), action, details }); writeDbSync(db); }
function isAdmin(userId) { reloadDb(); const p = db.partners.find(x => String(x.id) === String(userId)); return p && (p.role === "owner" || p.role === "admin"); }
function findPartner(userId) { reloadDb(); return db.partners.find(x => String(x.id) === String(userId)); }
function getStaff(userId) { reloadDb(); return db.staff.find(x => String(x.id) === String(userId)); }
function upsertStaff(userId, name, role = "staff", tz = "Asia/Kolkata") { reloadDb(); let s = db.staff.find(x => String(x.id) === String(userId)); if (s) { s.name = name; s.role = role; s.tz = tz; writeDbSync(db); return s;} s = { id: String(userId), name, role, tz, salaryType: "daily", salaryAmount: 0, payday: 1, attendance: {}, payments: [] }; db.staff.push(s); writeDbSync(db); return s; }
function calcDaysLeft(item) { if (!item.dailyUsage || item.dailyUsage <= 0) return Infinity; return item.stock / item.dailyUsage; }
function setSession(userId, obj) { reloadDb(); db.sessions = db.sessions || {}; db.sessions[String(userId)] = obj; writeDbSync(db); }
function getSession(userId) { reloadDb(); db.sessions = db.sessions || {}; return db.sessions[String(userId)] || null; }
function clearSession(userId) { reloadDb(); if (db.sessions && db.sessions[String(userId)]) { delete db.sessions[String(userId)]; writeDbSync(db); } }

// UI emojis
const E = { ok: "✅", warn: "⚠️", critical: "🚨", info: "ℹ️", heart: "❤️", clock: "⏰", package: "📦", person: "👤", group: "👥", file: "📄", money: "💵", calendar: "📅", phone: "📞", cancel: "✖️", partial: "🔶" };

// bot + express
const bot = new Bot(TELEGRAM_TOKEN);

// START welcome (professional & emotional)
bot.command("start", async (ctx) => {
  try {
    const name = ctx.from?.first_name || ctx.from?.username || "friend";
    // ensure staff record exists
    upsertStaff(ctx.from.id, name, findPartner(ctx.from.id)?.role || "staff", findPartner(ctx.from.id)?.tz || "Asia/Kolkata");
    const partner = findPartner(ctx.from.id);
    const roleText = partner ? `*Role:* ${partner.role.toUpperCase()} ${partner.role === "owner" ? E.heart : ""}` : "*Role:* staff";
    const msg = `${E.heart} Hello *${name}* — Welcome to *GTA Food City Assistant*.\n\n${roleText}\n${E.info} I keep our kitchen calm and the team confident: veg confirmations, inventory alerts, attendance & payroll reminders, and custom reminders.\n\nTap below to begin.`;
    const kb = new InlineKeyboard()
      .text("How it works", "start:how")
      .text("Commands", "start:commands")
      .row()
      .text("Quick Add Item", "start:quickadd")
      .text("My Status", "start:mystatus")
      .row()
      .text("Support", "start:support");
    await ctx.reply(msg, { parse_mode: "Markdown", reply_markup: kb });
    logAudit(ctx.from.id, "start", `${ctx.from.id}`);
  } catch (e) { console.error("start error", e.message); }
});

// callback handler for start buttons, veg and payroll/attendance/pay buttons
bot.on("callback_query:data", async (ctx, next) => {
  try {
    const data = ctx.callbackQuery?.data || "";
    if (!data) return;
    // START buttons
    if (data.startsWith("start:")) {
      const action = data.split(":")[1];
      if (action === "how") {
        await ctx.api.sendMessage(ctx.from.id, `${E.info} *How it works*\n• Closing-time veg check with Yes/No/Not yet and auto followups.\n• Inventory: add/purchase/set usage → bot warns when low.\n• Attendance & payroll: clock in/out; bot reminds/payments daily or monthly.\n• Create custom reminders for yourself or everyone.`, { parse_mode: "Markdown" });
        await ctx.answerCallbackQuery({ text: "How it works — sent." });
        return;
      }
      if (action === "commands") {
        const cmds =
`${E.file} *Commands (interactive & simple)*\n\n${E.person} /whoami\n${E.package} /additem — interactive\n${E.package} /purchase — interactive\n${E.package} /setusage — interactive\n${E.package} /inventory\n${E.calendar} /addreminder — interactive\n${E.calendar} /myreminders\n${E.clock} /clockin\n${E.clock} /clockout\n${E.calendar} /attendance <id> — admin view\n${E.money} /setsalary <id> <daily|monthly> <amount> [payday]\n${E.money} /pay <id> — mark payment\n${E.group} /addpartner <id> <name> <role>`;
        await ctx.api.sendMessage(ctx.from.id, cmds, { parse_mode: "Markdown" });
        await ctx.answerCallbackQuery({ text: "Commands sent." });
        return;
      }
      if (action === "quickadd") {
        if (!isAdmin(ctx.from.id)) { await ctx.answerCallbackQuery({ text: "Only owners/admins." }); return; }
        setSession(ctx.from.id, { action: "additem", step: 1, temp: {} });
        await ctx.api.sendMessage(ctx.from.id, "Quick Add Item: Step 1 — Enter item id (short):");
        await ctx.answerCallbackQuery();
        return;
      }
      if (action === "mystatus") {
        const partner = findPartner(ctx.from.id);
        const staff = getStaff(ctx.from.id);
        const role = partner?.role || staff?.role || "staff";
        const salary = staff?.salaryAmount || 0;
        const salaryType = staff?.salaryType || "daily";
        await ctx.api.sendMessage(ctx.from.id, `${E.person} *Your Status*\nName: ${staff?.name}\nRole: ${role}\nSalary: ${salaryType} ${salary}\nUse /attendance to view your records.`, { parse_mode: "Markdown" });
        await ctx.answerCallbackQuery({ text: "Status sent." });
        return;
      }
      if (action === "support") {
        await ctx.api.sendMessage(ctx.from.id, `${E.phone} Support: message co-owners or admin. For access changes use /addpartner.`, { parse_mode: "Markdown" });
        await ctx.answerCallbackQuery({ text: "Support info sent." });
        return;
      }
    }

    // Veg confirm callbacks: veg:YYYY-MM-DD:yes/no/notyet
    if (data.startsWith("veg:")) {
      const [, date, action] = data.split(":");
      const pid = String(ctx.from.id);
      reloadDb();
      db.pendingConfirmations = db.pendingConfirmations || {};
      db.pendingConfirmations[date] = db.pendingConfirmations[date] || {};
      if (action === "yes") {
        db.pendingConfirmations[date][pid] = { status: "confirmed", lastUpdated: dayjs().toISOString(), nextCheck: null };
        writeDbSync(db);
        await ctx.api.sendMessage(pid, `Thanks — veg list confirmed for ${date}. ${E.ok}`);
        await ctx.answerCallbackQuery({ text: "Confirmed ✅" });
        logAudit(pid, "veg_confirm", `yes:${date}`);
        return;
      } else if (action === "no" || action === "notyet") {
        const next = dayjs().add(db.settings.vegConfirm.followupMinutes1, "minute").toISOString();
        db.pendingConfirmations[date][pid] = { status: action === "no" ? "no" : "notyet", lastUpdated: dayjs().toISOString(), nextCheck: next };
        writeDbSync(db);
        await ctx.api.sendMessage(pid, `Noted — we'll remind in ${db.settings.vegConfirm.followupMinutes1} minutes.`);
        await ctx.answerCallbackQuery({ text: "Followup scheduled." });
        logAudit(pid, "veg_confirm", `${action}:${date}`);
        return;
      }
    }

    // Payment callbacks: pay:<id>:yes/partial/no
    if (data.startsWith("pay:")) {
      const [, staffId, action] = data.split(":");
      const actor = String(ctx.from.id);
      reloadDb();
      const staff = db.staff.find(s => String(s.id) === String(staffId));
      if (!staff) { await ctx.answerCallbackQuery({ text: "Staff not found." }); return; }
      if (action === "yes") {
        // record full payment for today (or last pay period)
        const when = dayjs().toISOString();
        const amount = staff.salaryAmount || 0;
        db.payments = db.payments || [];
        db.payments.push({ staffId: String(staffId), amount, when, recordedBy: actor, type: staff.salaryType });
        writeDbSync(db);
        await ctx.api.sendMessage(actor, `${E.ok} Recorded full payment of ${amount} for ${staff.name}.`);
        await ctx.answerCallbackQuery({ text: "Payment recorded." });
        logAudit(actor, "pay_full", `${staffId}|${amount}`);
        return;
      } else if (action === "partial") {
        // ask actor to enter amount — start a small session
        setSession(actor, { action: "pay_partial", step: 1, temp: { staffId } });
        await ctx.api.sendMessage(actor, `Enter partial paid amount for ${staff.name} (number):`);
        await ctx.answerCallbackQuery({ text: "Enter partial amount in chat." });
        return;
      } else if (action === "no") {
        // record unpaid
        db.payments = db.payments || [];
        db.payments.push({ staffId: String(staffId), amount: 0, when: dayjs().toISOString(), recordedBy: actor, note: "Not paid", type: staff.salaryType });
        writeDbSync(db);
        await ctx.api.sendMessage(actor, `${E.warn} Marked as NOT paid for ${staff.name}.`);
        await ctx.answerCallbackQuery({ text: "Marked not paid." });
        logAudit(actor, "pay_none", `${staffId}`);
        return;
      }
    }

    // Attendance quick callbacks: att:<id>:present/absent/leave
    if (data.startsWith("att:")) {
      const [, sid, action] = data.split(":");
      const actor = String(ctx.from.id);
      reloadDb();
      const staff = db.staff.find(s => String(s.id) === String(sid));
      if (!staff) { await ctx.answerCallbackQuery({ text: "Staff not found." }); return; }
      const today = dayjs().tz(staff.tz || "Asia/Kolkata").format("YYYY-MM-DD");
      staff.attendance = staff.attendance || {};
      staff.attendance[today] = staff.attendance[today] || { in: null, out: null, status: null };
      if (action === "present") staff.attendance[today].status = "present";
      else if (action === "absent") staff.attendance[today].status = "absent";
      else if (action === "leave") staff.attendance[today].status = "leave";
      writeDbSync(db);
      await ctx.api.sendMessage(actor, `${E.clock} Marked ${staff.name} as ${action} for ${today}.`);
      await ctx.answerCallbackQuery({ text: "Attendance saved." });
      logAudit(actor, "attendance_mark", `${sid}|${action}|${today}`);
      return;
    }

    // pass through
    return next();

  } catch (err) { console.error("callback handler err", err); }
});

// Commands & interactive session flows
bot.command("whoami", ctx => ctx.reply(String(ctx.chat.id)));
bot.command("cancel", ctx => { clearSession(ctx.from.id); ctx.reply(`${E.cancel} Cancelled.`); });

// addpartner / removepartner
bot.command("addpartner", async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.reply("Not authorized.");
  const parts = ctx.message.text.split(" ").slice(1);
  if (parts.length < 2) return ctx.reply("Usage: /addpartner <chat_id> <name> [role]");
  const id = parts[0], name = parts[1], role = parts[2] || "staff";
  reloadDb();
  if (db.partners.find(p => String(p.id) === String(id))) return ctx.reply("Partner exists.");
  db.partners.push({ id: String(id), name, role, tz: "Asia/Kolkata" });
  writeDbSync(db);
  upsertStaff(id, name, role);
  logAudit(ctx.from.id, "addpartner", `${id}|${name}|${role}`);
  ctx.reply(`Added partner ${name} (${id}) as ${role}.`);
});
bot.command("removepartner", async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.reply("Not authorized.");
  const parts = ctx.message.text.split(" ").slice(1);
  if (!parts.length) return ctx.reply("Usage: /removepartner <chat_id>");
  const id = parts[0]; reloadDb();
  const idx = db.partners.findIndex(p => String(p.id) === String(id));
  if (idx === -1) return ctx.reply("Partner not found.");
  const removed = db.partners.splice(idx, 1)[0]; writeDbSync(db);
  logAudit(ctx.from.id, "removepartner", JSON.stringify(removed));
  ctx.reply(`Removed partner ${removed.name} (${removed.id}).`);
});

// Interactive additem / purchase / setusage flows (same as before but preserved)
bot.command("additem", async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.reply("Only owners/admins.");
  setSession(ctx.from.id, { action: "additem", step: 1, temp: {} });
  await ctx.reply("Add Item — Step 1/4: Enter item id (short):");
});
bot.command("purchase", async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.reply("Only owners/admins.");
  setSession(ctx.from.id, { action: "purchase", step: 1, temp: {} });
  await ctx.reply("Purchase — Step 1/3: Enter item id:");
});
bot.command("setusage", async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.reply("Only owners/admins.");
  setSession(ctx.from.id, { action: "setusage", step: 1, temp: {} });
  await ctx.reply("Set Usage — Step 1/2: Enter item id:");
});
bot.command("inventory", async ctx => {
  reloadDb();
  if (!db.inventory.length) return ctx.reply("No inventory items.");
  const lines = db.inventory.map(it => {
    const days = calcDaysLeft(it);
    const daysText = isFinite(days) ? `${Math.floor(days)} day(s)` : "N/A";
    return `${E.package} ${it.name} (${it.id}) — ${it.stock} ${it.unit}, daily ${it.dailyUsage} — ~${daysText} left`;
  });
  ctx.reply(lines.join("\n"));
});

// staff & payroll commands
bot.command("setsalary", async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.reply("Not authorized.");
  const parts = ctx.message.text.split(" ").slice(1);
  if (parts.length < 3) return ctx.reply("Usage: /setsalary <chat_id> <daily|monthly> <amount> [payday]");
  const id = parts[0]; const type = parts[1]; const amt = Number(parts[2]); const payday = parts[3] ? Number(parts[3]) : 1;
  if (isNaN(amt)) return ctx.reply("Enter numeric amount.");
  reloadDb();
  const s = db.staff.find(x => String(x.id) === String(id));
  if (!s) return ctx.reply("Staff not found.");
  s.salaryType = type === "monthly" ? "monthly" : "daily";
  s.salaryAmount = amt;
  if (type === "monthly") s.payday = payday;
  writeDbSync(db);
  logAudit(ctx.from.id, "setsalary", `${id}|${s.salaryType}|${amt}|${s.payday}`);
  ctx.reply(`${E.money} Salary set for ${s.name}: ${s.salaryType} ${s.salaryAmount} ${s.salaryType === "monthly" ? `(payday: ${s.payday})` : ""}`);
});

// pay command (starts inline pay flow)
bot.command("pay", async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.reply("Not authorized.");
  const parts = ctx.message.text.split(" ").slice(1);
  if (parts.length < 1) return ctx.reply("Usage: /pay <chat_id>");
  const id = parts[0];
  reloadDb();
  const s = db.staff.find(x => String(x.id) === String(id));
  if (!s) return ctx.reply("Staff not found.");
  // send inline buttons: Paid / Partial / Not Paid
  const kb = new InlineKeyboard().text(`${E.ok} Paid`, `pay:${id}:yes`).text(`${E.partial} Partial`, `pay:${id}:partial`).row().text(`${E.warn} Not Paid`, `pay:${id}:no`);
  await ctx.reply(`${E.money} Mark payment for ${s.name} (type: ${s.salaryType}, amount: ${s.salaryAmount})`, { reply_markup: kb });
});

// clockin/out & attendance (simple)
bot.command("clockin", async ctx => {
  const uid = String(ctx.from.id);
  const staff = getStaff(uid) || upsertStaff(uid, ctx.from.first_name || "Staff");
  const today = dayjs().tz(staff.tz || "Asia/Kolkata").format("YYYY-MM-DD");
  staff.attendance = staff.attendance || {};
  staff.attendance[today] = staff.attendance[today] || { in: null, out: null, status: null };
  if (staff.attendance[today].in) return ctx.reply("You already clocked in today.");
  staff.attendance[today].in = dayjs().toISOString();
  writeDbSync(db);
  logAudit(uid, "clockin", `${today}`);
  ctx.reply(`${E.clock} Clocked in at ${dayjs().tz(staff.tz || "Asia/Kolkata").format("HH:mm")}`);
});
bot.command("clockout", async ctx => {
  const uid = String(ctx.from.id);
  const staff = getStaff(uid);
  if (!staff) return ctx.reply("Not registered. Ask admin to add you.");
  const today = dayjs().tz(staff.tz || "Asia/Kolkata").format("YYYY-MM-DD");
  staff.attendance = staff.attendance || {};
  staff.attendance[today] = staff.attendance[today] || { in: null, out: null, status: null };
  if (!staff.attendance[today].in) return ctx.reply("You didn't clock in today.");
  if (staff.attendance[today].out) return ctx.reply("You already clocked out.");
  staff.attendance[today].out = dayjs().toISOString();
  writeDbSync(db);
  logAudit(uid, "clockout", `${today}`);
  ctx.reply(`${E.clock} Clocked out at ${dayjs().tz(staff.tz || "Asia/Kolkata").format("HH:mm")}`);
});

// attendance admin view
bot.command("attendance", async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.reply("Not authorized.");
  const parts = ctx.message.text.split(" ").slice(1);
  if (parts.length < 1) return ctx.reply("Usage: /attendance <chat_id> [YYYY-MM]");
  const id = parts[0]; const month = parts[1] || dayjs().format("YYYY-MM");
  reloadDb();
  const s = db.staff.find(x => String(x.id) === String(id));
  if (!s) return ctx.reply("Staff not found.");
  const days = Object.keys(s.attendance || {}).filter(d => d.startsWith(month));
  if (!days.length) return ctx.reply("No records for that month.");
  const lines = days.map(d => { const rec = s.attendance[d]; const inT = rec.in ? dayjs(rec.in).tz(s.tz).format("HH:mm") : "-", outT = rec.out ? dayjs(rec.out).tz(s.tz).format("HH:mm") : "-", status = rec.status || "-"; return `${d}: in ${inT} out ${outT} status ${status}`; });
  ctx.reply(`${E.calendar} Attendance for ${s.name} (${month}):\n` + lines.join("\n"));
});

// addreminder interactive
bot.command("addreminder", async ctx => {
  setSession(ctx.from.id, { action: "addreminder", step: 1, temp: {} });
  await ctx.reply("Add Reminder — Step 1/4\nWho to remind? Reply: `me`, `all`, or a chat_id.");
});
bot.command("myreminders", async ctx => {
  reloadDb();
  const mine = db.reminders.filter(r => r.target === String(ctx.from.id) || r.target === "all" || r.createdBy === String(ctx.from.id));
  if (!mine.length) return ctx.reply("No reminders.");
  const lines = mine.map(r => `${E.calendar} [${r.id}] To: ${r.target} — ${r.text} — ${dayjs(r.when).tz("Asia/Kolkata").format("YYYY-MM-DD HH:mm")} — ${r.repeat || "once"}`);
  ctx.reply(lines.join("\n"));
});

// message handler for interactive sessions (additem/purchase/setusage/addreminder and partial payment)
bot.on("message", async (ctx, next) => {
  try {
    const text = (ctx.message.text || "").trim();
    const session = getSession(ctx.from.id);
    if (!session) return next();
    // additem flow
    if (session.action === "additem") {
      if (session.step === 1) { session.temp.id = text.replace(/\s+/g, "_").toLowerCase(); session.step = 2; setSession(ctx.from.id, session); return ctx.reply("Step 2/4: Enter full name."); }
      if (session.step === 2) { session.temp.name = text; session.step = 3; setSession(ctx.from.id, session); return ctx.reply("Step 3/4: Enter daily usage (number)."); }
      if (session.step === 3) { const d = Number(text); if (isNaN(d)) return ctx.reply("Enter number."); session.temp.dailyUsage = d; session.step = 4; setSession(ctx.from.id, session); return ctx.reply("Step 4/4: Enter stock and unit (e.g. 50 packets)."); }
      if (session.step === 4) { const p = text.split(" "); const stock = Number(p[0]); const unit = p.slice(1).join(" ") || "units"; if (isNaN(stock)) return ctx.reply("Provide numeric stock."); reloadDb(); if (db.inventory.find(it => String(it.id) === String(session.temp.id))) { clearSession(ctx.from.id); return ctx.reply("Item id exists."); } db.inventory.push({ id: session.temp.id, name: session.temp.name, stock, unit, dailyUsage: session.temp.dailyUsage, warnDays: 4, criticalDays: 2, lastUpdated: dayjs().toISOString() }); writeDbSync(db); logAudit(ctx.from.id, "additem", `${session.temp.id}|${session.temp.name}|${stock}`); clearSession(ctx.from.id); return ctx.reply(`${E.package} Added ${session.temp.name} (${session.temp.id}) ${stock} ${unit}`); }
    }

    // purchase flow
    if (session.action === "purchase") {
      if (session.step === 1) { session.temp.id = text; session.step = 2; setSession(ctx.from.id, session); return ctx.reply("Step 2/3: Enter quantity (number)."); }
      if (session.step === 2) { const q = Number(text); if (isNaN(q)) return ctx.reply("Enter number."); session.temp.qty = q; session.step = 3; setSession(ctx.from.id, session); return ctx.reply("Step 3/3: Enter unit or 'same'."); }
      if (session.step === 3) { const unit = text === "same" ? null : text; reloadDb(); const it = db.inventory.find(x => String(x.id) === String(session.temp.id)); if (!it) { clearSession(ctx.from.id); return ctx.reply("Item not found."); } it.stock = (it.stock || 0) + Number(session.temp.qty); if (unit) it.unit = unit; it.lastUpdated = dayjs().toISOString(); writeDbSync(db); logAudit(ctx.from.id, "purchase", `${it.id}|${session.temp.qty}`); clearSession(ctx.from.id); return ctx.reply(`${E.package} Purchase recorded: +${session.temp.qty} ${it.unit} to ${it.name}. Now ${it.stock} ${it.unit}`); }
    }

    // setusage flow
    if (session.action === "setusage") {
      if (session.step === 1) { session.temp.id = text; session.step = 2; setSession(ctx.from.id, session); return ctx.reply("Step 2/2: Enter daily usage (number)."); }
      if (session.step === 2) { const u = Number(text); if (isNaN(u)) return ctx.reply("Enter number."); reloadDb(); const it = db.inventory.find(x => String(x.id) === String(session.temp.id)); if (!it) { clearSession(ctx.from.id); return ctx.reply("Item not found."); } it.dailyUsage = u; it.lastUpdated = dayjs().toISOString(); writeDbSync(db); logAudit(ctx.from.id, "setusage", `${it.id}|${u}`); clearSession(ctx.from.id); return ctx.reply(`${E.package} Daily usage for ${it.name} set to ${u}.`); }
    }

    // addreminder flow
    if (session.action === "addreminder") {
      if (session.step === 1) {
        const who = text.toLowerCase();
        if (who === "me") session.temp.target = String(ctx.from.id);
        else if (who === "all") session.temp.target = "all";
        else session.temp.target = text;
        session.step = 2; setSession(ctx.from.id, session);
        return ctx.reply("Step 2/4: Enter reminder text (short):");
      } else if (session.step === 2) {
        session.temp.text = text; session.step = 3; setSession(ctx.from.id, session);
        return ctx.reply("Step 3/4: Enter datetime (YYYY-MM-DD HH:MM) in IST:");
      } else if (session.step === 3) {
        const parsed = dayjs.tz(text, "YYYY-MM-DD HH:mm", "Asia/Kolkata");
        if (!parsed.isValid()) return ctx.reply("Invalid. Use YYYY-MM-DD HH:MM");
        session.temp.when = parsed.toISOString(); session.step = 4; setSession(ctx.from.id, session);
        return ctx.reply("Step 4/4: Repeat? reply 'once' or 'daily':");
      } else if (session.step === 4) {
        const rep = text.toLowerCase(); if (!(rep === "once" || rep === "daily")) return ctx.reply("Reply 'once' or 'daily'.");
        session.temp.repeat = rep;
        reloadDb();
        const id = `r${Date.now()}`;
        db.reminders.push({ id, createdBy: String(ctx.from.id), target: session.temp.target, text: session.temp.text, when: session.temp.when, repeat: session.temp.repeat });
        writeDbSync(db);
        logAudit(ctx.from.id, "addreminder", `${id}|${session.temp.target}|${session.temp.text}|${session.temp.when}|${session.temp.repeat}`);
        clearSession(ctx.from.id);
        return ctx.reply(`${E.calendar} Reminder saved: ${session.temp.text} at ${dayjs(session.temp.when).tz("Asia/Kolkata").format("YYYY-MM-DD HH:mm")} repeat: ${session.temp.repeat}`);
      }
    }

    // pay_partial session: actor enters amount to record partial payment
    if (session.action === "pay_partial") {
      if (session.step === 1) {
        const amt = Number(text);
        if (isNaN(amt)) return ctx.reply("Enter numeric amount.");
        const staffId = session.temp.staffId;
        reloadDb();
        const staff = db.staff.find(s => String(s.id) === String(staffId));
        db.payments = db.payments || [];
        db.payments.push({ staffId: String(staffId), amount: amt, when: dayjs().toISOString(), recordedBy: String(ctx.from.id), note: "partial" });
        writeDbSync(db);
        logAudit(ctx.from.id, "pay_partial", `${staffId}|${amt}`);
        clearSession(ctx.from.id);
        return ctx.reply(`${E.partial} Recorded partial payment of ${amt} for ${staff ? staff.name : staffId}.`);
      }
    }

    // fallback
    return;
  } catch (err) {
    console.error("message handler error:", err); try { await ctx.reply("Error processing. Use /cancel to stop."); } catch(e) {}
  }
});

// heartbeat endpoint (unchanged)
const app = express();
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
  } catch (err) { console.error("heartbeat error", err); return res.status(500).send("error"); }
});

// helper keyboards
function vegKeyboard(date) { return new InlineKeyboard().text("✅ Yes", `veg:${date}:yes`).text("❌ No", `veg:${date}:no`).row().text("⏳ Not yet", `veg:${date}:notyet`); }
function paymentKeyboard(staffId) { return new InlineKeyboard().text(`${E.ok} Paid`, `pay:${staffId}:yes`).text(`${E.partial} Partial`, `pay:${staffId}:partial`).row().text(`${E.warn} Not Paid`, `pay:${staffId}:no`); }
function attendanceKeyboard(staffId) { return new InlineKeyboard().text("Present", `att:${staffId}:present`).text("Absent", `att:${staffId}:absent`).row().text("On Leave", `att:${staffId}:leave`); }

// send veg confirm
async function sendVegConfirmForDate(date) {
  reloadDb();
  const s = db.schedules.find(x => x.id === "vegetables");
  if (!s) return;
  for (const p of (db.partners || [])) {
    const existing = db.pendingConfirmations && db.pendingConfirmations[date] && db.pendingConfirmations[date][p.id];
    if (existing && existing.status === "confirmed") continue;
    const text = `${E.calendar} *Vegetable check for ${date}*\n\n${s.message}\n\nPlease confirm below.`;
    try { await bot.api.sendMessage(String(p.id), text, { parse_mode: "Markdown", reply_markup: vegKeyboard(date) }); } catch(e) { console.error("veg send err", e.message); }
    if (!existing) { reloadDb(); db.pendingConfirmations = db.pendingConfirmations || {}; db.pendingConfirmations[date] = db.pendingConfirmations[date] || {}; db.pendingConfirmations[date][p.id] = { status: "pending", lastUpdated: dayjs().toISOString(), nextCheck: null }; writeDbSync(db); }
  }
}

// scheduler (runs every 30s) — handles schedules, veg followups, reminders, attendance prompts, payment prompts, inventory checks
bot.start({ onStart: () => console.log("Bot started (polling).") });
setInterval(async () => {
  try {
    reloadDb();
    const partners = db.partners || [];
    const schedules = db.schedules || [];

    // 1) schedules (veg + others)
    for (const s of schedules) {
      for (const p of partners) {
        try {
          const tz = p.tz || "Asia/Kolkata";
          const nowTz = dayjs().tz(tz);
          const [hh, mm] = (s.time || "00:00").split(":").map(Number);
          if (nowTz.hour() === hh && nowTz.minute() === mm) {
            const key = `${s.id}__${p.id}`;
            const lastSentIso = db.lastSent[key];
            const lastSentDay = lastSentIso ? dayjs(lastSentIso).tz(tz).format("YYYY-MM-DD") : null;
            const today = nowTz.format("YYYY-MM-DD");
            if (lastSentDay === today) continue;
            if (s.id === "vegetables") {
              const bizDate = dayjs().tz("Asia/Kolkata").format("YYYY-MM-DD");
              await sendVegConfirmForDate(bizDate);
              for (const pp of partners) db.lastSent[`${s.id}__${pp.id}`] = dayjs().toISOString();
              writeDbSync(db);
            } else {
              const text = `${E.calendar} *${s.label}*\n\n${s.message}\n\nLocal: ${nowTz.format("YYYY-MM-DD HH:mm (z)")}`;
              await bot.api.sendMessage(String(p.id), text, { parse_mode: "Markdown" });
              db.lastSent[key] = dayjs().toISOString();
              writeDbSync(db);
            }
          }
        } catch (e) { console.error("schedule send err", e.message); }
      }
    }

    // 2) veg confirmations followups & escalate
    const pending = db.pendingConfirmations || {};
    for (const date of Object.keys(pending)) {
      for (const pid of Object.keys(pending[date])) {
        const rec = pending[date][pid];
        if (!rec) continue;
        if (rec.status === "confirmed") { delete pending[date][pid]; writeDbSync(db); continue; }
        if (!rec.nextCheck) { db.pendingConfirmations[date][pid].nextCheck = dayjs().add(db.settings.vegConfirm.followupMinutes1, "minute").toISOString(); writeDbSync(db); continue; }
        if (dayjs(rec.nextCheck).isBefore(dayjs())) {
          const partner = findPartner(pid);
          if (!partner) { delete pending[date][pid]; writeDbSync(db); continue; }
          if (rec.status === "notyet") {
            await bot.api.sendMessage(String(pid), `Reminder: please confirm veg list for ${date}.`, { reply_markup: vegKeyboard(date) });
            db.pendingConfirmations[date][pid].nextCheck = dayjs().add(db.settings.vegConfirm.followupMinutes1, "minute").toISOString(); writeDbSync(db);
          } else if (rec.status === "no") {
            const last = dayjs(rec.lastUpdated); const minutesSince = dayjs().diff(last, "minute");
            if (minutesSince < db.settings.vegConfirm.followupMinutes2) {
              await bot.api.sendMessage(String(pid), `Reminder: still no veg list for ${date}. Please send now or confirm when sent.`);
              db.pendingConfirmations[date][pid].nextCheck = dayjs().add(db.settings.vegConfirm.followupMinutes2, "minute").toISOString(); writeDbSync(db);
            } else {
              for (const o of db.partners) await bot.api.sendMessage(String(o.id), `${E.warn} URGENT: Veg list still NOT received for ${date} from ${partner.name || pid}.`);
              delete pending[date][pid]; writeDbSync(db);
            }
          } else if (rec.status === "pending") {
            db.pendingConfirmations[date][pid].nextCheck = dayjs().add(db.settings.vegConfirm.followupMinutes1, "minute").toISOString(); writeDbSync(db);
          }
        }
      }
    }

    // 3) reminders (once/daily)
    const now = dayjs();
    for (const r of (db.reminders || [])) {
      if (r.done) continue;
      const when = dayjs(r.when);
      if (when.isBefore(now.add(1, "minute"))) {
        let targets = [];
        if (r.target === "all") targets = db.partners.map(p => String(p.id));
        else targets = [String(r.target)];
        for (const t of targets) {
          try {
            // send with inline "Done" button
            const kb = new InlineKeyboard().text(`${E.ok} Done`, `remdone:${r.id}`);
            await bot.api.sendMessage(t, `${E.calendar} *Reminder*\n${r.text}\nAt: ${when.tz("Asia/Kolkata").format("YYYY-MM-DD HH:mm")}`, { parse_mode: "Markdown", reply_markup: kb });
          } catch (e) { console.error("reminder send err", e.message); }
        }
        if (r.repeat === "daily") { r.when = dayjs(r.when).add(1, "day").toISOString(); } else { r.done = true; }
        writeDbSync(db);
        logAudit("system", "reminder_sent", `${r.id}|${r.text}`);
      }
    }
    db.reminders = (db.reminders || []).filter(r => !r.done); writeDbSync(db);

    // 4) attendance daily prompt (configured time) -> at attendancePromptTime IST ask for each staff via inline buttons to manager/admin
    // We'll send attendance prompt to all partners (or could be to managers only)
    const attTime = db.settings.attendancePromptTime || "12:00";
    const [attH, attM] = attTime.split(":").map(Number);
    const bizNow = dayjs().tz("Asia/Kolkata");
    if (bizNow.hour() === attH && bizNow.minute() === attM) {
      // avoid duplicate sends: use lastSent key
      const key = `attendance_prompt__${bizNow.format("YYYY-MM-DD")}`;
      if (!db.lastSent[key]) {
        for (const s of (db.staff || [])) {
          try {
            const kb = attendanceKeyboard(s.id);
            // send to partners (owners/admins) who manage attendance
            for (const p of db.partners) {
              await bot.api.sendMessage(String(p.id), `${E.clock} Attendance: Did *${s.name}* come to work today?`, { parse_mode: "Markdown", reply_markup: kb });
            }
          } catch (e) { console.error("attendance prompt err", e.message); }
        }
        db.lastSent[key] = dayjs().toISOString(); writeDbSync(db);
      }
    }

    // 5) payroll reminders
    // daily check (endOfDayPaymentCheck) — ask: Did you pay this daily staff today? buttons: Paid/Partial/Not paid
    const eod = db.settings.endOfDayPaymentCheck || "00:05";
    const [eodH, eodM] = eod.split(":").map(Number);
    if (bizNow.hour() === eodH && bizNow.minute() === eodM) {
      const key = `paycheck_eod__${bizNow.format("YYYY-MM-DD")}`;
      if (!db.lastSent[key]) {
        for (const s of (db.staff || [])) {
          if (s.salaryType === "daily") {
            for (const p of db.partners) {
              try {
                await bot.api.sendMessage(String(p.id), `${E.money} Payment check — Did you pay *${s.name}* (${s.salaryAmount}) today?`, { parse_mode: "Markdown", reply_markup: paymentKeyboard(s.id) });
              } catch (e) { console.error("paycheck send err", e.message); }
            }
          }
        }
        db.lastSent[key] = dayjs().toISOString(); writeDbSync(db);
      }
    }

    // monthly reminders: 1) daysBefore reminder, 2) payday reminder
    const mdaysBefore = Number(db.settings.monthlyReminderDaysBefore || 7);
    // iterate staff with monthly salary
    for (const s of (db.staff || [])) {
      if (s.salaryType === "monthly") {
        const payday = Number(s.payday || 1);
        const payDateThisMonth = dayjs().tz("Asia/Kolkata").date(payday).startOf("day");
        // if payday is earlier than today (and month rolling), make sure to use current month
        let payMoment = payDateThisMonth;
        if (payMoment.isBefore(bizNow.startOf("day"))) payMoment = payMoment.add(1, "month");
        const daysUntil = payMoment.diff(bizNow.startOf("day"), "day");
        // if daysUntil === mdaysBefore -> send reminder (once)
        const keyBefore = `monthly_reminder_before__${s.id}__${payMoment.format("YYYY-MM")}`;
        if (daysUntil === mdaysBefore && !db.lastSent[keyBefore]) {
          // send to partners
          for (const p of db.partners) await bot.api.sendMessage(String(p.id), `${E.calendar} Reminder: Payday for ${s.name} is in ${mdaysBefore} day(s) on ${payMoment.format("YYYY-MM-DD")}. Amount: ${s.salaryAmount}`);
          db.lastSent[keyBefore] = dayjs().toISOString(); writeDbSync(db);
        }
        // payday reminder
        const keyPayday = `monthly_reminder_payday__${s.id}__${payMoment.format("YYYY-MM")}`;
        if (bizNow.isSame(payMoment, "day") && !db.lastSent[keyPayday]) {
          for (const p of db.partners) await bot.api.sendMessage(String(p.id), `${E.money} Payday today for ${s.name} — Amount: ${s.salaryAmount}. Mark payment:`, { reply_markup: paymentKeyboard(s.id) });
          db.lastSent[keyPayday] = dayjs().toISOString(); writeDbSync(db);
        }
      }
    }

    // 6) inventory checks (warn/critical)
    reloadDb();
    for (const item of db.inventory || []) {
      const daysLeft = calcDaysLeft(item);
      if (!isFinite(daysLeft)) continue;
      if (daysLeft <= (item.warnDays || 4) && !item._warned) {
        const txt = `${E.warn} Low stock: *${item.name}*\nStock: ${item.stock} ${item.unit}\nDaily: ${item.dailyUsage}\n~${Math.floor(daysLeft)} day(s) left.`;
        for (const p of db.partners) await bot.api.sendMessage(String(p.id), txt, { parse_mode: "Markdown" });
        item._warned = true; writeDbSync(db); logAudit("system", "low_warning", `${item.id}|${Math.floor(daysLeft)}d`);
      }
      if (daysLeft <= (item.criticalDays || 2) && !item._critical) {
        const txt = `${E.critical} CRITICAL: *${item.name}*\nStock: ${item.stock} ${item.unit}\nImmediate action required.`;
        for (const p of db.partners) await bot.api.sendMessage(String(p.id), txt, { parse_mode: "Markdown" });
        item._critical = true; writeDbSync(db); logAudit("system", "critical_alert", `${item.id}|${Math.floor(daysLeft)}d`);
      }
      if (isFinite(daysLeft) && daysLeft > (item.warnDays || 4) && item._warned) { item._warned = false; writeDbSync(db); }
      if (isFinite(daysLeft) && daysLeft > (item.criticalDays || 2) && item._critical) { item._critical = false; writeDbSync(db); }
    }

  } catch (err) { console.error("scheduler error", err); }
}, 30 * 1000);

// inline callback for reminder done (remdone:<id>)
bot.on("callback_query:data", async (ctx) => {
  try {
    const data = ctx.callbackQuery?.data || "";
    if (data.startsWith("remdone:")) {
      const id = data.split(":")[1];
      reloadDb();
      const r = db.reminders.find(x => x.id === id);
      if (r) {
        r.done = true; writeDbSync(db);
        await ctx.answerCallbackQuery({ text: "Marked done." });
        await ctx.api.sendMessage(ctx.from.id, `${E.ok} Reminder marked done.`);
        logAudit(ctx.from.id, "reminder_done", id);
      } else {
        await ctx.answerCallbackQuery({ text: "Reminder not found." });
      }
    }
  } catch (e) { console.error("remdone cb err", e); }
});

// Express root
const PORT = process.env.PORT || 3000;
app.get("/", (req, res) => res.send("Inventory Reminder Bot running"));
app.listen(PORT, () => console.log(`HTTP server listening on port ${PORT}`));
