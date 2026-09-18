const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Normalize the Telegram token before telegram-bot.js is loaded.
// This protects against accidental whitespace, quotes, or a copied KEY=value wrapper.
function normalizeTelegramToken(value) {
  let token = String(value || '').trim();
  token = token.replace(/^TELEGRAM_BOT_TOKEN\s*=\s*/i, '').trim();
  token = token.replace(/^['"]|['"]$/g, '').trim();

  // Accept common accidental copy/paste forms from BotFather/browser:
  // raw token, "bot<token>", or the full Bot API URL.
  const urlMatch = token.match(/api\.telegram\.org\/bot([^/?#\s]+)(?:\/[^\s]*)?/i);
  if (urlMatch) token = urlMatch[1].trim();
  token = token.replace(/^bot(?=\d+:)/i, '').trim();
  token = token.split(/[?#]/, 1)[0].replace(/\/getMe$/i, '').replace(/\/$/, '').trim();

  return token;
}
process.env.TELEGRAM_BOT_TOKEN = normalizeTelegramToken(process.env.TELEGRAM_BOT_TOKEN);

const telegram = require('./telegram-bot');

const port = Number(process.env.PORT) || 10000;
const root = __dirname;
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || 'https://webshop-sim-1.onrender.com').replace(/\/$/, '');
const TELEGRAM_BOT_ID = String(process.env.TELEGRAM_BOT_ID || '').trim();
const SUPPORT_USERNAME = telegram.supportUsername;
const SUPPORT_URL = `https://t.me/${SUPPORT_USERNAME}`;
const BOT_INVITE_URL = `https://t.me/${telegram.username}`;
const mimeTypes = { '.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml','.ico':'image/x-icon' };

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
function sendJson(res, status, payload) {
  const data = JSON.stringify(payload);
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
  res.end(data);
}
function makeOrderNumber() { const d = new Date(); const stamp = d.toISOString().slice(0,10).replace(/-/g,''); const rnd = crypto.randomBytes(3).toString('hex').toUpperCase(); return `LYCA-${stamp}-${rnd}`; }
function makeInvoiceNumber(orderNumber) { return orderNumber.replace(/^LYCA-/, 'LYCA-RE-'); }
function formatInvoice(order) { return telegram.invoiceText(order); }

async function telegramApi(method, body = {}) {
  const token = normalizeTelegramToken(process.env.TELEGRAM_BOT_TOKEN);
  if (!token) return { ok:false, description:'TELEGRAM_BOT_TOKEN fehlt' };
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body) });
    return await r.json();
  } catch (err) {
    return { ok:false, description:err.message || 'Telegram API request failed' };
  }
}

const openaiApiKey = String(process.env.OPENAI_API_KEY || '').trim();
const openaiModel = String(process.env.OPENAI_MODEL || 'gpt-5.6-luna').trim();
const webAiSessions = new Map();

async function webAiReply(sessionId, userText) {
  if (!openaiApiKey) return { ok:false, error:'KI ist derzeit nicht konfiguriert.' };
  const id = String(sessionId || 'web').slice(0,120);
  if (!webAiSessions.has(id)) webAiSessions.set(id, []);
  const history = webAiSessions.get(id);
  history.push({ role:'user', content:String(userText || '').slice(0,8000) });
  const input = history.slice(-12);
  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method:'POST',
      headers:{'content-type':'application/json','authorization':`Bearer ${openaiApiKey}`},
      body:JSON.stringify({
        model:openaiModel,
        instructions:'Du bist der KI-Assistent des Lyca Webshops. Antworte auf Deutsch, freundlich und präzise. Hilf bei Produkten, Bestellung, Rechnung, Warenkorb und allgemeinem Support. Erfinde keine Bestell-, Zahlungs- oder Kontodaten. Für konkrete Bestellungen benötigst du die Bestellnummer. Verweise bei menschlichem Support auf @Lyca_Support.',
        input,
        max_output_tokens:700
      })
    });
    const data=await response.json();
    if (!response.ok) {
      console.error('Web AI error:', data?.error?.message || `HTTP ${response.status}`);
      return {ok:false,error:'Der KI-Assistent ist momentan nicht erreichbar.'};
    }
    const answer=String(data.output_text || '').trim();
    if (!answer) return {ok:false,error:'Keine KI-Antwort erhalten.'};
    history.push({role:'assistant',content:answer});
    if (history.length>20) history.splice(0,history.length-20);
    return {ok:true,answer};
  } catch(err) {
    console.error('Web AI request failed:',err.message || err);
    return {ok:false,error:'Der KI-Assistent ist momentan nicht erreichbar.'};
  }
}

