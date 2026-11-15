const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function normalizeTelegramToken(value) {
  let token = String(value || '').trim();
  token = token.replace(/^TELEGRAM_BOT_TOKEN\s*=\s*/i, '').trim();
  token = token.replace(/^['"]|['"]$/g, '').trim();
  const urlMatch = token.match(/api\.telegram\.org\/bot([^\/?#\s]+)(?:\/[^\s]*)?/i);
  if (urlMatch) token = urlMatch[1].trim();
  token = token.replace(/^bot(?=\d+:)/i, '').trim();
  return token.split(/[?#]/, 1)[0].replace(/\/getMe$/i, '').replace(/\/$/, '').trim();
}

process.env.TELEGRAM_BOT_TOKEN = normalizeTelegramToken(
  process.env.TELEGRAM_BOT_TOKEN ||
  process.env.TELEGRAM_TOKEN ||
  process.env.TELEGRAM_API_TOKEN ||
  process.env.BOT_TOKEN ||
  ''
);

const telegram = require('./telegram-bot');
const port = Number(process.env.PORT) || 10000;
const root = __dirname;
// Production webshop domain. Render custom-domain DNS must point aktiv-lyca.de to this service.
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || 'https://webshop-sim-1.onrender.com').replace(/\/$/,'');
const REDIRECT_TO_CANONICAL = String(process.env.REDIRECT_TO_CANONICAL || 'false').toLowerCase() === 'true';
const STATUS_API_TOKEN = String(process.env.STATUS_API_TOKEN || '').trim();
const REQUIRE_WEBHOOK_SECRET = String(process.env.REQUIRE_WEBHOOK_SECRET || 'false').toLowerCase() === 'true';
const rateBuckets = new Map();
const BLOCKED_PUBLIC_FILES = new Set(['/server.js','/telegram-bot.js','/payment_wallets.json','/.env','.env.example','/package.json','/package-lock.json','/Procfile','/requirements.txt']);
function applySecurityHeaders(res) {
  res.setHeader('Strict-Transport-Security','max-age=31536000; includeSubDomains');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Resource-Policy','same-origin');
}
function allowRequest(req) {
  // Telegram retries webhook deliveries from shared IP ranges. Do not rate-limit
  // the signed webhook endpoint; authenticate it with Telegram's secret header instead.
  if (req.method === 'POST' && (req.url || '').split('?')[0] === '/api/telegram-webhook') return true;
  if (req.method === 'GET' && (req.url || '').startsWith('/health')) return true;
  const key = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim() || 'unknown';
  const now = Date.now();
  let bucket = rateBuckets.get(key);
  if (!bucket || now - bucket.startedAt >= 60000) bucket = {startedAt:now,count:0};
  bucket.count += 1; rateBuckets.set(key,bucket);
  if (rateBuckets.size > 5000) for (const [k,v] of rateBuckets) if (now-v.startedAt >= 60000) rateBuckets.delete(k);
  return bucket.count <= 180;
}
function isProtectedEndpoint(req) {
  return String(req.url || '').split('?')[0].startsWith('/api/');
}
const CANONICAL_SHOP_URL = String(process.env.CANONICAL_SHOP_URL || PUBLIC_BASE_URL).replace(/\/$/,'');
const TELEGRAM_BOT_ID = String(process.env.TELEGRAM_BOT_ID || '').trim();
const SUPPORT_USERNAME = telegram.supportUsername;
const SUPPORT_URL = `https://t.me/${SUPPORT_USERNAME}`;
const pageStats = { totalViews:0, sessionViews:0, byDay:new Map() };
function recordPageView() {
  pageStats.totalViews += 1;
  pageStats.sessionViews += 1;
  const day = new Date().toLocaleDateString('en-CA',{timeZone:'Europe/Berlin'});
  pageStats.byDay.set(day, (pageStats.byDay.get(day) || 0) + 1);
}
function getPageStats() {
  const day = new Date().toLocaleDateString('en-CA',{timeZone:'Europe/Berlin'});
  return { totalViews:pageStats.totalViews, sessionViews:pageStats.sessionViews, todayViews:pageStats.byDay.get(day) || 0 };
}
telegram.setStatsProvider(getPageStats);
const BOT_INVITE_URL = () => `https://t.me/${encodeURIComponent(telegram.getUsername ? telegram.getUsername() : telegram.username)}`;
const mimeTypes = {
  '.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8',
  '.json':'application/json; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp',
  '.svg':'image/svg+xml','.ico':'image/x-icon'
};

function safePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const filePath = path.resolve(root, relative);
  return filePath.startsWith(root + path.sep) || filePath === root ? filePath : null;
}
function parseJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 256000) req.destroy(new Error('Payload too large')); });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function parseUrlEncoded(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1000000) req.destroy(new Error('Payload too large')); });
    req.on('end', () => {
      try {
        const params = new URLSearchParams(body || '');
        const data = Object.fromEntries(params.entries());
        if (data.items) data.items = JSON.parse(data.items);
        resolve(data);
      } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function normalizeLycaOrderItems(items) {
  if (!Array.isArray(items) || items.length !== 1) {
    throw new Error('Bitte ausschließlich das Lyca Mobile Triple-SIM Produkt bestellen.');
  }
  const qty = Number(items[0]?.qty);
  if (!Number.isSafeInteger(qty) || qty < 10 || qty > 5000 || qty % 10 !== 0) {
    throw new Error('Die Bestellmenge muss zwischen 10 und 5.000 Stück liegen und in 10er-Schritten angegeben werden.');
  }
  const price = qty >= 500 ? 3.50
    : qty >= 250 ? 3.80
    : qty >= 200 ? 4.00
    : qty >= 100 ? 4.50
    : qty >= 50 ? 5.00
    : 7.00;
  return [{ name: 'Lyca Mobile Triple-SIM', qty, price }];
}

async function createTelegramOrder(data) {
  const customer = data.customer || {
    name: String(data.customer_name || '').trim(),
    email: String(data.customer_email || '').trim(),
    address: String(data.customer_address || '').trim()
  };
  const items = Array.isArray(data.items) ? data.items : [];
  if (!customer.name || !customer.email || !customer.email.includes('@') || !customer.address || !items.length) {
    throw new Error('Bitte Name, E-Mail, Anschrift und Warenkorb angeben.');
  }
  const diagnostics = await telegramDiagnostics();
  if (!diagnostics.authenticated || !diagnostics.bot?.username) {
    const err = new Error('Telegram-Bot ist auf dem Server nicht authentifiziert.');
    err.statusCode = 503;
    throw err;
  }
  const verifiedBotUsername = String(diagnostics.bot.username).replace(/^@/,'').trim();
  const orderNumber = makeOrderNumber();
  const invoiceNumber = makeInvoiceNumber(orderNumber);
  const normalizedItems = normalizeLycaOrderItems(items);
  const total = normalizedItems.reduce((sum,x) => sum + x.price*x.qty,0);
  const order = {
    orderNumber, invoiceNumber,
    createdAt:new Date().toLocaleString('de-DE',{timeZone:'Europe/Berlin'}),
    customer:{
      name:String(customer.name).trim(),
      email:String(customer.email).trim(),
      address:String(customer.address).trim()
    },
    telegramChatId:String(data.telegram_chat_id || '').trim(),
    items:normalizedItems,
    total,
    paymentStatus:'UNBEZAHLT'
  };
  const result = await telegram.sendOrder(order);
  if (!result?.ok || !result.adminRecipients) { const err = new Error(result?.error || 'Bestellung konnte nicht an Lyca_Support zugestellt werden.'); err.statusCode = 503; throw err; }
  const invoiceText = formatInvoice(order);
  const supportUrl = result.supportUrl || `${SUPPORT_URL}?text=${encodeURIComponent(invoiceText)}`;
  const verifiedBotUrl = `https://t.me/${verifiedBotUsername}?start=${encodeURIComponent(orderNumber)}`;
  return {order, result, invoiceText, supportUrl, verifiedBotUrl};
}

async function telegramCheckoutRedirect(req,res) {
  try {
    const data = await parseUrlEncoded(req);
    const created = await createTelegramOrder(data);
    const target = created.verifiedBotUrl;
    const safeTarget = String(target).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    const html = '<!doctype html><html lang="de"><head>' +
      '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<meta name="robots" content="noindex,nofollow">' +
      '<title>Weiter zu Telegram</title>' +
      '<style>body{margin:0;background:#0b0f14;color:#fff;font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:grid;place-items:center;min-height:100vh;padding:24px;box-sizing:border-box}.card{width:min(520px,100%);background:#151b22;border:1px solid #2b3440;border-radius:24px;padding:28px;box-sizing:border-box;text-align:center;box-shadow:0 18px 50px rgba(0,0,0,.35)}h1{font-size:25px;margin:0 0 10px}p{color:#b8c1cc;line-height:1.5}.btn{display:block;width:100%;box-sizing:border-box;margin-top:18px;padding:16px;border-radius:14px;background:#229ed9;color:#fff;text-decoration:none;font-weight:700;font-size:17px}.small{font-size:13px;color:#7f8a96;margin-top:14px}</style>' +
      '<script>window.addEventListener("load",function(){setTimeout(function(){try{window.location.href=' + JSON.stringify(target) + '}catch(e){}},150)});</script>' +
      '</head><body><main class="card"><h1>Bestellung erstellt ✅</h1><p>Deine Bestellung wurde gespeichert. Telegram wird jetzt geöffnet.</p>' +
      '<a class="btn" href="' + safeTarget + '">🤖 Telegram öffnen</a>' +
      '<div class="small">Falls Telegram nicht automatisch startet, tippe auf den Button.</div></main></body></html>';
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    res.end(html);
  } catch (err) {
    console.error('Lyca checkout redirect error:',err);
    const status = Number(err.statusCode) || 400;
    const message = String(err.message || 'Bestellung konnte nicht verarbeitet werden.')
      .replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
    const html = '<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Bestellung nicht abgeschlossen</title><style>body{margin:0;background:#080d14;color:#f5f7fb;font-family:system-ui;display:grid;place-items:center;min-height:100vh;padding:22px;box-sizing:border-box}.card{width:min(520px,100%);padding:28px;border:1px solid #344253;border-radius:20px;background:#111a24;box-sizing:border-box}p{color:#c4ceda;line-height:1.55}a{display:inline-block;margin-top:14px;padding:12px 18px;border-radius:12px;background:#77e6d0;color:#06110f;text-decoration:none;font-weight:700}</style></head><body><main class="card"><h1>Bestellung nicht abgeschlossen</h1><p>' + message + '</p><p>Es wurde keine Bestellung als erfolgreich bestätigt.</p><a href="/">Zurück zum Lyca-Shop</a></main></body></html>';
    res.writeHead(status, {'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
    res.end(html);
  }
}
function sendJson(res, status, payload) {
  const data = JSON.stringify(payload);
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
  res.end(data);
}
function makeOrderNumber() {
  const d = new Date();
  const stamp = d.toISOString().slice(0,10).replace(/-/g,'');
  const rnd = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `LYCA-${stamp}-${rnd}`;
}
function makeInvoiceNumber(orderNumber) { return orderNumber.replace(/^LYCA-/, 'LYCA-RE-'); }
function formatInvoice(order) { return telegram.invoiceText(order); }

async function telegramApi(method, body = {}) {
  const token = normalizeTelegramToken(process.env.TELEGRAM_BOT_TOKEN);
  if (!token) return { ok:false, description:'TELEGRAM_BOT_TOKEN fehlt' };
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body)
    });
    return await r.json();
  } catch (err) {
    return { ok:false, description:err.message || 'Telegram API request failed' };
  }
}

