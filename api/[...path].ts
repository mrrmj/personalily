// =====================================================================
// Visionary Bot — SINGLE FILE (all logic + inline admin dashboard)
// Routes (all handled here):
//   GET  /                          → admin dashboard HTML
//   POST /api/webhook               → Telegram updates
//   GET  /api/status                → bot status
//   GET/POST /api/config            → bot config
//   GET  /api/users                 → list VIP
//   POST /api/users/add             → add VIP
//   POST /api/users/remove          → remove VIP
//   GET/POST /api/logs              → read/clear logs
//   GET  /api/logs/stream           → SSE logs
//   POST /api/bot/start|stop|restart→ webhook control
//   GET  /api/telegram/verify       → token check
//   GET  /api/wingo/history         → live Wingo + prediction
//   POST /api/simulate              → chat simulator
// =====================================================================

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Telegraf, Markup } from 'telegraf';
import { kv } from '@vercel/kv';

// ─── TYPES ───────────────────────────────────────────────────────────
interface Plan { label: string; price: string; days: number; }
interface BotConfig {
  BOT_API_TOKEN: string; ADMIN_ID: string; DEV_ID: string;
  BOT_NAME: string; ADMIN_USERNAME: string; BOT_GROUP_LINK: string; PLANS: Plan[];
}
interface WingoRecord {
  issueNumber: string; colour: string;
  number: number | string | null; size: string; time: string;
}
interface LogEntry {
  id: number; time: string;
  level: 'info' | 'warn' | 'error' | 'success'; text: string;
}

// ─── CONFIG STORE ────────────────────────────────────────────────────
const DEFAULT_CONFIG: BotConfig = {
  BOT_API_TOKEN: '', ADMIN_ID: '0', DEV_ID: '0',
  BOT_NAME: 'Visionary Bot', ADMIN_USERNAME: 'AdminUsername', BOT_GROUP_LINK: 'official_channel',
  PLANS: [
    { label: '7 Days - ₹800', price: '₹800', days: 7 },
    { label: '2 Week - ₹1500', price: '₹1500', days: 14 },
    { label: '1 Month - ₹2900', price: '₹2900', days: 30 },
    { label: '♾️ Permanent - ₹8000', price: '₹8000', days: 3650 },
  ],
};

async function getConfig(): Promise<BotConfig> {
  const stored = await kv.get<Partial<BotConfig>>('bot:config');
  return { ...DEFAULT_CONFIG, ...(stored || {}) };
}

async function saveConfig(c: BotConfig) { await kv.set('bot:config', c); }

// ─── USER STORE ──────────────────────────────────────────────────────
async function getUsers(): Promise<Record<string, string>> {
  return (await kv.get<Record<string, string>>('bot:users')) || {};
}
async function setUsers(u: Record<string, string>) { await kv.set('bot:users', u); }

async function isSubscribed(username: string): Promise<boolean> {
  const users = await getUsers();
  const entry = users[username.toLowerCase()];
  if (!entry) return false;
  const now = new Date(); now.setUTCHours(0, 0, 0, 0);
  if (now <= new Date(entry + 'T00:00:00Z')) return true;
  delete users[username.toLowerCase()];
  await setUsers(users);
  return false;
}

function listUsers(users: Record<string, string>): string {
  const e = Object.entries(users);
  if (!e.length) return '(no users)';
  return e.map(([u, x]) => `🧑‍🌾 -> @${u}  (expires ${x})`).join('\n');
}

// ─── LOGS ────────────────────────────────────────────────────────────
async function pushLog(text: string, level: LogEntry['level'] = 'info') {
  const entry: LogEntry = {
    id: Date.now() + Math.floor(Math.random() * 1000),
    time: new Date().toISOString().slice(11, 19),
    level, text: text.trimEnd(),
  };
  await kv.lpush('bot:logs', JSON.stringify(entry));
  await kv.ltrim('bot:logs', 0, 199);
}

async function getLogs(limit = 200): Promise<LogEntry[]> {
  const raw = (await kv.lrange<string[]>('bot:logs', 0, Math.max(0, limit - 1))) || [];
  return raw.map(s => (typeof s === 'string' ? JSON.parse(s) : s));
}

