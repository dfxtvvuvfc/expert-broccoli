import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {spawn, execFile} from 'child_process';
import {fileURLToPath} from 'url';
import QRCode from 'qrcode';
import WebSocket, {WebSocketServer} from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({limit: '128kb'}));

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STORE = path.join(DATA_DIR, 'vodi.json');
const XRAY = process.env.XRAY_BIN || 'xray';
const XRAY_PORT = Number(process.env.XRAY_LISTEN_PORT || 10000);
const API_PORT = Number(process.env.XRAY_API_PORT || 10085);
const DEFAULT_HOST = String(process.env.PUBLIC_DOMAIN || process.env.RAILWAY_PUBLIC_DOMAIN || '').trim();
const WS_PATH_DEFAULT = '/vless';
const COOKIE = 'vodi_session';

fs.mkdirSync(DATA_DIR, {recursive: true});

const initial = {
  admin: {username: 'admin', passwordHash: null},
  configs: [],
  settings: {publicHost: DEFAULT_HOST, wsPath: WS_PATH_DEFAULT},
  meta: {version: 5}
};

function clone(v) { return JSON.parse(JSON.stringify(v)); }
function load() {
  try { return JSON.parse(fs.readFileSync(STORE, 'utf8')); }
  catch { return clone(initial); }
}
let db = load();
if (!db.admin || !db.admin.username) db.admin = clone(initial.admin);
if (!db.admin.passwordHash) db.admin.passwordHash = hashPassword('admin');
if (!Array.isArray(db.configs)) db.configs = [];
if (!db.settings) db.settings = clone(initial.settings);
if (!db.settings.wsPath) db.settings.wsPath = WS_PATH_DEFAULT;
if (db.settings.publicHost == null) db.settings.publicHost = DEFAULT_HOST;
// Vodi VPN intentionally supports one transport only: VLESS + WebSocket + TLS on 443.
db.settings.wsPath = WS_PATH_DEFAULT;
for (const c of db.configs) {
  c.baseUpBytes = Number(c.baseUpBytes || 0);
  c.baseDownBytes = Number(c.baseDownBytes || c.baseBytes || 0);
  delete c.baseBytes;
  c.volumeGB = c.volumeGB == null ? null : Number(c.volumeGB);
  c.days = c.days == null ? null : Number(c.days);
  c.enabled = c.enabled !== false;
  c.expired = Boolean(c.expired);
}
db.meta = {version: 5};

// Always start with one usable, unlimited VLESS profile. It is created only once.
if (db.configs.length === 0) {
  const now = Date.now();
  db.configs.push({
    id: crypto.randomBytes(9).toString('hex'),
    uuid: crypto.randomUUID(),
    name: 'Vodi VPN • اصلی',
    volumeGB: null,
    days: null,
    createdAt: now,
    expiresAt: null,
    token: randomToken(18),
    enabled: true,
    expired: false,
    baseUpBytes: 0,
    baseDownBytes: 0,
    devices: null
  });
}

function atomicSave() {
  const tmp = `${STORE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), {mode: 0o600});
  fs.renameSync(tmp, STORE);
}
atomicSave();

function randomToken(bytes = 32) { return crypto.randomBytes(bytes).toString('base64url'); }
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return `${salt}:${crypto.scryptSync(String(password), salt, 64).toString('hex')}`;
}
function verifyPassword(password, stored) {
  try {
    const [salt, expected] = String(stored || '').split(':');
    if (!salt || !expected) return false;
    const actual = crypto.scryptSync(String(password || ''), salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
  } catch { return false; }
}

const sessions = new Map();
const loginAttempts = new Map();
function setCookie(res, value, maxAge = 86400 * 7) {
  res.setHeader('Set-Cookie', `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`);
}
function clearCookie(res) { res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`); }
function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  const item = raw.split(';').map(x => x.trim()).find(x => x.startsWith(`${name}=`));
  return item ? decodeURIComponent(item.slice(name.length + 1)) : '';
}
function auth(req, res, next) {
  const token = readCookie(req, COOKIE);
  const session = sessions.get(token);
  if (!session) return res.status(401).json({error: 'جلسه منقضی شده است'});
  if (Date.now() - session.createdAt > 7 * 86400000) {
    sessions.delete(token); clearCookie(res);
    return res.status(401).json({error: 'جلسه منقضی شده است'});
  }
  req.session = session;
  next();
}

