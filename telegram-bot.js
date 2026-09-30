const telegramServiceEnabled = String(process.env.TELEGRAM_SERVICE_ENABLED || 'true').toLowerCase() !== 'false';
const token = telegramServiceEnabled ? String(
  process.env.TELEGRAM_BOT_TOKEN ||
  process.env.TELEGRAM_TOKEN ||
  process.env.TELEGRAM_API_TOKEN ||
  process.env.BOT_TOKEN ||
  ''
).trim() : '';

let botUsername = String(process.env.TELEGRAM_BOT_USERNAME || 'Lyca_Webshop1_Bot').replace(/^@/, '');
const publicBaseUrl = String(process.env.PUBLIC_BASE_URL || 'https://webshop-sim-1.onrender.com').replace(/\/$/,'');
const webhookSecret = String(process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();
const adminChatIds = new Set(String(process.env.TELEGRAM_ADMIN_CHAT_IDS || process.env.TELEGRAM_ADMIN_CHAT_ID || '').split(',').map(x => x.trim()).filter(Boolean));
const supportChatId = String(process.env.TELEGRAM_SUPPORT_CHAT_ID || '').trim();
let resolvedSupportChatId = supportChatId;
// Lyca_Support is the sole application administrator. Telegram bot ownership is
// intentionally separate: this role controls the webshop admin panel and payment confirmations.
const supportAdminOnly = String(process.env.LYCA_SUPPORT_ADMIN_ONLY || 'true').toLowerCase() !== 'false';
// If no separate administrator chat is configured, keep Support as the emergency recipient
// so orders are not lost. When TELEGRAM_ADMIN_CHAT_IDS is configured, Support receives
// the complete order only after the administrator confirms payment.
if (!adminChatIds.size && supportChatId) adminChatIds.add(supportChatId);
const supportUsername = String(process.env.SUPPORT_USERNAME || 'Lyca_Support').replace(/^@/, '');
let walletConfig = {};
try { walletConfig = require('./payment_wallets.json')?.payment_wallets || {}; } catch {}
// Public receiving addresses are defined centrally in payment_wallets.json.
// The repository configuration is authoritative so stale Render environment variables
// cannot silently override the intended payment addresses.
const wallets = {
  BTC: walletConfig.BTC || process.env.BTC_WALLET || '',
  SOL: walletConfig.SOL || process.env.SOL_WALLET || '',
  BNB: walletConfig.BNB_SMART_CHAIN || process.env.BNB_WALLET || ''
};

const orders = new Map();
let statsProvider = null;
const sessions = new Map();
const businessConnections = new Map();
const businessConnectionUsers = new Map();
// Telegram may retry webhook deliveries. Keep a short in-process idempotency cache
// so one update can never create duplicate bot replies/orders.
const seenUpdateIds = new Map();
const seenCallbackIds = new Map();
function rememberOnce(map, key, ttlMs = 10 * 60 * 1000) {
  const now = Date.now();
  for (const [k, expires] of map) if (expires <= now) map.delete(k);
  const k = String(key || '');
  if (!k) return true;
  if (map.has(k)) return false;
  map.set(k, now + ttlMs);
  return true;
}
function isAdminChat(chatId, username = '') {
  const id = String(chatId || '');
  const user = String(username || '').replace(/^@/, '').toLowerCase();
  const isSupport = id === resolvedSupportChatId || user === supportUsername.toLowerCase();
  if (supportAdminOnly) return isSupport;
  return adminChatIds.has(id) || isSupport;
}

const products = {
  lyca: {
    id: 'lyca',
    name: 'Lyca Mobile Triple-SIM',
    description: 'Bereits aktivierte Lyca Mobile Prepaid-SIM · Triple-SIM (Standard, Micro und Nano) · deutsche Rufnummer · flexible Tarifwahl und Guthabenaufladung.',
    prices: { 10: 7, 50: 5, 100: 4.5, 200: 4, 250: 3.8, 500: 3.5 }
  }
};

function formatMoney(n) { return Number(n || 0).toFixed(2).replace('.', ',') + ' €'; }
function makeTelegramOrderNumber() {
  const d = new Date();
  const stamp = d.toISOString().slice(0,10).replace(/-/g,'');
  const rnd = Math.random().toString(16).slice(2,8).toUpperCase();
  return 'LYCA-' + stamp + '-' + rnd;
}

function formatOrder(order) {
  const lines = order.items.map(x => `• ${x.name} · ${x.qty} Stück · ${formatMoney(x.price)} / Stück`).join('\n');
  return `🛒 LYCA WEBSHOP · NEUE BESTELLUNG\n\n🔢 Bestellnummer: ${order.orderNumber}\n🧾 Rechnung: ${order.invoiceNumber}\n📅 ${order.createdAt}\n\n👤 KUNDE\n${order.customer.name}\n${order.customer.address}\n${order.customer.email}\n\n📦 BESTELLUNG\n${lines}\n\n💶 Gesamt: ${formatMoney(order.total)}\n📌 Zahlungsstatus: ${order.paymentStatus}\n\n📩 Support: @${supportUsername}`;
}
function invoiceText(order) {
  const txLine = order.transactionId ? `\nTransaktions-ID / TXID: ${order.transactionId}` : '';
  const paidLine = order.paidAt ? `\nBestätigt: ${order.paidAt}` : '';
  return `🧾 LYCA WEBSHOP · RECHNUNG / BESTELLBESTÄTIGUNG\n\nRechnungsnummer: ${order.invoiceNumber}\nBestellnummer: ${order.orderNumber}\nDatum: ${order.createdAt}\n\nKunde: ${order.customer.name}\nAdresse: ${order.customer.address}\nE-Mail: ${order.customer.email}\n\n${order.items.map(x => `• ${x.name} | Menge: ${x.qty} | ${formatMoney(x.price)} / Stück`).join('\n')}\n\nGesamt: ${formatMoney(order.total)}\nZahlungsstatus: ${order.paymentStatus}${txLine}${paidLine}\n\nSupport: @${supportUsername}`;
}
function paidInvoiceKeyboard(order) {
  return { inline_keyboard: [
    [callback('🧾 Bezahlung abgeschlossen mit Rechnung', 'paid_invoice:' + order.orderNumber)]
  ] };
}
function botOrderUrl(orderNumber) { return `https://t.me/${botUsername}?start=${encodeURIComponent(String(orderNumber))}`; }
function supportUrl(order) {
  const text = order ? `Hallo Lyca Support, ich brauche Hilfe zu meiner Bestellung ${order.orderNumber}.\n\n${invoiceText(order)}` : 'Hallo Lyca Support, ich brauche Hilfe zu meiner Lyca-Webshop-Bestellung.';
  return `https://t.me/${supportUsername}?text=${encodeURIComponent(text)}`;
}
function webAppButton() { return { text: '🛍️ Shop öffnen', web_app: { url: publicBaseUrl } }; }
function telegramCheckoutButton(chatId) {
  return { text: '🧾 Kasse öffnen', web_app: { url: publicBaseUrl + '/telegram-checkout?chat_id=' + encodeURIComponent(String(chatId)) } };
}
function urlButton(text, url) { return { text, url }; }
function callback(text, data) { return { text, callback_data: data }; }
function qrUrl(value) {
  return 'https://api.qrserver.com/v1/create-qr-code/?size=420x420&margin=12&data=' + encodeURIComponent(String(value || ''));
}
function paymentKeyboard(order) {
  if (!order) return { inline_keyboard: [] };
  return { inline_keyboard: [
    [callback('🔗 Transaktions-ID eingeben', 'txid_input:' + order.orderNumber)]
  ] };
}
function adminOrderKeyboard(order) {
  if (!order || order.paymentStatus === 'BEZAHLT') return { inline_keyboard: [] };
  return { inline_keyboard: [
    [callback('✅ Zahlung bestätigen', 'paid:' + order.orderNumber)]
  ] };
}

function businessKeyboard() {
  // Telegram Business replies do not accept Web App buttons inside inline keyboards.
  // Use normal URL buttons here; the regular bot chat keeps the Web App button.
  return { inline_keyboard: [
    [callback('🛍️ Produkte', 'products'), callback('🛒 Warenkorb', 'cart')],
    [callback('📋 Bestellung', 'orders'), callback('💳 Wallets', 'wallets')],
    [urlButton('🛍️ Shop öffnen', publicBaseUrl)],
    [urlButton('🤖 Bot öffnen', botOrderUrl('')), urlButton('❓ Support', `https://t.me/${supportUsername}`)]
  ] };
}
function mainKeyboard() {
  return { inline_keyboard: [
    [callback('🛍️ Produkte', 'products'), callback('🛒 Warenkorb', 'cart')],
    [callback('📋 Bestellung', 'orders'), callback('💳 Wallets', 'wallets')],
    [webAppButton()],
    [urlButton('🤖 Bot öffnen', botOrderUrl('')), urlButton('❓ Support', `https://t.me/${supportUsername}`)]
  ] };
}
function productKeyboard() {
  return { inline_keyboard: [
    [callback('📱 Lyca Triple-SIM', 'product:lyca')],
    [callback('🛒 Warenkorb', 'cart'), callback('↩️ Start', 'home')],
    [webAppButton(), urlButton('❓ Support', `https://t.me/${supportUsername}`)]
  ] };
}
function quantityKeyboard() {
  return { inline_keyboard: [
    [callback('10 Stück · 7,00 €/Stk.', 'add:lyca:10')],
    [callback('50 Stück · 5,00 €/Stk.', 'add:lyca:50')],
    [callback('100 Stück · 4,50 €/Stk.', 'add:lyca:100')],
    [callback('200 Stück · 4,00 €/Stk.', 'add:lyca:200')],
    [callback('250 Stück · 3,80 €/Stk.', 'add:lyca:250')],
    [callback('500 Stück · 3,50 €/Stk.', 'add:lyca:500')],
    [callback('↩️ Produkte', 'products')]
  ] };
}
function cartKeyboard(hasItems) {
  const rows = [];
  if (hasItems) rows.push([callback('🧾 Kasse', 'checkout')], [callback('🛍️ Weiter einkaufen', 'products')], [callback('🗑️ Warenkorb leeren', 'cart:clear')]);
  else rows.push([callback('🛍️ Produkte anzeigen', 'products')]);
  rows.push([webAppButton(), callback('↩️ Start', 'home')]);
  return { inline_keyboard: rows };
}
function walletKeyboard() {
  return { inline_keyboard: [
    [callback('₿ Bitcoin (BTC)', 'wallet:BTC')],
    [callback('◎ Solana (SOL)', 'wallet:SOL')],
    [callback('◆ BNB', 'wallet:BNB')],
    [callback('↩️ Start', 'home')]
  ] };
}
function walletText(coin) {
  const address = wallets[coin];
  const names = { BTC:'Bitcoin (BTC)', SOL:'Solana (SOL)', BNB:'BNB Smart Chain' };
  return `💳 ZAHLUNGS-WALLET\n\n${names[coin] || coin}\n\n${address || 'Wallet nicht konfiguriert.'}\n\n⚠️ Bitte ausschließlich die angegebene Kryptowährung an diese Adresse senden. Prüfe die Adresse vor dem Versand.\n\nFür Bestell- und Zahlungsfragen: @${supportUsername}`;
}
function walletsText(order) {
  const suffix = order ? `\n\n🔢 Bestellnummer: ${order.orderNumber}\n💶 Gesamt: ${formatMoney(order.total)}\n📌 Status: ${order.paymentStatus}` : '';
  return `💳 LYCA WEBSHOP · ZAHLUNGS-WALLETS${suffix}\n\n₿ Bitcoin (BTC)\n${wallets.BTC || 'nicht konfiguriert'}\n\n◎ Solana (SOL)\n${wallets.SOL || 'nicht konfiguriert'}\n\n◆ BNB Smart Chain\n${wallets.BNB || 'nicht konfiguriert'}\n\n⚠️ Sende nur die jeweils passende Kryptowährung an die dazugehörige Adresse. Nach der Zahlung bitte Lyca Support kontaktieren.`;
}
async function sendWalletQRCodes(chatId, order = null) {
  const title = order
    ? `💳 ZAHLUNG FÜR BESTELLUNG ${order.orderNumber}\n\nGesamt: ${formatMoney(order.total)}\nStatus: ${order.paymentStatus}\n\nScanne den gewünschten QR-Code. Nach der Überweisung gib unten die TXID ein.`
    : '💳 LYCA WEBSHOP · ZAHLUNGS-WALLETS\n\nScanne den gewünschten QR-Code.';
  await sendMessage(chatId, title);
  const entries = [
    ['BTC','₿ Bitcoin (BTC)',wallets.BTC],
    ['SOL','◎ Solana (SOL)',wallets.SOL],
    ['BNB','◆ BNB Smart Chain',wallets.BNB]
  ];
  for (const [coin,label,address] of entries) {
    if (!address) continue;
    const result = await api('sendPhoto', {
      chat_id: chatId,
      photo: qrUrl(address),
      caption: `${label}\n\n${address}\n\n${order ? 'Bestellung: ' + order.orderNumber : 'Lyca Webshop'}`
    });
    if (!result.ok) {
      console.error(`Lyca Bot: QR send failed for ${coin}: ${result.description || 'unknown Telegram error'}`);
      await sendMessage(chatId, `${label}\n\n${address}`);
    }
  }
  if (order) {
    await sendMessage(chatId,
      `🔘 ZAHLUNGSSTATUS\n\nBestellung: ${order.orderNumber}\nStatus: ${order.paymentStatus}\n\nNach deiner Zahlung gib die TXID ein. Die Zahlung wird anschließend vom Administrator geprüft und bestätigt.`,
      { reply_markup: paymentKeyboard(order) }
    );
  }
}
function orderKeyboard(order, admin = false) {
  if (order && admin) return adminOrderKeyboard(order);
  const rows = [];
  if (!order) {
    rows.push(
      [urlButton('🛍️ Shop öffnen', publicBaseUrl)],
      [callback('🛍️ Produkte', 'products'), callback('🛒 Warenkorb', 'cart')],
      [callback('🧾 Kasse', 'checkout')]
    );
  }
  if (order) {
    // Existing order: never make the customer rebuild the cart or start checkout again.
    if (order.paymentStatus !== 'BEZAHLT') {
      rows.push([callback('💳 Wallets / QR-Codes', 'wallets:' + order.orderNumber)]);
      rows.push([callback('🔗 TXID eingeben', 'txid_input:' + order.orderNumber)]);
    } else {
      rows.push([callback('🧾 Rechnung / Zahlung bestätigt', 'paid_invoice:' + order.orderNumber)]);
    }
    rows.push([urlButton('💬 Support kontaktieren', supportUrl(order))]);
  }
  return { inline_keyboard: rows };
}

async function api(method, body = {}) {
  if (!token) return { ok: false, description: 'TELEGRAM_BOT_TOKEN fehlt' };
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return r.json();
  } catch (err) { return { ok: false, description: err.message || 'Telegram request failed' }; }
}
async function sendMessage(chatId, text, extra = {}) { return api('sendMessage', { chat_id: chatId, text, ...extra }); }
async function sendBusinessMessage(connectionId, chatId, text, extra = {}) { return api('sendMessage', { business_connection_id: connectionId, chat_id: chatId, text, ...extra }); }
async function editMessage(chatId, messageId, text, replyMarkup) { return api('editMessageText', { chat_id: chatId, message_id: messageId, text, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) }); }