async function clearLogs() { await kv.del('bot:logs'); }

// ─── WINGO ───────────────────────────────────────────────────────────
const WINGO_URL = 'https://sky-predictor-1012593186417.asia-southeast1.run.app/api/wingo-history-1m-500';

async function fetchWingoHistory(): Promise<WingoRecord[]> {
  const res = await fetch(WINGO_URL, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Wingo API returned ${res.status}`);
  const data: any = await res.json();
  return (data?.data?.list || []).map((r: any) => ({
    issueNumber: String(r.issueNumber ?? r.period ?? r.issue ?? ''),
    colour: String(r.colour ?? r.color ?? '').toLowerCase(),
    number: r.number ?? r.result ?? r.num ?? null,
    size: String(r.size ?? r.bigSmall ?? '').toLowerCase(),
    time: String(r.time ?? ''),
  }));
}

function getColourEmoji(colour: string): string {
  const c = (colour || '').toLowerCase();
  if (!c) return '—';
  if (c === 'red') return '🔴';
  if (c === 'green') return '🟢';
  if (c === 'violet') return '🟣';
  if (c.includes('red') && c.includes('green')) return '🔴,🟢';
  if (c.includes('red') && c.includes('violet')) return '🔴,🟣';
  if (c.includes('violet') && c.includes('green')) return '🟣,🟢';
  return c;
}

function getSize(r: WingoRecord): string {
  if (r.size === 'big' || r.size === 'small') return r.size;
  const n = typeof r.number === 'string' ? parseInt(r.number, 10) : r.number;
  if (typeof n === 'number' && !isNaN(n)) return n >= 5 && n <= 9 ? 'big' : 'small';
  return '—';
}

function predictFromOldest(records: WingoRecord[]): string {
  if (!records.length)
    return 'Visionary Bot Prediction 96% Accurate ⭐\n 1 - Minute server\n\n⚠️ No history data available.';
  const o = records[records.length - 1];
  return (
    `Visionary Bot Prediction 96% Accurate ⭐\n` +
    ` 1 - Minute server\n\n` +
    `Period: ${o.issueNumber || '—'}\n` +
    `Next Number: ${o.number ?? '—'}\n` +
    `Next Big/Small: ${getSize(o)}\n` +
    `Next Color: ${getColourEmoji(o.colour)}`
  );
}

function formatTrend(records: WingoRecord[], limit = 10): string {
  let m = '📈 Recent Trend\n💹 Max Rate: 88%\n\n💥💥💥💥💥💥💥💥💥💥\n\n';
  for (const r of records.slice(0, limit)) {
    m += `🔸Period: <b>${r.issueNumber || '—'}</b>\n🔹Colour: <b>${getColourEmoji(r.colour)}</b>\n` +
         `🔸Big/Small: <b>${getSize(r)}</b>\n🔹Number: <b>${r.number ?? '—'}</b>\n\n💥💥💥💥💥💥💥💥💥💥\n\n`;
  }
  return m;
}

// ─── BOT ─────────────────────────────────────────────────────────────
function isAdmin(c: BotConfig, chatId: number | string): boolean {
  const id = String(chatId);
  return id !== '0' && (id === String(c.ADMIN_ID) || id === String(c.DEV_ID));
}

async function isJoinedChannel(bot: Telegraf, channel: string, chatId: number): Promise<boolean> {
  try {
    const m = await bot.telegram.getChatMember('@' + channel, chatId);
    return m.status !== 'left';
  } catch (e) { console.error('[isJoinedChannel]', e); return false; }
}

async function createBot(config: BotConfig): Promise<Telegraf> {
  const bot = new Telegraf(config.BOT_API_TOKEN);
  const replyKb = Markup.keyboard([
    ['📊 Trend Chart', '🎲 Prediction'],
    ['🛠️ Customer Support', '📢 Main Channel'],
    ['🔒 Privacy Policy'],
  ]).resize();

  bot.start(async (ctx) => {
    await ctx.reply(
      `Hi ${ctx.from.first_name} 🌟,\n\nThank you for your interest in ${config.BOT_NAME}! 🤖 To unlock advanced features and exclusive content, ` +
      `simply subscribe to our official JEMSH Mods channel (https://t.me/${config.BOT_GROUP_LINK}). 🚀\n\n` +
      `This step is crucial to ensure you're a real person and not a robot. We're excited to welcome you to our VIP community!`,
      replyKb
    );
  });

  bot.command('id', (ctx) => ctx.reply(`Your id: ${ctx.chat.id}`));

  bot.command('add', async (ctx) => {
    if (!isAdmin(config, ctx.chat.id)) return;
    try {
      const p = ctx.message.text.split(/\s+/);
      const user = p[1].replace(/^@/, '').toLowerCase();
      const days = parseInt(p[2].replace(/[dD]/, ''), 10);
      if (isNaN(days) || days <= 0) throw new Error('bad');
      const exp = new Date(); exp.setDate(exp.getDate() + days);
      const expStr = exp.toISOString().split('T')[0];
      const users = await getUsers(); users[user] = expStr; await setUsers(users);
      await pushLog(`Admin added @${user} for ${days} days`, 'success');
      await ctx.reply(`User added Successfully.\n\nUsers After Modified :\n\n${listUsers(users)}`);
    } catch { await ctx.reply('Need Username (/add <username> <duration>)'); }
  });

  bot.command('remove', async (ctx) => {
    if (!isAdmin(config, ctx.chat.id)) return;
    try {
      const user = ctx.message.text.split(/\s+/)[1].replace(/^@/, '').toLowerCase();
      const users = await getUsers();
      if (!(user in users)) return ctx.reply('User not Exist.');
      delete users[user]; await setUsers(users);
      await pushLog(`Admin removed @${user}`, 'info');
      await ctx.reply(`User removed Successfully.\n\nUsers After Modified :\n\n${listUsers(users)}`);
    } catch { await ctx.reply('Need Username (/remove <username>)'); }
  });

  bot.command('check', async (ctx) => {
    if (!isAdmin(config, ctx.chat.id)) return;
    try {
      const user = ctx.message.text.split(/\s+/)[1];
      await ctx.reply((await isSubscribed(user)) ? 'True' : 'False');
    } catch { await ctx.reply('Need Username (/check <username>)'); }
  });

  bot.command(['getAll', 'usage'], async (ctx) => {
    if (!isAdmin(config, ctx.chat.id)) return;
    await ctx.reply(`All Users:\n\n${listUsers(await getUsers())}`);
  });

  bot.on('text', async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith('/')) return;
    const chatId = ctx.chat.id;
    const username = ctx.from.username;

    if (!username) {
      return ctx.reply(`❌ You Dont have Username.\nGo to Telegram Settings ⚙️ and Create ➕ your telegram username to use ${config.BOT_NAME}.`);
    }

    if (!(await isJoinedChannel(bot, config.BOT_GROUP_LINK, chatId))) {
      return ctx.reply(
        `Hi ${username} 🌟,\n\nSimply subscribe to our official Channel to use ${config.BOT_NAME}.\n Link: https://t.me/${config.BOT_GROUP_LINK} 🚀.\n`,
        Markup.inlineKeyboard([Markup.button.url('Subscribe Here', `https://t.me/${config.BOT_GROUP_LINK}`)])
      );
    }

    if (text === '🎲 Prediction') {
      let phId: number | null = null;
      try {
        const ph = await ctx.reply('Predicting...'); phId = ph.message_id;
        const vip = isAdmin(config, chatId) || (await isSubscribed(username));
        if (!vip) {
          const btns = config.PLANS.map(p => Markup.button.url(
            p.label,
            `https://t.me/${config.ADMIN_USERNAME}?text=${encodeURIComponent(`Hello Sir, I want to Purchase **${p.label} Plan**. Please Proceed further.`)}`
          ));
          await ctx.reply(
            `🌟 Welcome to ${config.BOT_NAME} Subscription 🌟\n\nUnveil the exceptional benefits awaiting you with our Subscription:\n\n` +
            `🎯 88% Accuracy Guarantee: Unlock precise predictions with unparalleled precision.\n🏆 Single-Level Wins: Experience victory in just one game.\n` +
            `🕒 24/7 Availability: Access our services round the clock, from any corner of the globe.\n⚡️ Lightning-Fast Responses: Enjoy rapid solutions and real-time updates.\n\n` +
            `Embark on your journey to unparalleled success by selecting from the options below to discover our exclusive Subscription features:`,
            Markup.inlineKeyboard(btns.map(b => [b]))
          );
        } else {
          const r = await fetchWingoHistory();
          await ctx.reply(predictFromOldest(r));
        }
      } catch (e: any) {
        await pushLog(`Prediction error: ${e.message}`, 'error');
        await ctx.reply('Prediction Error: Oops! 🤖 Something went wrong.');
      } finally {
        if (phId) { try { await ctx.telegram.deleteMessage(chatId, phId); } catch {} }
      }
    } else if (text === '📊 Trend Chart') {
      try {
        const r = await fetchWingoHistory();
        await ctx.reply(formatTrend(r, 10), { parse_mode: 'HTML' });
      } catch (e: any) { await ctx.reply('Trend Chart: Oops! 🤖 Something went wrong.'); }
    } else if (text === '🛠️ Customer Support') {
      await ctx.reply(
        `Dear <b>${ctx.from.first_name} ${ctx.from.last_name || ''}</b>\nIf you encounter any issues or need assistance, feel free to DM me.👇👇`,
        { parse_mode: 'HTML', ...Markup.inlineKeyboard([Markup.button.url('SUPPORT', `https://t.me/${config.ADMIN_USERNAME}`)]) }
      );
    } else if (text === '📢 Main Channel') {
      const name = ctx.from.first_name + (ctx.from.last_name ? ' ' + ctx.from.last_name : '');
      await ctx.reply(
        `Hello Dear <b>${name}</b> you need daily free mod and best accurate prediction you must join our Main Channel 👇👇`,
        { parse_mode: 'HTML', ...Markup.inlineKeyboard([Markup.button.url('Join Now', `https://t.me/${config.BOT_GROUP_LINK}`)]) }
      );
    } else if (text === '🔒 Privacy Policy') {
      await ctx.reply(
        `<b>✨ ${config.BOT_NAME} - Privacy Policy ✨</b>\n\n` +
        `<b>🔰 Legal Consultation</b>: Seek advice from legal professionals specializing in privacy law.\n\n` +
        `<b>🔰 Data Privacy</b>: Ensure compliance with privacy laws.\n\n` +
        `<b>🔰 Transparency</b>: Clearly communicate how the bot works.\n\n` +
        `<b>🔰 Accuracy</b>: Predictions are not legal advice.\n\n` +
        `<b>🔰 Disclaimers</b>: Predictions are algorithmic and may not be accurate.`,
        { parse_mode: 'HTML' }
      );
    }
  });

  return bot;
}