function validHost(value) {
  return /^(?:[a-zA-Z0-9-]+\.)*[a-zA-Z0-9-]+$/.test(value) || /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value);
}
function cleanHost(value) {
  return String(value || '').trim().replace(/^https?:\/\//i, '').replace(/\/$/, '').split('/')[0];
}
function publicHost(req) {
  const configured = cleanHost(db.settings.publicHost);
  if (configured) return configured;
  const env = cleanHost(process.env.PUBLIC_DOMAIN || process.env.RAILWAY_PUBLIC_DOMAIN);
  if (env) return env;
  return String(req?.headers?.host || '').split(':')[0];
}
function baseUrl(req) {
  const proto = String(req?.headers?.['x-forwarded-proto'] || '').split(',')[0] || 'https';
  return `${proto}://${publicHost(req)}`;
}
function vlessLink(c, req) {
  const host = publicHost(req);
  const pathValue = db.settings.wsPath || WS_PATH_DEFAULT;
  const q = new URLSearchParams({
    encryption: 'none', security: 'tls', type: 'ws', host,
    path: pathValue, sni: host
  });
  return `vless://${c.uuid}@${host}:443?${q.toString()}#${encodeURIComponent(c.name)}`;
}
function human(bytes) {
  let n = Number(bytes || 0);
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  if (i === 0) return `${Math.round(n)} B`;
  return `${n < 10 ? n.toFixed(1) : n.toFixed(0)} ${units[i]}`;
}
function totalLimit(c) { return c.volumeGB == null ? 0 : Math.round(c.volumeGB * 1024 ** 3); }
function expirySeconds(c) { return c.expiresAt ? Math.floor(c.expiresAt / 1000) : 0; }

let xray = null;
let xrayRestarting = false;
let statsCache = {};
let statsAt = 0;
let reloadTimer = null;

function xrayConfig() {
  const clients = db.configs
    .filter(c => c.enabled !== false && !c.expired)
    .map(c => ({id: c.uuid, email: c.id, level: 0}));
  return {
    log: {loglevel: 'warning'},
    api: {tag: 'api', listen: `127.0.0.1:${API_PORT}`, services: ['StatsService']},
    stats: {},
    policy: {
      levels: {'0': {
        handshake: 60, connIdle: 300, uplinkOnly: 1, downlinkOnly: 1,
        statsUserUplink: true, statsUserDownlink: true, statsUserOnline: true,
        bufferSize: 4
      }}
    },
    inbounds: [
      {tag: 'vless-ws', listen: '127.0.0.1', port: XRAY_PORT, protocol: 'vless',
        settings: {clients, decryption: 'none'},
        streamSettings: {network: 'ws', security: 'none', wsSettings: {path: db.settings.wsPath || WS_PATH_DEFAULT}}}
    ],
    outbounds: [{tag: 'direct', protocol: 'freedom'}]
  };
}
function writeXrayConfig() {
  const file = path.join(DATA_DIR, 'xray.json');
  fs.writeFileSync(file, JSON.stringify(xrayConfig(), null, 2), {mode: 0o600});
  return file;
}
function queryStats(callback) {
  execFile(XRAY, ['api', 'statsquery', '--server', `127.0.0.1:${API_PORT}`], {timeout: 3500, maxBuffer: 2 * 1024 * 1024}, (err, stdout) => {
    if (err) return callback({});
    try {
      const out = {};
      const list = JSON.parse(stdout).stat || [];
      for (const row of list) {
        const m = String(row.name || '').match(/^user>>>(.+?)>>>traffic>>>(uplink|downlink)$/);
        if (!m) continue;
        out[m[1]] ||= {up: 0, down: 0};
        out[m[1]][m[2] === 'uplink' ? 'up' : 'down'] = Number(row.value) || 0;
      }
      callback(out);
    } catch { callback({}); }
  });
}
function refreshStats(force = false) {
  return new Promise(resolve => {
    if (!force && Date.now() - statsAt < 5000) return resolve(statsCache);
    queryStats(result => { statsCache = result; statsAt = Date.now(); resolve(result); });
  });
}
function currentUsed(c, stats = statsCache) {
  const live = stats[c.id] || {up: 0, down: 0};
  return Number(c.baseUpBytes || 0) + Number(c.baseDownBytes || 0) + Number(live.up || 0) + Number(live.down || 0);
}
function snapshotStatsIntoBase(stats) {
  let changed = false;
  for (const c of db.configs) {
    const live = stats[c.id];
    if (!live) continue;
    const add = Number(live.up || 0) + Number(live.down || 0);
    if (Number(live.up || 0) > 0 || Number(live.down || 0) > 0) {
      c.baseUpBytes = Number(c.baseUpBytes || 0) + Number(live.up || 0);
      c.baseDownBytes = Number(c.baseDownBytes || 0) + Number(live.down || 0);
      changed = true;
    }
  }
  return changed;
}
function startXray() {
  if (xray || xrayRestarting) return;
  const cfg = writeXrayConfig();
  xray = spawn(XRAY, ['run', '-config', cfg], {stdio: ['ignore', 'pipe', 'pipe']});
  xray.stdout.on('data', d => process.stdout.write(`[xray] ${d}`));
  xray.stderr.on('data', d => process.stderr.write(`[xray] ${d}`));
  xray.on('exit', (code, signal) => {
    console.log(`[xray] exited code=${code} signal=${signal || ''}`);
    xray = null;
  });
}
async function restartXray() {
  if (xrayRestarting) return;
  xrayRestarting = true;
  try {
    const before = await refreshStats(true);
    if (snapshotStatsIntoBase(before)) atomicSave();
    if (xray) {
      try { xray.kill('SIGTERM'); } catch {}
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    statsCache = {}; statsAt = 0;
    const cfg = writeXrayConfig();
    const valid = await new Promise(resolve => execFile(XRAY, ['run', '-test', '-config', cfg], {timeout: 5000}, err => resolve(!err)));
    if (!valid) { console.error('[xray] configuration test failed'); return; }
    startXray();
  } finally {
    xrayRestarting = false;
  }
}
function scheduleReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => restartXray().catch(err => console.error('xray reload', err)), 250);
}

