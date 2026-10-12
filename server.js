/* 校园二手集市 —— 后端服务（含后台管理 + 访问验证） */
'use strict';

const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const crypto = require('crypto');

const PORT           = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const ADMIN_TOKEN_TTL = 2 * 60 * 60 * 1000;

const ROOT        = __dirname;
const PUBLIC_DIR  = path.join(ROOT, 'public');
const DATA_DIR    = path.join(ROOT, 'data');
const IMAGES_DIR  = path.join(DATA_DIR, 'images');
const ITEMS_FILE  = path.join(DATA_DIR, 'items.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

/* ---------------- 初始化 ---------------- */
for (const d of [DATA_DIR, IMAGES_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}
if (!fs.existsSync(ITEMS_FILE)) fs.writeFileSync(ITEMS_FILE, '[]', 'utf8');
if (!fs.existsSync(SETTINGS_FILE)) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ question: '', answer: '' }, null, 2), 'utf8');
}
if (!fs.existsSync(path.join(PUBLIC_DIR, 'index.html'))) {
  console.error('\n[错误] 找不到 public/index.html，请检查文件结构。\n');
}

/* ---------------- 数据读写 ---------------- */
function readItems() {
  try {
    const raw = fs.readFileSync(ITEMS_FILE, 'utf8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    console.error('读取 items.json 失败：', e.message);
    return [];
  }
}
function writeItems(items) {
  const tmp = ITEMS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(items, null, 2), 'utf8');
  fs.renameSync(tmp, ITEMS_FILE);
}

function readSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
    const s = JSON.parse(raw);
    return {
      question: String(s.question || '').trim(),
      answer:   String(s.answer   || '').trim()
    };
  } catch (e) {
    return { question: '', answer: '' };
  }
}
function writeSettings(s) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2), 'utf8');
}

function toPublic(item) {
  const { ownerKey, image, ...rest } = item;
  return {
    ...rest,
    image: image ? '/api/images/' + image : null
  };
}

/* ---------------- 管理员会话 ---------------- */
const adminTokens = new Map();
function createAdminToken() {
  const t = crypto.randomBytes(24).toString('hex');
  adminTokens.set(t, Date.now() + ADMIN_TOKEN_TTL);
  return t;
}
function checkAdmin(req) {
  const auth = req.headers['authorization'] || '';
  const m = /^Bearer\s+([A-Fa-f0-9]+)$/.exec(auth);
  if (!m) return false;
  const exp = adminTokens.get(m[1]);
  if (!exp) return false;
  if (exp < Date.now()) { adminTokens.delete(m[1]); return false; }
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [t, exp] of adminTokens) if (exp < now) adminTokens.delete(t);
}, 10 * 60 * 1000).unref();

/* ---------------- 访客验证 token ---------------- */
const verifyTokens = new Map();
function createVerifyToken() {
  const t = crypto.randomBytes(24).toString('hex');
  verifyTokens.set(t, { createdAt: Date.now() });
  return t;
}
function checkVerify(req) {
  const t = req.headers['x-verify-token'];
  if (!t) return false;
  return verifyTokens.has(t);
}
function clearVerifyTokens() {
  verifyTokens.clear();
  console.log('[验证] 已清空所有访客验证 token');
}

/* ---------------- HTTP 工具 ---------------- */
function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}
function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const raw = await readBody(req);
  return JSON.parse(raw || '{}');
}

/* =============== 验证接口 =============== */

function handleGetVerifyQuestion(req, res) {
  const s = readSettings();
  const required = !!(s.question && s.answer);
  sendJson(res, 200, {
    required,
    question: required ? s.question : ''
  });
}

async function handleVerifyAnswer(req, res) {
  let payload;
  try { payload = await readJson(req); }
  catch (e) { return sendJson(res, 400, { error: '请求格式错误' }); }

  const s = readSettings();
  if (!s.question || !s.answer) {
    return sendJson(res, 200, { token: createVerifyToken() });
  }

  const answer = String(payload.answer || '').trim();
  if (answer.toLowerCase() !== s.answer.toLowerCase()) {
    await new Promise((r) => setTimeout(r, 400));
    return sendJson(res, 401, { error: '答案不正确，请再试一次' });
  }

  sendJson(res, 200, { token: createVerifyToken() });
}

/* =============== 公开接口 =============== */

function handleListItems(req, res) {
  const verified = checkVerify(req);
  const items = readItems().map((it) => {
    const pub = toPublic(it);
    if (!verified) pub.contact = null;
    return pub;
  });
  sendJson(res, 200, { items, verified });
}