const BOT_DESCRIPTION = 'Mit bereits aktivierten Lyca Mobile Prepaid-SIM-Karten bist du sofort startklar. 📱 Triple-SIM (Standard, Micro, Nano), deutsche Rufnummer, flexible Tarifwahl und Guthabenaufladung. Bestellung, Warenkorb und Rechnung direkt über Telegram. Support: @' + SUPPORT_USERNAME;
const BOT_SHORT_DESCRIPTION = 'Lyca Webshop 🛍️ Triple-SIM · Bestellung · Rechnung';
const BOT_COMMANDS = [
  { command:'start', description:'Lyca Webshop starten' },
  { command:'products', description:'Produkte und Preise anzeigen' },
  { command:'cart', description:'Warenkorb anzeigen' },
  { command:'orders', description:'Bestellungen anzeigen' },
  { command:'shop', description:'Webshop öffnen' },
  { command:'order', description:'Bestellung mit Nummer anzeigen' },
  { command:'invoice', description:'Rechnung anzeigen' },
  { command:'wallets', description:'Zahlungs-Wallets und QR-Codes' },
  { command:'support', description:'Support kontaktieren' },
  { command:'myid', description:'Telegram Chat-ID anzeigen' },
  { command:'admin', description:'Lyca Support Admin-Panel' },
  { command:'cancel', description:'Vorgang abbrechen' }
];