function saveOrder(order) { orders.set(order.orderNumber, order); return order; }
function getOrder(id) { return orders.get(String(id || '').trim()) || null; }
function getSession(chatId) {
  const key = String(chatId);
  if (!sessions.has(key)) sessions.set(key, { cart: [], lastOrder: null });
  return sessions.get(key);
}
function cartItems(chatId) { return getSession(chatId).cart; }
function cartTotal(chatId) { return cartItems(chatId).reduce((sum, item) => sum + item.unitPrice * item.qty, 0); }
function addToCart(chatId, productId, qty) {
  const product = products[productId];
  const price = product?.prices?.[qty];
  if (!product || !price) return false;
  const cart = cartItems(chatId);
  const existing = cart.find(x => x.productId === productId);
  if (existing) { existing.qty += qty; existing.unitPrice = price; }
  else cart.push({ productId, name: product.name, qty, unitPrice: price });
  return true;
}
function clearCart(chatId) { getSession(chatId).cart = []; }
function cartText(chatId) {
  const cart = cartItems(chatId);
  if (!cart.length) return '🛒 DEIN WARENKORB\n\nDer Warenkorb ist leer.';
  const lines = cart.map(x => `• ${x.name}\n  Menge: ${x.qty}\n  Preis: ${formatMoney(x.unitPrice)} / Stück\n  Position: ${formatMoney(x.unitPrice * x.qty)}`).join('\n\n');
  return `🛒 DEIN WARENKORB\n\n${lines}\n\n💶 Gesamt: ${formatMoney(cartTotal(chatId))}`;
}
function getCartCheckout(chatId) {
  const cart = cartItems(chatId);
  return {
    items: cart.map(x => ({ productId:x.productId, name:x.name, qty:Number(x.qty)||1, price:Number(x.unitPrice)||0 })),
    total: cartTotal(chatId)
  };
}
function productText() {
  return `📱 LYCA MOBILE TRIPLE-SIM\n\n${products.lyca.description}\n\n✓ Standard-, Micro- und Nano-SIM\n✓ Telefonie & SMS\n✓ Mobiles Internet je nach Tarif\n✓ Deutsche Nummer\n\n📦 MENGENPREISE\n10 → 7,00 € / Stück\n50 → 5,00 € / Stück\n100 → 4,50 € / Stück\n200 → 4,00 € / Stück\n250 → 3,80 € / Stück\n500 → 3,50 € / Stück\n\nWähle unten die gewünschte Menge.`;
}