async function handleCreateItem(req, res) {
  const s = readSettings();
  const needsVerify = !!(s.question && s.answer);
  if (needsVerify && !checkVerify(req)) {
    return sendJson(res, 401, { error: '请先完成访问验证', needVerify: true });
  }

  let payload;
  try { payload = await readJson(req); }
  catch (e) { return sendJson(res, 400, { error: '请求格式错误' }); }

  const campus      = String(payload.campus      || '').trim();
  const name        = String(payload.name        || '').trim();
  const contact     = String(payload.contact     || '').trim();
  const description = String(payload.description || '').trim();
  let   price       = payload.price;

  if (!campus || !name || !contact) {
    return sendJson(res, 400, { error: '校区、物品名称、联系方式为必填项' });
  }
  if (campus.length > 20 || name.length > 40 ||
      contact.length > 60 || description.length > 500) {
    return sendJson(res, 400, { error: '字段长度超出限制' });
  }

  if (price === '' || price === null || price === undefined) {
    price = null;
  } else {
    const n = Number(price);
    if (!isFinite(n) || n < 0) return sendJson(res, 400, { error: '价格不合法' });
    price = Math.round(n * 100) / 100;
  }

  const id       = 'it_' + crypto.randomBytes(8).toString('hex');
  const ownerKey = crypto.randomBytes(16).toString('hex');

  let imageFile = null;
  const img = payload.image;
  if (img && typeof img === 'string') {
    const m = /^data:image\/(?:jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=]+)$/i.exec(img);
    if (m) {
      const buf = Buffer.from(m[1], 'base64');
      if (buf.length > 3 * 1024 * 1024) {
        return sendJson(res, 400, { error: '图片太大，请重新选择' });
      }
      imageFile = id + '.jpg';
      fs.writeFileSync(path.join(IMAGES_DIR, imageFile), buf);
    }
  }

  const item = {
    id, ownerKey, campus, name, description, contact, price,
    image: imageFile, status: 'active', createdAt: Date.now()
  };

  const items = readItems();
  items.unshift(item);
  writeItems(items);
  sendJson(res, 201, { item: toPublic(item), ownerKey });
}

async function handleUpdateItem(req, res, id) {
  let payload;
  try { payload = await readJson(req); }
  catch (e) { return sendJson(res, 400, { error: '请求格式错误' }); }

  const items = readItems();
  const idx = items.findIndex((i) => i.id === id);
  if (idx === -1) return sendJson(res, 404, { error: '物品不存在' });
  if (items[idx].ownerKey !== payload.ownerKey) {
    return sendJson(res, 403, { error: '没有权限修改该物品' });
  }
  const status = payload.status;
  if (status !== 'active' && status !== 'sold') {
    return sendJson(res, 400, { error: '状态不合法' });
  }
  items[idx].status = status;
  writeItems(items);
  sendJson(res, 200, { item: toPublic(items[idx]) });
}

async function handleDeleteItem(req, res, id) {
  let payload;
  try { payload = await readJson(req); }
  catch (e) { return sendJson(res, 400, { error: '请求格式错误' }); }

  const items = readItems();
  const idx = items.findIndex((i) => i.id === id);
  if (idx === -1) return sendJson(res, 404, { error: '物品不存在' });
  if (items[idx].ownerKey !== payload.ownerKey) {
    return sendJson(res, 403, { error: '没有权限删除该物品' });
  }
  const [removed] = items.splice(idx, 1);
  writeItems(items);
  if (removed.image) fs.unlink(path.join(IMAGES_DIR, removed.image), () => {});
  sendJson(res, 200, { ok: true });
}

/* =============== 管理员接口 =============== */

async function handleAdminLogin(req, res) {
  let payload;
  try { payload = await readJson(req); }
  catch (e) { return sendJson(res, 400, { error: '请求格式错误' }); }

  const pwd = String(payload.password || '');
  if (pwd !== ADMIN_PASSWORD) {
    await new Promise((r) => setTimeout(r, 400));
    return sendJson(res, 401, { error: '密码错误' });
  }
  sendJson(res, 200, { token: createAdminToken(), expiresIn: ADMIN_TOKEN_TTL });
}

function handleAdminList(req, res) {
  if (!checkAdmin(req)) return sendJson(res, 401, { error: '未登录或登录已过期' });
  sendJson(res, 200, { items: readItems().map(toPublic) });
}

async function handleAdminDelete(req, res, id) {
  if (!checkAdmin(req)) return sendJson(res, 401, { error: '未登录或登录已过期' });
  const items = readItems();
  const idx = items.findIndex((i) => i.id === id);
  if (idx === -1) return sendJson(res, 404, { error: '物品不存在' });
  const [removed] = items.splice(idx, 1);
  writeItems(items);
  if (removed.image) fs.unlink(path.join(IMAGES_DIR, removed.image), () => {});
  sendJson(res, 200, { ok: true });
}

async function handleAdminCleanSold(req, res) {
  if (!checkAdmin(req)) return sendJson(res, 401, { error: '未登录或登录已过期' });
  const items = readItems();
  const kept = [];
  let removedCount = 0;
  for (const it of items) {
    if (it.status === 'sold') {
      removedCount++;
      if (it.image) fs.unlink(path.join(IMAGES_DIR, it.image), () => {});
    } else kept.push(it);
  }
  writeItems(kept);
  sendJson(res, 200, { ok: true, removed: removedCount });
}

/* ---- 管理员：验证问题设置 ---- */

