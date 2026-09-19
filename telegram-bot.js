const token = String(
  process.env.TELEGRAM_BOT_TOKEN ||
  process.env.TELEGRAM_TOKEN ||
  process.env.TELEGRAM_API_TOKEN ||
  process.env.BOT_TOKEN ||
  ''
).trim();
let botUsername = String(process.env.TELEGRAM_BOT_USERNAME || 'Lyca_webshop2_bot').replace(/^@/, '');
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
const businessConnectionUsers = new Map();
const cryptoPayments = new Map();

const products = {
  lyca: {
    id: 'lyca',
    name: 'Lyca Mobile Triple-SIM',
    description: '3-in-1 SIM (Standard, Micro und Nano) · Telefonie, SMS und mobiles Internet.',
    prices: { 10: 7, 50: 5, 100: 4.5, 200: 4, 250: 3.8, 500: 3.5 }
  }
};


async function getCryptoPriceEur(coin) {
  const symbol = { BTC:'BTC', SOL:'SOL', BNB:'BNB' }[coin];
  if (!symbol) throw new Error('Unbekannte Kryptowährung');
  const urls = [
    `https://data-api.binance.vision/api/v3/ticker/price?symbol=${symbol}EUR`,
    `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}EUR`
  ];
  for (const url of urls) {
    try {
      const r = await fetch(url);
      const data = await r.json();
      const price = Number(data?.price);
      if (r.ok && Number.isFinite(price) && price > 0) return price;
    } catch {}
  }
  throw new Error('Krypto-Kurs konnte nicht abgerufen werden.');
}
function cryptoDecimals(coin) { return coin === 'SOL' ? 9 : 8; }
async function createCryptoPayment(chatId, coin) {
  const session = getSession(chatId);
  const order = session.lastOrder ? getOrder(session.lastOrder) : null;
  if (!order) return { ok:false, description:'Keine Bestellung im Chat ausgewählt. Öffne zuerst deine Bestellung.' };
  if (order.paymentStatus === 'BEZAHLT') return { ok:false, description:'Diese Bestellung ist bereits bezahlt.' };
  const priceEur = await getCryptoPriceEur(coin);
  const decimals = cryptoDecimals(coin);
  const amount = Number((order.total / priceEur).toFixed(decimals));
  if (!(amount > 0)) return { ok:false, description:'Zahlungsbetrag konnte nicht berechnet werden.' };
  const intent = { orderNumber:order.orderNumber, chatId:String(chatId), coin, wallet:wallets[coin], eurTotal:Number(order.total), cryptoAmount:amount, priceEur, createdAt:Date.now(), status:'UNBEZAHLT' };
  cryptoPayments.set(order.orderNumber, intent);
  return { ok:true, intent };
}
function getPendingCryptoPayments() { return Array.from(cryptoPayments.values()).filter(p => p.status === 'UNBEZAHLT'); }
async function markOrderPaid(orderNumber, payment) {
  const order = getOrder(orderNumber);
  if (!order || order.paymentStatus === 'BEZAHLT') return false;
  order.paymentStatus = 'BEZAHLT';
  order.paymentMethod = payment.coin;
  order.paymentTxId = payment.txid;
  order.paidAt = new Date().toLocaleString('de-DE',{timeZone:'Europe/Berlin'});
  const intent = cryptoPayments.get(orderNumber);
  if (intent) { intent.status='BEZAHLT'; intent.txid=payment.txid; intent.detectedAt=Date.now(); }
  const msg = `✅ ZAHLUNG BEZAHLT\\n\\n🔢 Bestellung: ${order.orderNumber}\\n💳 Zahlungsmethode: ${payment.coin}\\n🔗 TXID: ${payment.txid}\\n📅 Bezahlt: ${order.paidAt}\\n\\n${invoiceText(order)}`;
  const customerChatId = String(order.telegramChatId || intent?.chatId || '').trim();
  if (customerChatId) await sendMessage(customerChatId, msg, { reply_markup: orderKeyboard(order) });
  for (const adminId of adminChatIds) await sendMessage(adminId, msg, { reply_markup: orderKeyboard(order) });
  return true;
}

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
  const text = order ? `Hallo Lyca Support, ich brauche Hilfe zu meiner Bestellung ${order.orderNumber}.\n\n${invoiceText(order)}` : 'Hallo Lyca Support, ich brauche Hilfe zu meiner Lyca-Webshop-Bestellung.';
  return `https://t.me/${supportUsername}?text=${encodeURIComponent(text)}`;
}
function webAppButton() { return { text: '🛍️ Shop öffnen', web_app: { url: publicBaseUrl } }; }
function urlButton(text, url) { return { text, url }; }
function callback(text, data) { return { text, callback_data: data }; }

