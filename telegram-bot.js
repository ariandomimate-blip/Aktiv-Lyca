const token=process.env.TELEGRAM_BOT_TOKEN;
let adminChatId=process.env.TELEGRAM_ADMIN_CHAT_ID||null;
let offset=0;
const botUsername=(process.env.TELEGRAM_BOT_USERNAME||'Lyca_Bot').replace(/^@/,'');
const api=token?`https://api.telegram.org/bot${token}`:null;
async function tg(method,body){if(!api)throw new Error('TELEGRAM_BOT_TOKEN missing');const r=await fetch(`${api}/${method}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const j=await r.json();if(!r.ok||!j.ok)throw new Error(j.description||'Telegram API error');return j.result}
async function send(chatId,text,extra={}){return tg('sendMessage',{chat_id:chatId,text,...extra})}
async function handle(u){const m=u.message;if(!m)return;const chatId=String(m.chat.id);adminChatId=adminChatId||chatId;const text=(m.text||'').trim();if(text==='/start'||text==='/help'||text.toUpperCase()==='TEST'){return send(chatId,'✅ Aktiv-Lyca Bestellbot ist aktiv.\n\nBestellungen aus dem Webshop werden hierher gesendet.\n\nBestellinformationen: Name · E-Mail · Anschrift · Bestellnummer · Artikel · Menge · Gesamtbetrag.')}if(text==='/order'){return send(chatId,'Bestellung bitte über den Aktiv-Lyca-Webshop aufgeben.')} }
async function loop(){if(!api){console.log('Telegram bot disabled: TELEGRAM_BOT_TOKEN is not configured.');return}try{const updates=await tg('getUpdates',{offset,timeout:20,allowed_updates:['message']});for(const u of updates){offset=u.update_id+1;try{await handle(u)}catch(e){console.error('Telegram handler:',e.message)}}}catch(e){console.error('Telegram bot error:',e.message)}setTimeout(loop,500)}
async function sendOrder(text){if(!adminChatId)throw new Error(`Noch keine Telegram-Chat-ID. Bitte @${botUsername} öffnen und /start senden.`);return send(adminChatId,text)}
if(api)loop();
module.exports={enabled:!!api,sendOrder,getAdminChatId:()=>adminChatId};