function isLoginLimited(ip) {
  const now = Date.now();
  const item = loginAttempts.get(ip) || {count: 0, at: now};
  if (now - item.at > 10 * 60 * 1000) return false;
  return item.count >= 8;
}
function recordLoginFail(ip) {
  const now = Date.now();
  const item = loginAttempts.get(ip) || {count: 0, at: now};
  if (now - item.at > 10 * 60 * 1000) { item.count = 0; item.at = now; }
  item.count++; loginAttempts.set(ip, item);
}

app.get('/api/health', async (_req, res) => {
  res.json({ok: true, service: 'vodi-vpn', xray: Boolean(xray), protocol: 'VLESS', transport: 'WebSocket'});
});
app.post('/api/login', (req, res) => {
  const ip = req.ip || 'unknown';
  if (isLoginLimited(ip)) return res.status(429).json({error: 'تلاش‌های ورود زیاد است؛ چند دقیقه بعد دوباره امتحان کنید.'});
  const {username, password} = req.body || {};
  if (username !== 'admin' || !verifyPassword(password, db.admin.passwordHash)) {
    recordLoginFail(ip); return res.status(401).json({error: 'نام کاربری یا رمز عبور اشتباه است'});
  }
  loginAttempts.delete(ip);
  const t = randomToken(32); sessions.set(t, {createdAt: Date.now()});
  setCookie(res, t); res.json({ok: true});
});
app.post('/api/logout', auth, (req, res) => { const t = readCookie(req, COOKIE); sessions.delete(t); clearCookie(res); res.json({ok: true}); });
app.post('/api/change-password', auth, (req, res) => {
  const {currentPassword, newPassword, confirmPassword} = req.body || {};
  if (!verifyPassword(currentPassword, db.admin.passwordHash)) return res.status(400).json({error: 'رمز فعلی اشتباه است'});
  if (String(newPassword || '').length < 6) return res.status(400).json({error: 'رمز جدید باید حداقل ۶ کاراکتر باشد'});
  if (newPassword !== confirmPassword) return res.status(400).json({error: 'تکرار رمز جدید یکسان نیست'});
  db.admin.passwordHash = hashPassword(newPassword); atomicSave(); sessions.clear(); clearCookie(res); res.json({ok: true});
});

app.get('/api/bootstrap', auth, async (req, res) => {
  const st = await refreshStats();
  const configs = db.configs.map(c => ({
    ...c, usedBytes: currentUsed(c, st), link: vlessLink(c, req),
    subscriptionPage: `${baseUrl(req)}/sub/${c.token}`,
    subscriptionRaw: `${baseUrl(req)}/sub/${c.token}/raw`
  }));
  res.json({settings: {...db.settings, publicHost: publicHost(req)}, configs,
    nodes: [{id: 'railway-xray', name: 'Railway Xray', status: xray ? 'online' : 'offline'}]});
});
app.post('/api/settings', auth, (req, res) => {
  const {publicHost: incomingHost, wsPath} = req.body || {};
  if (incomingHost !== undefined) {
    const h = cleanHost(incomingHost);
    if (h && !validHost(h)) return res.status(400).json({error: 'دامنه نامعتبر است'});
    db.settings.publicHost = h;
  }
  // WS path is intentionally fixed for compatibility and predictable client URLs.
  db.settings.wsPath = WS_PATH_DEFAULT;
  atomicSave(); scheduleReload(); res.json({ok: true, wsPath: WS_PATH_DEFAULT});
});