function mainKeyboard() {
  return { inline_keyboard: [
    [callback('🛍️ Produkte', 'products'), callback('🛒 Warenkorb', 'cart')],
    [callback('📋 Bestellung', 'orders'), callback('🤖 KI-Assistent', 'ai')],
    [webAppButton()],
    [urlButton('❓ Support', `https://t.me/${supportUsername}`)]
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
function cryptoPaymentKeyboard() {
  return { inline_keyboard: [
    [callback('₿ Bitcoin bezahlen', 'pay:btc')],
    [callback('◎ Solana bezahlen', 'pay:sol')],
    [callback('◈ BNB Smart Chain bezahlen', 'pay:bnb')],
    [callback('🛒 Warenkorb', 'cart'), callback('↩️ Start', 'home')]
  ] };
}
function cartKeyboard(hasItems) {
  const rows = [];
  if (hasItems) rows.push([callback('✅ Zur Kasse', 'checkout')], [callback('🛍️ Weiter einkaufen', 'products')], [callback('🗑️ Warenkorb leeren', 'cart:clear')]);
  else rows.push([callback('🛍️ Produkte anzeigen', 'products')]);
  rows.push([webAppButton(), callback('↩️ Start', 'home')]);
  return { inline_keyboard: rows };
}
function orderKeyboard(order) {
  const rows = [];
  if (order) rows.push([callback('🧾 Rechnung', `invoice:${order.orderNumber}`)], [callback('🛒 Shop öffnen', 'products')]);
  rows.push([webAppButton(), urlButton('❓ Support', `https://t.me/${supportUsername}`)], [callback('↩️ Start', 'home')]);
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
const openaiApiKey = String(process.env.OPENAI_API_KEY || '').trim();
const openaiModel = String(process.env.OPENAI_MODEL || 'gpt-5.6-luna').trim();
const aiEnabled = String(process.env.AI_ENABLED || 'true').toLowerCase() !== 'false';
const aiSessions = new Map();

function getAiHistory(chatId) {
  const key = String(chatId);
  if (!aiSessions.has(key)) aiSessions.set(key, []);
  return aiSessions.get(key);
}

async function openaiReply(chatId, userText) {
  if (!aiEnabled || !openaiApiKey) return null;
  const history = getAiHistory(chatId);
  history.push({ role: 'user', content: String(userText || '').slice(0, 8000) });
  const recent = history.slice(-12);
  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${openaiApiKey}`
      },
      body: JSON.stringify({
        model: openaiModel,
        instructions: 'Du bist der KI-Assistent des Lyca Webshops. Antworte auf Deutsch, freundlich und präzise. Hilf bei Shop, Produkten, Bestellung, Rechnung und allgemeinem Support. Erfinde keine Bestell-, Zahlungs- oder Kontodaten. Wenn eine konkrete Bestellung benötigt wird, verlange die Bestellnummer. Du bist ein Support-Assistent und behauptest nicht, ein menschlicher Mitarbeiter zu sein.',
        input: recent,
        max_output_tokens: 700
      })
    });
    const data = await response.json();
    if (!response.ok) {
      console.error('OpenAI API error:', data?.error?.message || `HTTP ${response.status}`);
      return null;
    }
    const answer = String(data.output_text || '').trim();
    if (!answer) return null;
    history.push({ role: 'assistant', content: answer });
    if (history.length > 20) history.splice(0, history.length - 20);
    return answer;
  } catch (err) {
    console.error('OpenAI request failed:', err.message || err);
    return null;
  }
}
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
function productText() {
  return `📱 LYCA MOBILE TRIPLE-SIM\n\n${products.lyca.description}\n\n✓ Standard-, Micro- und Nano-SIM\n✓ Telefonie & SMS\n✓ Mobiles Internet je nach Tarif\n✓ Deutsche Nummer\n\n📦 MENGENPREISE\n10 → 7,00 € / Stück\n50 → 5,00 € / Stück\n100 → 4,50 € / Stück\n200 → 4,00 € / Stück\n250 → 3,80 € / Stück\n500 → 3,50 € / Stück\n\nWähle unten die gewünschte Menge.`;
}
function checkoutText(chatId) {
  const cart = cartItems(chatId);
  if (!cart.length) return '🛒 Dein Warenkorb ist leer. Wähle zuerst ein Produkt.';
  return `🧾 KASSE · ZUSAMMENFASSUNG

${cart.map(x => `• ${x.name} · ${x.qty} Stück · ${formatMoney(x.unitPrice)} / Stück`).join('\n')}

────────────────
💶 Gesamt: ${formatMoney(cartTotal(chatId))}

💳 ZAHLUNG PER KRYPTO

₿ Bitcoin:
${wallets.BTC}

◎ Solana:
${wallets.SOL}

◈ BNB Smart Chain:
${wallets.BNB}

⚠️ Nur das passende Netzwerk für die jeweilige Adresse verwenden.

Für die vollständige Bestellung mit Name, E-Mail und Anschrift öffnest du jetzt den Lyca-Webshop.`;
}

async function sendOrder(order) {
  saveOrder(order);
  console.log(`Lyca Bot: new order ${order.orderNumber}`);
  const recipients = Array.from(adminChatIds);
  if (!recipients.length) console.error('Lyca Bot: no admin recipients configured — Lyca_Support must send /start first or TELEGRAM_SUPPORT_CHAT_ID must be set.');
  for (const chatId of recipients) {
    try {
      const result = await sendMessage(chatId, formatOrder(order), { reply_markup: orderKeyboard(order) });
      if (!result.ok) console.error(`Lyca Bot: failed to notify admin ${chatId}: ${result.description || 'unknown Telegram error'}`);
    } catch (err) { console.error(`Lyca Bot: failed to notify admin ${chatId}`, err.message); }
  }
  let customerNotified = false;
  const customerChatId = String(order.telegramChatId || '').trim();
  if (customerChatId) {
    try {
      const customerMessage = `✅ BESTELLUNG ERFOLGREICH ERSTELLT\n\n🔢 Bestellnummer: ${order.orderNumber}\n🧾 Rechnungsnummer: ${order.invoiceNumber}\n📅 ${order.createdAt}\n\n${invoiceText(order)}\n\n📌 Zahlungsstatus: ${order.paymentStatus}\n\nDeine Bestellung und Rechnung sind jetzt direkt in Telegram verfügbar.`;
      const result = await sendMessage(customerChatId, customerMessage, { reply_markup: orderKeyboard(order) });
      customerNotified = Boolean(result.ok);
      if (!result.ok) console.error(`Lyca Bot: failed to send customer confirmation: ${result.description || 'unknown Telegram error'}`);
    } catch (err) { console.error('Lyca Bot: customer confirmation failed', err.message); }
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
  if (/rechnung|invoice/i.test(t)) return '🧾 Gerne. Bitte sende mir deine Bestellnummer, z. B. LYCA-20260917-ABC123.';
  if (/bestellung|order|bestell/i.test(t)) return '📦 Gerne helfe ich dir mit deiner Bestellung. Bitte sende mir deine Bestellnummer.';
  if (/preis|kosten|sim|shop|kaufen|produkt/i.test(t)) return `🛍️ Hier geht es zum Lyca Webshop: ${publicBaseUrl}`;
  return '👋 Hallo! Willkommen beim Lyca Support. Ich helfe dir bei Produkten, Warenkorb, Bestellung und Rechnung. Bitte nutze die Shop-Schaltflächen oder nenne deine Bestellnummer.';
}

async function handleBusinessConnection(connection) {
  const id = String(connection.id || '');
  if (!id) return;
  businessConnections.set(id, connection);
  if (connection.user?.id != null) businessConnectionUsers.set(String(connection.user.id), id);
  console.log(`Lyca Business connection ${connection.is_enabled ? 'enabled' : 'disabled'} for ${connection.user?.username || connection.user?.id || 'unknown user'} (${id}) rights=${JSON.stringify(connection.rights || {})}`);
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
  const connectionId = String(msg.business_connection_id || '');
  if (!connectionId || !msg.chat) return;
  const connection = await getBusinessConnection(connectionId);
  if (connection && connection.is_enabled === false) return;
  if (connection?.rights?.can_reply === false) {
    console.warn(`Lyca Business message received but can_reply=false for ${connectionId}`);
    return;
  }
  const text = String(msg.text || msg.caption || '').trim();
  if (!text) return;
  let reply = businessReplyText(text);
  if (!/LYCA-\d{8}-[A-F0-9]{6}/i.test(text) && !/rechnung|invoice|bestellung|order|preis|kosten|sim|shop|kaufen|produkt/i.test(text)) {
    const ai = await openaiReply(`business:${connectionId}:${msg.chat.id}`, text);
    if (ai) reply = `🤖 ${ai}`;
  }
  const result = await sendBusinessMessage(connectionId, msg.chat.id, reply, { reply_markup: mainKeyboard() });
  if (!result.ok) console.error(`Lyca Business reply failed: ${result.description || 'unknown Telegram error'}`);
  if (connection?.rights?.can_read_messages) {
    const read = await api('readBusinessMessage', { business_connection_id: connectionId, chat_id: msg.chat.id, message_id: msg.message_id });
    if (!read.ok) console.warn(`Lyca Business read failed: ${read.description || 'unknown Telegram error'}`);
  }
}

async function showHome(chatId, messageId = null) {
  const text = '👋 WILLKOMMEN BEIM LYCA WEBSHOP 2\n\n📱 Lyca Mobile Triple-SIM\n🛍️ Produkte direkt ansehen und bestellen\n🛒 Warenkorb verwalten\n🧾 Bestellnummer & Rechnung erhalten\n🤖 KI-Support für Fragen\n💬 Persönlicher Support: @' + supportUsername + '\n\nWähle unten eine Funktion:';
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
async function showOrders(chatId, messageId = null) {
  const session = getSession(chatId);
  const order = session.lastOrder ? getOrder(session.lastOrder) : null;
  const text = order ? `📋 DEINE LETZTE BESTELLUNG\n\n${invoiceText(order)}` : '📋 BESTELLUNGEN\n\nNoch keine Bestellung in diesem Bot-Chat gespeichert.\n\nWenn du über den Webshop bestellt hast, kannst du die Bestellnummer hier mit /order BESTELLNUMMER aufrufen.';
  if (messageId) return editMessage(chatId, messageId, text, orderKeyboard(order));
  return sendMessage(chatId, text, { reply_markup: orderKeyboard(order) });
}

async function handleCallback(q) {
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
  if (data === 'ai') return sendMessage(chatId, '🤖 KI-ASSISTENT\n\nSchreibe deine Frage direkt hier in den Chat oder nutze /ai gefolgt von deiner Frage.\n\nBeispiele:\n• Wie bestelle ich?\n• Wo ist meine Rechnung?\n• Wie funktioniert der Warenkorb?', { reply_markup: mainKeyboard() });
  if (data === 'checkout') {
    if (!cartItems(chatId).length) return showCart(chatId, messageId);
    return editMessage(chatId, messageId, checkoutText(chatId), cryptoPaymentKeyboard());
  }
  if (data === 'pay:btc' || data === 'pay:sol' || data === 'pay:bnb') {
    const coin = data === 'pay:btc' ? 'BTC' : data === 'pay:sol' ? 'SOL' : 'BNB';
    try {
      const result = await createCryptoPayment(chatId, coin);
      if (!result.ok) return sendMessage(chatId, '⚠️ ' + result.description, { reply_markup: cryptoPaymentKeyboard() });
      const p = result.intent;
      return sendMessage(chatId, `💳 ${coin}-ZAHLUNG\\n\\n🔢 Bestellung: ${p.orderNumber}\\n💶 Warenwert: ${formatMoney(p.eurTotal)}\\n\\nBitte exakt diesen Betrag senden:\\n${p.cryptoAmount} ${coin}\\n\\n📍 Wallet:\\n${p.wallet}\\n\\nDer Shop überwacht die Blockchain. Nach bestätigtem Eingang wird die Bestellung automatisch auf BEZAHLT gesetzt und die Rechnung erneut mit Zahlungsstatus BEZAHLT gesendet.\\n\\n⚠️ Nur das angegebene Netzwerk verwenden.`, { reply_markup: cryptoPaymentKeyboard() });
    } catch (err) {
      return sendMessage(chatId, '⚠️ Zahlung konnte nicht vorbereitet werden: ' + (err.message || 'unbekannter Fehler'), { reply_markup: cryptoPaymentKeyboard() });
    }
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
  if (update.business_connection) { await handleBusinessConnection(update.business_connection); return; }
  if (update.business_message) { await handleBusinessMessage(update.business_message); return; }
  if (update.edited_business_message || update.deleted_business_messages) return;
  if (update.callback_query) return handleCallback(update.callback_query);

  const msg = update.message;
  if (!msg || !msg.chat) return;
  const chatId = msg.chat.id;
  const text = String(msg.text || '').trim();
  const parts = text.split(/\s+/);
  const command = parts[0].split('@')[0];
  const senderUsername = String(msg.from?.username || '').replace(/^@/, '');
  const isSupportAdmin = senderUsername.toLowerCase() === supportUsername.toLowerCase();
  if (isSupportAdmin) adminChatIds.add(String(chatId));
  const session = getSession(chatId);

  if (command === '/start') {
    const order = getOrder(parts[1]);
    session.lastOrder = order?.orderNumber || session.lastOrder || null;
    if (isSupportAdmin) return sendMessage(chatId, '🛠️ LYCA SUPPORT · ADMIN\n\nDu bist als Support-Administrator verbunden. Neue Webshop-Bestellungen werden an die konfigurierten Administratoren gesendet.\n\n🆔 Deine Chat-ID: ' + chatId, { reply_markup: mainKeyboard() });
    return showHome(chatId);
  }
  if (command === '/myid') return sendMessage(chatId, `🆔 Deine Telegram Chat-ID: ${chatId}`, { reply_markup: mainKeyboard() });
  if (command === '/ai') { const prompt = parts.slice(1).join(' ').trim(); if (!prompt) return sendMessage(chatId, '🤖 Schreibe z. B. /ai Wie kann ich bestellen?', { reply_markup: mainKeyboard() }); const ai = await openaiReply(chatId, prompt); return sendMessage(chatId, ai || '⚠️ KI ist momentan nicht konfiguriert. Bitte versuche es später erneut.', { reply_markup: mainKeyboard() }); }
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
  if (command === '/paid' || command === '/unpaid') {
    if (!adminChatIds.has(String(chatId))) return sendMessage(chatId, 'Dieser Befehl ist nur für den Shop-Administrator verfügbar.', { reply_markup: mainKeyboard() });
    const order = getOrder(parts[1]);
    if (!order) return sendMessage(chatId, 'Bestellung nicht gefunden.', { reply_markup: mainKeyboard() });
    order.paymentStatus = command === '/paid' ? 'BEZAHLT' : 'UNBEZAHLT';
    return sendMessage(chatId, `✅ ${order.orderNumber}: ${order.paymentStatus}`, { reply_markup: orderKeyboard(order) });
  }
  if (/^(test|hallo|hi|hey)$/i.test(text)) return showHome(chatId);
  if (/warenkorb|cart/i.test(text)) return showCart(chatId);
  if (/produkte|produkt|sim/i.test(text)) return showProducts(chatId);
  if (/bestellung|order/i.test(text)) return showOrders(chatId);
  if (/support|hilfe/i.test(text)) return sendMessage(chatId, `💬 LYCA SUPPORT\n\n@${supportUsername}`, { reply_markup: mainKeyboard() });
  const ai = await openaiReply(chatId, text);
  if (ai) return sendMessage(chatId, ai, { reply_markup: mainKeyboard() });
  return sendMessage(chatId, '🤖 Ich habe dich verstanden. Nutze die Schaltflächen unten, um den Shop zu öffnen.', { reply_markup: mainKeyboard() });
}

async function configure(baseUrl = publicBaseUrl) {
  if (!token) return { enabled: false, reason: 'TELEGRAM_BOT_TOKEN fehlt' };
  const me = await api('getMe');
  if (!me.ok) return { enabled: false, reason: me.description || 'Telegram token rejected' };
  if (me.result?.username) botUsername = String(me.result.username).replace(/^@/, '');
  if (baseUrl) {
    const webhookUrl = `${baseUrl}/api/telegram-webhook`;
    const body = { url: webhookUrl, allowed_updates: ['message', 'callback_query', 'business_connection', 'business_message', 'edited_business_message', 'deleted_business_messages'], drop_pending_updates: false };
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
    { command: 'myid', description: 'Telegram Chat-ID anzeigen' },
    { command: 'ai', description: 'KI-Assistent fragen' }
  ] });
  if (baseUrl) await api('setChatMenuButton', { menu_button: { type: 'web_app', text: '🛍️ Shop', web_app: { url: baseUrl } } });
  return { enabled: true, username: me.result.username, webhook: `${baseUrl}/api/telegram-webhook`, businessMode: Boolean(me.result?.can_connect_to_business), canConnectToBusiness: Boolean(me.result?.can_connect_to_business), miniAppUrl: baseUrl };
}

module.exports = {
  enabled: Boolean(token), tokenConfigured: Boolean(token), username: botUsername, wallets,
  sendOrder, handleUpdate, configure, getOrder, getOrders: () => Array.from(orders.values()),
  getBalances: () => ({ BTC: 'n/a', SOL: 'n/a', BNB: 'n/a' }),
  getPendingCryptoPayments, markOrderPaid, getCryptoPriceEur,
  invoiceText, webhookSecret, supportUsername, supportChatId, botOrderUrl, supportUrl,
  getBusinessStatus: () => ({
    connections: Array.from(businessConnections.values()).map(c => ({
      id: c.id,
      user: c.user ? { id: c.user.id, username: c.user.username || '', firstName: c.user.first_name || '' } : null,
      is_enabled: c.is_enabled,
      rights: c.rights || {}
    }))
  })
};