async function sendOrder(order) {
  saveOrder(order);
  const recipients = supportAdminOnly
    ? (resolvedSupportChatId ? [resolvedSupportChatId] : [])
    : Array.from(adminChatIds);
  for (const chatId of recipients) {
    try {
      const result = await sendMessage(chatId, formatOrder(order), { reply_markup: adminOrderKeyboard(order) });
      if (!result.ok) console.error(`Lyca Bot: failed to notify admin ${chatId}: ${result.description || 'unknown Telegram error'}`);
    } catch (err) { console.error(`Lyca Bot: failed to notify admin ${chatId}`, err.message); }
  }
  let customerNotified = false;
  const customerChatId = String(order.telegramChatId || '').trim();
  if (customerChatId) {
    const result = await sendMessage(customerChatId,
      `🧾 BESTELLUNG ERSTELLT\n\nBestellnummer: ${order.orderNumber}\nRechnungsnummer: ${order.invoiceNumber}\nGesamt: ${formatMoney(order.total)}\n\n📌 Zahlungsstatus: UNBEZAHLT\n\nBitte zuerst über die Wallets bezahlen und danach die TXID eingeben. Die Rechnung wird erst nach der Bestätigung durch Lyca_Support freigeschaltet.`,
      { reply_markup: orderKeyboard(order) }
    );
    customerNotified = Boolean(result.ok);
    await sendWalletQRCodes(customerChatId, order);
  }
  return { ok: true, orderNumber: order.orderNumber, botUsername, message: formatOrder(order), adminRecipients: recipients.length, customerNotified, invoiceUrl: botOrderUrl(order.orderNumber), supportUrl: supportUrl(order) };
}

function businessReplyText(text) {
  const t = String(text || '').trim();
  const orderMatch = t.match(/\bLYCA-\d{8}-[A-F0-9]{6}\b/i);
  if (orderMatch) {
    const order = getOrder(orderMatch[0]);
    if (order) return `✅ Ich habe deine Bestellung ${order.orderNumber} gefunden.\n\n${invoiceText(order)}\n\nWenn du weitere Hilfe brauchst, antworte einfach hier.`;
  }
  if (/rechnung|invoice/i.test(t)) return '🧾 Bitte sende mir deine Bestellnummer, z. B. LYCA-20260917-ABC123.';
  if (/bestellung|order|bestell/i.test(t)) return '📦 Bitte sende mir deine Bestellnummer.';
  if (/preis|kosten|sim|shop|kaufen|produkt/i.test(t)) return `🛍️ Hier geht es zum Lyca Webshop: ${publicBaseUrl}`;
  return '👋 Willkommen beim Lyca Support. Nutze die Shop-Schaltflächen oder nenne deine Bestellnummer.';
}

