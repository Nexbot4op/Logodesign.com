// Rubika Bot Panel — server (no dependencies, Node 18+)
// Serves the panel UI, talks to the official Rubika Bot API, and runs the bot engine
// (polling getUpdates + group moderation features) for every token that logs in.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const BASE = process.env.RUBIKA_BASE || 'https://botapi.rubika.ir/v3';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'bots.json');
const POLL_MS = Number(process.env.POLL_MS || 1000);

fs.mkdirSync(DATA_DIR, { recursive: true });

/* ------------------------------ Rubika API ------------------------------ */
async function rb(token, method, body = {}) {
  const res = await fetch(`${BASE}/${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  let json;
  try { json = await res.json(); } catch { throw new Error(`پاسخ نامعتبر از روبیکا (HTTP ${res.status})`); }
  if (json.status !== 'OK') {
    const e = new Error(json.status_det || json.status || 'خطای روبیکا');
    e.rubika = json;
    throw e;
  }
  return json.data || {};
}

/* -------------------------------- Storage ------------------------------- */
const defaultSettings = () => ({
  privateWelcome: 'سلام {name} 👋\nبه {bot} خوش اومدی!',
  welcome: { on: false, text: 'سلام {name} 🌹 به گروه {group} خوش اومدی!' },
  goodbye: { on: false, text: '{name} از گروه {group} رفت 👋' },
  rules: { text: '' },
  antispam: { on: false, max: 5, seconds: 10 },
  antilink: { on: false },
  wordfilter: { on: false, words: [] },
  antiads: { on: false },
  warn: { max: 3, action: 'kick', onViolation: true },
  locks: { forward: false, file: false, sticker: false, contact: false, poll: false, location: false },
  auto: [],
  admins: [],
  glass: {},
  fun: { on: true },
  buttons: [],
  forcejoin: { on: false, group: true, private: true, channels: [], text: 'برای استفاده از ربات، اول در کانال زیر عضو شو و بعد دوباره پیام بده:' },
});

/* --------------------------- Forced membership -------------------------- */
// NOTE: Rubika's public Bot API documentation does not list a membership-check method.
// We try `getChatMember`; if Rubika rejects it, the check is "unknown" and nobody is blocked.
const memCache = new Map();
async function isMember(bot, channelId, userId) {
  const k = `${bot.me.bot_id || ''}:${channelId}:${userId}`;
  const hit = memCache.get(k);
  if (hit && Date.now() - hit.t < (hit.v === false ? 10000 : 60000)) return hit.v;
  let v = null;
  try {
    const d = await rb(bot.token, 'getChatMember', { chat_id: channelId, user_id: userId });
    const mem = d.member || d.chat_member || {};
    if (typeof d.is_member === 'boolean') v = d.is_member;
    else {
      const st = String(mem.status || mem.role || d.status || d.role || '').toLowerCase();
      if (st) v = !/(left|kick|ban|restrict|none)/.test(st);
    }
    bot.runtime.fjUnsupported = v === null ? 'Rubika پاسخی نداد که عضویت را مشخص کند' : '';
  } catch (e) {
    if (!bot.runtime.fjUnsupported) log(bot, `بررسی عضویت انجام نشد (${e.message}); فعلاً کسی مسدود نمی‌شود`);
    bot.runtime.fjUnsupported = e.message;
  }
  memCache.set(k, { v, t: Date.now() });
  return v;
}
// true = allowed. false = blocked (a join notice was sent, at most once a minute per user).
async function joinGate(bot, chatId, userId, where) {
  const f = bot.settings.forcejoin;
  if (!bot.vip || !f || !f.on || !userId) return true;
  if ((where === 'group' && !f.group) || (where === 'private' && !f.private)) return true;
  if (bot.settings.admins.includes(userId)) return true;
  const missing = [];
  for (const ch of f.channels || []) {
    if (!ch.id) continue;
    if ((await isMember(bot, ch.id, userId)) === false) missing.push(ch);
  }
  if (!missing.length) return true;
  const rt = bot.runtime;
  rt.fjNotified = rt.fjNotified || {};
  const nk = `${chatId}:${userId}`;
  if (Date.now() - (rt.fjNotified[nk] || 0) > 60000) {
    rt.fjNotified[nk] = Date.now();
    const links = missing.map((c) => `• ${c.title || c.id}${c.link ? '\n' + c.link : ''}`).join('\n');
    const text = `${await fill(bot, f.text, { chatId, userId })}\n${links}`;
    const rows = missing.filter((c) => c.link).map((c, i) => ({ buttons: [{ id: `fj_${i}`, type: 'Link', button_text: `عضویت در ${c.title || 'کانال'}`, button_link: { type: 'url', link_url: c.link } }] }));
    let r = rows.length ? await say(bot, chatId, text, { inline_keypad: { rows } }) : null;
    if (!r) r = await say(bot, chatId, text);
  }
  return false;
}

/* ------------------------------ Button layout --------------------------- */
function buildKeypad(bot) {
  const byRow = {};
  let n = 0;
  for (const b of bot.settings.buttons || []) if (b && b.text) { n++; (byRow[bot.vip ? Math.max(1, Math.min(12, b.row | 0 || 1)) : n] ||= []).push(b); }
  const rows = [];
  for (const k of Object.keys(byRow).map(Number).sort((a, b) => a - b))
    for (let i = 0; i < byRow[k].length; i += 3)
      rows.push({ buttons: byRow[k].slice(i, i + 3).map((b) => ({ id: b.id, type: 'Simple', button_text: b.text })) });
  return rows.length ? { rows } : null;
}
function cleanButtons(list) {
  return (Array.isArray(list) ? list : []).slice(0, 24).map((b, i) => ({
    id: String((b && b.id) || `btn_${Date.now().toString(36)}_${i}`).slice(0, 40),
    text: String((b && b.text) || '').slice(0, 40),
    reply: String((b && b.reply) || '').slice(0, 1000),
    row: Math.max(1, Math.min(12, ((b && b.row) | 0) || 1)),
  })).filter((b) => b.text);
}

/* ---------------------- Fun & game tags / commands ---------------------- */
const JOKES = [
  'به خرگوشه می‌گن چرا گوش‌هات بلنده؟ می‌گه: اینترنت ایران رو بهتر بگیره!',
  'معلم: بچه‌ها پرنده‌ای که تخم می‌ذاره رو نام ببرید. شاگرد: مرغ. معلم: خوبه، یکی دیگه. شاگرد: مرغ دوم!',
  'می‌گن ورزش سلامتی میاره؛ من هر وقت می‌رم باشگاه فقط گرسنگی میاد.',
  'رفتم رژیم بگیرم، گفتن اول لیست غذاهای ممنوع رو بخون. الان سه روزه دارم می‌خونم و گرسنه‌ام!',
  'گوشیم گفت: ۱٪ شارژ مونده. گفتم: منم همینطور داداش.',
];
const FALS = [
  'امروز خبر خوبی در راهه؛ صبور باش.',
  'یه فرصت تازه جلوی پاته، از دستش نده.',
  'به دوستی که مدت‌هاست زنگ نزدی سر بزن.',
  'آرامش امروزت از تصمیمی می‌آد که دیروز گرفتی.',
  'کار کوچیکی که امروز شروع کنی، فردا بزرگ می‌شه.',
];
const RPS = ['سنگ ✊', 'کاغذ ✋', 'قیچی ✌️'];
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const QUOTES = [
  'هر روز یه قدم کوچیک هم قدمه.', 'شکست یعنی یه راه دیگه برای یاد گرفتن.', 'کار امروز رو به فردا نینداز.', 'صبر تلخه ولی میوه‌اش شیرینه.',
  'کسی که تلاش کنه، دیر یا زود می‌رسه.', 'آرامش یعنی بدونی کار درست رو انجام دادی.', 'با لبخند شروع کن، بقیه‌اش خودش درست می‌شه.', 'بزرگ‌ترین ریسک، ریسک نکردنه.',
];
const FACTS = [
  'عسل هیچ‌وقت خراب نمی‌شه.', 'اختاپوس سه تا قلب داره.', 'حدود ۷۱ درصد سطح زمین آبه.', 'نور خورشید حدود هشت دقیقه طول می‌کشه تا به زمین برسه.',
  'موز از نظر گیاه‌شناسی یک «توت» حساب می‌شه.', 'یک روز روی ونوس از یک سالش طولانی‌تره.', 'مغز آدم حدود ۲۰ درصد انرژی بدن رو مصرف می‌کنه.', 'قلب میگو توی سرشه.',
];
const TRUTHS = [
  'آخرین باری که دروغ گفتی کی بود؟', 'بدترین عادتت چیه؟', 'اگه می‌تونستی یه چیز خودت رو عوض کنی، چی بود؟', 'کدوم فیلم رو بیشتر از همه دوست داری؟',
  'آخرین چیزی که ازش خجالت کشیدی چی بود؟', 'بهترین خاطره‌ی بچگیت چیه؟', 'اگه یه روز نامرئی بودی چی کار می‌کردی؟', 'ترسناک‌ترین چیز برات چیه؟',
];
const DARES = [
  'یه جمله رو سه بار تند پشت‌سرهم بگو.', 'یه استیکر بامزه برای گروه بفرست.', 'یه ویس بفرست و یه شعر بخون.', 'یه عکس از چیزی که الان کنارته بفرست.',
  'تا پنج دقیقه فقط با ایموجی حرف بزن.', 'یه جوک بگو.', 'اسم سه تا از غذاهای مورد علاقه‌ات رو بگو.', 'یه خاطره‌ی خنده‌دار تعریف کن.',
];
const BALL = ['قطعاً بله', 'به نظر میاد آره', 'احتمالاً آره', 'شاید', 'الان نمی‌شه گفت، بعداً بپرس', 'روش حساب نکن', 'به نظر نمی‌رسه', 'قطعاً نه'];
const COLORS = ['قرمز', 'آبی', 'سبز', 'زرد', 'نارنجی', 'بنفش', 'صورتی', 'مشکی', 'سفید', 'فیروزه‌ای'];
const EMOJIS = ['😀', '😎', '🔥', '⭐', '🎉', '🌈', '🍀', '💎', '🚀', '🌟', '🎯', '🎮'];
const TZ = 'Asia/Tehran';
const faDate = (o) => new Date().toLocaleDateString('fa-IR', { timeZone: TZ, ...o });
const FUN_TAGS = {
  joke: () => pick(JOKES), fal: () => pick(FALS), quote: () => pick(QUOTES), fact: () => pick(FACTS),
  truth: () => pick(TRUTHS), dare: () => pick(DARES), ball: () => pick(BALL), color: () => pick(COLORS), emoji: () => pick(EMOJIS),
  dice: () => `🎲 ${randInt(1, 6)}`, dice2: () => `🎲 ${randInt(1, 6)} و 🎲 ${randInt(1, 6)}`,
  coin: () => pick(['شیر', 'خط']), yesno: () => pick(['بله', 'خیر']), rps: () => pick(RPS),
  rand: () => randInt(1, 100), luck: () => `${randInt(0, 100)}٪`,
  card: () => pick(['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']) + pick(['♠', '♥', '♦', '♣']),
  lotto: () => { const s = new Set(); while (s.size < 6) s.add(randInt(1, 49)); return [...s].sort((a, b) => a - b).join(' - '); },
  time: () => new Date().toLocaleTimeString('fa-IR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }),
  date: () => faDate({ year: 'numeric', month: '2-digit', day: '2-digit' }), weekday: () => faDate({ weekday: 'long' }),
  day: () => faDate({ day: 'numeric' }), month: () => faDate({ month: 'long' }), year: () => faDate({ year: 'numeric' }),
  greeting: () => {
    const h = Number(new Date().toLocaleString('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false })) % 24;
    return h >= 5 && h < 12 ? 'صبح بخیر' : h < 16 ? 'ظهر بخیر' : h < 19 ? 'عصر بخیر' : 'شب بخیر';
  },
};
// Tags are replaced in a single pass, so text inserted by a tag (a user's name, the rules) is never re-expanded.
function funText(text, extra = {}) {
  return String(text || '').replace(/\{([a-z0-9_]+)\}/gi, (m, k) => {
    k = k.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(extra, k)) return String(extra[k]);
    return FUN_TAGS[k] ? String(FUN_TAGS[k]()) : m;
  });
}
const FUN_CMDS = {
  '/joke': '{joke}', '/fal': '🔮 {fal}', '/dice': '{dice}', '/coin': '🪙 {coin}', '/rps': '{rps}', '/rand': '🎯 {rand}',
  '/quote': '💬 {quote}', '/fact': '💡 {fact}', '/truth': '❓ {truth}', '/dare': '🔥 {dare}', '/ball': '🎱 {ball}',
  '/yesno': '{yesno}', '/card': '🃏 {card}', '/lotto': '🎰 {lotto}', '/luck': '🍀 {luck}', '/date': '{weekday} {date}',
};
async function funCommand(bot, chatId, m) {
  if (!bot.settings.fun || !bot.settings.fun.on) return false;
  const cmd = String(m.text || '').trim().split(/\s+/)[0].replace(/@.*$/, '').toLowerCase();
  const tpl = FUN_CMDS[cmd];
  if (!tpl) return false;
  await say(bot, chatId, funText(tpl), { reply_to_message_id: m.message_id });
  return true;
}

/* VIP: a bot owner unlocks VIP items by entering a one-time activation code.
   The server owner issues codes through the VIP_CODES environment variable (comma-separated). */
const VIP_FILE = path.join(DATA_DIR, 'vip-used.json');
let vipUsed = [];
try { vipUsed = JSON.parse(fs.readFileSync(VIP_FILE, 'utf8')); } catch { vipUsed = []; }
const VIP_DAYS = Number(process.env.VIP_DAYS || 30);
// One-time activation codes per shop item. The server owner can add more with environment variables.
const DEFAULT_CODES = { vip: ['#N55X9'], antiads: ['#A35K2'], adpm: ['#P55M7'] };
const ENV_CODES = { vip: 'VIP_CODES', antiads: 'ANTIADS_CODES', adpm: 'ADPM_CODES' };
const PRODUCTS = Object.keys(DEFAULT_CODES);
const codesFor = (p) => [...DEFAULT_CODES[p], ...String(process.env[ENV_CODES[p]] || '').split(',').map((x) => x.trim()).filter(Boolean)];
const has = (bot, p) => ((bot.subs || {})[p] || 0) > Date.now();

let db = {};
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { db = {}; }
let saveTimer = null;
function writeDb() {
  const tmp = DB_FILE + '.tmp';
  const out = {};
  for (const [id, b] of Object.entries(db)) {
    out[id] = { token: b.token, subs: b.subs, me: b.me, settings: b.settings, chats: b.chats, warns: b.warns, mutes: b.mutes, offset: b.offset };
  }
  fs.writeFileSync(tmp, JSON.stringify(out));
  fs.renameSync(tmp, DB_FILE);
}
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeDb, 300);
}
// flush pending changes when the process is stopped, so a restart never loses the last edits
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { try { writeDb(); } catch {} process.exit(0); });
const idOf = (token) => crypto.createHash('sha256').update(token).digest('hex').slice(0, 20);
function deepMerge(base, patch) {
  if (Array.isArray(patch) || typeof patch !== 'object' || patch === null) return patch;
  const out = { ...base };
  for (const k of Object.keys(patch)) out[k] = deepMerge(base ? base[k] : undefined, patch[k]);
  return out;
}
function hydrate(id, b) {
  // Paid items are time-limited: each is active only while its expiry (b.subs[item]) is in the future.
  b.subs = b.subs && typeof b.subs === 'object' ? b.subs : {};
  if (b.vip && !b.vipUntil && !b.subs.vip) b.subs.vip = Date.now() + VIP_DAYS * 86400000; // oldest data format
  if (b.vipUntil && !b.subs.vip) b.subs.vip = Number(b.vipUntil) || 0;
  delete b.vip; delete b.vipUntil;
  Object.defineProperty(b, 'vip', { get() { return (this.subs.vip || 0) > Date.now(); }, enumerable: false, configurable: true });
  Object.defineProperty(b, 'vipUntil', { get() { return this.subs.vip || 0; }, set(v) { this.subs.vip = v; }, enumerable: false, configurable: true });
  b.settings = deepMerge(defaultSettings(), b.settings || {});
  b.chats = b.chats || {};
  b.warns = b.warns || {};
  b.mutes = b.mutes || {};
  b.offset = b.offset || '';
  b.runtime = { log: [], names: {}, spam: {}, msgOwner: {}, lastPoll: 0, running: false, error: '', stop: false };
  db[id] = b;
}
for (const [id, b] of Object.entries(db)) hydrate(id, b);

const chatType = (id = '') => (id.startsWith('g0') ? 'group' : id.startsWith('c0') ? 'channel' : 'private');
function log(bot, text) {
  bot.runtime.log.unshift({ t: Date.now(), text });
  bot.runtime.log.length = Math.min(bot.runtime.log.length, 80);
}
function track(bot, chatId, patch = {}) {
  const c = bot.chats[chatId] || (bot.chats[chatId] = { type: chatType(chatId), title: '', users: {}, first: Date.now() });
  Object.assign(c, patch, { last: Date.now() });
  save();
  return c;
}

/* ------------------------------ Bot engine ------------------------------ */
async function userInfo(bot, guid) {
  const cache = (bot.runtime.info = bot.runtime.info || {});
  if (cache[guid]) return cache[guid];
  try {
    const d = await rb(bot.token, 'getChat', { chat_id: guid });
    const c = d.chat || {};
    const full = [c.first_name, c.last_name].filter(Boolean).join(' ') || c.title || c.username || guid;
    cache[guid] = { name: full, first: c.first_name || full.split(' ')[0], username: c.username ? '@' + c.username : '' };
  } catch { cache[guid] = { name: guid, first: guid, username: '' }; }
  return cache[guid];
}
const nameOf = async (bot, guid) => (await userInfo(bot, guid)).name;
async function groupTitle(bot, chatId) {
  const c = bot.chats[chatId];
  if (c && c.customTitle) return c.customTitle;
  if (c && c.title) return c.title;
  try {
    const d = await rb(bot.token, 'getChat', { chat_id: chatId });
    const t = (d.chat || {}).title || chatId;
    track(bot, chatId, { title: t });
    return t;
  } catch { return chatId; }
}
async function fill(bot, text, ctx = {}) {
  const t = String(text || '');
  const need = (...ks) => ks.some((k) => t.includes('{' + k + '}'));
  const u = ctx.userId && need('name', 'firstname', 'username') ? await userInfo(bot, ctx.userId) : {};
  const isGroup = !!ctx.chatId && chatType(ctx.chatId) === 'group';
  const group = isGroup && need('group') ? await groupTitle(bot, ctx.chatId) : '';
  const chats = Object.values(bot.chats);
  return funText(t, {
    name: u.name || '', firstname: u.first || '', username: u.username || '',
    bot: bot.me.bot_title || bot.me.username || '', botusername: bot.me.username ? '@' + bot.me.username : '',
    group, id: ctx.userId || '',
    warns: ctx.chatId && ctx.userId ? (bot.warns[ctx.chatId] || {})[ctx.userId] || 0 : 0,
    warnmax: bot.settings.warn.max, rules: bot.settings.rules.text || '',
    seen: isGroup ? Object.keys((bot.chats[ctx.chatId] || {}).users || {}).length : 0,
    chats: chats.length, groups: chats.filter((c) => c.type === 'group').length, privates: chats.filter((c) => c.type === 'private').length,
  });
}
async function say(bot, chatId, text, extra = {}) {
  try { return await rb(bot.token, 'sendMessage', { chat_id: chatId, text, ...extra }); }
  catch (e) { log(bot, `ارسال به ${chatId} ناموفق: ${e.message}`); return null; }
}
async function del(bot, chatId, messageId) {
  try { await rb(bot.token, 'deleteMessage', { chat_id: chatId, message_id: messageId }); return true; }
  catch (e) { log(bot, `حذف پیام ناموفق (ربات باید ادمین گروه باشد): ${e.message}`); return false; }
}

async function punish(bot, chatId, userId, kind, minutes = 0) {
  const s = bot.settings;
  if (kind === 'ban' || kind === 'kick') {
    await rb(bot.token, 'banChatMember', { chat_id: chatId, user_id: userId });
    if (kind === 'kick') { try { await rb(bot.token, 'unbanChatMember', { chat_id: chatId, user_id: userId }); } catch {} }
  } else if (kind === 'unban') {
    await rb(bot.token, 'unbanChatMember', { chat_id: chatId, user_id: userId });
  } else if (kind === 'mute') {
    (bot.mutes[chatId] = bot.mutes[chatId] || {})[userId] = Date.now() + Math.max(1, minutes) * 60000;
  } else if (kind === 'unmute') {
    if (bot.mutes[chatId]) delete bot.mutes[chatId][userId];
  } else if (kind === 'warn') {
    const w = (bot.warns[chatId] = bot.warns[chatId] || {});
    w[userId] = (w[userId] || 0) + 1;
    if (w[userId] >= s.warn.max) {
      w[userId] = 0;
      await punish(bot, chatId, userId, s.warn.action === 'ban' ? 'ban' : 'kick');
      log(bot, `کاربر ${userId} به‌خاطر اخطار زیاد ${s.warn.action === 'ban' ? 'بن' : 'اخراج'} شد`);
    }
  } else if (kind === 'clearwarn') {
    if (bot.warns[chatId]) delete bot.warns[chatId][userId];
  }
  save();
}

async function violation(bot, chatId, m, reason) {
  await del(bot, chatId, m.message_id);
  log(bot, `${reason} — پیام حذف شد`);
  if (bot.settings.warn.onViolation && m.sender_id) {
    try {
      await punish(bot, chatId, m.sender_id, 'warn');
      const left = bot.settings.warn.max - ((bot.warns[chatId] || {})[m.sender_id] || 0);
      const nm = await nameOf(bot, m.sender_id);
      if (left < bot.settings.warn.max) await say(bot, chatId, `⚠️ ${nm}: ${reason}. اخطار ثبت شد (${bot.settings.warn.max - left}/${bot.settings.warn.max})`);
    } catch (e) { log(bot, `اخطار ناموفق: ${e.message}`); }
  }
}

const URL_RE = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|ir|org|net|me|ly|xyz|info|io|co)\b|rubika\.ir\/|t\.me\/)/i;
const ADS_RE = /(@[a-z0-9_]{4,}|rubika\.ir\/|join|عضو\s*(شو|شید)|جوین|کانال\s*ما|بنر|تبلیغ|فالو\s*کن|ممبر|تبادل)/i;

async function groupEvent(bot, chatId, m) {
  const ev = m.event_data || m.event || m.aux_event;
  const kind = ev && (ev.type || ev.event_type);
  if (!kind) return false;
  const who = (ev.peer_guid || ev.user_id || (ev.peer_objects && ev.peer_objects[0] && ev.peer_objects[0].object_guid) || m.sender_id || '');
  if (/Add|Join/i.test(kind)) {
    if (bot.settings.welcome.on) await say(bot, chatId, await fill(bot, bot.settings.welcome.text, { chatId, userId: who }));
    if (who) track(bot, chatId).users[who] = await nameOf(bot, who);
    return true;
  }
  if (/Remove|Leave/i.test(kind)) {
    if (bot.settings.goodbye.on) await say(bot, chatId, await fill(bot, bot.settings.goodbye.text, { chatId, userId: who }));
    return true;
  }
  return false;
}

async function handleCommand(bot, chatId, m, isAdmin) {
  const parts = (m.text || '').trim().split(/\s+/);
  const cmd = parts[0].replace(/@.*$/, '').toLowerCase();
  if (cmd === '/rules' || cmd === 'قوانین') {
    await say(bot, chatId, bot.settings.rules.text || 'قوانینی برای این گروه ثبت نشده است.', { reply_to_message_id: m.message_id });
    return true;
  }
  if (!isAdmin) return false;
  const target = (m.reply_to_message_id && bot.runtime.msgOwner[`${chatId}:${m.reply_to_message_id}`]) || parts[1];
  const map = { '/ban': 'ban', '/unban': 'unban', '/kick': 'kick', '/warn': 'warn', '/mute': 'mute', '/unmute': 'unmute', '/clearwarn': 'clearwarn' };
  const kind = map[cmd];
  if (!kind) return false;
  if (!target || !/^[a-z]0/i.test(target)) {
    await say(bot, chatId, 'روی پیام کاربر ریپلای کنید و دستور را بفرستید.', { reply_to_message_id: m.message_id });
    return true;
  }
  const mins = Number(parts[m.reply_to_message_id ? 1 : 2]) || 10;
  try {
    await punish(bot, chatId, target, kind, mins);
    await say(bot, chatId, `✅ ${cmd} انجام شد`, { reply_to_message_id: m.message_id });
  } catch (e) { await say(bot, chatId, `❌ ${e.message}`, { reply_to_message_id: m.message_id }); }
  return true;
}

async function handleMessage(bot, chatId, m) {
  const type = chatType(chatId);
  const s = bot.settings;
  const sender = m.sender_id;
  const chat = track(bot, chatId);

  if (type === 'private') {
    if (m.text && m.text.trim().split(/\s+/)[0].toLowerCase() === '/stopads') {
      chat.noAds = true; save();
      await say(bot, chatId, 'تبلیغات برای شما قطع شد.');
      return;
    }
    if (!(await joinGate(bot, chatId, chatId, 'private'))) return;
    if (m.text === '/start') await say(bot, chatId, await fill(bot, s.privateWelcome, { chatId, userId: chatId }));
    else if (m.text) await funCommand(bot, chatId, m);
    return;
  }
  if (type !== 'group') return;

  if (await groupEvent(bot, chatId, m)) return;
  if (!sender || m.sender_type === 'Bot') return;

  const rt = bot.runtime;
  rt.msgOwner[`${chatId}:${m.message_id}`] = sender;
  const keys = Object.keys(rt.msgOwner);
  if (keys.length > 3000) for (const k of keys.slice(0, 1000)) delete rt.msgOwner[k];
  if (!chat.users[sender]) { chat.users[sender] = await nameOf(bot, sender); save(); }

  const isAdmin = s.admins.includes(sender);
  if (m.text && (await handleCommand(bot, chatId, m, isAdmin))) return;
  if (m.text && (await funCommand(bot, chatId, m))) return;
  if (isAdmin) return;
  if (!(await joinGate(bot, chatId, sender, 'group'))) { await del(bot, chatId, m.message_id); return; }

  const muteUntil = (bot.mutes[chatId] || {})[sender];
  if (muteUntil) {
    if (muteUntil > Date.now()) { await del(bot, chatId, m.message_id); return; }
    delete bot.mutes[chatId][sender]; save();
  }

  const L = s.locks;
  if (L.forward && (m.forwarded_from || m.forwarded_no_link)) return violation(bot, chatId, m, 'فوروارد ممنوع است');
  if (L.file && m.file) return violation(bot, chatId, m, 'ارسال فایل قفل است');
  if (L.sticker && m.sticker) return violation(bot, chatId, m, 'ارسال استیکر قفل است');
  if (L.contact && m.contact_message) return violation(bot, chatId, m, 'ارسال مخاطب قفل است');
  if (L.poll && m.poll) return violation(bot, chatId, m, 'ارسال نظرسنجی قفل است');
  if (L.location && (m.location || m.live_location)) return violation(bot, chatId, m, 'ارسال موقعیت قفل است');

  const text = m.text || '';
  if (s.antilink.on && URL_RE.test(text)) return violation(bot, chatId, m, 'ارسال لینک ممنوع است');
  if (s.antiads.on && has(bot, 'antiads') && (ADS_RE.test(text) || URL_RE.test(text))) return violation(bot, chatId, m, 'تبلیغات ممنوع است');
  if (s.wordfilter.on && s.wordfilter.words.some((w) => w && text.toLowerCase().includes(w.toLowerCase()))) return violation(bot, chatId, m, 'استفاده از کلمه ممنوعه');

  if (s.antispam.on) {
    const k = `${chatId}:${sender}`;
    const now = Date.now();
    const arr = (rt.spam[k] = (rt.spam[k] || []).filter((t) => now - t < s.antispam.seconds * 1000));
    arr.push(now);
    if (arr.length > s.antispam.max) { rt.spam[k] = []; return violation(bot, chatId, m, 'ارسال پیام پشت‌سرهم (اسپم)'); }
  }
}

async function handleInline(bot, im) {
  const btn = im.aux_data && im.aux_data.button_id;
  const found = btn && (bot.settings.buttons || []).find((x) => x.id === btn);
  const reply = btn && ((found && found.reply) || bot.settings.glass[btn]);
  if (reply && im.chat_id) await say(bot, im.chat_id, await fill(bot, reply, { chatId: im.chat_id, userId: im.sender_id }));
}

async function pollOnce(bot) {
  const body = { limit: 100 };
  if (bot.offset) body.offset_id = bot.offset;
  const d = await rb(bot.token, 'getUpdates', body);
  bot.runtime.lastPoll = Date.now();
  bot.runtime.error = '';
  for (const u of d.updates || []) {
    try {
      if (u.type === 'NewMessage' && u.new_message) await handleMessage(bot, u.chat_id, u.new_message);
      else if (u.type === 'StartedBot') { track(bot, u.chat_id); if (await joinGate(bot, u.chat_id, u.chat_id, 'private')) await say(bot, u.chat_id, await fill(bot, bot.settings.privateWelcome, { chatId: u.chat_id, userId: u.chat_id })); }
      else if (u.inline_message) await handleInline(bot, u.inline_message);
      else if (u.type === 'UpdatedMessage' && u.updated_message && u.updated_message.aux_data) await handleInline(bot, { ...u.updated_message, chat_id: u.chat_id });
    } catch (e) { log(bot, `خطا در پردازش آپدیت: ${e.message}`); }
  }
  if (d.next_offset_id) { bot.offset = d.next_offset_id; save(); }
}

async function loop(bot) {
  if (bot.runtime.running) return;
  bot.runtime.running = true;
  bot.runtime.stop = false;
  while (!bot.runtime.stop) {
    try { await pollOnce(bot); }
    catch (e) { bot.runtime.error = e.message; await new Promise((r) => setTimeout(r, 4000)); }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  bot.runtime.running = false;
}

// auto messages — checked every 30s
setInterval(() => {
  for (const bot of Object.values(db)) {
    if (bot.vipUntil && !bot.vip && !bot.runtime.vipExpiredLogged) { bot.runtime.vipExpiredLogged = true; log(bot, 'مدت برچسب VIP تمام شد؛ برای استفاده دوباره باید دوباره بخرید'); }
    if (!bot.runtime.running) continue;
    for (const a of bot.settings.auto) {
      if (!a.on || !a.text || !a.everyMin) continue;
      if (Date.now() - (a.last || 0) < a.everyMin * 60000) continue;
      a.last = Date.now(); save();
      const want = a.target || 'groups';
      for (const [cid, c] of Object.entries(bot.chats)) {
        if ((want === 'groups' && c.type === 'group') || (want === 'private' && c.type === 'private') || want === 'all') {
          if (c.type !== 'channel') say(bot, cid, a.text);
        }
      }
    }
  }
}, 30000);

/* ------------------------------ Banner ads ------------------------------ */
// Owners of the "تبلیغ در پیوی ربات‌ها" item write a banner. After approval it is sent once to the private chats of
// every bot registered on this panel, except: the advertiser's own bot, bots that own the anti-ads item, chats that
// sent /stopads, and chats that already got an ad in the last 24 hours. Every message carries a "تبلیغ" label.
const BANNER_FILE = path.join(DATA_DIR, 'banners.json');
let banners = [];
try { banners = JSON.parse(fs.readFileSync(BANNER_FILE, 'utf8')); } catch { banners = []; }
const saveBanners = () => fs.writeFileSync(BANNER_FILE, JSON.stringify(banners));
const AD_AUTO = process.env.AD_AUTO_APPROVE === '1';
const AD_COOLDOWN = 24 * 3600 * 1000;
const AD_LABEL = '\n\n— تبلیغ | برای قطع تبلیغات: /stopads';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pubBanner = (b) => ({ id: b.id, text: b.text, status: b.status, createdAt: b.createdAt, stats: b.stats, ownerName: b.ownerName });
let adRunning = false;
async function runAds() {
  if (adRunning) return;
  adRunning = true;
  try { for (const ad of banners.filter((b) => b.status === 'approved')) await sendBanner(ad); }
  catch (e) { console.error('ads:', e.message); }
  finally { adRunning = false; }
}
async function sendBanner(ad) {
  ad.sentKeys = ad.sentKeys || [];
  ad.stats = ad.stats || { sent: 0, fail: 0, skipped: 0 };
  const done = new Set(ad.sentKeys);
  let n = 0;
  for (const [id, bot] of Object.entries(db)) {
    if (id === ad.owner || bot.runtime.stop || has(bot, 'antiads')) continue;
    for (const [cid, c] of Object.entries(bot.chats)) {
      if (c.type !== 'private') continue;
      const key = `${id}:${cid}`;
      if (done.has(key)) continue;
      done.add(key); ad.sentKeys.push(key);
      if (c.noAds || Date.now() - (c.lastAd || 0) < AD_COOLDOWN) { ad.stats.skipped++; continue; }
      try { await rb(bot.token, 'sendMessage', { chat_id: cid, text: ad.text + AD_LABEL }); c.lastAd = Date.now(); ad.stats.sent++; }
      catch { ad.stats.fail++; }
      if (++n % 25 === 0) { saveBanners(); save(); }
      await sleep(150);
    }
  }
  ad.status = 'done'; ad.finishedAt = Date.now();
  saveBanners(); save();
}
function adminOk(req) {
  const k = String(process.env.ADMIN_KEY || ''), h = String(req.headers['x-admin-key'] || '');
  return !!k && h.length === k.length && crypto.timingSafeEqual(Buffer.from(h), Buffer.from(k));
}

for (const bot of Object.values(db)) loop(bot);
setTimeout(runAds, 3000); // resume banners that were approved before a restart

/* -------------------------------- HTTP API ------------------------------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
const readBody = (req) => new Promise((resolve, reject) => {
  let s = '';
  req.on('data', (c) => { s += c; if (s.length > 1e6) { reject(new Error('big')); req.destroy(); } });
  req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch { reject(new Error('bad json')); } });
});
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };

function publicState(bot) {
  const chats = Object.entries(bot.chats).map(([id, c]) => ({
    id, type: c.type, title: c.customTitle || c.title || '', rawTitle: c.title || '', last: c.last,
    users: Object.entries(c.users || {}).map(([uid, name]) => ({ id: uid, name, warns: (bot.warns[id] || {})[uid] || 0, muted: ((bot.mutes[id] || {})[uid] || 0) > Date.now() })),
  }));
  return {
    me: bot.me, vip: bot.vip, vipUntil: bot.vipUntil || 0, subs: bot.subs, settings: bot.settings, chats,
    status: { running: bot.runtime.running, lastPoll: bot.runtime.lastPoll, error: bot.runtime.error, fjUnsupported: bot.runtime.fjUnsupported || '' },
    stats: { private: chats.filter((c) => c.type === 'private').length, groups: chats.filter((c) => c.type === 'group').length, channels: chats.filter((c) => c.type === 'channel').length },
    log: bot.runtime.log,
  };
}

async function api(req, res, url) {
  const body = req.method === 'POST' || req.method === 'PUT' ? await readBody(req) : {};

  if (url === '/api/login') {
    const token = String(body.token || '').trim();
    if (!/^[A-Za-z0-9:_-]{10,}$/.test(token)) return send(res, 400, { error: 'توکن نامعتبر است' });
    let me;
    try { me = (await rb(token, 'getMe')).bot; } catch (e) { return send(res, 401, { error: `توکن پذیرفته نشد: ${e.message}` }); }
    const id = idOf(token);
    if (!db[id]) hydrate(id, { token, me });
    db[id].me = me || {};
    db[id].token = token;
    save();
    loop(db[id]);
    return send(res, 200, { ok: true, ...publicState(db[id]) });
  }

  if (url.startsWith('/api/admin/')) {
    if (!adminOk(req)) return send(res, 403, { error: 'کلید مدیریت نادرست است' });
    if (url === '/api/admin/banners') return send(res, 200, { banners: banners.slice().reverse().map(pubBanner), auto: AD_AUTO });
    if (url === '/api/admin/banner' && req.method === 'POST') {
      const b = banners.find((x) => x.id === body.id);
      if (!b) return send(res, 404, { error: 'بنر پیدا نشد' });
      if (b.status !== 'pending') return send(res, 400, { error: 'این بنر دیگر در انتظار تأیید نیست' });
      b.status = body.action === 'approve' ? 'approved' : 'rejected';
      saveBanners();
      if (b.status === 'approved') runAds();
      return send(res, 200, { ok: true, status: b.status });
    }
    return send(res, 404, { error: 'not found' });
  }

  const token = req.headers['x-token'];
  const bot = token && db[idOf(String(token))];
  if (!bot) return send(res, 401, { error: 'نشست معتبر نیست؛ دوباره وارد شوید' });

  if (url === '/api/state') return send(res, 200, publicState(bot));

  if (url === '/api/banners') return send(res, 200, { banners: banners.filter((b) => b.owner === idOf(String(token))).reverse().map(pubBanner) });

  if (url === '/api/banner' && req.method === 'POST') {
    if (!has(bot, 'adpm')) return send(res, 403, { error: 'اول «تبلیغ در پیوی ربات‌ها» را از فروشگاه فعال کنید' });
    const text = String(body.text || '').trim();
    if (text.length < 5 || text.length > 500) return send(res, 400, { error: 'متن بنر باید بین ۵ تا ۵۰۰ نویسه باشد' });
    const owner = idOf(String(token));
    if (banners.some((b) => b.owner === owner && (b.status === 'pending' || b.status === 'approved'))) return send(res, 400, { error: 'یک بنر قبلی شما هنوز در صف تأیید یا ارسال است' });
    const ad = { id: crypto.randomBytes(6).toString('hex'), owner, ownerName: bot.me.bot_title || bot.me.username || '', text, status: AD_AUTO ? 'approved' : 'pending', createdAt: Date.now(), stats: { sent: 0, fail: 0, skipped: 0 }, sentKeys: [] };
    banners.push(ad);
    saveBanners();
    if (AD_AUTO) runAds();
    return send(res, 200, { ok: true, banner: pubBanner(ad) });
  }

  if ((url === '/api/redeem' || url === '/api/vip') && req.method === 'POST') {
    const product = url === '/api/vip' ? 'vip' : String(body.product || '');
    if (!PRODUCTS.includes(product)) return send(res, 400, { error: 'محصول نامعتبر است' });
    const rt = bot.runtime;
    rt.vipTries = (rt.vipTries || []).filter((t) => Date.now() - t < 3600000);
    if (rt.vipTries.length >= 10) return send(res, 429, { error: 'تلاش بیش از حد؛ یک ساعت بعد دوباره امتحان کنید' });
    rt.vipTries.push(Date.now());
    const code = String(body.code || '').trim();
    if (!code || !codesFor(product).includes(code)) return send(res, 400, { error: 'کد فعال‌سازی نامعتبر است' });
    if (vipUsed.includes(code)) return send(res, 400, { error: 'این کد قبلاً استفاده شده است' });
    vipUsed.push(code);
    fs.writeFileSync(VIP_FILE, JSON.stringify(vipUsed));
    bot.subs[product] = Math.max(Date.now(), bot.subs[product] || 0) + VIP_DAYS * 86400000; // buying again before expiry adds another period
    if (product === 'vip') bot.runtime.vipExpiredLogged = false;
    save();
    log(bot, `${product} فعال شد (تا ${new Date(bot.subs[product]).toLocaleDateString('fa-IR')})`);
    return send(res, 200, { ok: true, product, until: bot.subs[product] });
  }

  if (url === '/api/settings' && req.method === 'PUT') {
    if (!has(bot, 'antiads') && body.antiads) body.antiads.on = false; // anti-ads is a paid item
    if (!bot.vip && body.forcejoin) return send(res, 403, { error: 'عضویت ضروری مخصوص VIP است؛ اول برچسب VIP را فعال کنید' });
    bot.settings = deepMerge(bot.settings, body);
    if (body.auto) bot.settings.auto = body.auto;
    if (body.buttons) {
      bot.settings.buttons = cleanButtons(body.buttons);
      if (!bot.vip) bot.settings.buttons.forEach((b, i) => { b.row = i + 1; }); // custom layout is VIP-only
    }
    if (body.forcejoin && body.forcejoin.channels) {
      bot.settings.forcejoin.channels = body.forcejoin.channels.slice(0, 5)
        .map((c) => ({ id: String(c.id || '').trim(), title: String(c.title || '').slice(0, 60), link: String(c.link || '').trim() }))
        .filter((c) => c.id);
    }
    if (body.admins) bot.settings.admins = body.admins;
    if (body.wordfilter && body.wordfilter.words) bot.settings.wordfilter.words = body.wordfilter.words;
    save();
    return send(res, 200, { ok: true, settings: bot.settings });
  }

  if (url === '/api/chat' && req.method === 'PUT') {
    const c = bot.chats[body.chat_id];
    if (!c) return send(res, 404, { error: 'چت پیدا نشد' });
    c.customTitle = String(body.title || '').slice(0, 80);
    save();
    return send(res, 200, { ok: true });
  }

  if (url === '/api/send' || url === '/api/glass') {
    const text = String(body.text || '').trim();
    if (!text) return send(res, 400, { error: 'متن خالی است' });
    let extra = {};
    if (url === '/api/glass') {
      const kp = buildKeypad(bot);
      if (!kp) return send(res, 400, { error: 'اول در صفحه پیام شیشه‌ای دکمه‌ها را ذخیره کنید' });
      extra.inline_keypad = kp;
    }
    let targets = [];
    const t = body.target;
    if (t === 'all-groups') targets = Object.entries(bot.chats).filter(([, c]) => c.type === 'group').map(([i]) => i);
    else if (t === 'all-private') targets = Object.entries(bot.chats).filter(([, c]) => c.type === 'private').map(([i]) => i);
    else if (t) targets = [t];
    if (!targets.length) return send(res, 400, { error: 'گیرنده‌ای پیدا نشد (هنوز کسی با ربات تعامل نداشته)' });
    let ok = 0, fail = 0;
    for (const cid of targets) {
      const r = await say(bot, cid, await fill(bot, text, { chatId: cid, userId: chatType(cid) === 'private' ? cid : '' }), extra);
      r ? ok++ : fail++;
      await new Promise((r2) => setTimeout(r2, 120));
    }
    return send(res, 200, { ok, fail });
  }

  if (url === '/api/action') {
    try {
      await punish(bot, body.chat_id, body.user_id, body.type, Number(body.minutes) || 10);
      return send(res, 200, { ok: true });
    } catch (e) { return send(res, 400, { error: e.message }); }
  }

  if (url === '/api/disconnect') {
    bot.runtime.stop = true;
    if (body.forget) { delete db[idOf(String(token))]; }
    save();
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { error: 'not found' });
}

http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  try {
    if (url.startsWith('/api/')) return await api(req, res, url);
    const file = url === '/' ? '/index.html' : url;
    const full = path.join(__dirname, 'public', path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
    if (!full.startsWith(path.join(__dirname, 'public'))) { res.writeHead(403); return res.end(); }
    fs.readFile(full, (err, buf) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
      res.end(buf);
    });
  } catch (e) { send(res, 500, { error: e.message }); }
}).listen(PORT, () => console.log(`Rubika panel on http://localhost:${PORT}`));