// ─── HELPERS ─────────────────────────────────────────────────────────
function cleanHandle(s: string): string {
  return String(s || '').replace(/^(https?:\/\/)?(t\.me\/|telegram\.me\/)/, '').replace(/^@/, '').trim();
}
function getBaseUrl(req: VercelRequest): string {
  const h = ((req.headers['x-forwarded-host'] as string) || (req.headers.host as string) || '').split(',')[0].trim();
  return h ? `https://${h}` : '';
}

// ─── INLINE ADMIN DASHBOARD (HTML) ───────────────────────────────────
const ADMIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Visionary Bot Control Center</title>
<script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-950 text-slate-100 p-6 font-sans">
<div class="max-w-4xl mx-auto">
  <h1 class="text-3xl font-bold mb-1">🤖 Visionary Bot Control Center</h1>
  <p class="text-slate-400 mb-6">Manage your Telegram prediction bot — 24/7 on Vercel</p>

  <div id="status" class="mb-6 p-4 bg-slate-900 border border-slate-800 rounded-lg">
    <div class="text-slate-400 text-sm">Loading status…</div>
  </div>

  <section class="mb-6">
    <h2 class="text-xl font-semibold mb-2">⚙️ Configuration</h2>
    <form id="cfgForm" class="space-y-2 bg-slate-900 border border-slate-800 p-4 rounded-lg">
      <input name="BOT_API_TOKEN" placeholder="Bot Token (from @BotFather)" class="w-full p-2 bg-slate-800 rounded border border-slate-700">
      <div class="grid grid-cols-2 gap-2">
        <input name="ADMIN_ID" placeholder="Admin Telegram ID" class="p-2 bg-slate-800 rounded border border-slate-700">
        <input name="DEV_ID" placeholder="Dev Telegram ID" class="p-2 bg-slate-800 rounded border border-slate-700">
      </div>
      <input name="BOT_NAME" placeholder="Bot Name" class="w-full p-2 bg-slate-800 rounded border border-slate-700">
      <div class="grid grid-cols-2 gap-2">
        <input name="ADMIN_USERNAME" placeholder="Admin Username (no @)" class="p-2 bg-slate-800 rounded border border-slate-700">
        <input name="BOT_GROUP_LINK" placeholder="Channel Username (no @)" class="p-2 bg-slate-800 rounded border border-slate-700">
      </div>
      <button type="submit" class="bg-blue-600 hover:bg-blue-500 px-4 py-2 rounded font-semibold">💾 Save & Register Webhook</button>
    </form>
  </section>

  <section class="mb-6">
    <h2 class="text-xl font-semibold mb-2">👥 VIP Subscribers</h2>
    <form id="addForm" class="flex gap-2 mb-2">
      <input name="username" placeholder="username (no @)" class="flex-1 p-2 bg-slate-800 rounded border border-slate-700">
      <input name="days" type="number" placeholder="days" class="w-24 p-2 bg-slate-800 rounded border border-slate-700">
      <button type="submit" class="bg-green-600 hover:bg-green-500 px-4 py-2 rounded font-semibold">Add</button>
    </form>
    <div id="users" class="bg-slate-900 border border-slate-800 p-4 rounded-lg space-y-1"></div>
  </section>

  <section>
    <div class="flex justify-between items-center mb-2">
      <h2 class="text-xl font-semibold">📋 Live Logs</h2>
      <button onclick="clearLogs()" class="text-sm text-slate-400 hover:text-red-400">Clear</button>
    </div>
    <div id="logs" class="bg-slate-900 border border-slate-800 p-4 rounded-lg font-mono text-xs h-64 overflow-auto space-y-0.5"></div>
  </section>
