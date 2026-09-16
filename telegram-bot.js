const token=process.env.TELEGRAM_BOT_TOKEN;
let adminChatId=process.env.TELEGRAM_ADMIN_CHAT_ID||null;
let offset=0;
let started=false;
const botUsername=(process.env.TELEGRAM_BOT_USERNAME||'Lyca_webshop_bot').replace(/^@/,'');
const api=token?`https://api.telegram.org/bot${token}`:null;
const wallets={
  BTC:'bc1qg808ntjfxgvnguepngpl6f7ddwana39z7m2qxx',
  SOL:'2uqEwjquFWXbJhuhSwkMtbGcm2mZbi4JBoJWd6jrzeJA',
  BNB:'0x7f6dde8179319425917eD0c9fd84952f98b0C2A4'
};
async function tg(method,body={}){if(!api)throw new Error('TELEGRAM_BOT_TOKEN missing');const r=await fetch(`${api}/${method}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const j=await r.json();if(!r.ok||!j.ok)throw new Error(j.description||`Telegram API error (${r.status})`);return j.result}
async function send(chatId,text,extra={}){return tg('sendMessage',{chat_id:chatId,text,...extra})}
async function getBalances(){
  const out={BTC:'n/a',SOL:'n/a',BNB:'n/a'};
  try{const r=await fetch(`https://mempool.space/api/address/${wallets.BTC}`,{signal:AbortSignal.timeout(10000)});if(r.ok){const j=await r.json();const sats=(j.chain_stats?.funded_txo_sum||0)-(j.chain_stats?.spent_txo_sum||0);out.BTC=(sats/1e8).toFixed(8)+' BTC';}}catch{}
  try{const r=await fetch('https://api.mainnet-beta.solana.com',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getBalance',params:[wallets.SOL]}),signal:AbortSignal.timeout(10000)});if(r.ok){const j=await r.json();out.SOL=((j.result?.value||0)/1e9).toFixed(6)+' SOL';}}catch{}
  try{const r=await fetch('https://bsc-dataseed.binance.org/',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_getBalance',params:[wallets.BNB,'latest']}),signal:AbortSignal.timeout(10000)});if(r.ok){const j=await r.json();out.BNB=(Number(BigInt(j.result||'0x0'))/1e18).toFixed(6)+' BNB';}}catch{}
  return out;
}
async function handle(u){const m=u.message;if(!m)return;const chatId=String(m.chat.id);adminChatId=chatId;const text=(m.text||'').trim();if(text==='/start'||text==='/help'||text.toUpperCase()==='TEST'){return send(chatId,'✅ Lyca Webshop SIM Bestellbot ist aktiv.\n\nBestellungen aus dem SIM-Webshop werden hierher gesendet.\n\nChat-ID wurde registriert.')}if(text==='/order'){return send(chatId,'Bestellung bitte über den Lyca Webshop SIM aufgeben.')} }
async function loop(){if(!api)return;try{const updates=await tg('getUpdates',{offset,timeout:20,allowed_updates:['message']});for(const u of updates){offset=u.update_id+1;try{await handle(u)}catch(e){console.error('Telegram handler:',e.message)}}}catch(e){console.error('Telegram bot error:',e.message);await new Promise(r=>setTimeout(r,3000))}setTimeout(loop,500)}
async function init(){if(!api){console.log('Telegram bot disabled: TELEGRAM_BOT_TOKEN is not configured.');return}if(started)return;started=true;try{const me=await tg('getMe');console.log(`Telegram bot authenticated as @${me.username||botUsername} (id ${me.id})`);await tg('deleteWebhook',{drop_pending_updates:false});console.log('Telegram webhook cleared; polling enabled.');loop()}catch(e){started=false;console.error('Telegram bot startup error:',e.message);setTimeout(init,5000)}}
async function sendOrder(text){if(!adminChatId)throw new Error(`Noch keine Telegram-Chat-ID. Bitte @${botUsername} öffnen und /start senden.`);const b=await getBalances();const payment=`\n\n💰 WALLET-BALANCES\nBTC: ${b.BTC}\nSOL: ${b.SOL}\nBNB: ${b.BNB}\n\n📍 ZAHLUNGSADRESSEN\nBTC: ${wallets.BTC}\nSOL: ${wallets.SOL}\nBNB Smart Chain: ${wallets.BNB}`;return send(adminChatId,text+payment)}
init();
module.exports={enabled:!!api,sendOrder,getAdminChatId:()=>adminChatId,username:botUsername};