async function handleBusinessConnection(connection) {
  const id = String(connection.id || '');
  if (!id) return;
  businessConnections.set(id, connection);
  if (connection.user?.id != null) businessConnectionUsers.set(String(connection.user.id), id);
}
async function getBusinessConnection(connectionId) {
  const id = String(connectionId || '');
  if (!id) return null;
  const cached = businessConnections.get(id);
  if (cached) return cached;
  const result = await api('getBusinessConnection', { business_connection_id: id });
  if (result.ok && result.result) { businessConnections.set(id, result.result); return result.result; }
  return null;
}
async function handleBusinessMessage(msg) {
  // Telegram sends business_message updates for messages sent on behalf of the
  // connected account as well. Never answer those again or the bot can loop and
  // hit Telegram's rate limit (the observed duplicate-message problem).
  if (msg.sender_business_bot) return;
  if (msg.from?.is_bot) return;
  const connectionId = String(msg.business_connection_id || '');
  if (!connectionId || !msg.chat) return;
  const connection = await getBusinessConnection(connectionId);
  if (connection && connection.is_enabled === false) return;
  if (connection?.rights?.can_reply === false) return;
  const text = String(msg.text || msg.caption || '').trim();
  if (!text) return;
  const reply = businessReplyText(text);
  const result = await sendBusinessMessage(connectionId, msg.chat.id, reply, { reply_markup: businessKeyboard() });
  if (!result.ok) console.error(`Lyca Business reply failed: ${result.description || 'unknown Telegram error'}`);
}

async function showHome(chatId, messageId = null) {
  const text = '👋 WILLKOMMEN BEIM LYCA WEBSHOP\n\n📱 Lyca Mobile Triple-SIM\n🛍️ Produkte direkt ansehen und bestellen\n🛒 Warenkorb verwalten\n🧾 Bestellnummer & Rechnung erhalten\n💬 Persönlicher Support: @' + supportUsername + '\n\nWähle unten eine Funktion:';
  if (messageId) return editMessage(chatId, messageId, text, mainKeyboard());
  return sendMessage(chatId, text, { reply_markup: mainKeyboard() });
}
async function showProducts(chatId, messageId = null) {
  if (messageId) return editMessage(chatId, messageId, '🛍️ PRODUKTE\n\nWähle ein Produkt:', productKeyboard());
  return sendMessage(chatId, '🛍️ PRODUKTE\n\nWähle ein Produkt:', { reply_markup: productKeyboard() });
}
async function showProduct(chatId, messageId = null) {
  if (messageId) return editMessage(chatId, messageId, productText(), quantityKeyboard());
  return sendMessage(chatId, productText(), { reply_markup: quantityKeyboard() });
}
async function showCart(chatId, messageId = null) {
  const text = cartText(chatId);
  const markup = cartKeyboard(cartItems(chatId).length > 0);
  if (messageId) return editMessage(chatId, messageId, text, markup);
  return sendMessage(chatId, text, { reply_markup: markup });
}
function adminPanelKeyboard() {

  return { inline_keyboard: [
    [callback('📥 Offene Zahlungen', 'admin:pending'), callback('📋 Bestellungen', 'admin:orders')],
    [callback('🔄 Aktualisieren', 'admin:panel'), callback('📊 Seitenaufrufe', 'admin:stats')],
    [callback('📡 Bot-Status', 'admin:status')],
    [callback('💳 Wallets', 'wallets'), callback('↩️ Start', 'home')]
  ] };
}
function adminPanelText(chatId) {
  const all = Array.from(orders.values());
  const pending = all.filter(o => o.paymentStatus !== 'BEZAHLT' && o.transactionId);
  const awaitingTx = all.filter(o => o.paymentStatus !== 'BEZAHLT' && !o.transactionId);
  const connections = Array.from(businessConnections.values()).filter(c => c.is_enabled !== false).length;
  return '🛠️ LYCA_SUPPORT · ADMINISTRATOR-PANEL\n\n' +
    '👤 Administrator: @' + supportUsername + '\n' +
    '🆔 Chat-ID: ' + chatId + '\n\n' +
    '📦 Bestellungen im Speicher: ' + all.length + '\n' +
    '🔗 TX-ID zur Prüfung: ' + pending.length + '\n' +
    '⏳ Noch ohne TX-ID: ' + awaitingTx.length + '\n' +
    '🏢 Business-Verbindungen: ' + connections + '\n\n' +
    'Wähle eine Funktion:';
}
async function showAdminPanel(chatId, messageId = null, actorUsername = '') {
  if (!isAdminChat(chatId, actorUsername)) return sendMessage(chatId, '⛔ Nur Lyca_Support ist als Administrator freigeschaltet.');
  const text = adminPanelText(chatId);
  if (messageId) return editMessage(chatId, messageId, text, adminPanelKeyboard());
  return sendMessage(chatId, text, { reply_markup: adminPanelKeyboard() });
}
async function showAdminPending(chatId, messageId = null, actorUsername = '') {
  if (!isAdminChat(chatId, actorUsername)) return sendMessage(chatId, '⛔ Nur Lyca_Support ist als Administrator freigeschaltet.');
  const pending = Array.from(orders.values()).filter(o => o.paymentStatus !== 'BEZAHLT' && o.transactionId);
  if (!pending.length) {
    const text = '📥 OFFENE ZAHLUNGSPRÜFUNGEN\n\nAktuell liegt keine Zahlung mit übermittelter TX-ID zur Prüfung vor.';
    if (messageId) return editMessage(chatId, messageId, text, adminPanelKeyboard());
    return sendMessage(chatId, text, { reply_markup: adminPanelKeyboard() });
  }
  const text = '📥 OFFENE ZAHLUNGSPRÜFUNGEN\n\n' + pending.map(o =>
    '🔢 ' + o.orderNumber + '\n💶 ' + formatMoney(o.total) + '\n🔗 TXID: ' + o.transactionId + '\n👤 ' + o.customer.name
  ).join('\n\n');
  const rows = pending.map(o => [callback('✅ Zahlung bestätigen · ' + o.orderNumber, 'paid:' + o.orderNumber)]);
  rows.push([callback('↩️ Admin-Panel', 'admin:panel')]);
  const markup = { inline_keyboard: rows };
  if (messageId) return editMessage(chatId, messageId, text, markup);
  return sendMessage(chatId, text, { reply_markup: markup });
}
async function showAdminOrders(chatId, messageId = null, actorUsername = '') {
  if (!isAdminChat(chatId, actorUsername)) return sendMessage(chatId, '⛔ Nur Lyca_Support ist als Administrator freigeschaltet.');
  const all = Array.from(orders.values()).slice(-20).reverse();
  const text = all.length
    ? '📋 LETZTE BESTELLUNGEN\n\n' + all.map(o =>
        '🔢 ' + o.orderNumber + ' · ' + o.paymentStatus + '\n💶 ' + formatMoney(o.total) + '\n👤 ' + o.customer.name
      ).join('\n\n')
    : '📋 BESTELLUNGEN\n\nNoch keine Bestellungen im aktuellen Serverprozess.';
  const rows = all.filter(o => o.paymentStatus !== 'BEZAHLT' && o.transactionId)
    .map(o => [callback('✅ Zahlung bestätigen · ' + o.orderNumber, 'paid:' + o.orderNumber)]);
  rows.push([callback('↩️ Admin-Panel', 'admin:panel')]);
  const markup = { inline_keyboard: rows };
  if (messageId) return editMessage(chatId, messageId, text, markup);
  return sendMessage(chatId, text, { reply_markup: markup });
}
async function showAdminStats(chatId, messageId = null, actorUsername = '') {
  if (!isAdminChat(chatId, actorUsername)) return sendMessage(chatId, '⛔ Nur Lyca_Support ist als Administrator freigeschaltet.');
  const stats = typeof statsProvider === 'function' ? await statsProvider() : null;
  const text = stats
    ? '📊 LYCA WEBSHOP · SEITENAUFRUFE\\n\\n👁️ Gesamtaufrufe: ' + Number(stats.totalViews || 0) + '\\n📅 Heute: ' + Number(stats.todayViews || 0) + '\\n🕒 Seit Serverstart: ' + Number(stats.sessionViews || 0)
    : '📊 Seitenaufrufe sind noch nicht verbunden.';
  if (messageId) return editMessage(chatId, messageId, text, adminPanelKeyboard());
  return sendMessage(chatId, text, { reply_markup: adminPanelKeyboard() });
}
async function showAdminStatus(chatId, messageId = null, actorUsername = '') {
  if (!isAdminChat(chatId, actorUsername)) return sendMessage(chatId, '⛔ Nur Lyca_Support ist als Administrator freigeschaltet.');
  const me = await api('getMe');
  const hook = await api('getWebhookInfo');
  const text = '📡 LYCA BOT · STATUS\n\n' +
    '🤖 Bot: @' + botUsername + '\n' +
    '🔐 API: ' + (me.ok ? 'OK' : 'FEHLER') + '\n' +
    '🪝 Webhook: ' + (hook.ok && hook.result?.url ? hook.result.url : 'nicht gesetzt') + '\n' +
    '📨 Warteschlange: ' + (hook.ok ? (hook.result?.pending_update_count || 0) : 'unbekannt') + '\n' +
    '🏢 Business: ' + (me.ok && me.result?.can_connect_to_business ? 'bereit' : 'nicht freigeschaltet');
  if (messageId) return editMessage(chatId, messageId, text, adminPanelKeyboard());
  return sendMessage(chatId, text, { reply_markup: adminPanelKeyboard() });
}

