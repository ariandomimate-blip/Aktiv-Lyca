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
    const deepLinkedOrder = getOrder(parts[1]);
    const latestOrder = deepLinkedOrder || Array.from(orders.values())
      .filter(o => String(o.telegramChatId || '') === String(chatId))
      .sort((a,b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0] || null;
    session.lastOrder = latestOrder?.orderNumber || session.lastOrder || null;

    // Register the dedicated @Lyca_Support account as an administrator.
    if (isSupportAdmin) adminChatIds.add(String(chatId));

    // Open the actual order in the bot when a valid deep-link is used.
    if (latestOrder) {
      return sendMessage(chatId,
        \`🛍️ LYCA WEBSHOP · BESTELLUNG\\n\\n\${formatOrder(latestOrder)}\\n\\n🧾 Die vollständige Rechnung / Bestellbestätigung ist hier im Bot verfügbar.\\n\\n📋 /order = Bestellung\\n🧾 /invoice = Rechnung\\n💬 /support = Support\`,
        { reply_markup: orderKeyboard(latestOrder) }
      );
    }

    if (isSupportAdmin) return sendMessage(chatId, '🛠️ LYCA SUPPORT · ADMIN\\n\\nDu bist als Support-Administrator verbunden. Neue Webshop-Bestellungen werden automatisch an die registrierten Administratoren weitergeleitet.\\n\\n🆔 Deine Chat-ID: ' + chatId, { reply_markup: mainKeyboard() });
    return showHome(chatId);
  }
  `;

const patched = source.slice(0, start) + replacement + source.slice(end);
fs.writeFileSync(file, patched, 'utf8');
console.log('Lyca start patch: order deep-link and support registration enabled');
