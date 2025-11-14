// index.js (web-service friendly, simple file-db using fs)
const { Bot } = require("grammy");
const fs = require("fs");
const path = require("path");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");
const express = require("express");

dayjs.extend(utc);
dayjs.extend(timezone);

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
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
    return data;
  } catch (e) {
    // If file missing or corrupt, create a default structure
    const init = { lastSent: {}, partners: [], schedules: [] };
    try { fs.writeFileSync(DB_FILE, JSON.stringify(init, null, 2)); } catch(err){ /* ignore */ }
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

// in-memory DB (kept synced)
let db = loadDbSync();

function reloadDb() {
  db = loadDbSync();
}

// helpers for schedule/time checks
function parseTimeHHMM(timeStr) {
  const [hh, mm] = (timeStr || "00:00").split(":").map(Number);
  return { hh: hh || 0, mm: mm || 0 };
}

function timeMatchesNowForTZ(timeStr, nowTz) {
  const { hh, mm } = parseTimeHHMM(timeStr);
  return nowTz.hour() === hh && nowTz.minute() === mm;
}

function shouldSendForPartner(schedule, partner, nowTz) {
  if (!timeMatchesNowForTZ(schedule.time, nowTz)) return false;
  const key = `${schedule.id}__${partner.id}`;
  const lastSentIso = db.lastSent[key];
  if (!lastSentIso) return true;
  const last = dayjs(lastSentIso).tz(partner.tz || "UTC");
  const diffDays = nowTz.startOf('day').diff(last.startOf('day'), 'day');
  return diffDays >= (schedule.intervalDays || 1);
}

function markSentForPartner(scheduleId, partnerId, now) {
  const key = `${scheduleId}__${partnerId}`;
  db.lastSent[key] = now.toISOString();
  writeDbSync(db);
}

const bot = new Bot(TELEGRAM_TOKEN);

// Telegram commands
bot.command("start", ctx => ctx.reply("Inventory Reminder Bot active. You will receive scheduled alerts."));
bot.command("whoami", ctx => ctx.reply(`Your chat id: ${ctx.chat.id}`));
bot.command("schedules", ctx => {
  reloadDb();
  const list = (db.schedules || []).map(s => `${s.label} (${s.id}) — every ${s.intervalDays} day(s) at ${s.time}`).join("\n");
  ctx.reply("Current schedules:\n" + (list || "No schedules found."));
});
bot.command("test", async ctx => {
  const parts = ctx.message.text.split(" ");
  if (parts.length < 2) return ctx.reply("Usage: /test <schedule_id>");
  const id = parts[1].trim();
  reloadDb();
  const s = db.schedules.find(x => x.id === id);
  if (!s) return ctx.reply("Schedule not found: " + id);
  const targets = (db.partners || []).map(p => String(p.id));
  const now = dayjs();
  for (const pid of targets) {
    try {
      const partner = db.partners.find(p => String(p.id) === String(pid));
      const displayTime = now.tz(partner.tz || "UTC").format("YYYY-MM-DD HH:mm (z)");
      const text = `🔔 TEST — ${s.label}\n\n${s.message}\n\nTime for ${partner.name}: ${displayTime}`;
      await bot.api.sendMessage(pid, text);
    } catch (e) {
      console.error("test send error", e.message);
    }
  }
  ctx.reply("Test reminders sent to all partners.");
});
bot.command("setschedule", async ctx => {
  const userId = String(ctx.chat.id);
  reloadDb();
  if (!db.partners.find(p => String(p.id) === userId)) return ctx.reply("Not authorized.");
  const parts = ctx.message.text.split(" ");
  if (parts.length < 4) return ctx.reply("Usage: /setschedule id intervalDays HH:MM Message...");
  const id = parts[1];
  const intervalDays = parseInt(parts[2], 10) || 1;
  const time = parts[3];
  const message = parts.slice(4).join(" ") || `Check ${id}`;
  const idx = db.schedules.findIndex(s => s.id === id);
  if (idx === -1) {
    db.schedules.push({ id, label: id, intervalDays, time, message });
  } else {
    db.schedules[idx] = { ...db.schedules[idx], intervalDays, time, message };
  }
  writeDbSync(db);
  ctx.reply(`Schedule set: ${id} every ${intervalDays} days at ${time}`);
});

(async function main() {
  // ensure DB is loaded
  reloadDb();

  // start bot polling
  bot.start({ onStart: () => console.log("Bot started (polling).") });

  // scheduler loop every 30 seconds
  setInterval(async () => {
    try {
      reloadDb();
      const partners = db.partners || [];
      const schedules = db.schedules || [];
      for (const partner of partners) {
        try {
          const partnerTz = partner.tz || "UTC";
          const nowTz = dayjs().tz(partnerTz);
          for (const schedule of schedules) {
            try {
              if (shouldSendForPartner(schedule, partner, nowTz)) {
                const displayTimeForPartner = nowTz.format("YYYY-MM-DD HH:mm (z)");
                const istTime = dayjs().tz("Asia/Kolkata").format("YYYY-MM-DD HH:mm (z)");
                const text = `🔔 *${schedule.label} Reminder*\n\n${schedule.message}\n\n_Local time: ${displayTimeForPartner}_\n_Business IST: ${istTime}_`;
                await bot.api.sendMessage(String(partner.id), text, { parse_mode: "Markdown" });
                markSentForPartner(schedule.id, partner.id, nowTz);
                console.log(`Sent ${schedule.id} to ${partner.name} (${partner.id}) at ${displayTimeForPartner}`);
              }
            } catch (e) {
              console.error("Error send to partner", partner.id, schedule.id, e.message);
            }
          }
        } catch (e) {
          console.error("Error processing partner", partner.id, e.message);
        }
      }
    } catch (err) {
      console.error("Scheduler loop error:", err.message);
    }
  }, 30 * 1000);

  // small Express server for health-check (so UptimeRobot can ping the URL)
  const app = express();
  app.get("/", (req, res) => res.send("Inventory Reminder Bot running"));
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`HTTP server listening on port ${PORT}`));
})();
