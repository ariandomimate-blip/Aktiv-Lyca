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
    req.on('data', chunk => { body += chunk; if (body.length > 1000000) req.destroy(new Error('Payload too large')); });
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
  const requestedOrderNumber = String(data.order_number || '').trim();
  const orderNumber = /^LYCA-\d{8}-[A-F0-9]{6}$/i.test(requestedOrderNumber)
    ? requestedOrderNumber.toUpperCase()
    : makeOrderNumber();
  const invoiceNumber = makeInvoiceNumber(orderNumber);
  const normalizedItems = items.map(x => ({
    name:String(x.name || 'Lyca Mobile Triple-SIM'),
    qty:Math.max(1,Number(x.qty)||1),
    price:Math.max(0,Number(x.price)||0)
  }));
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
  const invoiceText = formatInvoice(order);
  const supportUrl = result.supportUrl || ``${SUPPORT_URL}?text=${encodeURIComponent(invoiceText)}`;
  const verifiedBotUrl = `https://t.me/${verifiedBotUsername}?start=${encodeURIComponent(orderNumber)}`;
  return {order, result, invoiceText, supportUrl, verifiedBotUrl};
}

async function telegramCheckoutRedirect(req,res) {
  try {
    const data = await parseUrlEncoded(req);
    const created = await createTelegramOrder(data);
    res.writeHead(303, {
      Location: created.verifiedBotUrl,
      'Cache-Control': 'no-store'
    });
    res.end();
  } catch (err) {
    console.error('Lyca checkout redirect error:',err);
    sendJson(res, Number(err.statusCode)||400, {ok:false,error:err.message||'Bestellung konnte nicht verarbeitet werden.'});
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

const BOT_DESCRIPTION = 'Willkommen im Lyca Webshop! 🛍️ Lyca Mobile Triple-SIM bequem online bestellen. Warenkorb, Bestellung und Rechnung direkt über Telegram. Support: @' + SUPPORT_USERNAME;
const BOT_SHORT_DESCRIPTION = 'Lyca Webshop 🛍️ Triple-SIM · Bestellung · Rechnung';
const BOT_COMMANDS = [
  { command:'start', description:'Lyca Webshop starten' },
  { command:'products', description:'Produkte und Preise anzeigen' },
  { command:'cart', description:'Warenkorb anzeigen' },
  { command:'orders', description:'Bestellungen anzeigen' },
  { command:'shop', description:'Webshop öffnen' },
  { command:'support', description:'Support kontaktieren' },
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
    const requestedOrderNumber = String(data.order_number || '').trim();
    const orderNumber = /^LYCA-\d{8}-[A-F0-9]{6}$/i.test(requestedOrderNumber)
      ? requestedOrderNumber.toUpperCase()
      : makeOrderNumber();
    const invoiceNumber = makeInvoiceNumber(orderNumber);
    const normalizedItems = items.map(x => ({
      name:String(x.name || 'Lyca Mobile Triple-SIM'),
      qty:Math.max(1,Number(x.qty)||1),
      price:Math.max(0,Number(x.price)||0)
    }));
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
    return sendJson(res,500,{error:err.message || 'Bestellung konnte nicht verarbeitet werden.'});
  }
}

async function telegramWebhook(req,res) {
  if (telegram.webhookSecret && req.headers['x-telegram-bot-api-secret-token'] !== telegram.webhookSecret) return sendJson(res,403,{ok:false,error:'Forbidden'});
  try {
    const update = await parseJson(req);
    await telegram.handleUpdate(update);
    return sendJson(res,200,{ok:true});
  } catch (err) {
    console.error('Telegram webhook error:',err);
    return sendJson(res,500,{ok:false,error:'Webhook processing failed'});
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
    webhook:d.webhook,
    webhook_url:`${PUBLIC_BASE_URL}/api/telegram-webhook`,
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
      webhookUrl:diagnostics.webhook?.url || ''
    });
  } catch (err) {
    console.error('Telegram setup failed:',err.message || err);
  }
}

const server = http.createServer(async (req,res) => {
  const route = (req.url || '').split('?')[0];
  if (req.method === 'GET' && route === '/api/telegram-status') return telegramStatus(req,res);
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
  if (req.method === 'POST' && route === '/api/telegram-webhook') return telegramWebhook(req,res);
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