const BOT_DESCRIPTION = 'Willkommen im Lyca Webshop! 🛍️ Lyca Mobile Triple-SIM bequem online bestellen. Warenkorb, Bestellung und Rechnung direkt über Telegram. Zahlungsarten: Bitcoin (BTC), Solana (SOL) und BNB – je nach freigeschalteter Zahlungsoption. Support: @' + SUPPORT_USERNAME;
const BOT_SHORT_DESCRIPTION = 'Lyca Webshop 🛍️ Triple-SIM · Bestellung · Rechnung · BTC · SOL · BNB';
const BOT_COMMANDS = [
  { command:'start', description:'Lyca Webshop starten' },
  { command:'products', description:'Produkte und Preise anzeigen' },
  { command:'cart', description:'Warenkorb anzeigen' },
  { command:'orders', description:'Bestellungen anzeigen' },
  { command:'shop', description:'Webshop öffnen' },
  { command:'support', description:'Support kontaktieren' },
  { command:'payment', description:'Zahlungsarten anzeigen' },
  { command:'cancel', description:'Vorgang abbrechen' },
  { command:'ai', description:'KI-Assistent fragen' }
];

async function configureTelegramProfile() {
  if (!normalizeTelegramToken(process.env.TELEGRAM_BOT_TOKEN)) return { ok:false, description:'Token fehlt' };
  const results = {};
  results.description = await telegramApi('setMyDescription', { description:BOT_DESCRIPTION });
  results.shortDescription = await telegramApi('setMyShortDescription', { short_description:BOT_SHORT_DESCRIPTION });
  results.commands = await telegramApi('setMyCommands', { commands:BOT_COMMANDS });
  return results;
}

async function telegramDiagnostics() {
  const tokenConfigured = Boolean(normalizeTelegramToken(process.env.TELEGRAM_BOT_TOKEN));
  if (!tokenConfigured) return { ok:false, tokenConfigured:false, authenticated:false, reason:'TELEGRAM_BOT_TOKEN fehlt' };
  const me = await telegramApi('getMe');
  const webhook = await telegramApi('getWebhookInfo');
  return {
    ok: Boolean(me.ok),
    tokenConfigured:true,
    authenticated:Boolean(me.ok),
    can_connect_to_business: Boolean(me.ok && me.result?.can_connect_to_business),
    bot: me.ok && me.result ? { id:me.result.id, username:me.result.username, firstName:me.result.first_name, isBot:me.result.is_bot, canConnectToBusiness:Boolean(me.result.can_connect_to_business), hasMainWebApp:Boolean(me.result.has_main_web_app) } : null,
    expected_bot_username: telegram.username,
    expected_bot_id: TELEGRAM_BOT_ID || null,
    bot_id_matches_expected: Boolean(me.ok && TELEGRAM_BOT_ID && String(me.result?.id) === TELEGRAM_BOT_ID),
    telegramError: me.ok ? null : (me.description || 'Unauthorized'),
    webhook: webhook.ok ? {
      url:webhook.result.url || '',
      pendingUpdateCount:webhook.result.pending_update_count || 0,
      lastErrorMessage:webhook.result.last_error_message || null
    } : null,
    webhookError: webhook.ok ? null : (webhook.description || 'Webhook status unavailable')
  };
}