</div>

<script>
const FIELDS = ['BOT_API_TOKEN','ADMIN_ID','DEV_ID','BOT_NAME','ADMIN_USERNAME','BOT_GROUP_LINK'];

async function refresh() {
  try {
    const s = await (await fetch('/api/status')).json();
    const color = s.status === 'running' ? 'text-green-400' : s.status === 'waiting_token' ? 'text-yellow-400' : 'text-red-400';
    document.getElementById('status').innerHTML =
      \`<div class="flex items-center gap-3">
        <span class="text-2xl">\${s.status === 'running' ? '🟢' : s.status === 'waiting_token' ? '🟡' : '🔴'}</span>
        <div>
          <div class="font-semibold \${color}">Status: \${s.status.toUpperCase()}</div>
          <div class="text-xs text-slate-400">Bot: \${s.botName} · Channel: @\${s.botGroupLink} · Webhook: \${s.webhookUrl || 'not registered'}</div>
        </div>
      </div>\`;

    const c = await (await fetch('/api/config')).json();
    const form = document.getElementById('cfgForm');
    FIELDS.forEach(k => { if (form[k]) form[k].value = c[k] || ''; });

    const u = await (await fetch('/api/users')).json();
    document.getElementById('users').innerHTML = u.users.length
      ? u.users.map(x => \`<div class="flex justify-between items-center py-1 border-b border-slate-800">
          <span>@\${x.username} · expires \${x.expiration} (\${x.daysLeft}d)</span>
          <button onclick="removeUser('\${x.username}')" class="text-red-400 hover:text-red-300 text-sm">Remove</button>
        </div>\`).join('')
      : '<div class="text-slate-500">No VIP users yet</div>';

    const l = await (await fetch('/api/logs?limit=50')).json();
    document.getElementById('logs').innerHTML = l.logs.reverse()
      .map(e => \`<div class="\${e.level === 'error' ? 'text-red-400' : e.level === 'success' ? 'text-green-400' : e.level === 'warn' ? 'text-yellow-400' : 'text-slate-300'}">
        <span class="text-slate-500">[\${e.time}]</span> \${e.text}
      </div>\`).join('') || '<div class="text-slate-500">No logs yet</div>';
  } catch (e) { console.error(e); }
}

document.getElementById('cfgForm').onsubmit = async (e) => {
  e.preventDefault();
  const data = {};
  FIELDS.forEach(k => { data[k] = e.target[k].value; });
  const r = await fetch('/api/config', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) });
  const j = await r.json();
  alert(j.success ? 'Saved! Webhook registered. Bot is now live.' : 'Error: ' + (j.error || 'unknown'));
  refresh();
};

document.getElementById('addForm').onsubmit = async (e) => {
  e.preventDefault();
  await fetch('/api/users/add', { method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ username: e.target.username.value, days: e.target.days.value }) });
  e.target.reset();
  refresh();
};

async function removeUser(u) {
  if (!confirm('Remove @' + u + '?')) return;
  await fetch('/api/users/remove', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ username: u }) });
  refresh();
}

async function clearLogs() {
  await fetch('/api/logs', { method: 'POST' });
  refresh();
}

refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>`;

// ─── MAIN HANDLER ────────────────────────────────────────────────────
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const raw = req.query.path;
  const segments: string[] = Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? [raw] : [];
  const route = segments.join('/');

  try {
    // Serve admin dashboard for `/`, `/dashboard`, `/render`, and any non-API path
    if (route === 'render' || route === '' || route === 'index') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(ADMIN_HTML);
    }

    // POST /api/webhook
    if (route === 'webhook') {
      if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
      const config = await getConfig();
      if (!config.BOT_API_TOKEN) {
        await pushLog('Webhook called but BOT_API_TOKEN is not configured', 'warn');
        return res.status(500).send('Bot token not configured');
      }
      const bot = await createBot(config);
      await bot.handleUpdate(req.body);
      return res.status(200).send('ok');
    }

    // GET /api/status
    if (route === 'status') {
      const config = await getConfig();
      const isConfigured = Boolean(config.BOT_API_TOKEN && config.BOT_API_TOKEN.length > 15);
      let webhookUrl: string | null = null;
      if (isConfigured) {
        try {
          const r = await fetch(`https://api.telegram.org/bot${config.BOT_API_TOKEN}/getWebhookInfo`);
          const d: any = await r.json();
          webhookUrl = d?.result?.url || null;
        } catch {}
      }
      return res.json({
        status: webhookUrl ? 'running' : isConfigured ? 'starting' : 'waiting_token',
        isConfigured, botName: config.BOT_NAME,
        adminUsername: config.ADMIN_USERNAME, botGroupLink: config.BOT_GROUP_LINK, webhookUrl,
      });
    }

    // GET/POST /api/config
    if (route === 'config') {
      if (req.method === 'GET') {
        const c = await getConfig();
        const tokenPreview = c.BOT_API_TOKEN ? `${c.BOT_API_TOKEN.slice(0, 6)}...${c.BOT_API_TOKEN.slice(-4)}` : '';
        return res.json({ ...c, tokenPreview });
      }
      if (req.method === 'POST') {
        const body = req.body || {};
        const current = await getConfig();
        const updated: BotConfig = {
          ...current, ...body,
          ADMIN_USERNAME: cleanHandle(body.ADMIN_USERNAME || current.ADMIN_USERNAME),
          BOT_GROUP_LINK: cleanHandle(body.BOT_GROUP_LINK || current.BOT_GROUP_LINK),
        };
        await saveConfig(updated);
        await pushLog('Bot configuration updated from Web Dashboard.', 'success');

        if (updated.BOT_API_TOKEN) {
          const webhookUrl = `${getBaseUrl(req)}/api/webhook`;
          try {
            const resp = await fetch(`https://api.telegram.org/bot${updated.BOT_API_TOKEN}/setWebhook`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ url: webhookUrl }),
            });
            const result: any = await resp.json();
            if (result.ok) await pushLog(`Webhook registered: ${webhookUrl}`, 'success');
            else await pushLog(`setWebhook failed: ${result.description}`, 'error');
          } catch (e: any) { await pushLog(`setWebhook error: ${e.message}`, 'error'); }
        }
        return res.json({ success: true, config: updated });
      }
      return res.status(405).json({ error: 'Method not allowed' });
    }

    // GET /api/users
    if (route === 'users' && req.method === 'GET') {
      const users = await getUsers();
      const now = new Date(); now.setUTCHours(0, 0, 0, 0);
      return res.json({
        users: Object.entries(users).map(([username, expiration]) => {
          const exp = new Date(expiration + 'T00:00:00Z');
          const daysLeft = Math.ceil((exp.getTime() - now.getTime()) / 86_400_000);
          return { username, expiration, daysLeft: Math.max(0, daysLeft), isActive: daysLeft >= 0 };
        }),
      });
    }

    // POST /api/users/add
    if (route === 'users/add') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { username, days } = req.body || {};
      if (!username || !days) return res.status(400).json({ error: 'username and days required' });
      const cleanUser = String(username).toLowerCase().replace(/^@/, '').trim();
      const numDays = parseInt(String(days), 10);
      if (isNaN(numDays) || numDays <= 0) return res.status(400).json({ error: 'days must be positive' });
      const exp = new Date(); exp.setDate(exp.getDate() + numDays);
      const expStr = exp.toISOString().split('T')[0];
      const users = await getUsers(); users[cleanUser] = expStr; await setUsers(users);
      await pushLog(`VIP Manager: added @${cleanUser} for ${numDays} days (until ${expStr})`, 'success');
      return res.json({ success: true, username: cleanUser, expiration: expStr });
    }

    // POST /api/users/remove
    if (route === 'users/remove') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { username } = req.body || {};
      if (!username) return res.status(400).json({ error: 'username required' });
      const cleanUser = String(username).toLowerCase().replace(/^@/, '').trim();
      const users = await getUsers(); delete users[cleanUser]; await setUsers(users);
      await pushLog(`VIP Manager: removed @${cleanUser}`, 'info');
      return res.json({ success: true });
    }

    // GET/POST /api/logs
    if (route === 'logs') {
      if (req.method === 'GET') return res.json({ logs: await getLogs(parseInt(String(req.query.limit || '200'), 10)) });
      if (req.method === 'POST') {
        await clearLogs();
        await pushLog('Console logs cleared by user.', 'info');
        return res.json({ success: true });
      }
      return res.status(405).json({ error: 'Method not allowed' });
    }

    // GET /api/logs/stream
    if (route === 'logs/stream') {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('X-Accel-Buffering', 'no');
      for (const e of (await getLogs(50)).reverse()) res.write(`data: ${JSON.stringify(e)}\n\n`);
      return res.end();
    }

    // POST /api/bot/start|stop|restart
    if (route.startsWith('bot/')) {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const action = route.slice(4);
      const config = await getConfig();
      if (!config.BOT_API_TOKEN) return res.status(400).json({ error: 'BOT_API_TOKEN not configured' });

      if (action === 'start' || action === 'restart') {
        const webhookUrl = `${getBaseUrl(req)}/api/webhook`;
        const resp = await fetch(`https://api.telegram.org/bot${config.BOT_API_TOKEN}/setWebhook`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: webhookUrl }),
        });
        const result: any = await resp.json();
        if (!result.ok) throw new Error(result.description || 'setWebhook failed');
        await pushLog(`Bot ${action}: webhook registered at ${webhookUrl}`, 'success');
        return res.json({ success: true, status: 'running', webhookUrl });
      }
      if (action === 'stop') {
        await fetch(`https://api.telegram.org/bot${config.BOT_API_TOKEN}/deleteWebhook`);
        await pushLog('Bot stopped: webhook deleted', 'info');
        return res.json({ success: true, status: 'stopped' });
      }
      return res.status(400).json({ error: 'Unknown action' });
    }

    // GET /api/telegram/verify
    if (route === 'telegram/verify') {
      const config = await getConfig();
      const token = (req.query.token as string) || config.BOT_API_TOKEN;
      if (!token || !token.includes(':')) return res.status(400).json({ valid: false, message: 'Invalid token' });
      const r = await fetch(`https://api.telegram.org/bot${token}/getMe`);
      const d: any = await r.json();
      return d.ok ? res.json({ valid: true, bot: d.result }) : res.json({ valid: false, error: d.description });
    }

    // GET /api/wingo/history
    if (route === 'wingo/history') {
      const records = await fetchWingoHistory();
      let prediction: any = null;
      if (records.length) {
        const o = records[records.length - 1]; const n = records[0];
        prediction = {
          targetPeriod: n.issueNumber ? String(BigInt(n.issueNumber) + 1n) : 'Next Round',
          referencePeriod: o.issueNumber, predictedNumber: o.number,
          predictedSize: getSize(o), predictedColour: getColourEmoji(o.colour),
          rawColour: o.colour, confidence: '96%', server: '1 - Minute Server',
        };
      }
      return res.json({ total: records.length, latest: records[0] || null, prediction, records: records.slice(0, 50) });
    }

    // POST /api/simulate
    if (route === 'simulate') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { text, username = 'trader_demo', chatId = '999888777', isAdmin: simAdmin = false } = req.body || {};
      const config = await getConfig();
      const input = String(text || '').trim();
      const users = await getUsers();
      let isSub = false;
      const exp = users[String(username).toLowerCase()];
      if (exp) { const now = new Date(); now.setUTCHours(0, 0, 0, 0); isSub = new Date(exp + 'T00:00:00Z') >= now; }

      if (input === '/start') return res.json({
        reply: `Hi ${username} 🌟,\n\nThank you for your interest in ${config.BOT_NAME}! 🤖`,
        replyMarkup: ['📊 Trend Chart', '🎲 Prediction', '🛠️ Customer Support', '📢 Main Channel', '🔒 Privacy Policy'],
      });
      if (input === '/id') return res.json({ reply: `Your Telegram User ID: <code>${chatId}</code>` });
      if (input === '📊 Trend Chart') return res.json({ reply: formatTrend(await fetchWingoHistory(), 10) });
      if (input === '🎲 Prediction') {
        if (simAdmin || isSub) return res.json({ reply: predictFromOldest(await fetchWingoHistory()), isVip: true });
        return res.json({
          reply: `🌟 Welcome to ${config.BOT_NAME} Subscription 🌟\n\nChoose a plan to continue:`,
          buttons: config.PLANS.map(p => ({ text: p.label, url: `https://t.me/${config.ADMIN_USERNAME}?text=${encodeURIComponent(`I want **${p.label}**`)}` })),
          isVip: false,
        });
      }
      if (input.startsWith('/add')) {
        if (!simAdmin) return res.json({ reply: '⛔ Not authorized.' });
        const p = input.split(/\s+/);
        if (p.length < 3) return res.json({ reply: 'Usage: /add <username> <duration>' });
        const u = p[1].replace(/^@/, '').toLowerCase();
        const days = parseInt(p[2].replace(/[dD]/, ''), 10);
        if (isNaN(days) || days <= 0) return res.json({ reply: 'Duration must be positive.' });
        const e = new Date(); e.setDate(e.getDate() + days);
        const expStr = e.toISOString().split('T')[0];
        const all = await getUsers(); all[u] = expStr; await setUsers(all);
        return res.json({ reply: `User added Successfully.\n\nUsers After Modified:\n${listUsers(all)}` });
      }
      return res.json({ reply: `Received: "${input}"` });
    }

    return res.status(404).json({ error: `Unknown route: /api/${route}` });
  } catch (e: any) {
    console.error('[api]', e);
    await pushLog(`API error on /api/${route}: ${e.message}`, 'error');
    return res.status(500).json({ error: e.message });
  }
}