app.post('/api/configs', auth, (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name || name.length > 80) return res.status(400).json({error: 'نام کانفیگ را وارد کنید'});
  const rawVolume = req.body?.volumeGB;
  const rawDays = req.body?.days;
  const volumeGB = rawVolume === '' || rawVolume == null ? null : Number(rawVolume);
  const days = rawDays === '' || rawDays == null ? null : Number(rawDays);
  if (volumeGB !== null && (!Number.isFinite(volumeGB) || volumeGB <= 0 || volumeGB > 100000)) return res.status(400).json({error: 'حجم نامعتبر است'});
  if (days !== null && (!Number.isFinite(days) || days <= 0 || days > 3650)) return res.status(400).json({error: 'مدت نامعتبر است'});
  const now = Date.now();
  const c = {id: crypto.randomBytes(9).toString('hex'), uuid: crypto.randomUUID(), name,
    volumeGB, days, createdAt: now, expiresAt: days ? now + days * 86400000 : null,
    token: randomToken(18), enabled: true, expired: false, baseUpBytes: 0, baseDownBytes: 0, devices: null};
  db.configs.unshift(c); atomicSave(); scheduleReload();
  res.status(201).json({...c, usedBytes: 0, link: vlessLink(c, req), subscriptionPage: `${baseUrl(req)}/sub/${c.token}`, subscriptionRaw: `${baseUrl(req)}/sub/${c.token}/raw`});
});
app.patch('/api/configs/:id', auth, (req, res) => {
  const c = db.configs.find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({error: 'کانفیگ پیدا نشد'});
  if (req.body?.enabled !== undefined) c.enabled = Boolean(req.body.enabled);
  if (req.body?.name !== undefined) { const n = String(req.body.name).trim(); if (!n || n.length > 80) return res.status(400).json({error: 'نام نامعتبر است'}); c.name = n; }
  if (req.body?.volumeGB !== undefined) { const v = req.body.volumeGB === '' || req.body.volumeGB == null ? null : Number(req.body.volumeGB); if (v !== null && (!Number.isFinite(v) || v <= 0)) return res.status(400).json({error: 'حجم نامعتبر است'}); c.volumeGB = v; }
  if (req.body?.days !== undefined) { const d = req.body.days === '' || req.body.days == null ? null : Number(req.body.days); if (d !== null && (!Number.isFinite(d) || d <= 0)) return res.status(400).json({error: 'مدت نامعتبر است'}); c.days = d; c.expiresAt = d ? Date.now() + d * 86400000 : null; c.expired = false; }
  atomicSave(); scheduleReload(); res.json({...c, usedBytes: currentUsed(c), link: vlessLink(c, req)});
});
app.delete('/api/configs/:id', auth, (req, res) => {
  const before = db.configs.length; db.configs = db.configs.filter(x => x.id !== req.params.id);
  if (db.configs.length === before) return res.status(404).json({error: 'کانفیگ پیدا نشد'});
  atomicSave(); scheduleReload(); res.json({ok: true});
});
app.post('/api/configs/:id/reset', auth, async (req, res) => {
  const target = db.configs.find(x => x.id === req.params.id);
  if (!target) return res.status(404).json({error: 'کانفیگ پیدا نشد'});
  const st = await refreshStats(true);
  // Xray exposes reset for statsquery globally. Preserve every other user's live usage before resetting.
  for (const c of db.configs) {
    const live = st[c.id];
    if (c.id === target.id) { c.baseUpBytes = 0; c.baseDownBytes = 0; }
    else { c.baseUpBytes = Number(c.baseUpBytes || 0) + Number(live?.up || 0); c.baseDownBytes = Number(c.baseDownBytes || 0) + Number(live?.down || 0); }
  }
  await new Promise(resolve => execFile(XRAY, ['api', 'statsquery', '--server', `127.0.0.1:${API_PORT}`, '-reset=true'], {timeout: 5000}, () => resolve()));
  atomicSave(); statsCache = {}; statsAt = 0; res.json({ok: true});
});
app.get('/api/configs/:id/qr', auth, async (req, res) => {
  const c = db.configs.find(x => x.id === req.params.id); if (!c) return res.sendStatus(404);
  res.type('png').send(await QRCode.toBuffer(vlessLink(c, req), {width: 520, margin: 2, errorCorrectionLevel: 'M'}));
});