async function telegramOrder(req, res) {
  try {
    const data = await parseJson(req);
    const customer = data.customer || {};
    const items = Array.isArray(data.items) ? data.items : [];
    if (!customer.name || !customer.email || !customer.email.includes('@') || !customer.address || !items.length) return sendJson(res, 400, {error:'Bitte Name, E-Mail, Anschrift und Warenkorb angeben.'});
    const orderNumber = makeOrderNumber();
    const invoiceNumber = makeInvoiceNumber(orderNumber);
    const normalizedItems = items.map(x => ({ name:String(x.name || 'Lyca Mobile Triple-SIM'), qty:Math.max(1, Number(x.qty)||1), price:Math.max(0, Number(x.price)||0) }));
    const total = normalizedItems.reduce((sum,x) => sum + x.price*x.qty, 0);
    const order = {
      orderNumber, invoiceNumber,
      createdAt:new Date().toLocaleString('de-DE',{timeZone:'Europe/Berlin'}),
      customer:{name:String(customer.name).trim(), email:String(customer.email).trim(), address:String(customer.address).trim()},
      telegramChatId:String(data.telegram_chat_id || '').trim(),
      items:normalizedItems, total, paymentStatus:'UNBEZAHLT'
    };
    const result = await telegram.sendOrder(order);
    const invoiceText = formatInvoice(order);
    const supportUrl = result.supportUrl || `${SUPPORT_URL}?text=${encodeURIComponent(invoiceText)}`;
    sendJson(res, 201, {
      ok:true,
      order_number:orderNumber,
      invoice_number:invoiceNumber,
      payment_status:order.paymentStatus,
      bot_username:telegram.username,
      bot_mode:telegram.tokenConfigured ? 'telegram-api' : 'token-missing',
      admin_recipients:result.adminRecipients,
      bot_message:result.message,
      invoice:invoiceText,
      invoice_url:result.invoiceUrl || telegram.botOrderUrl(orderNumber),
      support_username:SUPPORT_USERNAME,
      support_url:supportUrl,
      telegram_url:result.invoiceUrl || telegram.botOrderUrl(orderNumber),
      shop_url:PUBLIC_BASE_URL
    });
  } catch (err) {
    console.error('Lyca order error:', err);
    sendJson(res, 500, {error:err.message || 'Bestellung konnte nicht verarbeitet werden.'});
  }
}

async function telegramWebhook(req, res) {
  if (telegram.webhookSecret && req.headers['x-telegram-bot-api-secret-token'] !== telegram.webhookSecret) return sendJson(res, 403, {ok:false,error:'Forbidden'});
  try { const update = await parseJson(req); await telegram.handleUpdate(update); sendJson(res, 200, {ok:true}); }
  catch (err) { console.error('Telegram webhook error:', err); sendJson(res, 500, {ok:false,error:'Webhook processing failed'}); }
}

async function telegramStatus(req,res) {
  const diagnostics = await telegramDiagnostics();
  sendJson(res,200,{
    ok:true,
    telegram_enabled:diagnostics.authenticated,
    bot_enabled:true,
    bot_username:telegram.username,
    bot_mode:diagnostics.authenticated?'telegram-api':'token-invalid-or-missing',
    token_configured:diagnostics.tokenConfigured,
    authenticated:diagnostics.authenticated,
    bot:diagnostics.bot,
    telegram_error:diagnostics.telegramError,
    webhook:diagnostics.webhook,
    webhook_url:`${PUBLIC_BASE_URL}/api/telegram-webhook`,
    invite_url:BOT_INVITE_URL,
    shop_url:PUBLIC_BASE_URL,
    support_username:SUPPORT_USERNAME,
    support_url:SUPPORT_URL,
    payment_modes:['Bitcoin (BTC)','Solana (SOL)','BNB'],
    invitation:`👋 Willkommen im Lyca Webshop!\n\n🛍️ Lyca Mobile Triple-SIM online bestellen.\n📦 Produkte · Warenkorb · Bestellung · Rechnung\n💳 Zahlungsarten: Bitcoin (BTC), Solana (SOL) und BNB.\n\n🔗 ${BOT_INVITE_URL}`
  });
}

async function telegramInvite(req,res) {
  const diagnostics = await telegramDiagnostics();
  sendJson(res, diagnostics.authenticated ? 200 : 503, {
    ok:diagnostics.authenticated,
    bot_username:telegram.username,
    invite_url:BOT_INVITE_URL,
    authenticated:diagnostics.authenticated,
    description:BOT_DESCRIPTION,
    short_description:BOT_SHORT_DESCRIPTION,
    payment_modes:['Bitcoin (BTC)','Solana (SOL)','BNB'],
    message:`👋 LYCA WEBSHOP\n\nWillkommen! 🛍️\nBestelle deine Lyca Mobile Triple-SIM direkt über Telegram.\n\n📱 Standard · Micro · Nano\n📦 Mengenpreise im Shop\n🧾 Bestellung & Rechnung\n💳 Zahlung: Bitcoin (BTC), Solana (SOL) und BNB\n❓ Support: @${SUPPORT_USERNAME}\n\n👉 Bot öffnen: ${BOT_INVITE_URL}`
  });
}