async function configureTelegramProfile() {
  if (!normalizeTelegramToken(process.env.TELEGRAM_BOT_TOKEN)) return { ok:false, description:'Token fehlt' };
  return {
    description: await telegramApi('setMyDescription', {description:BOT_DESCRIPTION}),
    shortDescription: await telegramApi('setMyShortDescription', {short_description:BOT_SHORT_DESCRIPTION}),
    commands: await telegramApi('setMyCommands', {commands:BOT_COMMANDS})
  };
}

async function telegramDiagnostics() {
  const tokenConfigured = Boolean(normalizeTelegramToken(process.env.TELEGRAM_BOT_TOKEN));
  if (!tokenConfigured) return {ok:false,tokenConfigured:false,authenticated:false,reason:'TELEGRAM_BOT_TOKEN fehlt'};
  const me = await telegramApi('getMe');
  const webhook = await telegramApi('getWebhookInfo');
  return {
    ok:Boolean(me.ok),
    tokenConfigured:true,
    authenticated:Boolean(me.ok),
    can_connect_to_business:Boolean(me.ok && me.result?.can_connect_to_business),
    bot:me.ok && me.result ? {
      id:me.result.id, username:me.result.username, firstName:me.result.first_name,
      isBot:me.result.is_bot, canConnectToBusiness:Boolean(me.result.can_connect_to_business),
      hasMainWebApp:Boolean(me.result.has_main_web_app)
    } : null,
    expected_bot_username:telegram.getUsername ? telegram.getUsername() : telegram.username,
    expected_bot_id:TELEGRAM_BOT_ID || null,
    bot_id_matches_expected:Boolean(me.ok && TELEGRAM_BOT_ID && String(me.result?.id) === TELEGRAM_BOT_ID),
    telegramError:me.ok ? null : (me.description || 'Unauthorized'),
    webhook:webhook.ok ? {
      url:webhook.result.url || '',
      pendingUpdateCount:webhook.result.pending_update_count || 0,
      lastErrorMessage:webhook.result.last_error_message || null
    } : null,
    webhookError:webhook.ok ? null : (webhook.description || 'Webhook status unavailable')
  };
}