async function showOrders(chatId, messageId = null) {
  const session = getSession(chatId);
  const order = session.lastOrder ? getOrder(session.lastOrder) : null;
  const text = order ? `📋 DEINE LETZTE BESTELLUNG\n\n${invoiceText(order)}` : '📋 BESTELLUNGEN\n\nNoch keine Bestellung in diesem Bot-Chat gespeichert.\n\nWenn du über den Webshop bestellt hast, kannst du die Bestellnummer hier mit /order BESTELLNUMMER aufrufen.';
  if (messageId) return editMessage(chatId, messageId, text, orderKeyboard(order));
  return sendMessage(chatId, text, { reply_markup: orderKeyboard(order) });
}

async function markOrderPaid(order, actorChatId, sourceMessage = null) {
  if (!order) return false;
  const txid = String(order.transactionId || '').trim();
  // A payment can NEVER be confirmed before the customer has submitted a TXID.
  // The administrator must see the TXID and explicitly press the confirmation button.
  if (!txid) {
    if (actorChatId) {
      await sendMessage(actorChatId,
        `⛔ ZAHLUNG NICHT BESTÄTIGT\\n\\nBestellung: ${order.orderNumber}\\n\\nFür diese Bestellung wurde noch keine Transaktions-ID (TXID) vom Kunden übermittelt. Erst TXID eingeben lassen, prüfen und danach „✅ Zahlung bestätigen“ drücken.`,
        { reply_markup: adminOrderKeyboard(order) }
      );
    }
    return false;
  }
  if (order.paymentStatus === 'BEZAHLT') return true;
  order.paymentStatus = 'BEZAHLT';
  order.paidAt = new Date().toLocaleString('de-DE',{timeZone:'Europe/Berlin'});
  const paidText = formatOrder(order) + `\n\n🔗 Transaktions-ID / TXID:\n${txid}\n\n💰 ZAHLUNG BESTÄTIGT\n🕒 Bestätigt: ${order.paidAt}\n\n🧾 RECHNUNG\n${invoiceText(order)}`;

  // Entfernt den Bestätigungsbutton beim Administrator nach der Bestätigung.
  if (sourceMessage?.message_id) {
    await editMessage(sourceMessage.chat.id, sourceMessage.message_id, paidText, paidInvoiceKeyboard(order));
  } else if (actorChatId) {
    await sendMessage(actorChatId, paidText, { reply_markup: paidInvoiceKeyboard(order) });
  }

  // Der Kunde erhält erst nach der manuellen Bestätigung die Rechnung.
  const customerChatId = String(order.telegramChatId || '').trim();
  if (customerChatId) {
    await sendMessage(customerChatId,
      `✅ ZAHLUNG BESTÄTIGT\n\nBestellnummer: ${order.orderNumber}\nRechnungsnummer: ${order.invoiceNumber}\nGesamt: ${formatMoney(order.total)}\n\nDie Zahlung wurde vom Administrator bestätigt.\n\n🧾 RECHNUNG\n${invoiceText(order)}`,
      { reply_markup: paidInvoiceKeyboard(order) }
    );
  }

  // Nach der Bestätigung erhält Lyca_Support die fertige Rechnung ebenfalls.
  if (resolvedSupportChatId) {
    await sendMessage(resolvedSupportChatId,
      `🧾 RECHNUNG – LYCA_SUPPORT\n\n${invoiceText(order)}\n\n💰 ZAHLUNG BESTÄTIGT\nTXID: ${txid}\nBestätigt: ${order.paidAt}`,
      { reply_markup: paidInvoiceKeyboard(order) }
    );
  }
  return true;
}
async function handleCallback(q) {
  if (!rememberOnce(seenCallbackIds, q.id, 10 * 60 * 1000)) return;
  await api('answerCallbackQuery', { callback_query_id: q.id });
  const chatId = q.message?.chat?.id;
  const messageId = q.message?.message_id;
  if (!chatId) return;
  const data = String(q.data || '');
  if (data === 'home') return showHome(chatId, messageId);
  if (data === 'products') return showProducts(chatId, messageId);
  if (data === 'product:lyca') return showProduct(chatId, messageId);
  if (data === 'cart') return showCart(chatId, messageId);
  if (data === 'cart:clear') { clearCart(chatId); return showCart(chatId, messageId); }
  if (data === 'orders') return showOrders(chatId, messageId);
  const callbackUsername = String(q.from?.username || '').replace(/^@/, '');
  if (data === 'admin:panel') return showAdminPanel(chatId, messageId, callbackUsername);
  if (data === 'admin:pending') return showAdminPending(chatId, messageId, callbackUsername);
  if (data === 'admin:orders') return showAdminOrders(chatId, messageId, callbackUsername);
  if (data === 'admin:stats') return showAdminStats(chatId, messageId, callbackUsername);
  if (data === 'admin:status') return showAdminStatus(chatId, messageId, callbackUsername);
  if (data === 'wallets') return sendWalletQRCodes(chatId, null);
  if (data.startsWith('wallets:')) {
    const order = getOrder(data.slice(8));
    return sendWalletQRCodes(chatId, order);
  }
  if (data.startsWith('wallet:')) {
    const coin = data.split(':')[1];
    if (!wallets[coin]) return sendMessage(chatId, walletsText(), { reply_markup: walletKeyboard() });
    return sendMessage(chatId, walletText(coin), { reply_markup: walletKeyboard() });
  }
  if (data === 'checkout') {
    const cart = cartItems(chatId);
    if (!cart.length) return sendMessage(chatId, '🛒 Dein Warenkorb ist leer. Wähle zuerst ein Produkt.', { reply_markup: productKeyboard() });
    return sendMessage(
      chatId,
      '🧾 CHECKOUT\n\n' + cartText(chatId) + '\n\n👤 Öffne die Kasse und gib Name, E-Mail und Anschrift in einem Formular ein.\n\n✅ Die Bestellung wird danach direkt in diesem Telegram-Chat weitergeführt.',
      { reply_markup: { inline_keyboard: [[telegramCheckoutButton(chatId)], [callback('❌ Kasse abbrechen', 'cart')]] } }
    );
  }
  if (data === 'checkout:cancel') return showCart(chatId, messageId);
  if (data.startsWith('txid_input:')) {
    const order = getOrder(data.slice(11));
    if (!order) return sendMessage(chatId, 'Bestellung nicht gefunden.');
    if (order.paymentStatus === 'BEZAHLT') return sendMessage(chatId, `Die Bestellung ${order.orderNumber} ist bereits als bezahlt bestätigt.`);
    const session = getSession(chatId);
    session.pendingPaymentOrder = order.orderNumber;
    return sendMessage(chatId,
      `🔗 TRANSAKTIONS-ID EINGEBEN\n\nBestellung: ${order.orderNumber}\nRechnungsnummer: ${order.invoiceNumber}\nBetrag: ${formatMoney(order.total)}\n\nBitte gib jetzt die vollständige Transaktions-ID / TXID in das Eingabefeld ein und sende sie mit dem Senden-Pfeil ab.\n\n⚠️ Erst nach dem Absenden wird die TXID gespeichert und an Lyca_Support zur Prüfung weitergeleitet.`,
      { reply_markup: { force_reply: true, input_field_placeholder: 'TXID / Transaktions-ID eingeben' } }
    );
  }

  if (data.startsWith('paid_invoice:')) {
    const order = getOrder(data.slice(13));
    if (!order) return sendMessage(chatId, 'Bestellung nicht gefunden.');
    if (order.paymentStatus !== 'BEZAHLT') {
      return sendMessage(chatId, '⏳ Die Zahlung ist noch nicht bestätigt. Die Rechnung wird erst nach der manuellen Bestätigung durch Lyca_Support freigeschaltet.');
    }
    return sendMessage(chatId, invoiceText(order), { reply_markup: paidInvoiceKeyboard(order) });
  }
  if (data.startsWith('paid:')) {
    const order = getOrder(data.slice(5));
    const actorUsername = String(q.from?.username || '').replace(/^@/, '');
    const isAdmin = isAdminChat(chatId, actorUsername);
    if (!isAdmin) return sendMessage(chatId, '⛔ Diese Aktion ist nur für den Lyca Administrator freigeschaltet.');
    if (!order) return sendMessage(chatId, 'Bestellung nicht gefunden.');
    if (!String(order.transactionId || '').trim()) {
      return sendMessage(chatId,
        `⛔ Zahlung kann noch nicht bestätigt werden.\n\nBestellung: ${order.orderNumber}\nEs wurde noch keine TXID vom Kunden übermittelt.`,
        { reply_markup: adminOrderKeyboard(order) }
      );
    }
    await markOrderPaid(order, chatId, q.message || null);
    return;
  }
  if (data.startsWith('add:')) {
    const [, productId, qtyText] = data.split(':');
    const qty = Number(qtyText);
    if (addToCart(chatId, productId, qty)) {
      return editMessage(chatId, messageId, `✅ Zum Warenkorb hinzugefügt\n\n${products[productId].name}\nMenge: ${qty}\nPreis: ${formatMoney(products[productId].prices[qty])} / Stück\n\n🛒 Warenkorb gesamt: ${formatMoney(cartTotal(chatId))}`, { inline_keyboard: [[callback('🛒 Warenkorb öffnen', 'cart')], [callback('➕ Weiter einkaufen', 'products')], [webAppButton()], [callback('↩️ Start', 'home')]] });
    }
    return showProduct(chatId, messageId);
  }
  if (data.startsWith('invoice:')) {
    const order = getOrder(data.slice(8));
    return sendMessage(chatId, order ? invoiceText(order) : 'Rechnung nicht gefunden.', { reply_markup: orderKeyboard(order) });
  }
  if (data.startsWith('order:')) {
    const order = getOrder(data.slice(6));
    return sendMessage(chatId, order ? formatOrder(order) : 'Bestellung nicht gefunden.', { reply_markup: orderKeyboard(order) });
  }
}

