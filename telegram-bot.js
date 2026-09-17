const orders=new Map();
const botUsername='Lyca_Webshop_Bot';
const wallets={BTC:'bc1qg808ntjfxgvnguepngpl6f7ddwana39z7m2qxx',SOL:'2uqEwjquFWXbJhuhSwkMtbGcm2mZbi4JBoJWd6jrzeJA',BNB:'0x7f6dde8179319425917eD0c9fd84952f98b0C2A4'};

function getBalances(){return {BTC:'n/a',SOL:'n/a',BNB:'n/a'}}
function formatOrder(order,b=getBalances()){
  return `🛒 NEUE BESTELLUNG · LYCA WEBSHOP\n\n🔢 Bestellnummer: ${order.orderNumber}\n🧾 Rechnung: ${order.invoiceNumber}\n📅 Datum: ${order.createdAt}\n\n👤 KUNDE\nName: ${order.customer.name}\nE-Mail: ${order.customer.email}\nAnschrift: ${order.customer.address}\n\n📦 BESTELLUNG\n${order.items.map(x=>`${x.name} · ${x.qty} Stück · ${x.price.toFixed(2).replace('.',',')} € / Stück`).join('\n')}\n\n💶 Gesamt: ${order.total.toFixed(2).replace('.',',')} €\n💳 Zahlungsstatus: ${order.paymentStatus}\n\n💰 ZAHLUNGSADRESSEN\nBTC: ${wallets.BTC}\nSOL: ${wallets.SOL}\nBNB Smart Chain: ${wallets.BNB}\n\nℹ️ Zahlung wird erst nach Prüfung als BEZAHLT markiert.`
}

function sendOrder(order){
  orders.set(order.orderNumber,{...order});
  console.log(`Lyca Bot: new order ${order.orderNumber}`);
  return {ok:true,orderNumber:order.orderNumber,botUsername,message:formatOrder(order)};
}

function command(text){
  const input=String(text||'').trim();
  if(input==='/start'||input==='/help') return `🤖 Lyca Webshop Bot ist aktiv.\n\nBot: @${botUsername}\n\nBefehle:\n/order BESTELLNUMMER – Bestellung anzeigen\n/paid BESTELLNUMMER – Zahlung als bezahlt markieren\n/unpaid BESTELLNUMMER – Zahlung als unbezahlt markieren\n/id – Bot-ID anzeigen`;
  if(input==='/id') return `🤖 Lyca Webshop Bot\nBot: @${botUsername}\nModus: tokenloser Webshop-Bot`;
  const parts=input.split(/\s+/); const id=parts[1]; const order=orders.get(id);
  if(parts[0]==='/order') return order?formatOrder(order):`Bestellung ${id||''} wurde nicht gefunden.`;
  if(parts[0]==='/paid') { if(!order)return `Bestellung ${id||''} wurde nicht gefunden.`; order.paymentStatus='BEZAHLT'; return `✅ Zahlung bestätigt\n\nBestellung: ${order.orderNumber}\nStatus: BEZAHLT`; }
  if(parts[0]==='/unpaid') { if(!order)return `Bestellung ${id||''} wurde nicht gefunden.`; order.paymentStatus='UNBEZAHLT'; return `↩️ Zahlung zurückgesetzt\n\nBestellung: ${order.orderNumber}\nStatus: UNBEZAHLT`; }
  return 'Unbekannter Befehl. Nutze /help.';
}

module.exports={enabled:true,sendOrder,command,getOrder:id=>orders.get(id)||null,getOrders:()=>Array.from(orders.values()),getBalances,username:botUsername};
