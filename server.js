const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const telegram = require('./telegram-bot');

const port = Number(process.env.PORT) || 10000;
const root = __dirname;
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || 'https://webshop-sim-1.onrender.com').replace(/\/$/, '');
const SUPPORT_USERNAME = telegram.supportUsername;
const SUPPORT_URL = `https://t.me/${SUPPORT_USERNAME}`;
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
      items:normalizedItems, total, paymentStatus:'UNBEZAHLT'
    };
    const result = await telegram.sendOrder(order);
    const invoiceText = formatInvoice(order);
    // Telegram opens the support chat with the complete order/invoice prefilled.
    // The customer still has to press Send because Telegram does not let a website send as the user.
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
  sendJson(res,200,{ok:true,telegram_enabled:telegram.tokenConfigured,bot_enabled:true,bot_username:telegram.username,bot_mode:telegram.tokenConfigured?'telegram-api':'token-missing',webhook:`${PUBLIC_BASE_URL}/api/telegram-webhook`,shop_url:PUBLIC_BASE_URL,support_username:SUPPORT_USERNAME,support_url:SUPPORT_URL,message:telegram.tokenConfigured?'Telegram Bot API is configured by environment variables.':'TELEGRAM_BOT_TOKEN is missing in Render.'});
}

async function setupTelegram() {
  try { const result = await telegram.configure(PUBLIC_BASE_URL); console.log('Telegram setup:', result); }
  catch (err) { console.error('Telegram setup failed:', err.message || err); }
}

const server = http.createServer(async (req,res) => {
  const route = (req.url || '').split('?')[0];
  if (req.method === 'GET' && route === '/api/telegram-status') return telegramStatus(req,res);
  if (req.method === 'POST' && route === '/api/telegram-webhook') return telegramWebhook(req,res);
  if (req.method === 'POST' && route === '/api/telegram-order') return telegramOrder(req,res);

  let filePath;
  try { filePath = safePath(req.url || '/'); } catch { res.writeHead(400); return res.end('Bad Request'); }
  if (!filePath) { res.writeHead(403); return res.end('Forbidden'); }
  fs.stat(filePath,(statErr,stat)=>{ if (!statErr && stat.isFile()) return sendFile(filePath,res); sendFile(path.join(root,'index.html'),res); });
});
function sendFile(filePath,res){ fs.readFile(filePath,(err,data)=>{ if(err){res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'});return res.end('Not Found');} const ext=path.extname(filePath).toLowerCase(); res.writeHead(200,{'Content-Type':mimeTypes[ext]||'application/octet-stream','Cache-Control':ext==='.html'?'no-cache':'public, max-age=3600'}); res.end(data); }); }

server.listen(port,'0.0.0.0',()=>{ console.log(`Lyca Webshop server listening on port ${port}`); setupTelegram(); });