async function handleUpdate(update) {
  if (update.update_id != null && !rememberOnce(seenUpdateIds, update.update_id, 10 * 60 * 1000)) return;
  if (update.business_connection) { await handleBusinessConnection(update.business_connection); return; }
  if (update.business_message) { await handleBusinessMessage(update.business_message); return; }
  if (update.edited_business_message || update.deleted_business_messages) return;
  if (update.callback_query) return handleCallback(update.callback_query);

  const msg = update.message;
  if (!msg || !msg.chat) return;
  console.log('Lyca Telegram update:', JSON.stringify({
    update_id: update.update_id,
    chat_id: msg.chat.id,
    text: String(msg.text || '').slice(0, 120)
  }));
  const chatId = msg.chat.id;
  const text = String(msg.text || '').trim();
  const parts = text.split(/\s+/);
  const command = parts[0].split('@')[0];
  const senderUsername = String(msg.from?.username || '').replace(/^@/, '');
  const isSupportAdmin = isAdminChat(chatId, senderUsername);
  if (isSupportAdmin) {
    adminChatIds.add(String(chatId));
    resolvedSupportChatId = String(chatId);
  }
  const session = getSession(chatId);

  // Direct Telegram checkout: collect the same customer data as the webshop,
  // create the order in this bot process, and immediately issue the invoice/wallets.
  if (session.checkout && text && !text.startsWith('/')) {
    const step = session.checkout.step;
    if (step === 'name') {
      if (text.length < 2) return sendMessage(chatId, '⚠️ Bitte gib deinen vollständigen Namen ein.');
      session.checkout.name = text;
      session.checkout.step = 'email';
      return sendMessage(chatId, '📧 Danke. Bitte gib jetzt deine E-Mail-Adresse ein.');
    }
    if (step === 'email') {
      if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(text)) return sendMessage(chatId, '⚠️ Bitte gib eine gültige E-Mail-Adresse ein.');
      session.checkout.email = text;
      session.checkout.step = 'address';
      return sendMessage(chatId, '📍 Danke. Bitte gib jetzt deine vollständige Anschrift ein (Straße, Hausnummer, PLZ, Ort).');
    }
    if (step === 'address') {
      if (text.length < 5) return sendMessage(chatId, '⚠️ Bitte gib deine vollständige Anschrift ein.');
      session.checkout.address = text;
      const cart = cartItems(chatId);
      if (!cart.length) {
        session.checkout = null;
        return sendMessage(chatId, '🛒 Dein Warenkorb ist leer. Bitte wähle zuerst ein Produkt.', { reply_markup: productKeyboard() });
      }
      const orderNumber = makeTelegramOrderNumber();
      const invoiceNumber = orderNumber.replace(/^LYCA-/, 'LYCA-RE-');
      const items = cart.map(x => ({
        name: x.name,
        qty: Math.max(1, Number(x.qty) || 1),
        price: Math.max(0, Number(x.unitPrice) || 0)
      }));
      const total = items.reduce((sum, x) => sum + x.price * x.qty, 0);
      const order = {
        orderNumber,
        invoiceNumber,
        createdAt: new Date().toLocaleString('de-DE', {timeZone:'Europe/Berlin'}),
        customer: {
          name: session.checkout.name,
          email: session.checkout.email,
          address: session.checkout.address
        },
        telegramChatId: String(chatId),
        items,
        total,
        paymentStatus: 'UNBEZAHLT'
      };
      session.checkout = null;
      clearCart(chatId);
      session.lastOrder = orderNumber;
      try {
        const result = await sendOrder(order);
        return sendMessage(chatId,
          '✅ BESTELLUNG ERSTELLT\\n\\n' +
          'Bestellnummer: ' + order.orderNumber + '\\n' +
          'Rechnungsnummer: ' + order.invoiceNumber + '\\n' +
          'Gesamt: ' + formatMoney(order.total) + '\\n' +
          '📌 Zahlungsstatus: UNBEZAHLT\\n\\n' +
          'Die Rechnung und die Wallet-/QR-Codes wurden direkt in diesem Telegram-Chat gesendet.\\n' +
          '🔗 Du musst den Webshop nicht öffnen.',
          { reply_markup: orderKeyboard(order) }
        );
      } catch (err) {
        saveOrder(order);
        return sendMessage(chatId, '⚠️ Bestellung erstellt, aber die Benachrichtigung konnte nicht vollständig gesendet werden. Bestellnummer: ' + orderNumber, { reply_markup: orderKeyboard(order) });
      }
    }
  }

  // Customer must provide the transaction ID before the administrator can review the payment.
  if (session.pendingPaymentOrder && text && !text.startsWith('/')) {
    const order = getOrder(session.pendingPaymentOrder);
    if (order && order.paymentStatus !== 'BEZAHLT') {
      const txid = text.trim();
      if (txid.length < 6) {
        return sendMessage(chatId, '⚠️ Die Transaktions-ID ist zu kurz. Bitte sende die vollständige TXID.');
      }
      order.transactionId = txid;
      order.paymentReportedAt = new Date().toLocaleString('de-DE',{timeZone:'Europe/Berlin'});
      session.pendingPaymentOrder = null;

      const notice = `🔔 ZAHLUNG GEMELDET – PRÜFUNG DURCH LYCA_SUPPORT\\n\\n🧾 RECHNUNG / BESTELLBESTÄTIGUNG\\n${invoiceText(order)}\\n\\n📌 Zahlungsstatus: UNBEZAHLT\\n🔗 Transaktions-ID / TXID: ${order.transactionId}\\n🕒 Kunde meldete Zahlung: ${order.paymentReportedAt}\\n\\nBitte die TXID prüfen. Erst nach „✅ Zahlung bestätigen“ wird die Rechnung bei Kunde und Lyca_Support auf BEZAHLT aktualisiert.`;
      const recipients = supportAdminOnly
        ? (resolvedSupportChatId ? [String(resolvedSupportChatId)] : (isSupportAdmin ? [String(chatId)] : []))
        : (supportChatId ? [String(supportChatId)] : Array.from(adminChatIds));
      for (const adminId of recipients) {
        await sendMessage(adminId, notice, { reply_markup: adminOrderKeyboard(order) });
      }
      if (!recipients.length) {
        return sendMessage(
          chatId,
          '⚠️ TXID gespeichert, aber Lyca_Support ist noch nicht als Administrator erreichbar.\\n\\n' +
          '👉 @' + supportUsername + ' muss den Bot einmal öffnen und „Start“ bzw. /start admin drücken. Danach wird dieses Telegram-Konto automatisch als Administrator registriert und alle offenen TXIDs werden an Lyca_Support weitergeleitet.',
          { reply_markup: { inline_keyboard: [[urlButton('🛠️ Lyca_Support · Admin aktivieren', 'https://t.me/' + botUsername + '?start=admin')]] } }
        );
      }
      return sendMessage(chatId, `⏳ TX-ID ÜBERMITTELT\\n\\nBestellung: ${order.orderNumber}\\nRechnungsnummer: ${order.invoiceNumber}\\nTXID: ${order.transactionId}\\nZahlungsstatus: UNBEZAHLT\\n\\nDie Transaktions-ID wurde direkt an @${supportUsername} zur Prüfung gesendet. Lyca_Support muss die Zahlung zuerst bestätigen. Danach erhältst du automatisch die aktualisierte Rechnung mit TXID und Status BEZAHLT.`);
    }
    session.pendingPaymentOrder = null;
  }

  if (command === '/admin') {
    if (isSupportAdmin) {
      adminChatIds.add(String(chatId));
      resolvedSupportChatId = String(chatId);
      return sendMessage(chatId, '🛠️ LYCA_SUPPORT · ADMINISTRATOR AKTIVIERT\\n\\n✅ Dieses Telegram-Konto ist registriert. Neue TXIDs und Bestellungen werden direkt hierher weitergeleitet.', { reply_markup: { inline_keyboard: [[callback('🛠️ Admin-Panel', 'admin:panel')]] } });
    }
    return sendMessage(chatId, '⛔ Administratorzugriff ist nur für @' + supportUsername + ' freigeschaltet.');
  }
  if (command === '/start') {
    const startParam = String(parts[1] || '').trim();
    if (startParam && startParam.toLowerCase() === 'admin') {
      // One-time administrator registration: Telegram only exposes a user's private
      // chat ID after that user has opened/started the bot. When @Lyca_Support
      // starts the bot, register that chat immediately and make the admin panel available.
      if (isSupportAdmin) {
        adminChatIds.add(String(chatId));
        resolvedSupportChatId = String(chatId);
        session.lastOrder = session.lastOrder || null;
        return sendMessage(chatId,
          '🛠️ LYCA_SUPPORT · ADMINISTRATOR AKTIVIERT\\n\\n' +
          '✅ Dieses Telegram-Konto ist jetzt als Administrator registriert.\\n' +
          '👤 @' + supportUsername + '\\n' +
          '🆔 Chat-ID: ' + chatId + '\\n\\n' +
          'Neue Bestellungen und TX-ID-Prüfungen werden ab jetzt hierher weitergeleitet.',
          { reply_markup: adminPanelKeyboard() }
        );
      }
      return sendMessage(chatId, '⛔ Der Administrator-Link kann nur mit @' + supportUsername + ' aktiviert werden.');
    }
    if (startParam && startParam !== 'wallets') {
      for (let i=0; i<8 && !getOrder(startParam); i++) {
        await new Promise(resolve=>setTimeout(resolve,250));
      }
    }
    if (startParam.toLowerCase() === 'wallets') {
      return sendMessage(chatId, walletsText(), { reply_markup: walletKeyboard() });
    }
    const deepLinkedOrder = getOrder(startParam);
    if (deepLinkedOrder) deepLinkedOrder.telegramChatId = String(chatId);
    const latestOrder = deepLinkedOrder || Array.from(orders.values())
      .filter(o => String(o.telegramChatId || '') === String(chatId))
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0] || null;
    session.lastOrder = latestOrder?.orderNumber || session.lastOrder || null;
    if (isSupportAdmin) {
      adminChatIds.add(String(chatId));
      resolvedSupportChatId = String(chatId);
    }
    if (latestOrder) {
      return sendMessage(
        chatId,
        `🧾 LYCA WEBSHOP · BESTELLUNG ERKANNT\n\nBestellnummer: ${latestOrder.orderNumber}\nRechnungsnummer: ${latestOrder.invoiceNumber}\nGesamt: ${formatMoney(latestOrder.total)}\n\n📌 Zahlungsstatus: ${latestOrder.paymentStatus === 'BEZAHLT' ? 'BEZAHLT' : 'UNBEZAHLT'}\n\n${latestOrder.paymentStatus === 'BEZAHLT' ? 'Die Zahlung ist bestätigt. Deine Rechnung ist verfügbar.' : 'Die Bestellung ist bereits erstellt. Bezahle jetzt, gib die TXID ein und warte auf die Bestätigung durch Lyca_Support. Du musst die Produkte nicht erneut auswählen.'}`,
        { reply_markup: orderKeyboard(latestOrder) }
      );
    }
    if (isSupportAdmin) {
      return sendMessage(
        chatId,
        '🛠️ LYCA SUPPORT · ADMIN\n\nDu bist als Support-Administrator verbunden. Neue Webshop-Bestellungen werden automatisch an dich zur Zahlungsprüfung weitergeleitet.\n\n🆔 Deine Chat-ID: ' + chatId + '\n\nÖffne jetzt das Administrator-Panel für offene TX-ID-Prüfungen und Bestellungen.',
        { reply_markup: adminPanelKeyboard() }
      );
    }
    return showHome(chatId);
  }
  if (command === '/myid') return sendMessage(chatId, `🆔 Deine Telegram Chat-ID: ${chatId}`, { reply_markup: mainKeyboard() });
  if (command === '/shop') return showProducts(chatId);
  if (command === '/support') return sendMessage(chatId, `💬 LYCA SUPPORT\n\n@${supportUsername}`, { reply_markup: mainKeyboard() });
  if (command === '/order') {
    const order = getOrder(parts[1]);
    if (order) session.lastOrder = order.orderNumber;
    return sendMessage(chatId, order ? formatOrder(order) : 'Bestellung nicht gefunden.', { reply_markup: orderKeyboard(order) });
  }
  if (command === '/invoice') {
    const order = getOrder(parts[1] || session.lastOrder);
    return sendMessage(chatId, order ? invoiceText(order) : 'Keine Bestellung gefunden.', { reply_markup: orderKeyboard(order) });
  }
  if (/^(test|hallo|hi|hey)$/i.test(text)) return showHome(chatId);
  if (/warenkorb|cart/i.test(text)) return showCart(chatId);
  if (/produkte|produkt|sim/i.test(text)) return showProducts(chatId);
  if (/bestellung|order/i.test(text)) return showOrders(chatId);
  if (/support|hilfe/i.test(text)) return sendMessage(chatId, `💬 LYCA SUPPORT\n\n@${supportUsername}`, { reply_markup: mainKeyboard() });
  return sendMessage(chatId, '👋 Willkommen beim Lyca Webshop. Nutze die Schaltflächen unten, um Produkte, Warenkorb, Bestellung und Support zu öffnen.', { reply_markup: mainKeyboard() });
}

