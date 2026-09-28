const bulkPrices=[{min:10,price:7},{min:50,price:5},{min:100,price:4.5},{min:200,price:4},{min:250,price:3.8},{min:500,price:3.5}];
const lyca={id:1,brand:'Lyca Mobile',name:'Triple-SIM',type:'Prepaid',network:'Lyca Mobile',data:'3-in-1',speed:'LTE/5G*',price:7,code:'LY',image:'assets/sim/f932503a-66a1-4252-acf7-579a10b724ee.jpeg',esim:false};const state={items:[],network:'Alle',brand:'Alle'};const $=s=>document.querySelector(s);const euro=n=>n.toLocaleString('de-DE',{style:'currency',currency:'EUR'});
function unitPrice(q){let p=7;for(const tier of bulkPrices)if(q>=tier.min)p=tier.price;return p}
function renderProducts(){const p=lyca;$('#products').innerHTML=`<article class="product"><div class="product-image"><img src="${p.image}" alt="Lyca Mobile Triple-SIM" loading="lazy"></div><div class="product-body"><span class="tag">Prepaid · Triple-SIM</span><div class="provider">LYCA MOBILE · DEUTSCHE NUMMER</div><h3>Lyca Mobile Triple-SIM</h3><p style="color:#aeb7c4">Bereits aktiviert · Mindestaufladung 5 € · Standard, Micro und Nano</p><div class="product-bottom"><div class="price"><strong>ab ${euro(3.5)}</strong><small>pro Stück bei 500 Stück</small></div><button class="add" data-add="1">Ab 10 Stück</button></div></div></article>`;document.querySelectorAll('[data-add]').forEach(b=>b.onclick=()=>window.addLycaProduct(10))}
function add(id,qty=1){const found=state.items.find(x=>x.id===id);if(found)found.qty+=qty;else state.items.push({...lyca,qty});renderCart();openCart()}
function renderCart(){const count=state.items.reduce((s,x)=>s+x.qty,0);$('#cartCount').textContent=count;$('#cartItems').innerHTML=state.items.length?state.items.map(x=>{const unit=unitPrice(x.qty);return `<div class="cart-row"><div><strong>${x.brand}</strong><br><small>${x.name} · ${x.qty} Stück</small></div><div><strong>${euro(unit*x.qty)}</strong><br><small>${euro(unit)} / Stück</small></div></div>`}).join(''):'<div class="empty">Dein Warenkorb ist leer.</div>';$('#cartTotal').textContent=euro(state.items.reduce((s,x)=>s+unitPrice(x.qty)*x.qty,0))}
function openCart(){$('#cartDrawer').classList.add('open');$('#cartDrawer').setAttribute('aria-hidden','false');$('#backdrop').classList.add('show')}
function closeAll(){$('#cartDrawer').classList.remove('open');$('#cartDrawer').setAttribute('aria-hidden','true');$('#backdrop').classList.remove('show');$('#checkoutModal').classList.remove('show')}
let TELEGRAM_BOT_USERNAME='Lyca_Webshop1_Bot';
const TELEGRAM_BOT_ID='8941978091';
async function resolveTelegramBotUsername(){
  try{
    const r=await fetch('/api/telegram-status',{cache:'no-store'});
    if(!r.ok)return;
    const data=await r.json();
    const username=String(data?.bot_username||'').replace(/^@/,'').trim();
    if(username)TELEGRAM_BOT_USERNAME=username;
  }catch{}
}
function telegramBotUrl(orderNumber){const param=encodeURIComponent(String(orderNumber||''));return 'https://t.me/'+TELEGRAM_BOT_USERNAME+'?start='+param}
function telegramBotUri(orderNumber){const param=encodeURIComponent(String(orderNumber||''));return 'tg://resolve?domain='+TELEGRAM_BOT_USERNAME+'&start='+param}
function openTelegramSupport(url, orderNumber=''){
  if(!url)return;
  const target=String(url).trim();
  // Keep the real Telegram HTTPS deep link. On iOS, a user-initiated
  // navigation to https://t.me/... is the most reliable way to hand off
  // from Safari to the installed Telegram app.
  try{
    const tg=window.Telegram?.WebApp;
    if(tg?.openTelegramLink && target.startsWith('https://t.me/')){
      tg.openTelegramLink(target);
      return;
    }
  }catch(err){console.warn('Telegram WebApp handoff failed:',err)}
  try{
    // This runs directly from the customer's button tap, preserving the
    // iOS user gesture required to open Telegram.
    window.location.assign(target);
  }catch(err){
    console.warn('Telegram browser handoff failed:',err);
    try{ window.open(target,'_blank','noopener,noreferrer'); }catch{}
  }
}

window.addLycaProduct=qty=>add(1,qty);
$('#cartOpen').onclick=openCart;
$('#cartClose').onclick=closeAll;
$('#backdrop').onclick=closeAll;
$('#checkout').onclick=()=>{if(!state.items.length)return alert('Bitte zuerst die SIM-Karte in den Warenkorb legen.');$('#checkoutModal').classList.add('show');$('#backdrop').classList.remove('show')};
$('#checkoutClose').onclick=()=>$('#checkoutModal').classList.remove('show');

$('#checkoutForm').onsubmit=e=>{
  e.preventDefault();
  if(!state.items.length)return;
  const form=new FormData(e.target);
  const customer={
    name:`${form.get('firstName')} ${form.get('lastName')}`.trim(),
    email:String(form.get('email')||'').trim(),
    address:String(form.get('address')||'').trim()
  };
  const telegramChatId=window.Telegram?.WebApp?.initDataUnsafe?.user?.id
    ? String(window.Telegram.WebApp.initDataUnsafe.user.id) : '';
  const items=state.items.map(x=>({name:`${x.brand} ${x.name}`,qty:x.qty,price:unitPrice(x.qty)}));
  const btn=e.target.querySelector('button[type="submit"]');
  btn.disabled=true;
  btn.textContent='BESTELLUNG WIRD VORBEREITET …';

  // Native form POST: the server creates the order first and returns HTTP 303
  // directly to Telegram. This avoids iOS popup blockers and async fetch races.
  const clientOrderNumber='LYCA-'+new Date().toISOString().slice(0,10).replace(/-/g,'')+'-'+
    Array.from(crypto.getRandomValues(new Uint8Array(3)))
      .map(x=>x.toString(16).padStart(2,'0')).join('').toUpperCase();

  const handoff=document.createElement('form');
  handoff.method='POST';
  handoff.action='/telegram-checkout-redirect';
  handoff.style.display='none';

  const fields={
    order_number:clientOrderNumber,
    customer_name:customer.name,
    customer_email:customer.email,
    customer_address:customer.address,
    telegram_chat_id:telegramChatId,
    items:JSON.stringify(items)
  };
  Object.entries(fields).forEach(([name,value])=>{
    const input=document.createElement('input');
    input.type='hidden';
    input.name=name;
    input.value=String(value);
    handoff.appendChild(input);
  });
  document.body.appendChild(handoff);
  handoff.submit();
};
renderProducts();renderCart();
