// index.js
// GTA Food City Assistant
// Organized menu with inline buttons: Employees, Inventory, Reminders, Commands, Admin, Help
// Includes: inventory, reminders, attendance, payroll, temp-admin, veg check, heartbeat.

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
if (!TELEGRAM_TOKEN) {
  console.error("Please set TELEGRAM_TOKEN env var.");
  process.exit(1);
}

// DB helpers
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
    data.settings = data.settings || {
      vegConfirm: { confirmTime: "23:30", followupMinutes1: 30, followupMinutes2: 60 },
      inventory: { checkIntervalMinutes: 60 },
      heartbeat: { thresholdMinutes: 10 },
      attendancePromptTime: "12:00",
      endOfDayPaymentCheck: "00:05",
      monthlyReminderDaysBefore: 7
    };
    data.audit = data.audit || [];
    data.sessions = data.sessions || {};
    return data;
  } catch (e) {
    const init = {
      lastSent: {},
      partners: [],
      schedules: [],
      pendingConfirmations: {},
      inventory: [],
      reminders: [],
      reminderHistory: [],
      staff: [],
      payments: [],
      heartbeats: {},
      settings: {
        vegConfirm: { confirmTime: "23:30", followupMinutes1: 30, followupMinutes2: 60 },
        inventory: { checkIntervalMinutes: 60 },
        heartbeat: { thresholdMinutes: 10 },
        attendancePromptTime: "12:00",
        endOfDayPaymentCheck: "00:05",
        monthlyReminderDaysBefore: 7
      },
      audit: [],
      sessions: {}
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(init, null, 2));
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
function reloadDb() {
  db = loadDbSync();
}

// helpers
function logAudit(actor, action, details) {
  reloadDb();
  db.audit = db.audit || [];
  db.audit.push({
    when: dayjs().toISOString(),
    actor: String(actor),
    action,
    details
  });
  writeDbSync(db);
}

// sessions: keep tempAdmin + interactive flows together
function setSession(userId, obj) {
  reloadDb();
  db.sessions = db.sessions || {};
  const existing = db.sessions[String(userId)] || {};
  db.sessions[String(userId)] = { ...existing, ...obj };
  writeDbSync(db);
}
function getSession(userId) {
  reloadDb();
  db.sessions = db.sessions || {};
  return db.sessions[String(userId)] || null;
}
function clearSession(userId) {
  reloadDb();
  if (!db.sessions || !db.sessions[String(userId)]) return;
  delete db.sessions[String(userId)].action;
  delete db.sessions[String(userId)].step;
  delete db.sessions[String(userId)].tempState;
  delete db.sessions[String(userId)].temp;
  writeDbSync(db);
}

// admin/roles
function findPartner(userId) {
  reloadDb();
  return db.partners.find(x => String(x.id) === String(userId));
}
function getStaff(userId) {
  reloadDb();
  return db.staff.find(x => String(x.id) === String(userId));
}
function upsertStaff(userId, name, role = "staff", tz = "Asia/Kolkata") {
  reloadDb();
  let s = db.staff.find(x => String(x.id) === String(userId));
  if (s) {
    s.name = name;
    s.role = role;
    s.tz = tz;
    if (!s.joinedAt) s.joinedAt = dayjs().format("YYYY-MM-DD");
    writeDbSync(db);
    return s;
  }
  s = {
    id: String(userId),
    name,
    role,
    tz,
    salaryType: "daily",
    salaryAmount: 0,
    payday: 1,
    attendance: {},
    payments: [],
    joinedAt: dayjs().format("YYYY-MM-DD")
  };
  db.staff.push(s);
  writeDbSync(db);
  return s;
}

// isAdmin: permanent (owner/admin) OR tempAdmin session
function isAdmin(userId) {
  reloadDb();
  const p = db.partners.find(x => String(x.id) === String(userId));
  if (p && (p.role === "owner" || p.role === "admin")) return true;

  const sess = db.sessions && db.sessions[String(userId)];
  if (sess && sess.tempAdmin === true) return true;

  return false;
}

function calcDaysLeft(item) {
  if (!item.dailyUsage || item.dailyUsage <= 0) return Infinity;
  return item.stock / item.dailyUsage;
}

// emojis
const E = {
  ok: "✅",
  warn: "⚠️",
  critical: "🚨",
  info: "ℹ️",
  heart: "❤️",
  clock: "⏰",
  package: "📦",
  person: "👤",
  group: "👥",
  file: "📄",
  money: "💵",
  calendar: "📅",
  phone: "📞",
  cancel: "✖️",
  partial: "🔶"
};

// bot + express
const bot = new Bot(TELEGRAM_TOKEN);
const app = express();

// MAIN MENU keyboard
function mainMenuKeyboard(userId) {
  const admin = isAdmin(userId);
  const kb = new InlineKeyboard()
    .text("👥 Employees", "menu:employees")
    .text("📦 Inventory", "menu:inventory")
    .row()
    .text("⏰ Reminders", "menu:reminders")
    .text("📄 Commands", "menu:commands")
    .row();
  if (admin) {
    kb.text("🛠 Admin", "menu:admin");
  }
  kb.text("❓ Help", "menu:help");
  return kb;
}

// simple keyboards
function vegKeyboard(date) {
  return new InlineKeyboard()
    .text("✅ Yes", `veg:${date}:yes`)
    .text("❌ No", `veg:${date}:no`)
    .row()
    .text("⏳ Not yet", `veg:${date}:notyet`);
}
function paymentKeyboard(staffId) {
  return new InlineKeyboard()
    .text(`${E.ok} Paid`, `pay:${staffId}:yes`)
    .text(`${E.partial} Partial`, `pay:${staffId}:partial`)
    .row()
    .text(`${E.warn} Not Paid`, `pay:${staffId}:no`);
}
function attendanceKeyboard(staffId) {
  return new InlineKeyboard()
    .text("Present", `att:${staffId}:present`)
    .text("Absent", `att:${staffId}:absent`)
    .row()
    .text("On Leave", `att:${staffId}:leave`);
}

// /start
bot.command("start", async (ctx) => {
  try {
    const name = ctx.from?.first_name || ctx.from?.username || "friend";
    const p = findPartner(ctx.from.id);
    const staff = getStaff(ctx.from.id) || upsertStaff(ctx.from.id, name, p?.role || "staff", p?.tz || "Asia/Kolkata");
    const sess = getSession(ctx.from.id);
    const tmpTag = sess && sess.tempAdmin ? " (TEMP ADMIN)" : "";
    const roleText = p
      ? `${p.role.toUpperCase()}${p.role === "owner" ? " " + E.heart : ""}${tmpTag}`
      : `STAFF${tmpTag}`;
    const msg =
      `${E.heart} Hello *${staff.name}*!\n` +
      `Welcome to *GTA Food City Assistant*.\n\n` +
      `Role: *${roleText}*\n\n` +
      `I help with:\n` +
      `• Daily veg list follow-up\n` +
      `• Inventory & low-stock alerts\n` +
      `• Staff attendance & payroll reminders\n` +
      `• Custom reminders for owners & staff\n\n` +
      `Use the menu below to navigate.`;

    await ctx.reply(msg, {
      parse_mode: "Markdown",
      reply_markup: mainMenuKeyboard(ctx.from.id)
    });
    logAudit(ctx.from.id, "start", String(ctx.from.id));
  } catch (e) {
    console.error("start error", e.message);
  }
});

// /whoami — show id + role + temp admin
bot.command("whoami", (ctx) => {
  const id = String(ctx.chat.id);
  reloadDb();
  const partner = db.partners.find(p => String(p.id) === id);
  const staff = db.staff.find(s => String(s.id) === id);
  const baseRole = partner?.role || staff?.role || "staff";
  const sess = db.sessions && db.sessions[id];
  const tmp = sess && sess.tempAdmin ? " (TEMP ADMIN)" : "";
  ctx.reply(`${id}\nRole: ${baseRole}${tmp}`);
});

// /admin — temp admin with password 7201
bot.command("admin", async (ctx) => {
  setSession(ctx.from.id, { action: "admin_login", step: 1 });
  await ctx.reply("Enter admin password:");
});

// /logout — remove temp admin
bot.command("logout", async (ctx) => {
  reloadDb();
  const sess = db.sessions && db.sessions[String(ctx.from.id)];
  if (sess && sess.tempAdmin) {
    delete sess.tempAdmin;
    delete sess.tempAdminSince;
    writeDbSync(db);
    await ctx.reply("✅ Logged out of temporary admin — back to your normal role.");
    logAudit(ctx.from.id, "temp_admin_revoked", String(ctx.from.id));
    return;
  }
  await ctx.reply("You were not in temporary admin mode.");
});

// /cancel — cancel interactive flow (but keep tempAdmin)
bot.command("cancel", (ctx) => {
  clearSession(ctx.from.id);
  ctx.reply(`${E.cancel} Cancelled.`);
});

// add/remove partners (owners/admins)
bot.command("addpartner", async (ctx) => {
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

bot.command("removepartner", async (ctx) => {
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

// inventory commands (still used; called by menu)
bot.command("additem", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply("Only owners/admins.");
  setSession(ctx.from.id, { action: "additem", step: 1, temp: {} });
  await ctx.reply("Add Item — Step 1/4: Enter item id (short):");
});
bot.command("purchase", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply("Only owners/admins.");
  setSession(ctx.from.id, { action: "purchase", step: 1, temp: {} });
  await ctx.reply("Purchase — Step 1/3: Enter item id:");
});
bot.command("setusage", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply("Only owners/admins.");
  setSession(ctx.from.id, { action: "setusage", step: 1, temp: {} });
  await ctx.reply("Set Usage — Step 1/2: Enter item id:");
});
bot.command("inventory", async (ctx) => {
  reloadDb();
  if (!db.inventory.length) return ctx.reply("No inventory items.");
  const lines = db.inventory.map(it => {
    const days = calcDaysLeft(it);
    const daysText = isFinite(days) ? `${Math.floor(days)} day(s)` : "N/A";
    return `${E.package} ${it.name} (${it.id}) — ${it.stock} ${it.unit}, daily ${it.dailyUsage} — ~${daysText} left`;
  });
  ctx.reply(lines.join("\n"));
});

// payroll
bot.command("setsalary", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply("Not authorized.");
  const parts = ctx.message.text.split(" ").slice(1);
  if (parts.length < 3) return ctx.reply("Usage: /setsalary <chat_id> <daily|monthly> <amount> [payday]");
  const id = parts[0];
  const type = parts[1];
  const amt = Number(parts[2]);
  const payday = parts[3] ? Number(parts[3]) : 1;
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

// pay command
bot.command("pay", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply("Not authorized.");
  const parts = ctx.message.text.split(" ").slice(1);
  if (parts.length < 1) return ctx.reply("Usage: /pay <chat_id>");
  const id = parts[0];
  reloadDb();
  const s = db.staff.find(x => String(x.id) === String(id));
  if (!s) return ctx.reply("Staff not found.");
  const kb = paymentKeyboard(id);
  await ctx.reply(`${E.money} Mark payment for ${s.name} (type: ${s.salaryType}, amount: ${s.salaryAmount})`, { reply_markup: kb });
});

// clockin / clockout / attendance
bot.command("clockin", async (ctx) => {
  const uid = String(ctx.from.id);
  const staff = getStaff(uid) || upsertStaff(uid, ctx.from.first_name || "Staff");
  const today = dayjs().tz(staff.tz || "Asia/Kolkata").format("YYYY-MM-DD");
  staff.attendance = staff.attendance || {};
  staff.attendance[today] = staff.attendance[today] || { in: null, out: null, status: null };
  if (staff.attendance[today].in) return ctx.reply("You already clocked in today.");
  staff.attendance[today].in = dayjs().toISOString();
  writeDbSync(db);
  logAudit(uid, "clockin", today);
  ctx.reply(`${E.clock} Clocked in at ${dayjs().tz(staff.tz || "Asia/Kolkata").format("HH:mm")}`);
});

bot.command("clockout", async (ctx) => {
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
  logAudit(uid, "clockout", today);
  ctx.reply(`${E.clock} Clocked out at ${dayjs().tz(staff.tz || "Asia/Kolkata").format("HH:mm")}`);
});

bot.command("attendance", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply("Not authorized.");
  const parts = ctx.message.text.split(" ").slice(1);
  if (parts.length < 1) return ctx.reply("Usage: /attendance <chat_id> [YYYY-MM]");
  const id = parts[0];
  const month = parts[1] || dayjs().format("YYYY-MM");
  reloadDb();
  const s = db.staff.find(x => String(x.id) === String(id));
  if (!s) return ctx.reply("Staff not found.");
  const days = Object.keys(s.attendance || {}).filter(d => d.startsWith(month));
  if (!days.length) return ctx.reply("No records for that month.");
  const lines = days.map(d => {
    const rec = s.attendance[d];
    const inT = rec.in ? dayjs(rec.in).tz(s.tz).format("HH:mm") : "-";
    const outT = rec.out ? dayjs(rec.out).tz(s.tz).format("HH:mm") : "-";
    const status = rec.status || "-";
    return `${d}: in ${inT} out ${outT} status ${status}`;
  });
  ctx.reply(`${E.calendar} Attendance for ${s.name} (${month}):\n` + lines.join("\n"));
});

// reminders
bot.command("addreminder", async (ctx) => {
  setSession(ctx.from.id, { action: "addreminder", step: 1, temp: {} });
  await ctx.reply("Add Reminder — Step 1/4\nWho to remind? Reply: `me`, `all`, or a chat_id.");
});

bot.command("myreminders", async (ctx) => {
  reloadDb();
  const mine = db.reminders.filter(
    r =>
      r.target === String(ctx.from.id) ||
      r.target === "all" ||
      r.createdBy === String(ctx.from.id)
  );
  if (!mine.length) return ctx.reply("No reminders.");
  const lines = mine.map(r =>
    `${E.calendar} [${r.id}] To: ${r.target} — ${r.text} — ${dayjs(r.when)
      .tz("Asia/Kolkata")
      .format("YYYY-MM-DD HH:mm")} — ${r.repeat || "once"}`
  );
  ctx.reply(lines.join("\n"));
});

// MAIN CALLBACK HANDLER (menus + veg + pay + attendance + remdone)
bot.on("callback_query:data", async (ctx) => {
  try {
    const data = ctx.callbackQuery.data || "";
    const uid = String(ctx.from.id);

    // 1) MAIN MENU
    if (data.startsWith("menu:")) {
      const section = data.split(":")[1];

      if (section === "employees") {
        reloadDb();
        const kb = new InlineKeyboard();
        if (db.staff.length) {
          db.staff.forEach(s => {
            kb.text(`${s.name} (${s.role})`, `emp:view:${s.id}`).row();
          });
        }
        kb.text("➕ Add Employee", "emp:add").row();
        kb.text("⬅️ Back", "menu:home");
        await ctx.editMessageText("👥 *Employees*\nChoose an employee or add a new one.", {
          parse_mode: "Markdown",
          reply_markup: kb
        });
        return await ctx.answerCallbackQuery();
      }

      if (section === "inventory") {
        const kb = new InlineKeyboard()
          .text("📋 Summary", "inv:list")
          .row()
          .text("➕ Add Item", "inv:add")
          .text("🧾 Purchase", "inv:purchase")
          .row()
          .text("✏️ Set Usage", "inv:setusage")
          .row()
          .text("⬅️ Back", "menu:home");
        await ctx.editMessageText("📦 *Inventory Menu*", {
          parse_mode: "Markdown",
          reply_markup: kb
        });
        return await ctx.answerCallbackQuery();
      }

      if (section === "reminders") {
        const kb = new InlineKeyboard()
          .text("➕ Add Reminder", "rem:add")
          .text("📋 My Reminders", "rem:list")
          .row()
          .text("⬅️ Back", "menu:home");
        await ctx.editMessageText("⏰ *Reminders Menu*", {
          parse_mode: "Markdown",
          reply_markup: kb
        });
        return await ctx.answerCallbackQuery();
      }

      if (section === "commands") {
        const cmds =
`${E.file} *Commands (interactive & simple)*

${E.person} /whoami
${E.package} /additem
${E.package} /purchase
${E.package} /setusage
${E.package} /inventory
${E.calendar} /addreminder
${E.calendar} /myreminders
${E.clock} /clockin
${E.clock} /clockout
${E.calendar} /attendance <id> [YYYY-MM] — admin
${E.money} /setsalary <id> <daily|monthly> <amount> [payday]
${E.money} /pay <id> — mark payment
${E.group} /addpartner <id> <name> <role>
${E.info} /admin — temp admin (password 7201)
${E.info} /logout — leave temp admin`;
        await ctx.editMessageText(cmds, {
          parse_mode: "Markdown",
          reply_markup: new InlineKeyboard().text("⬅️ Back", "menu:home")
        });
        return await ctx.answerCallbackQuery();
      }

      if (section === "admin") {
        if (!isAdmin(uid)) {
          await ctx.answerCallbackQuery({ text: "Not authorized", show_alert: true });
          return;
        }
        const kb = new InlineKeyboard()
          .text("👥 Partners", "adm:partners")
          .row()
          .text("🧪 Temp Admin Info", "adm:temp")
          .row()
          .text("⬅️ Back", "menu:home");
        await ctx.editMessageText("🛠 *Admin Area*\nOwner/Admin only.", {
          parse_mode: "Markdown",
          reply_markup: kb
        });
        return await ctx.answerCallbackQuery();
      }

      if (section === "help") {
        const msg =
`${E.info} *Help*

• Use the main menu buttons to navigate:
  - Employees → staff profiles, salary, pay cycle.
  - Inventory → items, stock, usage.
  - Reminders → one-time or daily reminders.
  - Commands → full command list.
  - Admin → technical/owner tools.

For any confusion, contact the owner (Teja).`;
        await ctx.editMessageText(msg, {
          parse_mode: "Markdown",
          reply_markup: new InlineKeyboard().text("⬅️ Back", "menu:home")
        });
        return await ctx.answerCallbackQuery();
      }

      if (section === "home") {
        await ctx.editMessageText("🏠 *Main Menu*", {
          parse_mode: "Markdown",
          reply_markup: mainMenuKeyboard(uid)
        });
        return await ctx.answerCallbackQuery();
      }
    }

    // 2) EMPLOYEES
    if (data === "emp:add") {
      if (!isAdmin(uid)) {
        await ctx.answerCallbackQuery({ text: "Owner/Admin only", show_alert: true });
        return;
      }
      setSession(uid, { action: "add_employee", step: 1, temp: {} });
      await ctx.answerCallbackQuery();
      await ctx.api.sendMessage(uid, "Add Employee — Step 1/3: Enter employee name:");
      return;
    }

    if (data.startsWith("emp:view:")) {
      const id = data.split(":")[2];
      reloadDb();
      const s = db.staff.find(st => String(st.id) === String(id));
      if (!s) {
        await ctx.answerCallbackQuery({ text: "Employee not found", show_alert: true });
        return;
      }
      const joined = s.joinedAt || "not set";
      const profile =
`👤 *Employee Profile*

ID: \`${s.id}\`
Name: *${s.name}*
Role: *${s.role}*
Date of joining: *${joined}*
Salary type: *${s.salaryType || "not set"}*
Salary amount: *${s.salaryAmount || 0}*
Payday (if monthly): *${s.payday || "-"}*`;
      const kb = new InlineKeyboard()
        .text("✏️ Set Role", `emp:setrole:${s.id}`)
        .row()
        .text("💵 Set Salary", `emp:setsalary:${s.id}`)
        .row()
        .text("❌ Remove", `emp:remove:${s.id}`)
        .row()
        .text("⬅️ Back", "menu:employees");
      await ctx.editMessageText(profile, {
        parse_mode: "Markdown",
        reply_markup: kb
      });
      return await ctx.answerCallbackQuery();
    }

    if (data.startsWith("emp:setrole:")) {
      const id = data.split(":")[2];
      if (!isAdmin(uid)) {
        await ctx.answerCallbackQuery({ text: "Owner/Admin only", show_alert: true });
        return;
      }
      setSession(uid, { action: "set_role", step: 1, temp: { staffId: id } });
      await ctx.answerCallbackQuery();
      await ctx.api.sendMessage(uid, "Enter new role for this employee: `staff`, `owner` or `admin`");
      return;
    }

    if (data.startsWith("emp:setsalary:")) {
      const id = data.split(":")[2];
      if (!isAdmin(uid)) {
        await ctx.answerCallbackQuery({ text: "Owner/Admin only", show_alert: true });
        return;
      }
      setSession(uid, { action: "setsalary_flow", step: 1, temp: { staffId: id } });
      await ctx.answerCallbackQuery();
      await ctx.api.sendMessage(uid, "Set Salary — Step 1/3: Type `daily` or `monthly`");
      return;
    }

    if (data.startsWith("emp:remove:")) {
      const id = data.split(":")[2];
      if (!isAdmin(uid)) {
        await ctx.answerCallbackQuery({ text: "Owner/Admin only", show_alert: true });
        return;
      }
      reloadDb();
      const idx = db.staff.findIndex(st => String(st.id) === String(id));
      if (idx === -1) {
        await ctx.answerCallbackQuery({ text: "Employee not found", show_alert: true });
        return;
      }
      const removed = db.staff.splice(idx, 1)[0];
      writeDbSync(db);
      logAudit(uid, "emp_removed", JSON.stringify(removed));
      await ctx.answerCallbackQuery({ text: "Employee removed" });
      await ctx.editMessageText("Employee removed.", {
        reply_markup: new InlineKeyboard().text("⬅️ Back to Employees", "menu:employees")
      });
      return;
    }

    // 3) INVENTORY menu actions
    if (data === "inv:list") {
      reloadDb();
      if (!db.inventory.length) {
        await ctx.answerCallbackQuery();
        return await ctx.editMessageText("No inventory items yet.", {
          reply_markup: new InlineKeyboard().text("⬅️ Back", "menu:inventory")
        });
      }
      const lines = db.inventory.map(it => {
        const days = calcDaysLeft(it);
        const daysText = isFinite(days) ? `${Math.floor(days)} day(s)` : "N/A";
        return `${E.package} ${it.name} (${it.id}) — ${it.stock} ${it.unit}, daily ${it.dailyUsage} — ~${daysText} left`;
      });
      await ctx.answerCallbackQuery();
      return await ctx.editMessageText(lines.join("\n"), {
        reply_markup: new InlineKeyboard().text("⬅️ Back", "menu:inventory")
      });
    }

    if (data === "inv:add") {
      if (!isAdmin(uid)) {
        await ctx.answerCallbackQuery({ text: "Owner/Admin only", show_alert: true });
        return;
      }
      setSession(uid, { action: "additem", step: 1, temp: {} });
      await ctx.answerCallbackQuery();
      await ctx.api.sendMessage(uid, "Add Item — Step 1/4: Enter item id (short):");
      return;
    }

    if (data === "inv:purchase") {
      if (!isAdmin(uid)) {
        await ctx.answerCallbackQuery({ text: "Owner/Admin only", show_alert: true });
        return;
      }
      setSession(uid, { action: "purchase", step: 1, temp: {} });
      await ctx.answerCallbackQuery();
      await ctx.api.sendMessage(uid, "Purchase — Step 1/3: Enter item id:");
      return;
    }

    if (data === "inv:setusage") {
      if (!isAdmin(uid)) {
        await ctx.answerCallbackQuery({ text: "Owner/Admin only", show_alert: true });
        return;
      }
      setSession(uid, { action: "setusage", step: 1, temp: {} });
      await ctx.answerCallbackQuery();
      await ctx.api.sendMessage(uid, "Set Usage — Step 1/2: Enter item id:");
      return;
    }

    // 4) REMINDERS
    if (data === "rem:add") {
      setSession(uid, { action: "addreminder", step: 1, temp: {} });
      await ctx.answerCallbackQuery();
      await ctx.api.sendMessage(
        uid,
        "Add Reminder — Step 1/4\nWho to remind? Reply: `me`, `all`, or a chat_id."
      );
      return;
    }

    if (data === "rem:list") {
      reloadDb();
      const mine = db.reminders.filter(
        r =>
          r.target === String(uid) ||
          r.target === "all" ||
          r.createdBy === String(uid)
      );
      await ctx.answerCallbackQuery();
      if (!mine.length) {
        return await ctx.api.sendMessage(uid, "No reminders.");
      }
      const lines = mine.map(r =>
        `${E.calendar} [${r.id}] To: ${r.target} — ${r.text} — ${dayjs(r.when)
          .tz("Asia/Kolkata")
          .format("YYYY-MM-DD HH:mm")} — ${r.repeat || "once"}`
      );
      return await ctx.api.sendMessage(uid, lines.join("\n"));
    }

    // 5) veggies
    if (data.startsWith("veg:")) {
      const [, date, action] = data.split(":");
      const pid = uid;
      reloadDb();
      db.pendingConfirmations = db.pendingConfirmations || {};
      db.pendingConfirmations[date] = db.pendingConfirmations[date] || {};
      if (action === "yes") {
        db.pendingConfirmations[date][pid] = {
          status: "confirmed",
          lastUpdated: dayjs().toISOString(),
          nextCheck: null
        };
        writeDbSync(db);
        await ctx.api.sendMessage(pid, `Thanks — veg list confirmed for ${date}. ${E.ok}`);
        await ctx.answerCallbackQuery({ text: "Confirmed ✅" });
        logAudit(pid, "veg_confirm", `yes:${date}`);
        return;
      } else if (action === "no" || action === "notyet") {
        const next = dayjs()
          .add(db.settings.vegConfirm.followupMinutes1, "minute")
          .toISOString();
        db.pendingConfirmations[date][pid] = {
          status: action === "no" ? "no" : "notyet",
          lastUpdated: dayjs().toISOString(),
          nextCheck: next
        };
        writeDbSync(db);
        await ctx.api.sendMessage(
          pid,
          `Noted — we'll remind in ${db.settings.vegConfirm.followupMinutes1} minutes.`
        );
        await ctx.answerCallbackQuery({ text: "Followup scheduled." });
        logAudit(pid, "veg_confirm", `${action}:${date}`);
        return;
      }
    }

    // 6) payment
    if (data.startsWith("pay:")) {
      const [, staffId, action] = data.split(":");
      const actor = uid;
      reloadDb();
      const staff = db.staff.find(s => String(s.id) === String(staffId));
      if (!staff) {
        await ctx.answerCallbackQuery({ text: "Staff not found." });
        return;
      }
      if (action === "yes") {
        const when = dayjs().toISOString();
        const amount = staff.salaryAmount || 0;
        db.payments = db.payments || [];
        db.payments.push({
          staffId: String(staffId),
          amount,
          when,
          recordedBy: actor,
          type: staff.salaryType
        });
        writeDbSync(db);
        await ctx.api.sendMessage(
          actor,
          `${E.ok} Recorded full payment of ${amount} for ${staff.name}.`
        );
        await ctx.answerCallbackQuery({ text: "Payment recorded." });
        logAudit(actor, "pay_full", `${staffId}|${amount}`);
        return;
      } else if (action === "partial") {
        setSession(actor, { action: "pay_partial", step: 1, temp: { staffId } });
        await ctx.api.sendMessage(actor, `Enter partial paid amount for ${staff.name} (number):`);
        await ctx.answerCallbackQuery({ text: "Enter partial amount in chat." });
        return;
      } else if (action === "no") {
        db.payments = db.payments || [];
        db.payments.push({
          staffId: String(staffId),
          amount: 0,
          when: dayjs().toISOString(),
          recordedBy: actor,
          note: "Not paid",
          type: staff.salaryType
        });
        writeDbSync(db);
        await ctx.api.sendMessage(actor, `${E.warn} Marked as NOT paid for ${staff.name}.`);
        await ctx.answerCallbackQuery({ text: "Marked not paid." });
        logAudit(actor, "pay_none", `${staffId}`);
        return;
      }
    }

    // 7) attendance quick
    if (data.startsWith("att:")) {
      const [, sid, action] = data.split(":");
      const actor = uid;
      reloadDb();
      const staff = db.staff.find(s => String(s.id) === String(sid));
      if (!staff) {
        await ctx.answerCallbackQuery({ text: "Staff not found." });
        return;
      }
      const today = dayjs().tz(staff.tz || "Asia/Kolkata").format("YYYY-MM-DD");
      staff.attendance = staff.attendance || {};
      staff.attendance[today] = staff.attendance[today] || {
        in: null,
        out: null,
        status: null
      };
      if (action === "present") staff.attendance[today].status = "present";
      else if (action === "absent") staff.attendance[today].status = "absent";
      else if (action === "leave") staff.attendance[today].status = "leave";
      writeDbSync(db);
      await ctx.api.sendMessage(
        actor,
        `${E.clock} Marked ${staff.name} as ${action} for ${today}.`
      );
      await ctx.answerCallbackQuery({ text: "Attendance saved." });
      logAudit(actor, "attendance_mark", `${sid}|${action}|${today}`);
      return;
    }

    // 8) reminder done
    if (data.startsWith("remdone:")) {
      const id = data.split(":")[1];
      reloadDb();
      const r = db.reminders.find(x => x.id === id);
      if (r) {
        r.done = true;
        writeDbSync(db);
        await ctx.answerCallbackQuery({ text: "Marked done." });
        await ctx.api.sendMessage(uid, `${E.ok} Reminder marked done.`);
        logAudit(uid, "reminder_done", id);
      } else {
        await ctx.answerCallbackQuery({ text: "Reminder not found." });
      }
      return;
    }

    // 9) admin menu extras (optional)
    if (data === "adm:partners") {
      if (!isAdmin(uid)) {
        await ctx.answerCallbackQuery({ text: "Not authorized", show_alert: true });
        return;
      }
      reloadDb();
      if (!db.partners.length) {
        await ctx.answerCallbackQuery();
        return await ctx.editMessageText("No partners defined.", {
          reply_markup: new InlineKeyboard().text("⬅️ Back", "menu:admin")
        });
      }
      const lines = db.partners.map(
        p => `${p.name} (${p.id}) — role: ${p.role}`
      );
      await ctx.answerCallbackQuery();
      return await ctx.editMessageText(lines.join("\n"), {
        reply_markup: new InlineKeyboard().text("⬅️ Back", "menu:admin")
      });
    }

    if (data === "adm:temp") {
      await ctx.answerCallbackQuery();
      return await ctx.editMessageText(
        "Temp admin:\n\nUse /admin and password 7201 to become temporary admin.\nUse /logout to return to normal role.",
        { reply_markup: new InlineKeyboard().text("⬅️ Back", "menu:admin") }
      );
    }

  } catch (err) {
    console.error("callback handler err", err);
  }
});

// MESSAGE HANDLER — interactive flows (admin_login, inventory, employees, reminders, pay_partial)
bot.on("message", async (ctx, next) => {
  try {
    const text = (ctx.message.text || "").trim();
    const session = getSession(ctx.from.id);

    // admin_login
    if (session && session.action === "admin_login") {
      const entered = text.trim();
      clearSession(ctx.from.id);
      if (entered === "7201") {
        reloadDb();
        db.sessions = db.sessions || {};
        db.sessions[String(ctx.from.id)] = db.sessions[String(ctx.from.id)] || {};
        db.sessions[String(ctx.from.id)].tempAdmin = true;
        db.sessions[String(ctx.from.id)].tempAdminSince = dayjs().toISOString();
        writeDbSync(db);
        await ctx.reply("✅ Admin access granted for this session. Use /logout to drop admin access.");
        logAudit(ctx.from.id, "temp_admin_granted", String(ctx.from.id));
      } else {
        await ctx.reply("❌ Incorrect password. Admin access denied.");
        logAudit(ctx.from.id, "temp_admin_failed", String(ctx.from.id));
      }
      return;
    }

    // add_employee flow
    if (session && session.action === "add_employee") {
      if (session.step === 1) {
        session.temp = session.temp || {};
        session.temp.name = text;
        session.step = 2;
        setSession(ctx.from.id, session);
        return await ctx.reply("Add Employee — Step 2/3: Enter employee chat_id (from /whoami):");
      }
      if (session.step === 2) {
        session.temp.chatId = text;
        session.step = 3;
        setSession(ctx.from.id, session);
        return await ctx.reply("Add Employee — Step 3/3: Enter role: `staff`, `owner`, or `admin`");
      }
      if (session.step === 3) {
        const role = text.toLowerCase();
        if (!["staff", "owner", "admin"].includes(role)) {
          return await ctx.reply("Role must be: `staff`, `owner`, or `admin`");
        }
        reloadDb();
        const id = String(session.temp.chatId);
        const name = session.temp.name;
        // update partners & staff
        if (!db.partners.find(p => String(p.id) === id)) {
          db.partners.push({
            id,
            name,
            role: role === "staff" ? "staff" : role,
            tz: "Asia/Kolkata"
          });
        } else {
          const p = db.partners.find(p => String(p.id) === id);
          p.name = name;
          p.role = role === "staff" ? "staff" : role;
        }
        writeDbSync(db);
        upsertStaff(id, name, role);
        logAudit(ctx.from.id, "add_employee", `${id}|${name}|${role}`);
        clearSession(ctx.from.id);
        return await ctx.reply(`👤 Employee added: ${name} (${id}) role: ${role}`);
      }
    }

    // set_role flow
    if (session && session.action === "set_role") {
      const role = text.toLowerCase();
      if (!["staff", "owner", "admin"].includes(role)) {
        return await ctx.reply("Role must be: `staff`, `owner`, or `admin`");
      }
      const staffId = session.temp.staffId;
      reloadDb();
      const staff = db.staff.find(s => String(s.id) === String(staffId));
      if (!staff) {
        clearSession(ctx.from.id);
        return await ctx.reply("Employee not found.");
      }
      staff.role = role;
      const p = db.partners.find(p => String(p.id) === String(staffId));
      if (p) p.role = role === "staff" ? "staff" : role;
      writeDbSync(db);
      logAudit(ctx.from.id, "set_role", `${staffId}|${role}`);
      clearSession(ctx.from.id);
      return await ctx.reply(`Role updated: ${staff.name} is now ${role}.`);
    }

    // setsalary_flow (interactive version of setsalary)
    if (session && session.action === "setsalary_flow") {
      const staffId = session.temp.staffId;
      if (session.step === 1) {
        const type = text.toLowerCase();
        if (!["daily", "monthly"].includes(type)) {
          return await ctx.reply("Type must be `daily` or `monthly`.");
        }
        session.temp.salaryType = type;
        session.step = 2;
        setSession(ctx.from.id, session);
        return await ctx.reply("Set Salary — Step 2/3: Enter salary amount (number):");
      }
      if (session.step === 2) {
        const amt = Number(text);
        if (isNaN(amt)) return await ctx.reply("Enter numeric amount.");
        session.temp.salaryAmount = amt;
        if (session.temp.salaryType === "monthly") {
          session.step = 3;
          setSession(ctx.from.id, session);
          return await ctx.reply("Set Salary — Step 3/3: Enter payday (1–31):");
        } else {
          // daily: finish
          reloadDb();
          const s = db.staff.find(x => String(x.id) === String(staffId));
          if (!s) {
            clearSession(ctx.from.id);
            return await ctx.reply("Staff not found.");
          }
          s.salaryType = "daily";
          s.salaryAmount = amt;
          writeDbSync(db);
          logAudit(ctx.from.id, "setsalary_flow", `${staffId}|daily|${amt}`);
          clearSession(ctx.from.id);
          return await ctx.reply(`💵 Salary set for ${s.name}: daily ${amt}`);
        }
      }
      if (session.step === 3) {
        const day = Number(text);
        if (isNaN(day) || day < 1 || day > 31) return await ctx.reply("Enter payday 1–31.");
        reloadDb();
        const s = db.staff.find(x => String(x.id) === String(staffId));
        if (!s) {
          clearSession(ctx.from.id);
          return await ctx.reply("Staff not found.");
        }
        s.salaryType = "monthly";
        s.salaryAmount = session.temp.salaryAmount;
        s.payday = day;
        writeDbSync(db);
        logAudit(ctx.from.id, "setsalary_flow", `${staffId}|monthly|${s.salaryAmount}|${day}`);
        clearSession(ctx.from.id);
        return await ctx.reply(`💵 Salary set for ${s.name}: monthly ${s.salaryAmount} (payday ${day})`);
      }
    }

    // additem flow
    if (session && session.action === "additem") {
      if (session.step === 1) {
        session.temp.id = text.replace(/\s+/g, "_").toLowerCase();
        session.step = 2;
        setSession(ctx.from.id, session);
        return await ctx.reply("Step 2/4: Enter full name.");
      }
      if (session.step === 2) {
        session.temp.name = text;
        session.step = 3;
        setSession(ctx.from.id, session);
        return await ctx.reply("Step 3/4: Enter daily usage (number).");
      }
      if (session.step === 3) {
        const d = Number(text);
        if (isNaN(d)) return await ctx.reply("Enter number.");
        session.temp.dailyUsage = d;
        session.step = 4;
        setSession(ctx.from.id, session);
        return await ctx.reply("Step 4/4: Enter stock and unit (e.g. 50 packets).");
      }
      if (session.step === 4) {
        const p = text.split(" ");
        const stock = Number(p[0]);
        const unit = p.slice(1).join(" ") || "units";
        if (isNaN(stock)) return await ctx.reply("Provide numeric stock.");
        reloadDb();
        if (db.inventory.find(it => String(it.id) === String(session.temp.id))) {
          clearSession(ctx.from.id);
          return await ctx.reply("Item id exists.");
        }
        db.inventory.push({
          id: session.temp.id,
          name: session.temp.name,
          stock,
          unit,
          dailyUsage: session.temp.dailyUsage,
          warnDays: 4,
          criticalDays: 2,
          lastUpdated: dayjs().toISOString()
        });
        writeDbSync(db);
        logAudit(ctx.from.id, "additem", `${session.temp.id}|${session.temp.name}|${stock}`);
        clearSession(ctx.from.id);
        return await ctx.reply(`${E.package} Added ${session.temp.name} (${session.temp.id}) ${stock} ${unit}`);
      }
    }

    // purchase flow
    if (session && session.action === "purchase") {
      if (session.step === 1) {
        session.temp.id = text;
        session.step = 2;
        setSession(ctx.from.id, session);
        return await ctx.reply("Step 2/3: Enter quantity (number).");
      }
      if (session.step === 2) {
        const q = Number(text);
        if (isNaN(q)) return await ctx.reply("Enter number.");
        session.temp.qty = q;
        session.step = 3;
        setSession(ctx.from.id, session);
        return await ctx.reply("Step 3/3: Enter unit or 'same'.");
      }
      if (session.step === 3) {
        const unit = text === "same" ? null : text;
        reloadDb();
        const it = db.inventory.find(x => String(x.id) === String(session.temp.id));
        if (!it) {
          clearSession(ctx.from.id);
          return await ctx.reply("Item not found.");
        }
        it.stock = (it.stock || 0) + Number(session.temp.qty);
        if (unit) it.unit = unit;
        it.lastUpdated = dayjs().toISOString();
        writeDbSync(db);
        logAudit(ctx.from.id, "purchase", `${it.id}|${session.temp.qty}`);
        clearSession(ctx.from.id);
        return await ctx.reply(
          `${E.package} Purchase recorded: +${session.temp.qty} ${it.unit} to ${it.name}. Now ${it.stock} ${it.unit}`
        );
      }
    }

    // setusage flow
    if (session && session.action === "setusage") {
      if (session.step === 1) {
        session.temp.id = text;
        session.step = 2;
        setSession(ctx.from.id, session);
        return await ctx.reply("Step 2/2: Enter daily usage (number).");
      }
      if (session.step === 2) {
        const u = Number(text);
        if (isNaN(u)) return await ctx.reply("Enter number.");
        reloadDb();
        const it = db.inventory.find(x => String(x.id) === String(session.temp.id));
        if (!it) {
          clearSession(ctx.from.id);
          return await ctx.reply("Item not found.");
        }
        it.dailyUsage = u;
        it.lastUpdated = dayjs().toISOString();
        writeDbSync(db);
        logAudit(ctx.from.id, "setusage", `${it.id}|${u}`);
        clearSession(ctx.from.id);
        return await ctx.reply(`${E.package} Daily usage for ${it.name} set to ${u}.`);
      }
    }

    // addreminder flow
    if (session && session.action === "addreminder") {
      if (session.step === 1) {
        const who = text.toLowerCase();
        if (who === "me") session.temp.target = String(ctx.from.id);
        else if (who === "all") session.temp.target = "all";
        else session.temp.target = text;
        session.step = 2;
        setSession(ctx.from.id, session);
        return await ctx.reply("Step 2/4: Enter reminder text (short):");
      }
      if (session.step === 2) {
        session.temp.text = text;
        session.step = 3;
        setSession(ctx.from.id, session);
        return await ctx.reply("Step 3/4: Enter datetime (YYYY-MM-DD HH:MM) in IST:");
      }
      if (session.step === 3) {
        const parsed = dayjs.tz(text, "YYYY-MM-DD HH:mm", "Asia/Kolkata");
        if (!parsed.isValid()) return await ctx.reply("Invalid. Use YYYY-MM-DD HH:MM");
        session.temp.when = parsed.toISOString();
        session.step = 4;
        setSession(ctx.from.id, session);
        return await ctx.reply("Step 4/4: Repeat? reply 'once' or 'daily':");
      }
      if (session.step === 4) {
        const rep = text.toLowerCase();
        if (!(rep === "once" || rep === "daily")) return await ctx.reply("Reply 'once' or 'daily'.");
        session.temp.repeat = rep;
        reloadDb();
        const id = `r${Date.now()}`;
        db.reminders.push({
          id,
          createdBy: String(ctx.from.id),
          target: session.temp.target,
          text: session.temp.text,
          when: session.temp.when,
          repeat: session.temp.repeat
        });
        writeDbSync(db);
        logAudit(
          ctx.from.id,
          "addreminder",
          `${id}|${session.temp.target}|${session.temp.text}|${session.temp.when}|${session.temp.repeat}`
        );
        clearSession(ctx.from.id);
        return await ctx.reply(
          `${E.calendar} Reminder saved: ${session.temp.text} at ${dayjs(session.temp.when)
            .tz("Asia/Kolkata")
            .format("YYYY-MM-DD HH:mm")} repeat: ${session.temp.repeat}`
        );
      }
    }

    // pay_partial
    if (session && session.action === "pay_partial") {
      if (session.step === 1) {
        const amt = Number(text);
        if (isNaN(amt)) return await ctx.reply("Enter numeric amount.");
        const staffId = session.temp.staffId;
        reloadDb();
        const staff = db.staff.find(s => String(s.id) === String(staffId));
        db.payments = db.payments || [];
        db.payments.push({
          staffId: String(staffId),
          amount: amt,
          when: dayjs().toISOString(),
          recordedBy: String(ctx.from.id),
          note: "partial"
        });
        writeDbSync(db);
        logAudit(ctx.from.id, "pay_partial", `${staffId}|${amt}`);
        clearSession(ctx.from.id);
        return await ctx.reply(
          `${E.partial} Recorded partial payment of ${amt} for ${staff ? staff.name : staffId}.`
        );
      }
    }

    // no active session → pass to next
    return next();
  } catch (err) {
    console.error("message handler error:", err);
    try {
      await ctx.reply("Error processing. Use /cancel to stop current action.");
    } catch {}
  }
});

// send veg confirm
async function sendVegConfirmForDate(date) {
  reloadDb();
  const s = db.schedules.find(x => x.id === "vegetables");
  if (!s) return;
  for (const p of db.partners || []) {
    const existing =
      db.pendingConfirmations &&
      db.pendingConfirmations[date] &&
      db.pendingConfirmations[date][p.id];
    if (existing && existing.status === "confirmed") continue;
    const text =
      `${E.calendar} *Vegetable check for ${date}*\n\n` +
      `${s.message}\n\nPlease confirm below.`;
    try {
      await bot.api.sendMessage(String(p.id), text, {
        parse_mode: "Markdown",
        reply_markup: vegKeyboard(date)
      });
    } catch (e) {
      console.error("veg send err", e.message);
    }
    if (!existing) {
      reloadDb();
      db.pendingConfirmations = db.pendingConfirmations || {};
      db.pendingConfirmations[date] = db.pendingConfirmations[date] || {};
      db.pendingConfirmations[date][p.id] = {
        status: "pending",
        lastUpdated: dayjs().toISOString(),
        nextCheck: null
      };
      writeDbSync(db);
    }
  }
}

// scheduler
bot.start({ onStart: () => console.log("Bot started (polling).") });

setInterval(async () => {
  try {
    reloadDb();
    const partners = db.partners || [];
    const schedules = db.schedules || [];

    // Schedules (veg + others)
    for (const s of schedules) {
      for (const p of partners) {
        try {
          const tz = p.tz || "Asia/Kolkata";
          const nowTz = dayjs().tz(tz);
          const [hh, mm] = (s.time || "00:00").split(":").map(Number);
          if (nowTz.hour() === hh && nowTz.minute() === mm) {
            const key = `${s.id}__${p.id}`;
            const lastSentIso = db.lastSent[key];
            const lastSentDay = lastSentIso
              ? dayjs(lastSentIso).tz(tz).format("YYYY-MM-DD")
              : null;
            const today = nowTz.format("YYYY-MM-DD");
            if (lastSentDay === today) continue;
            if (s.id === "vegetables") {
              const bizDate = dayjs().tz("Asia/Kolkata").format("YYYY-MM-DD");
              await sendVegConfirmForDate(bizDate);
              for (const pp of partners) {
                db.lastSent[`${s.id}__${pp.id}`] = dayjs().toISOString();
              }
              writeDbSync(db);
            } else {
              const text =
                `${E.calendar} *${s.label}*\n\n${s.message}\n\n` +
                `Local: ${nowTz.format("YYYY-MM-DD HH:mm (z)")}`;
              await bot.api.sendMessage(String(p.id), text, { parse_mode: "Markdown" });
              db.lastSent[key] = dayjs().toISOString();
              writeDbSync(db);
            }
          }
        } catch (e) {
          console.error("schedule send err", e.message);
        }
      }
    }

    // veg followups & escalation
    const pending = db.pendingConfirmations || {};
    for (const date of Object.keys(pending)) {
      for (const pid of Object.keys(pending[date])) {
        const rec = pending[date][pid];
        if (!rec) continue;
        if (rec.status === "confirmed") {
          delete pending[date][pid];
          writeDbSync(db);
          continue;
        }
        if (!rec.nextCheck) {
          db.pendingConfirmations[date][pid].nextCheck = dayjs()
            .add(db.settings.vegConfirm.followupMinutes1, "minute")
            .toISOString();
          writeDbSync(db);
          continue;
        }
        if (dayjs(rec.nextCheck).isBefore(dayjs())) {
          const partner = findPartner(pid);
          if (!partner) {
            delete pending[date][pid];
            writeDbSync(db);
            continue;
          }
          if (rec.status === "notyet") {
            await bot.api.sendMessage(
              String(pid),
              `Reminder: please confirm veg list for ${date}.`,
              { reply_markup: vegKeyboard(date) }
            );
            db.pendingConfirmations[date][pid].nextCheck = dayjs()
              .add(db.settings.vegConfirm.followupMinutes1, "minute")
              .toISOString();
            writeDbSync(db);
          } else if (rec.status === "no") {
            const last = dayjs(rec.lastUpdated);
            const minutesSince = dayjs().diff(last, "minute");
            if (minutesSince < db.settings.vegConfirm.followupMinutes2) {
              await bot.api.sendMessage(
                String(pid),
                `Reminder: still no veg list for ${date}. Please send now or confirm when sent.`
              );
              db.pendingConfirmations[date][pid].nextCheck = dayjs()
                .add(db.settings.vegConfirm.followupMinutes2, "minute")
                .toISOString();
              writeDbSync(db);
            } else {
              for (const o of db.partners) {
                await bot.api.sendMessage(
                  String(o.id),
                  `${E.warn} URGENT: Veg list still NOT received for ${date} from ${
                    partner.name || pid
                  }.`
                );
              }
              delete pending[date][pid];
              writeDbSync(db);
            }
          } else if (rec.status === "pending") {
            db.pendingConfirmations[date][pid].nextCheck = dayjs()
              .add(db.settings.vegConfirm.followupMinutes1, "minute")
              .toISOString();
            writeDbSync(db);
          }
        }
      }
    }

    // reminders (once/daily)
    const now = dayjs();
    for (const r of db.reminders || []) {
      if (r.done) continue;
      const when = dayjs(r.when);
      if (when.isBefore(now.add(1, "minute"))) {
        let targets = [];
        if (r.target === "all") targets = db.partners.map(p => String(p.id));
        else targets = [String(r.target)];
        for (const t of targets) {
          try {
            const kb = new InlineKeyboard().text(`${E.ok} Done`, `remdone:${r.id}`);
            await bot.api.sendMessage(
              t,
              `${E.calendar} *Reminder*\n${r.text}\nAt: ${when
                .tz("Asia/Kolkata")
                .format("YYYY-MM-DD HH:mm")}`,
              { parse_mode: "Markdown", reply_markup: kb }
            );
          } catch (e) {
            console.error("reminder send err", e.message);
          }
        }
        if (r.repeat === "daily") {
          r.when = dayjs(r.when).add(1, "day").toISOString();
        } else {
          r.done = true;
        }
        writeDbSync(db);
        logAudit("system", "reminder_sent", `${r.id}|${r.text}`);
      }
    }
    db.reminders = (db.reminders || []).filter(r => !r.done);
    writeDbSync(db);

    // attendance prompt
    const attTime = db.settings.attendancePromptTime || "12:00";
    const [attH, attM] = attTime.split(":").map(Number);
    const bizNow = dayjs().tz("Asia/Kolkata");
    if (bizNow.hour() === attH && bizNow.minute() === attM) {
      const key = `attendance_prompt__${bizNow.format("YYYY-MM-DD")}`;
      if (!db.lastSent[key]) {
        for (const s of db.staff || []) {
          try {
            const kb = attendanceKeyboard(s.id);
            for (const p of db.partners) {
              await bot.api.sendMessage(
                String(p.id),
                `${E.clock} Attendance: Did *${s.name}* come to work today?`,
                { parse_mode: "Markdown", reply_markup: kb }
              );
            }
          } catch (e) {
            console.error("attendance prompt err", e.message);
          }
        }
        db.lastSent[key] = dayjs().toISOString();
        writeDbSync(db);
      }
    }

    // daily pay check
    const eod = db.settings.endOfDayPaymentCheck || "00:05";
    const [eodH, eodM] = eod.split(":").map(Number);
    if (bizNow.hour() === eodH && bizNow.minute() === eodM) {
      const key = `paycheck_eod__${bizNow.format("YYYY-MM-DD")}`;
      if (!db.lastSent[key]) {
        for (const s of db.staff || []) {
          if (s.salaryType === "daily") {
            for (const p of db.partners) {
              try {
                await bot.api.sendMessage(
                  String(p.id),
                  `${E.money} Payment check — Did you pay *${s.name}* (${s.salaryAmount}) today?`,
                  { parse_mode: "Markdown", reply_markup: paymentKeyboard(s.id) }
                );
              } catch (e) {
                console.error("paycheck send err", e.message);
              }
            }
          }
        }
        db.lastSent[key] = dayjs().toISOString();
        writeDbSync(db);
      }
    }

    // monthly reminders
    const mdaysBefore = Number(db.settings.monthlyReminderDaysBefore || 7);
    for (const s of db.staff || []) {
      if (s.salaryType === "monthly") {
        const payday = Number(s.payday || 1);
        let payMoment = dayjs().tz("Asia/Kolkata").date(payday).startOf("day");
        if (payMoment.isBefore(bizNow.startOf("day"))) payMoment = payMoment.add(1, "month");
        const daysUntil = payMoment.diff(bizNow.startOf("day"), "day");
        const keyBefore = `monthly_reminder_before__${s.id}__${payMoment.format("YYYY-MM")}`;
        if (daysUntil === mdaysBefore && !db.lastSent[keyBefore]) {
          for (const p of db.partners) {
            await bot.api.sendMessage(
              String(p.id),
              `${E.calendar} Reminder: Payday for ${s.name} is in ${mdaysBefore} day(s) on ${payMoment.format(
                "YYYY-MM-DD"
              )}. Amount: ${s.salaryAmount}`
            );
          }
          db.lastSent[keyBefore] = dayjs().toISOString();
          writeDbSync(db);
        }
        const keyPayday = `monthly_reminder_payday__${s.id}__${payMoment.format("YYYY-MM")}`;
        if (bizNow.isSame(payMoment, "day") && !db.lastSent[keyPayday]) {
          for (const p of db.partners) {
            await bot.api.sendMessage(
              String(p.id),
              `${E.money} Payday today for ${s.name} — Amount: ${s.salaryAmount}. Mark payment:`,
              { reply_markup: paymentKeyboard(s.id) }
            );
          }
          db.lastSent[keyPayday] = dayjs().toISOString();
          writeDbSync(db);
        }
      }
    }

    // inventory checks
    reloadDb();
    for (const item of db.inventory || []) {
      const daysLeft = calcDaysLeft(item);
      if (!isFinite(daysLeft)) continue;
      if (daysLeft <= (item.warnDays || 4) && !item._warned) {
        const txt =
          `${E.warn} Low stock: *${item.name}*\n` +
          `Stock: ${item.stock} ${item.unit}\nDaily: ${item.dailyUsage}\n` +
          `~${Math.floor(daysLeft)} day(s) left.`;
        for (const p of db.partners) {
          await bot.api.sendMessage(String(p.id), txt, { parse_mode: "Markdown" });
        }
        item._warned = true;
        writeDbSync(db);
        logAudit("system", "low_warning", `${item.id}|${Math.floor(daysLeft)}d`);
      }
      if (daysLeft <= (item.criticalDays || 2) && !item._critical) {
        const txt =
          `${E.critical} CRITICAL: *${item.name}*\n` +
          `Stock: ${item.stock} ${item.unit}\nImmediate action required.`;
        for (const p of db.partners) {
          await bot.api.sendMessage(String(p.id), txt, { parse_mode: "Markdown" });
        }
        item._critical = true;
        writeDbSync(db);
        logAudit("system", "critical_alert", `${item.id}|${Math.floor(daysLeft)}d`);
      }
      if (isFinite(daysLeft) && daysLeft > (item.warnDays || 4) && item._warned) {
        item._warned = false;
        writeDbSync(db);
      }
      if (isFinite(daysLeft) && daysLeft > (item.criticalDays || 2) && item._critical) {
        item._critical = false;
        writeDbSync(db);
      }
    }

  } catch (err) {
    console.error("scheduler error", err);
  }
}, 30 * 1000);

// heartbeat endpoint
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

// express root
const PORT = process.env.PORT || 3000;
app.get("/", (req, res) => res.send("Inventory Reminder Bot running"));
app.listen(PORT, () => console.log(`HTTP server listening on port ${PORT}`));