async function configure(baseUrl = publicBaseUrl) {
  if (!token) return { enabled: false, reason: 'TELEGRAM_BOT_TOKEN fehlt' };
  const me = await api('getMe');
  if (!me.ok) return { enabled: false, reason: me.description || 'Telegram token rejected' };
  if (me.result?.username) botUsername = String(me.result.username).replace(/^@/, '');
  // If the support account has already opened/authorized this bot, resolve it
  // automatically so new orders reach Support without a manually copied chat ID.
  try {
    const supportChat = await api('getChat', { chat_id: '@' + supportUsername });
    if (supportChat.ok && supportChat.result?.id != null) {
      // Lyca_Support is the administrator account.
      resolvedSupportChatId = String(supportChat.result.id);
      adminChatIds.add(resolvedSupportChatId);
    }
  } catch {}
  if (baseUrl) {
    const webhookUrl = `${baseUrl}/api/telegram-webhook`;
    const body = { url: webhookUrl, allowed_updates: ['message', 'callback_query', 'business_connection', 'business_message', 'edited_business_message', 'deleted_business_messages'], drop_pending_updates: true };
    if (webhookSecret) body.secret_token = webhookSecret;
    const hook = await api('setWebhook', body);
    if (!hook.ok) return { enabled: false, reason: hook.description || 'setWebhook failed' };
  }
  await api('setMyCommands', { commands: [
    { command: 'start', description: 'Shop starten' },
    { command: 'shop', description: 'Produkte öffnen' },
    { command: 'order', description: 'Bestellung anzeigen' },
    { command: 'invoice', description: 'Rechnung anzeigen' },
    { command: 'support', description: 'Support kontaktieren' },
    { command: 'wallets', description: 'Zahlungs-Wallets anzeigen' },
    { command: 'myid', description: 'Telegram Chat-ID anzeigen' },
    { command: 'admin', description: 'Administrator-Panel für Lyca_Support' }
  ] });
  if (baseUrl) await api('setChatMenuButton', { menu_button: { type: 'web_app', text: '🛍️ Shop', web_app: { url: baseUrl } } });
  return { enabled: true, username: me.result.username, webhook: `${baseUrl}/api/telegram-webhook`, businessMode: Boolean(me.result?.can_connect_to_business), canConnectToBusiness: Boolean(me.result?.can_connect_to_business), miniAppUrl: baseUrl };
}

module.exports = {
  enabled: Boolean(token),
  getUsername: () => botUsername,
  tokenConfigured: Boolean(token),
  username: botUsername,
  sendOrder,
  handleUpdate,
  configure,
  setStatsProvider: (fn) => { statsProvider = fn; },
  getOrder,
  getOrders: () => Array.from(orders.values()),
  invoiceText,
  webhookSecret,
  supportUsername,
  supportChatId,
  botOrderUrl,
  getCartCheckout,
  getBusinessStatus: () => ({
    connections: Array.from(businessConnections.values()).map(c => ({
      id: c.id,
      user: c.user ? { id: c.user.id, username: c.user.username || '', firstName: c.user.first_name || '' } : null,
      is_enabled: c.is_enabled,
      rights: c.rights || {}
    }))
  })
};