async function telegramOrder(req,res) {
  try {
    const data = await parseJson(req);
    const customer = data.customer || {};
    const items = Array.isArray(data.items) ? data.items : [];
    if (!customer.name || !customer.email || !customer.email.includes('@') || !customer.address || !items.length) {
      return sendJson(res,400,{error:'Bitte Name, E-Mail, Anschrift und Warenkorb angeben.'});
    }
    // Never create a checkout link from a stale/fallback bot username.
    // Telegram's getMe() is the source of truth for the bot that owns the token.
    const diagnostics = await telegramDiagnostics();
    if (!diagnostics.authenticated || !diagnostics.bot?.username) {
      return sendJson(res,503,{
        error:'Telegram-Bot ist auf dem Server nicht authentifiziert. Die Bestellung wurde nicht an einen falschen Bot-Link weitergeleitet.',
        telegram_error:diagnostics.telegramError || 'Telegram getMe() fehlgeschlagen'
      });
    }
    const verifiedBotUsername = String(diagnostics.bot.username).replace(/^@/,'').trim();
    const orderNumber = makeOrderNumber();
    const invoiceNumber = makeInvoiceNumber(orderNumber);
    const normalizedItems = normalizeLycaOrderItems(items);
    const total = normalizedItems.reduce((sum,x) => sum + x.price*x.qty,0);
    const order = {
      orderNumber, invoiceNumber,
      createdAt:new Date().toLocaleString('de-DE',{timeZone:'Europe/Berlin'}),
      customer:{
        name:String(customer.name).trim(),
        email:String(customer.email).trim(),
        address:String(customer.address).trim()
      },
      telegramChatId:String(data.telegram_chat_id || '').trim(),
      items:normalizedItems,
      total,
      paymentStatus:'UNBEZAHLT'
    };
    const result = await telegram.sendOrder(order);
    if (!result?.ok || !result.adminRecipients) { const err = new Error(result?.error || 'Bestellung konnte nicht an Lyca_Support zugestellt werden.'); err.statusCode = 503; throw err; }
    const invoiceText = formatInvoice(order);
    const supportUrl = result.supportUrl || `${SUPPORT_URL}?text=${encodeURIComponent(invoiceText)}`;
    // Always build the customer handoff from the username verified by getMe().
    const verifiedBotUrl = `https://t.me/${verifiedBotUsername}?start=${encodeURIComponent(orderNumber)}`;
    return sendJson(res,201,{
      ok:true,
      order_number:orderNumber,
      invoice_number:invoiceNumber,
      payment_status:order.paymentStatus,
      bot_username:telegram.getUsername ? telegram.getUsername() : telegram.username,
      bot_mode:telegram.tokenConfigured ? 'telegram-api' : 'token-missing',
      admin_recipients:result.adminRecipients,
      bot_message:result.message,
      invoice:invoiceText,
      invoice_url:verifiedBotUrl,
      support_username:SUPPORT_USERNAME,
      support_url:supportUrl,
      telegram_url:verifiedBotUrl,
      shop_url:PUBLIC_BASE_URL
    });
  } catch (err) {
    console.error('Lyca order error:',err);
    return sendJson(res,Number(err.statusCode)||500,{error:err.message || 'Bestellung konnte nicht verarbeitet werden.'});
  }
}

