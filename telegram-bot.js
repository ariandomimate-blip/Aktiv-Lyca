const crypto = require('crypto');

const token = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const botUsername = String(process.env.TELEGRAM_BOT_USERNAME || 'Lyca_Webshop_Bot').replace(/^@/, '');
const publicBaseUrl = String(process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
const webhookSecret = String(process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();
const adminChatId = String(process.env.TELEGRAM_ADMIN_CHAT_ID || '').trim();
const supportUsername = String(process.env.SUPPORT_USERNAME || 'Lyca_Support').replace(/^@/, '');

const wallets = {
  BTC: process.env.BTC_WALLET || 'bc1qg808ntjfxgvnguepngpl6f7ddwana39z7m2qxx',
  SOL: process.env.SOL_WALLET || '2uqEwjquFWXbJhuhSwkMtbGcm2mZbi4JBoJWd6jrzeJA',
  BNB: process.env.BNB_WALLET || '0x7f6dde8179319425917eD0c9fd84952f98b0C2A4'
};

const orders = new Map();
const sessions = new Map();

function formatMoney(n) { return Number(n || 0).toFixed(2).replace('.', ',') + ' €'; }
function formatOrder(order) {
  const lines = order.items.map(x => `• ${x.name} · ${x.qty} Stück · ${formatMoney(x.price)} / Stück`).join('\n');
  return `🛒 LYCA WEBSHOP · BESTELLUNG\n\n🔢 Bestellnummer: ${order.orderNumber}\n🧾 Rechnung: ${order.invoiceNumber}\n📅 ${order.createdAt}\n\n👤 KUNDE\n${order.customer.name}\n${order.customer.address}\n${order.customer.email}\n\n📦 BESTELLUNG\n${lines}\n\n💶 Gesamt: ${formatMoney(order.total)}\n💳 Zahlungsstatus: ${order.paymentStatus}\n\n📩 Support: @${supportUsername}`;
}

function invoiceText(order) {
  return `🧾 LYCA WEBSHOP · RECHNUNG / BESTELLBESTÄTIGUNG\n\nRechnungsnummer: ${order.invoiceNumber}\nBestellnummer: ${order.orderNumber}\nDatum: ${order.createdAt}\n\nKunde: ${order.customer.name}\nAdresse: ${order.customer.address}\nE-Mail: ${order.customer.email}\n\n${order.items.map(x => `• ${x.name} | Menge: ${x.qty} | ${formatMoney(x.price)} / Stück`).join('\n')}\n\nGesamt: ${formatMoney(order.total)}\nZahlungsstatus: ${order.paymentStatus}\n\nSupport: @${supportUsername}`;
}

function makeKeyboard(orderNumber) {
  const rows = [[{ text: '🛍️ Shop öffnen', web_app: { url: publicBaseUrl || 'https://webshopsim1.onrender.com' } }]];
  if (orderNumber) rows.push([{ text: '🧾 Bestellung', callback_data: `order:${orderNumber}` }]);
  rows.push([{ text: '💬 Support', url: `https://t.me/${supportUsername}` }]);
  return { inline_keyboard: rows };
}

async function api(method, body = {}) {
  if (!token) return { ok: false, description: 'TELEGRAM_BOT_TOKEN fehlt' };
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  return r.json();
}

async function sendMessage(chatId, text, extra = {}) {
  return api('sendMessage', { chat_id: chatId, text, ...extra });
}

function saveOrder(order) { orders.set(order.orderNumber, order); return order; }
function getOrder(id) { return orders.get(String(id || '').trim()) || null; }

async function sendOrder(order) {
  saveOrder(order);
  console.log(`Lyca Bot: new order ${order.orderNumber}`);
  if (token && adminChatId) await sendMessage(adminChatId, formatOrder(order), { reply_markup: makeKeyboard(order.orderNumber) });
  return { ok: true, orderNumber: order.orderNumber, botUsername, message: formatOrder(order) };
}

async function handleUpdate(update) {
  if (update.callback_query) {
    const q = update.callback_query;
    await api('answerCallbackQuery', { callback_query_id: q.id });
    if (String(q.data || '').startsWith('order:')) {
      const order = getOrder(String(q.data).slice(6));
      if (order) await sendMessage(q.message.chat.id, formatOrder(order), { reply_markup: makeKeyboard(order.orderNumber) });
      else await sendMessage(q.message.chat.id, 'Diese Bestellung ist auf dem aktuellen Server nicht mehr verfügbar.');
    }
    return;
  }
  const msg = update.message;
  if (!msg || !msg.chat) return;
  const chatId = msg.chat.id;
  const text = String(msg.text || '').trim();
  const parts = text.split(/\s+/);
  const command = parts[0].split('@')[0];

  if (command === '/start') {
    const order = getOrder(parts[1]);
    sessions.set(String(chatId), { lastOrder: order?.orderNumber || null });
    if (order) {
      await sendMessage(chatId, `✅ Bestellung ${order.orderNumber} wurde gefunden.\n\n${invoiceText(order)}`, { reply_markup: makeKeyboard(order.orderNumber) });
    } else {
      await sendMessage(chatId, `🤖 Willkommen beim Lyca Webshop.\n\n🛍️ Öffne den Shop über den Button.\n🧾 Nach dem Checkout erhältst du hier deine Bestellbestätigung und Rechnung.`, { reply_markup: makeKeyboard() });
    }
    return;
  }
  if (command === '/shop') {
    await sendMessage(chatId, '🛍️ Lyca Webshop', { reply_markup: makeKeyboard() });
    return;
  }
  if (command === '/order') {
    const order = getOrder(parts[1]);
    await sendMessage(chatId, order ? formatOrder(order) : 'Bestellung nicht gefunden.');
    return;
  }
  if (command === '/invoice') {
    const order = getOrder(parts[1] || sessions.get(String(chatId))?.lastOrder);
    await sendMessage(chatId, order ? invoiceText(order) : 'Keine Bestellung gefunden.');
    return;
  }
  if (command === '/paid' || command === '/unpaid') {
    if (!adminChatId || String(chatId) !== adminChatId) {
      await sendMessage(chatId, 'Dieser Befehl ist nur für den Shop-Administrator verfügbar.');
      return;
    }
    const order = getOrder(parts[1]);
    if (!order) { await sendMessage(chatId, 'Bestellung nicht gefunden.'); return; }
    order.paymentStatus = command === '/paid' ? 'BEZAHLT' : 'UNBEZAHLT';
    await sendMessage(chatId, `✅ ${order.orderNumber}: ${order.paymentStatus}`);
    return;
  }
  await sendMessage(chatId, 'Nutze /shop, /order BESTELLNUMMER oder /invoice BESTELLNUMMER.');
}

async function configure(baseUrl = publicBaseUrl) {
  if (!token) return { enabled: false, reason: 'TELEGRAM_BOT_TOKEN fehlt' };
  const me = await api('getMe');
  if (!me.ok) return { enabled: false, reason: me.description || 'Telegram token rejected' };
  if (baseUrl) {
    const webhookUrl = `${baseUrl}/api/telegram-webhook`;
    const body = { url: webhookUrl, allowed_updates: ['message', 'callback_query'], drop_pending_updates: false };
    if (webhookSecret) body.secret_token = webhookSecret;
    const hook = await api('setWebhook', body);
    if (!hook.ok) return { enabled: false, reason: hook.description || 'setWebhook failed' };
  }
  await api('setMyCommands', { commands: [
    { command: 'start', description: 'Bot starten' },
    { command: 'shop', description: 'Webshop öffnen' },
    { command: 'order', description: 'Bestellung anzeigen' },
    { command: 'invoice', description: 'Rechnung anzeigen' }
  ] });
  if (baseUrl) await api('setChatMenuButton', { menu_button: { type: 'web_app', text: '🛍️ Shop', web_app: { url: baseUrl } } });
  return { enabled: true, username: me.result.username, webhook: `${baseUrl || ''}/api/telegram-webhook` };
}

module.exports = {
  enabled: Boolean(token), tokenConfigured: Boolean(token), username: botUsername, wallets,
  sendOrder, handleUpdate, configure, getOrder, getOrders: () => Array.from(orders.values()),
  getBalances: () => ({ BTC: 'n/a', SOL: 'n/a', BNB: 'n/a' }),
  invoiceText, webhookSecret, supportUsername
};