function subscriptionHeaders(res, c, st) {
  const live = st[c.id] || {up: 0, down: 0};
  const upload = Number(c.baseUpBytes || 0) + Number(live.up || 0);
  const download = Number(c.baseDownBytes || 0) + Number(live.down || 0);
  const total = totalLimit(c);
  res.set('profile-title', `Vodi VPN • ${c.name}`);
  res.set('profile-update-interval', '12');
  res.set('subscription-userinfo', `upload=${upload}; download=${download}; total=${total}; expire=${expirySeconds(c)}`);
}
function publicConfig(req, c, st) {
  const usedBytes = currentUsed(c, st);
  const remainingBytes = c.volumeGB == null ? null : Math.max(0, totalLimit(c) - usedBytes);
  return {name: c.name, enabled: c.enabled && !c.expired, usedBytes, remainingBytes,
    volumeGB: c.volumeGB, expiresAt: c.expiresAt, devices: c.devices ?? null,
    vless: vlessLink(c, req), raw: `${baseUrl(req)}/sub/${c.token}/raw`, qr: `${baseUrl(req)}/sub/${c.token}/qr`};
}
app.get('/sub/:token/raw', async (req, res) => {
  const c = db.configs.find(x => x.token === req.params.token);
  if (!c) return res.status(404).type('text/plain').send('Not found');
  const st = await refreshStats(); subscriptionHeaders(res, c, st);
  res.type('text/plain').send(Buffer.from(`${vlessLink(c, req)}\n`).toString('base64'));
});
app.get('/sub/:token/qr', async (req, res) => {
  const c = db.configs.find(x => x.token === req.params.token); if (!c) return res.sendStatus(404);
  res.type('png').send(await QRCode.toBuffer(vlessLink(c, req), {width: 640, margin: 2, errorCorrectionLevel: 'M'}));
});
app.get('/sub/:token/meta', async (req, res) => {
  const c = db.configs.find(x => x.token === req.params.token); if (!c) return res.status(404).json({error: 'Not found'});
  const st = await refreshStats(); res.json(publicConfig(req, c, st));
});

app.use(express.static(path.join(__dirname, 'dist'), {maxAge: '1h', index: false}));
app.get('/sub/:token', (_req, res) => res.sendFile(path.join(__dirname, 'dist', 'index.html')));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'dist', 'index.html')));

const server = app.listen(PORT, '0.0.0.0', () => console.log(`Vodi VPN listening on ${PORT}`));
const wss = new WebSocketServer({noServer: true, perMessageDeflate: false, maxPayload: 16 * 1024 * 1024});
server.on('upgrade', (req, socket, head) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host}`);
    if (u.pathname !== (db.settings.wsPath || WS_PATH_DEFAULT)) return socket.destroy();
    if (!xray) return socket.destroy();
    wss.handleUpgrade(req, socket, head, client => {
      try { client._socket?.setNoDelay(true); client._socket?.setKeepAlive(true, 30000); } catch {}
      const upstream = new WebSocket(`ws://127.0.0.1:${XRAY_PORT}${u.pathname}`, {perMessageDeflate: false});
      try { upstream._socket?.setNoDelay(true); upstream._socket?.setKeepAlive(true, 30000); } catch {}
      let closed = false;
      const closeBoth = () => { if (closed) return; closed = true; try { client.close(); } catch {} try { upstream.close(); } catch {} };
      client.on('error', closeBoth); client.on('close', closeBoth);
      upstream.on('error', closeBoth); upstream.on('close', closeBoth);
      client.on('message', data => { if (upstream.readyState === WebSocket.OPEN) upstream.send(data); });
      upstream.on('message', data => { if (client.readyState === WebSocket.OPEN) client.send(data); });
      upstream.on('open', () => { /* VLESS WS tunnel is now bridged. */ });
    });
  } catch { try { socket.destroy(); } catch {} }
});

async function enforce() {
  if (!xray) return;
  const st = await refreshStats(true);
  let changed = false;
  for (const c of db.configs) {
    const used = currentUsed(c, st);
    c.lastUsedBytes = used;
    if (c.volumeGB != null && used >= totalLimit(c) && c.enabled) { c.enabled = false; changed = true; }
    if (c.expiresAt && Date.now() >= c.expiresAt && !c.expired) { c.expired = true; c.enabled = false; changed = true; }
  }
  if (changed) { atomicSave(); scheduleReload(); }
}
setInterval(enforce, 10000);
if (fs.existsSync(XRAY)) startXray();
