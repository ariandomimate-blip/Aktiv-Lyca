const token = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const botUsername = String(process.env.TELEGRAM_BOT_USERNAME || 'Lyca_webshop1_bot').replace(/^@/, '');
const publicBaseUrl = String(process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || 'https://webshop-sim-1.onrender.com').replace(/\/$/, '');
const webhookSecret = String(process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();
const adminChatIds = new Set(String(process.env.TELEGRAM_ADMIN_CHAT_IDS || process.env.TELEGRAM_ADMIN_CHAT_ID || '').split(',').map(x => x.trim()).filter(Boolean));
const supportChatId = String(process.env.TELEGRAM_SUPPORT_CHAT_ID || '').trim();
if (supportChatId) adminChatIds.add(supportChatId);
const supportUsername = String(process.env.SUPPORT_USERNAME || 'Lyca_Support').replace(/^@/, '');

const wallets = {
  BTC: process.env.BTC_WALLET || 'bc1qg808ntjfxgvnguepngpl6f7ddwana39z7m2qxx',
  SOL: process.env.SOL_WALLET || '2uqEwjquFWXbJhuhSwkMtbGcm2mZbi4JBoJWd6jrzeJA',
  BNB: process.env.BNB_WALLET || '0x7f6dde8179319425917eD0c9fd84952f98b0C2A4'
};

const orders = new Map();
const sessions = new Map();
const businessConnections = new Map();

function formatMoney(n) { return Number(n || 0).toFixed(2).replace('.', ',') + ' €'; }
function formatOrder(order) {
  const lines = order.items.map(x => `• ${x.name} · ${x.qty} Stück · ${formatMoney(x.price)} / Stück`).join('\n');
  return `🛒 LYCA WEBSHOP · NEUE BESTELLUNG\n\n🔢 Bestellnummer: ${order.orderNumber}\n🧾 Rechnung: ${order.invoiceNumber}\n📅 ${order.createdAt}\n\n👤 KUNDE\n${order.customer.name}\n${order.customer.address}\n${order.customer.email}\n\n📦 BESTELLUNG\n${lines}\n\n💶 Gesamt: ${formatMoney(order.total)}\n💳 Zahlungsstatus: ${order.paymentStatus}\n\n📩 Support: @${supportUsername}`;
}

function invoiceText(order) {
  return `🧾 LYCA WEBSHOP · RECHNUNG / BESTELLBESTÄTIGUNG\n\nRechnungsnummer: ${order.invoiceNumber}\nBestellnummer: ${order.orderNumber}\nDatum: ${order.createdAt}\n\nKunde: ${order.customer.name}\nAdresse: ${order.customer.address}\nE-Mail: ${order.customer.email}\n\n${order.items.map(x => `• ${x.name} | Menge: ${x.qty} | ${formatMoney(x.price)} / Stück`).join('\n')}\n\nGesamt: ${formatMoney(order.total)}\nZahlungsstatus: ${order.paymentStatus}\n\nSupport: @${supportUsername}`;
}

function botOrderUrl(orderNumber) { return `https://t.me/${botUsername}?start=${encodeURIComponent(String(orderNumber))}`; }
function supportUrl(order) {
  const text = order ? `Hallo Lyca Support, ich brauche Hilfe zu meiner Bestellung ${order.orderNumber}.\n\n${invoiceText(order)}` : `Hallo Lyca Support, ich brauche Hilfe zu meiner Lyca-Webshop-Bestellung.`;
  return `https://t.me/${supportUsername}?text=${encodeURIComponent(text)}`;
}
function makeKeyboard(orderNumber) {
  const rows = [[{ text: '🛍️ Shop öffnen', web_app: { url: publicBaseUrl } }]];
  if (orderNumber) {
    rows.push([{ text: '🧾 Rechnung öffnen', url: botOrderUrl(orderNumber) }]);
    rows.push([{ text: '💬 Support', url: supportUrl(getOrder(orderNumber)) }]);
  } else rows.push([{ text: '💬 Support', url: `https://t.me/${supportUsername}` }]);
  return { inline_keyboard: rows };
}

async function api(method, body = {}) {
  if (!token) return { ok: false, description: 'TELEGRAM_BOT_TOKEN fehlt' };
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}
async function sendMessage(chatId, text, extra = {}) { return api('sendMessage', { chat_id: chatId, text, ...extra }); }
async function sendBusinessMessage(connectionId, chatId, text, extra = {}) {
  return api('sendMessage', { business_connection_id: connectionId, chat_id: chatId, text, ...extra });
}
async function getBusinessConnection(connectionId) {
  const id = String(connectionId || '');
  if (!id) return null;
  const cached = businessConnections.get(id);
  if (cached) return cached;
  try {
    const result = await api('getBusinessConnection', { business_connection_id: id });
    if (result.ok && result.result) {
      businessConnections.set(id, result.result);
      return result.result;
    }
  } catch (err) {
    console.error('Lyca Business connection lookup failed:', err.message);
  }
  return null;
}

function saveOrder(order) { orders.set(order.orderNumber, order); return order; }
function getOrder(id) { return orders.get(String(id || '').trim()) || null; }

async function sendOrder(order) {
  saveOrder(order);
  console.log(`Lyca Bot: new order ${order.orderNumber}`);
  const recipients = Array.from(adminChatIds);
  if (!recipients.length) console.error('Lyca Bot: no admin recipients configured');
  for (const chatId of recipients) {
    try {
      const result = await sendMessage(chatId, formatOrder(order), { reply_markup: makeKeyboard(order.orderNumber) });
      if (!result.ok) console.error(`Lyca Bot: failed to notify admin ${chatId}: ${result.description || 'unknown Telegram error'}`);
    } catch (err) { console.error(`Lyca Bot: failed to notify admin ${chatId}`, err.message); }
  }
  return { ok: true, orderNumber: order.orderNumber, botUsername, message: formatOrder(order), adminRecipients: recipients.length, invoiceUrl: botOrderUrl(order.orderNumber), supportUrl: supportUrl(order) };
}

function businessReplyText(text) {
  const t = String(text || '').trim();
  const orderMatch = t.match(/\bLYCA-\d{8}-[A-F0-9]{6}\b/i);
  if (orderMatch) {
    const order = getOrder(orderMatch[0]);
    if (order) return `✅ Ich habe deine Bestellung ${order.orderNumber} gefunden.\n\n${invoiceText(order)}\n\nWenn du weitere Hilfe brauchst, antworte einfach hier.`;
  }
  if (/rechnung|invoice/i.test(t)) return '🧾 Gerne. Bitte sende mir deine Bestellnummer, z. B. LYCA-20260917-ABC123.';
  if (/bestellung|order|bestell/i.test(t)) return '📦 Gerne helfe ich dir mit deiner Bestellung. Bitte sende mir deine Bestellnummer.';
  if (/preis|kosten|sim|shop|kaufen|produkt/i.test(t)) return `🛍️ Hier geht es zum Lyca Webshop: ${publicBaseUrl}`;
  return '👋 Hallo! Willkommen beim Lyca Support. Ich helfe dir bei Bestellung, Rechnung und Shop-Fragen. Bitte nenne deine Bestellnummer oder beschreibe kurz dein Anliegen.';
}

async function handleBusinessConnection(connection) {
  const id = String(connection.id || '');
  if (!id) return;
  businessConnections.set(id, connection);
  console.log(`Lyca Business connection ${connection.is_enabled ? 'enabled' : 'disabled'} for ${connection.user?.username || connection.user?.id || 'unknown user'} (${id})`);
}

async function handleBusinessMessage(msg) {
  const connectionId = String(msg.business_connection_id || '');
  if (!connectionId || !msg.chat) return;
  const connection = await getBusinessConnection(connectionId);
  if (connection && connection.is_enabled === false) return;
  const rights = connection?.rights || {};
  if (connection && rights.can_reply === false) {
    console.error(`Lyca Business reply skipped: can_reply=false for connection ${connectionId}`);
    return;
  }
  const text = String(msg.text || '').trim();
  if (!text) return;
  const reply = businessReplyText(text);
  try {
    const result = await sendBusinessMessage(connectionId, msg.chat.id, reply);
    if (!result.ok) console.error(`Lyca Business reply failed: ${result.description || 'unknown Telegram error'}`);
    if (rights.can_read_messages) await api('readBusinessMessage', { business_connection_id: connectionId, chat_id: msg.chat.id, message_id: msg.message_id });
  } catch (err) { console.error('Lyca Business message error:', err.message); }
}

async function handleUpdate(update) {
  if (update.business_connection) { await handleBusinessConnection(update.business_connection); return; }
  if (update.business_message) { await handleBusinessMessage(update.business_message); return; }
  if (update.edited_business_message) { return; }
  if (update.deleted_business_messages) { return; }

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
  const senderUsername = String(msg.from?.username || '').replace(/^@/, '');
  const isSupportAdmin = senderUsername.toLowerCase() === supportUsername.toLowerCase();
  if (isSupportAdmin) adminChatIds.add(String(chatId));

  if (command === '/start') {
    const order = getOrder(parts[1]);
    sessions.set(String(chatId), { lastOrder: order?.orderNumber || null });
    if (isSupportAdmin) {
      await sendMessage(chatId, '🛠️ Lyca Support ist als Administrator verbunden.\n\nNeue Bestellungen werden an die konfigurierten Administratoren gesendet.\n\nDeine Chat-ID: ' + chatId + '\n\nDu kannst /paid BESTELLNUMMER oder /unpaid BESTELLNUMMER verwenden.', { reply_markup: makeKeyboard() });
      return;
    }
    if (order) await sendMessage(chatId, `✅ Bestellung ${order.orderNumber} wurde gefunden.\n\n${invoiceText(order)}`, { reply_markup: makeKeyboard(order.orderNumber) });
    else await sendMessage(chatId, `🤖 Willkommen beim Lyca Webshop!\n\n🛍️ Über den Button unten öffnest du den Shop.\n🧾 Nach dem Checkout kannst du deine Bestellbestätigung/Rechnung hier über den Rechnungslink öffnen.`, { reply_markup: makeKeyboard() });
    return;
  }
  if (command === '/myid') { await sendMessage(chatId, `🆔 Deine Telegram Chat-ID: ${chatId}`); return; }
  if (command === '/shop') { await sendMessage(chatId, '🛍️ Lyca Webshop', { reply_markup: makeKeyboard() }); return; }
  if (command === '/support') { await sendMessage(chatId, `💬 Lyca Support: @${supportUsername}`, { reply_markup: makeKeyboard() }); return; }
  if (command === '/order') {
    const order = getOrder(parts[1]);
    await sendMessage(chatId, order ? formatOrder(order) : 'Bestellung nicht gefunden.', { reply_markup: order ? makeKeyboard(order.orderNumber) : makeKeyboard() });
    return;
  }
  if (command === '/invoice') {
    const order = getOrder(parts[1] || sessions.get(String(chatId))?.lastOrder);
    await sendMessage(chatId, order ? invoiceText(order) : 'Keine Bestellung gefunden.', { reply_markup: order ? makeKeyboard(order.orderNumber) : makeKeyboard() });
    return;
  }
  if (command === '/paid' || command === '/unpaid') {
    if (!adminChatIds.has(String(chatId))) { await sendMessage(chatId, 'Dieser Befehl ist nur für den Shop-Administrator verfügbar.'); return; }
    const order = getOrder(parts[1]);
    if (!order) { await sendMessage(chatId, 'Bestellung nicht gefunden.'); return; }
    order.paymentStatus = command === '/paid' ? 'BEZAHLT' : 'UNBEZAHLT';
    await sendMessage(chatId, `✅ ${order.orderNumber}: ${order.paymentStatus}`, { reply_markup: makeKeyboard(order.orderNumber) });
    return;
  }
  await sendMessage(chatId, 'Nutze /shop, /order BESTELLNUMMER, /invoice BESTELLNUMMER, /support oder /myid.', { reply_markup: makeKeyboard() });
}

async function configure(baseUrl = publicBaseUrl) {
  if (!token) return { enabled: false, reason: 'TELEGRAM_BOT_TOKEN fehlt' };
  const me = await api('getMe');
  if (!me.ok) return { enabled: false, reason: me.description || 'Telegram token rejected' };
  if (baseUrl) {
    const webhookUrl = `${baseUrl}/api/telegram-webhook`;
    const body = { url: webhookUrl, allowed_updates: ['message', 'callback_query', 'business_connection', 'business_message', 'edited_business_message', 'deleted_business_messages'], drop_pending_updates: false };
    if (webhookSecret) body.secret_token = webhookSecret;
    const hook = await api('setWebhook', body);
    if (!hook.ok) return { enabled: false, reason: hook.description || 'setWebhook failed' };
  }
  await api('setMyCommands', { commands: [
    { command: 'start', description: 'Bot starten' },
    { command: 'shop', description: 'Webshop öffnen' },
    { command: 'order', description: 'Bestellung anzeigen' },
    { command: 'invoice', description: 'Rechnung anzeigen' },
    { command: 'support', description: 'Support kontaktieren' },
    { command: 'myid', description: 'Telegram Chat-ID anzeigen' }
  ] });
  if (baseUrl) await api('setChatMenuButton', { menu_button: { type: 'web_app', text: '🛍️ Shop', web_app: { url: baseUrl } } });
  return { enabled: true, username: me.result.username, webhook: `${baseUrl || ''}/api/telegram-webhook`, businessMode: true, miniAppUrl: baseUrl };
}

module.exports = {
  enabled: Boolean(token), tokenConfigured: Boolean(token), username: botUsername, wallets,
  sendOrder, handleUpdate, configure, getOrder, getOrders: () => Array.from(orders.values()),
  getBalances: () => ({ BTC: 'n/a', SOL: 'n/a', BNB: 'n/a' }),
  invoiceText, webhookSecret, supportUsername, supportChatId, botOrderUrl, supportUrl
};