async function telegramWebhook(req,res) {
  const supplied = String(req.headers['x-telegram-bot-api-secret-token'] || '');
  if (!telegram.webhookSecret || supplied !== telegram.webhookSecret) {
    console.warn('Lyca Telegram webhook rejected: secret missing or mismatched');
    return sendJson(res,403,{ok:false,error:'Ungültiges Telegram-Webhook-Secret.'});
  }
  try {
    const update = await parseJson(req);
    if (!update || typeof update.update_id !== 'number') return sendJson(res,400,{ok:false,error:'Ungültiges Telegram-Update.'});
    const updateType = update.message ? 'message' : update.callback_query ? 'callback_query' : update.business_message ? 'business_message' : update.business_connection ? 'business_connection' : 'other';
    console.log('Lyca Telegram webhook received:', update.update_id, updateType);
    // Acknowledge Telegram immediately after the signed payload is parsed. Bot
    // replies run asynchronously so a slow Telegram API call cannot cause retries.
    sendJson(res,200,{ok:true});
    Promise.resolve().then(() => telegram.handleUpdate(update)).catch(err => {
      console.error('Lyca Telegram webhook handler failed:', update.update_id, err.message || err);
    });
  } catch (err) {
    console.error('Lyca Telegram webhook parse failed:',err.message || err);
    return sendJson(res,400,{ok:false,error:'Telegram-Update konnte nicht verarbeitet werden.'});
  }
}

async function telegramStatus(req,res) {
  const d = await telegramDiagnostics();
  return sendJson(res,200,{
    ok:true,
    telegram_enabled:d.authenticated,
    bot_enabled:true,
    bot_username:telegram.getUsername ? telegram.getUsername() : telegram.username,
    bot_mode:d.authenticated?'telegram-api':'token-invalid-or-missing',
    token_configured:d.tokenConfigured,
    authenticated:d.authenticated,
    bot:d.bot,
    telegram_error:d.telegramError,
    mode:telegram.webhookSecret?'webhook':'long-polling',
    invite_url:BOT_INVITE_URL(),
    shop_url:PUBLIC_BASE_URL,
    support_username:SUPPORT_USERNAME,
    support_url:SUPPORT_URL,
    invitation:`👋 Willkommen im Lyca Webshop!\n\n🛍️ Lyca Mobile Triple-SIM online bestellen.\n📦 Produkte · Warenkorb · Bestellung · Rechnung\n\n🔗 ${BOT_INVITE_URL()}`
  });
}

