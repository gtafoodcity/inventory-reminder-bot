// index.js (worker-ready)
const { Bot } = require("grammy");
const { Low } = require("lowdb");
const { JSONFile } = require("lowdb/node");
const fs = require("fs");
const path = require("path");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");

dayjs.extend(utc);
dayjs.extend(timezone);

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
if (!TELEGRAM_TOKEN) {
  console.error("Please set TELEGRAM_TOKEN env var.");
  process.exit(1);
}

const DB_FILE = path.join(__dirname, "db.json");
if (!fs.existsSync(DB_FILE)) {
  console.error("db.json not found. Create db.json (see README).");
  process.exit(1);
}

const adapter = new JSONFile(DB_FILE);
const db = new Low(adapter);

async function initDb() {
  await db.read();
  db.data = db.data || { lastSent: {}, partners: [], schedules: [] };
  await db.write();
}

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
  const lastSentIso = db.data.lastSent[key];
  if (!lastSentIso) return true;
  const last = dayjs(lastSentIso).tz(partner.tz);
  const diffDays = nowTz.startOf('day').diff(last.startOf('day'), 'day');
  return diffDays >= (schedule.intervalDays || 1);
}

async function markSentForPartner(scheduleId, partnerId, now) {
  const key = `${scheduleId}__${partnerId}`;
  db.data.lastSent[key] = now.toISOString();
  await db.write();
}

const bot = new Bot(TELEGRAM_TOKEN);

// commands
bot.command("start", ctx => ctx.reply("Inventory Reminder Bot active. You will receive scheduled alerts."));
bot.command("whoami", ctx => ctx.reply(`Your chat id: ${ctx.chat.id}`));
bot.command("schedules", async ctx => {
  await db.read();
  const list = db.data.schedules.map(s => `${s.label} (${s.id}) — every ${s.intervalDays} day(s) at ${s.time}`).join("\n");
  ctx.reply("Current schedules:\n" + list);
});
bot.command("test", async ctx => {
  const parts = ctx.message.text.split(" ");
  if (parts.length < 2) return ctx.reply("Usage: /test <schedule_id>");
  const id = parts[1].trim();
  await db.read();
  const s = db.data.schedules.find(x => x.id === id);
  if (!s) return ctx.reply("Schedule not found: " + id);
  const targets = db.data.partners.map(p => p.id.toString());
  const now = dayjs();
  for (const pid of targets) {
    try {
      const partner = db.data.partners.find(p => String(p.id) === String(pid));
      const displayTime = now.tz(partner.tz).format("YYYY-MM-DD HH:mm (z)");
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
  await db.read();
  if (!db.data.partners.find(p => String(p.id) === userId)) return ctx.reply("Not authorized.");
  const parts = ctx.message.text.split(" ");
  if (parts.length < 4) return ctx.reply("Usage: /setschedule id intervalDays HH:MM Message...");
  const id = parts[1];
  const intervalDays = parseInt(parts[2], 10) || 1;
  const time = parts[3];
  const message = parts.slice(4).join(" ") || `Check ${id}`;
  const idx = db.data.schedules.findIndex(s => s.id === id);
  if (idx === -1) {
    db.data.schedules.push({ id, label: id, intervalDays, time, message });
  } else {
    db.data.schedules[idx] = { ...db.data.schedules[idx], intervalDays, time, message };
  }
  await db.write();
  ctx.reply(`Schedule set: ${id} every ${intervalDays} days at ${time}`);
});

(async function main() {
  await initDb();
  bot.start({ onStart: () => console.log("Bot started (polling).") });
  setInterval(async () => {
    try {
      await db.read();
      const partners = db.data.partners || [];
      const schedules = db.data.schedules || [];
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
                await markSentForPartner(schedule.id, partner.id, nowTz);
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
})();
