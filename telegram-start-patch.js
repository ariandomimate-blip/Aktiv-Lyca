const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, 'telegram-bot.js');
const source = fs.readFileSync(file, 'utf8');
const startMarker = "if (command === '/start')";
const endMarker = "if (command === '/myid')";
const start = source.indexOf(startMarker);
const end = source.indexOf(endMarker, start);

if (start < 0 || end < 0) {
  console.error('Lyca start patch: /start block not found');
  process.exit(1);
}

const replacement = `if (command === '/start') {
    const order = getOrder(parts[1]);
    session.lastOrder = order?.orderNumber || session.lastOrder || null;

    // Register the dedicated @Lyca_Support account as an administrator.
    // Telegram bots cannot send to a username directly; they need the chat ID.
    if (isSupportAdmin) adminChatIds.add(String(chatId));

    // A webshop deep-link must open the actual order immediately in the bot chat.
    if (order) {
      return sendMessage(chatId, 
        \`🛍️ LYCA WEBSHOP · BESTELLUNG\n\n\${formatOrder(order)}\n\n🧾 Die vollständige Rechnung ist hier im Bot verfügbar.\n\n📋 /orders = letzte Bestellung\n🧾 /invoice = Rechnung\n💬 /support = Support\`,
        { reply_markup: orderKeyboard(order) }
      );
    }

    if (isSupportAdmin) return sendMessage(chatId, '🛠️ LYCA SUPPORT · ADMIN\\n\\nDu bist als Support-Administrator verbunden. Neue Webshop-Bestellungen werden automatisch an die registrierten Administratoren weitergeleitet.\\n\\n🆔 Deine Chat-ID: ' + chatId, { reply_markup: mainKeyboard() });
    return showHome(chatId);
  }
  `;

const patched = source.slice(0, start) + replacement + source.slice(end);
fs.writeFileSync(file, patched, 'utf8');
console.log('Lyca start patch: order deep-link and support registration enabled');