async function telegramInvite(req,res) {
  const d = await telegramDiagnostics();
  return sendJson(res,d.authenticated?200:503,{
    ok:d.authenticated,
    bot_username:telegram.getUsername ? telegram.getUsername() : telegram.username,
    invite_url:BOT_INVITE_URL(),
    authenticated:d.authenticated,
    description:BOT_DESCRIPTION,
    short_description:BOT_SHORT_DESCRIPTION,
    message:`👋 LYCA WEBSHOP\n\nWillkommen! 🛍️\nBestelle deine Lyca Mobile Triple-SIM direkt über Telegram.\n\n📱 Standard · Micro · Nano\n📦 Mengenpreise im Shop\n🧾 Bestellung & Rechnung\n❓ Support: @${SUPPORT_USERNAME}\n\n👉 Bot öffnen: ${BOT_INVITE_URL()}`
  });
}

async function setupTelegram() {
  try {
    const result = await telegram.configure(PUBLIC_BASE_URL);
    console.log('Telegram setup:',result);
    if (result?.enabled) console.log('Telegram profile setup:',await configureTelegramProfile());
    const diagnostics = await telegramDiagnostics();
    console.log('Telegram diagnostics:',{
      authenticated:diagnostics.authenticated,
      canConnectToBusiness:diagnostics.can_connect_to_business,
      botUsername:diagnostics.bot?.username || (telegram.getUsername ? telegram.getUsername() : telegram.username),
      mode:telegram.webhookSecret?'webhook':'long-polling',
      webhook:diagnostics.webhook,
      webhookError:diagnostics.webhookError
    });
  } catch (err) {
    console.error('Telegram setup failed:',err.message || err);
  }
}