async function setupTelegram() {
  try {
    const result = await telegram.configure(PUBLIC_BASE_URL);
    console.log('Telegram setup:', result);
    if (result && result.enabled) {
      const profile = await configureTelegramProfile();
      console.log('Telegram profile setup:', {
        description:profile.description?.ok === true,
        shortDescription:profile.shortDescription?.ok === true,
        commands:profile.commands?.ok === true
      });
    }
    const diagnostics = await telegramDiagnostics();
    console.log('Telegram diagnostics:', {
      authenticated:diagnostics.authenticated,
      canConnectToBusiness:diagnostics.can_connect_to_business,
      botUsername:diagnostics.bot?.username || telegram.username,
      webhookUrl:diagnostics.webhook?.url || ''
    });
  } catch (err) { console.error('Telegram setup failed:', err.message || err); }
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
      bot_username:telegram.username,
      business_ready:ready,
      can_connect_to_business:ready,
      authenticated:diagnostics.authenticated,
      telegram_error:diagnostics.telegramError,
      webhook:diagnostics.webhook,
      connections:telegram.getBusinessStatus().connections,
      next_step: !diagnostics.authenticated
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
      '<title>Lyca Telegram Business Check</title><style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#111;color:#fff;max-width:720px;margin:40px auto;padding:20px} .card{padding:24px;border:1px solid #333;border-radius:18px;background:#1b1b1b} .ok{color:#7ee787}.bad{color:#ff7b72}.muted{color:#aaa} code{background:#222;padding:3px 6px;border-radius:6px}</style>' +
      '<div class="card"><h1>🤖 Lyca Telegram Business</h1><h2 class="' + (ready ? 'ok' : 'bad') + '">' + status + '</h2><p>' + detail + '</p>' +
      '<p>Bot: <code>@' + String(telegram.username).replace(/</g,'&lt;') + '</code></p>' +
      '<p>Authentifiziert: <b>' + String(diagnostics.authenticated) + '</b><br>can_connect_to_business: <b>' + String(ready) + '</b></p>' +
      '<p class="muted">Nach einer Änderung in @BotFather Telegram vollständig schließen/neu öffnen und diese Seite erneut laden.</p>' +
      '<p><a href="https://t.me/Lyca_webshop2_bot" style="color:#6cb6ff">@Lyca_webshop2_bot öffnen</a> · <a href="https://t.me/BotFather" style="color:#6cb6ff">@BotFather öffnen</a></p></div>';
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
    return res.end(html);
  }
  if (req.method === 'POST' && route === '/api/telegram-webhook') return telegramWebhook(req,res);
  if (req.method === 'POST' && route === '/api/telegram-order') return telegramOrder(req,res);
  if (req.method === 'POST' && route === '/api/chat') {
    try { const data=await parseJson(req); const message=String(data.message || '').trim(); if(!message) return sendJson(res,400,{ok:false,error:'Bitte eine Nachricht eingeben.'}); const result=await webAiReply(data.session_id,message); return sendJson(res,result.ok?200:503,result); }
    catch(err){ return sendJson(res,400,{ok:false,error:err.message || 'Chat-Anfrage ungültig.'}); }
  }

  let filePath;
  try { filePath = safePath(req.url || '/'); } catch { res.writeHead(400); return res.end('Bad Request'); }
  if (!filePath) { res.writeHead(403); return res.end('Forbidden'); }
  fs.stat(filePath,(statErr,stat)=>{ if (!statErr && stat.isFile()) return sendFile(filePath,res); sendFile(path.join(root,'index.html'),res); });
});
function sendFile(filePath,res){ fs.readFile(filePath,(err,data)=>{ if(err){res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'});return res.end('Not Found');} const ext=path.extname(filePath).toLowerCase(); res.writeHead(200,{'Content-Type':mimeTypes[ext]||'application/octet-stream','Cache-Control':ext==='.html'?'no-cache':'public, max-age=3600'}); res.end(data); }); }

server.listen(port,'0.0.0.0',()=>{ console.log(`Lyca Webshop server listening on port ${port}`); setupTelegram(); });