function handleAdminGetSettings(req, res) {
  if (!checkAdmin(req)) return sendJson(res, 401, { error: '未登录或登录已过期' });
  const s = readSettings();
  sendJson(res, 200, { question: s.question, answer: s.answer });
}

async function handleAdminSaveSettings(req, res) {
  if (!checkAdmin(req)) return sendJson(res, 401, { error: '未登录或登录已过期' });

  let payload;
  try { payload = await readJson(req); }
  catch (e) { return sendJson(res, 400, { error: '请求格式错误' }); }

  const question = String(payload.question || '').trim();
  const answer   = String(payload.answer   || '').trim();

  if (question.length > 200) return sendJson(res, 400, { error: '问题最多 200 字' });
  if (answer.length > 200)   return sendJson(res, 400, { error: '答案最多 200 字' });
  if ((question && !answer) || (!question && answer)) {
    return sendJson(res, 400, { error: '问题与答案必须同时填写，或同时清空' });
  }

  const old = readSettings();
  const changed = old.question !== question || old.answer !== answer;
  writeSettings({ question, answer });

  if (changed) clearVerifyTokens();

  sendJson(res, 200, { ok: true, question, answer });
}

/* ---------------- 图片输出 ---------------- */
function handleImage(req, res, filename) {
  const safe = path.basename(filename);
  const file = path.join(IMAGES_DIR, safe);
  if (!file.startsWith(IMAGES_DIR) || !fs.existsSync(file)) {
    res.writeHead(404); res.end('Not Found'); return;
  }
  res.writeHead(200, {
    'Content-Type': 'image/jpeg',
    'Cache-Control': 'public, max-age=86400'
  });
  fs.createReadStream(file).pipe(res);
}

/* ---------------- 静态文件 ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css' : 'text/css; charset=utf-8',
  '.js'  : 'application/javascript; charset=utf-8',
  '.png' : 'image/png',
  '.jpg' : 'image/jpeg',
  '.svg' : 'image/svg+xml',
  '.ico' : 'image/x-icon'
};
function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath);
  if (rel === '/') rel = '/index.html';
  if (rel === '/admin' || rel === '/admin/') rel = '/admin.html';
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found'); return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream'
    });
    fs.createReadStream(file).pipe(res);
  });
}

/* ---------------- 路由 ---------------- */
const server = http.createServer(async (req, res) => {
  const url      = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const pathname = url.pathname;
  const method   = (req.method || 'GET').toUpperCase();

  try {
    if (pathname === '/api/verify/question' && method === 'GET')
      return handleGetVerifyQuestion(req, res);
    if (pathname === '/api/verify/answer' && method === 'POST')
      return await handleVerifyAnswer(req, res);

    if (pathname === '/api/items' && method === 'GET')  return handleListItems(req, res);
    if (pathname === '/api/items' && method === 'POST') return await handleCreateItem(req, res);

    const mItem = /^\/api\/items\/([A-Za-z0-9_]+)$/.exec(pathname);
    if (mItem && method === 'PATCH')  return await handleUpdateItem(req, res, mItem[1]);
    if (mItem && method === 'DELETE') return await handleDeleteItem(req, res, mItem[1]);

    if (pathname === '/api/admin/login' && method === 'POST')
      return await handleAdminLogin(req, res);
    if (pathname === '/api/admin/items' && method === 'GET')
      return handleAdminList(req, res);
    if (pathname === '/api/admin/clean-sold' && method === 'POST')
      return await handleAdminCleanSold(req, res);
    if (pathname === '/api/admin/settings' && method === 'GET')
      return handleAdminGetSettings(req, res);
    if (pathname === '/api/admin/settings' && method === 'POST')
      return await handleAdminSaveSettings(req, res);

    const mAdminItem = /^\/api\/admin\/items\/([A-Za-z0-9_]+)$/.exec(pathname);
    if (mAdminItem && method === 'DELETE')
      return await handleAdminDelete(req, res, mAdminItem[1]);

    const mImg = /^\/api\/images\/([^/]+)$/.exec(pathname);
    if (mImg && method === 'GET') return handleImage(req, res, mImg[1]);

    if (pathname.startsWith('/api/')) return sendJson(res, 404, { error: '接口不存在' });

    if (method === 'GET' || method === 'HEAD') return serveStatic(req, res, pathname);

    res.writeHead(405); res.end('Method Not Allowed');
  } catch (err) {
    console.error('[服务器错误]', err);
    if (!res.headersSent) sendJson(res, 500, { error: '服务器内部错误' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n  ✅ 校园二手集市已启动\n');
  console.log('  前台首页：  http://localhost:' + PORT);
  console.log('  后台管理：  http://localhost:' + PORT + '/admin.html');
  console.log('  管理密码：  ' + ADMIN_PASSWORD +
    (ADMIN_PASSWORD === 'admin123' ? '   ⚠️ 请在代码或环境变量中修改！' : ''));
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        console.log('  局域网访问：http://' + net.address + ':' + PORT);
      }
    }
  }
  console.log('\n  按 Ctrl + C 停止服务\n');
});