const server = http.createServer(async (req,res) => {
  applySecurityHeaders(res);
  if (!allowRequest(req)) return sendJson(res,429,{ok:false,error:'Zu viele Anfragen. Bitte später erneut versuchen.'});
  const route = (req.url || '').split('?')[0];
  if (REDIRECT_TO_CANONICAL) {
    if (req.method === 'GET' && !route.startsWith('/api/')) {
      const target = CANONICAL_SHOP_URL + (req.url || '/');
      res.writeHead(308, {'Location': target, 'Cache-Control':'no-store'});
      return res.end();
    }
    if (req.method === 'POST' && (route === '/telegram-checkout-redirect' || route === '/api/telegram-order')) {
      const target = CANONICAL_SHOP_URL + route + ((req.url || '').includes('?') ? '?' + (req.url || '').split('?').slice(1).join('?') : '');
      res.writeHead(307, {'Location': target, 'Cache-Control':'no-store'});
      return res.end();
    }
  }
  // Lightweight public health endpoint for Render and browser diagnostics.\n  if (req.method === 'GET' && route === '/health') {\n    return sendJson(res,200,{ok:true,service:'Aktiv-Lyca',timestamp:new Date().toISOString()});\n  }\n  if (req.method === 'GET' && route === '/api/telegram-status') { if (STATUS_API_TOKEN && req.headers['x-status-token'] !== STATUS_API_TOKEN) return sendJson(res,404,{ok:false}); return telegramStatus(req,res); }
  if (BLOCKED_PUBLIC_FILES.has(route) || route.startsWith('/.env')) return sendJson(res,404,{ok:false,error:'Not Found'});
  if (req.method === 'GET' && route === '/api/telegram-cart') {
    const params = new URL(req.url || '/', 'http://localhost').searchParams;
    const chatId = String(params.get('chat_id') || '').trim();
    if (!chatId) return sendJson(res,400,{ok:false,error:'chat_id fehlt'});
    const cart = typeof telegram.getCartCheckout === 'function' ? telegram.getCartCheckout(chatId) : {items:[],total:0};
    return sendJson(res,200,{ok:true,cart});
  }
  if (req.method === 'GET' && route === '/telegram-checkout') {
    return sendFile(path.join(root,'telegram-checkout.html'),res);
  }
  if (req.method === 'GET' && route === '/api/telegram-invite') return telegramInvite(req,res);
  if (req.method === 'GET' && route === '/api/telegram-business-status') {
    const diagnostics = await telegramDiagnostics();
    const ready = Boolean(diagnostics.can_connect_to_business);
    return sendJson(res,200,{
      ok:true,
      bot_username:telegram.getUsername ? telegram.getUsername() : telegram.username,
      business_ready:ready,
      can_connect_to_business:ready,
      authenticated:diagnostics.authenticated,
      telegram_error:diagnostics.telegramError,
      webhook:diagnostics.webhook,
      connections:telegram.getBusinessStatus().connections,
      next_step:!diagnostics.authenticated
        ? 'Render sieht den Bot-Token nicht als gültig. In Render die TELEGRAM_BOT_TOKEN-Variable des Dienstes prüfen.'
        : !ready
          ? 'Telegram meldet can_connect_to_business=false. Secretary Mode in @BotFather muss für diesen Bot aktiv sein; danach Telegram neu öffnen und erneut prüfen.'
          : 'Der Bot ist Business-fähig. Jetzt @Lyca_Support öffnen und den Bot verbinden.'
    });
  }
  if (req.method === 'GET' && route === '/telegram-business-check') {
    const diagnostics = await telegramDiagnostics();
    const ready = Boolean(diagnostics.can_connect_to_business);
    const status = !diagnostics.authenticated ? 'TOKEN / AUTH FEHLER' : ready ? 'SECRETARY MODE BEREIT' : 'SECRETARY MODE NOCH NICHT FREIGESCHALTET';
    const detail = !diagnostics.authenticated
      ? 'Der Server kann den Bot aktuell nicht bei Telegram authentifizieren.'
      : ready
        ? 'Telegram bestätigt can_connect_to_business=true.'
        : 'Telegram bestätigt can_connect_to_business=false. Das ist eine Telegram-Bot-Konfiguration, nicht ein Webhook- oder JavaScript-Problem.';
    const html = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>Lyca Telegram Business Check</title><style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#111;color:#fff;max-width:720px;margin:40px auto;padding:20px}.card{padding:24px;border:1px solid #333;border-radius:18px;background:#1b1b1b}.ok{color:#7ee787}.bad{color:#ff7b72}.muted{color:#aaa}code{background:#222;padding:3px 6px;border-radius:6px}</style>' +
      '<div class="card"><h1>Lyca Telegram Business</h1><h2 class="' + (ready ? 'ok' : 'bad') + '">' + status + '</h2><p>' + detail + '</p><p>Bot: <code>@' + String(telegram.username).replace(/</g,'&lt;') + '</code></p><p>Authentifiziert: <b>' + String(diagnostics.authenticated) + '</b><br>can_connect_to_business: <b>' + String(ready) + '</b></p></div>';
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
    return res.end(html);
  }
  // Browser fallback: opening the webhook URL directly should show the same webshop UI as the main page.\n  // Telegram itself continues to use POST /api/telegram-webhook for webhook updates.\n  if (req.method === 'GET' && route === '/api/telegram-webhook') {\n    recordPageView();\n    return sendFile(path.join(root,'index.html'),res);\n  }\n  if (req.method === 'POST' && route === '/api/telegram-webhook') return telegramWebhook(req,res);
  if (req.method === 'POST' && route === '/api/telegram-order') return telegramOrder(req,res);
  if (req.method === 'POST' && route === '/telegram-checkout-redirect') return telegramCheckoutRedirect(req,res);

  // Count homepage visits for the Lyca Support admin panel.
  if (req.method === 'GET' && (route === '/' || route === '/index.html')) { recordPageView(); return sendFile(path.join(root,'index.html'),res); }
  let filePath;
  try { filePath = safePath(req.url || '/'); } catch { res.writeHead(400); return res.end('Bad Request'); }
  if (!filePath) { res.writeHead(403); return res.end('Forbidden'); }
  fs.stat(filePath,(statErr,stat)=>{
    if (!statErr && stat.isFile()) return sendFile(filePath,res);
    sendFile(path.join(root,'index.html'),res);
  });
});

function sendFile(filePath,res) {
  fs.readFile(filePath,(err,data)=>{
    if (err) {
      res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'});
      return res.end('Not Found');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200,{
      'Content-Type':mimeTypes[ext] || 'application/octet-stream',
      'Cache-Control':ext === '.html' ? 'no-cache' : 'public, max-age=3600'
    });
    res.end(data);
  });
}

server.listen(port,'0.0.0.0',()=>{ console.log(`Lyca Webshop server listening on port ${port}`); console.log('Lyca Webshop root:',root,'index exists:',fs.existsSync(path.join(root,'index.html')),'public URL:',PUBLIC_BASE_URL); setupTelegram(); });
