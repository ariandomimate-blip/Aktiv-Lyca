/*
  SIMNOVA PRODUCT CATALOG
  Neue Marken/SIM-Karten einfach als weiteren Eintrag ergänzen.
  Bildpfad: assets/sim/<dein-bild>.jpg|png|webp|svg
  Lege die Bilder später in diesem Ordner im GitHub-Repository ab.
*/
const products=[
['Telekom','MagentaMobil Prepaid','Prepaid','Telekom','15 GB','5G','4.95','TK','assets/sim/telekom.jpg'],
['congstar','Prepaid Allnet M','Prepaid','Telekom','15 GB','5G','9.00','CG','assets/sim/congstar.jpg'],
['fraenk','fraenk 20 GB','Flex','Telekom','20 GB','5G','10.00','FR','assets/sim/fraenk.jpg'],
['EDEKA smart','Kombi-Paket','Prepaid','Telekom','25 GB','5G','8.99','ES','assets/sim/edeka-smart.jpg'],
['ja! mobil','Smart Tarif','Prepaid','Telekom','25 GB','LTE/5G','8.99','JA','assets/sim/ja-mobil.jpg'],
['PENNY MOBIL','Prepaid Smart','Prepaid','Telekom','25 GB','LTE/5G','8.99','PE','assets/sim/penny-mobil.jpg'],
['Kaufland mobil','Smart XS','Prepaid','Telekom','25 GB','LTE/5G','8.99','KM','assets/sim/kaufland-mobil.jpg'],
['NORMA connect','Smart S','Prepaid','Telekom','15 GB','LTE','8.99','NC','assets/sim/norma-connect.jpg'],
['Vodafone','CallYa Allnet Flat S','Prepaid','Vodafone','20 GB','5G','9.99','VF','assets/sim/vodafone.jpg'],
['otelo','Allnet-Flat Classic','Vertrag','Vodafone','30 GB','5G','14.99','OT','assets/sim/otelo.jpg'],
['SIMon mobile','SIMon 20 GB','Flex','Vodafone','20 GB','5G','9.99','SM','assets/sim/simon-mobile.jpg'],
['Lidl Connect','Smart XL','Prepaid','Vodafone','25 GB','5G','8.99','LC','assets/sim/lidl-connect.jpg'],
['freenet','Flex 20 GB','Flex','Vodafone','20 GB','5G','9.99','FN','assets/sim/freenet.jpg'],
['o2','o2 Prepaid S','Prepaid','o2','20 GB','5G','9.99','O2','assets/sim/o2.jpg'],
['Blau','Allnet S Flex','Flex','o2','20 GB','5G','7.99','BL','assets/sim/blau.jpg'],
['ALDI TALK','Kombi-Paket S','Prepaid','o2','25 GB','5G','8.99','AT','assets/sim/aldi-talk.jpg'],
['LEBARA','Allnet Flat','Prepaid','o2','20 GB','5G','9.99','LE','assets/sim/lebara.jpg'],
['AY YILDIZ','Allnet Flat','Prepaid','o2','20 GB','5G','9.99','AY','assets/sim/ay-yildiz.jpg'],
['FONIC','Classic','Prepaid','o2','15 GB','LTE','9.99','FO','assets/sim/fonic.jpg'],
['Tchibo MOBIL','Prepaid Smart','Prepaid','o2','20 GB','5G','9.99','TC','assets/sim/tchibo-mobil.jpg'],
['Ortel Mobile','Allnet Flat','Prepaid','o2','20 GB','LTE','9.99','OR','assets/sim/ortel-mobile.jpg'],
['NettoKOM','Smart','Prepaid','o2','20 GB','LTE','8.99','NK','assets/sim/nettokom.jpg'],
['Lycamobile','All-in-One','Prepaid','o2','30 GB','5G','12.99','LY','assets/sim/lycamobile.jpg'],
['1&1','All-Net-Flat 50 GB','Vertrag','1&1','50 GB','5G','14.99','11','assets/sim/1und1.jpg'],
['sim.de','LTE All 50 GB','Vertrag','1&1','50 GB','5G','14.99','SD','assets/sim/sim-de.jpg'],
['winSIM','LTE All 50 GB','Vertrag','1&1','50 GB','5G','14.99','WS','assets/sim/winsim.jpg'],
['PremiumSIM','LTE 50 GB','Vertrag','1&1','50 GB','5G','14.99','PS','assets/sim/premiumsim.jpg'],
['smartmobil.de','LTE 50 GB','Vertrag','1&1','50 GB','5G','14.99','SM','assets/sim/smartmobil.jpg'],
['sim24','LTE 50 GB','Vertrag','1&1','50 GB','5G','14.99','24','assets/sim/sim24.jpg'],
['yourfone','LTE 50 GB','Vertrag','1&1','50 GB','5G','14.99','YF','assets/sim/yourfone.jpg'],
['handyvertrag.de','LTE 50 GB','Vertrag','1&1','50 GB','5G','14.99','HV','assets/sim/handyvertrag.jpg'],
['maXXim','LTE 50 GB','Vertrag','1&1','50 GB','5G','14.99','MX','assets/sim/maxxim.jpg'],
['simplytel','LTE 50 GB','Vertrag','1&1','50 GB','5G','14.99','ST','assets/sim/simplytel.jpg'],
['WEB.DE','Mobilfunk-Tarif','Vertrag','1&1','30 GB','5G','9.99','WD','assets/sim/webde.jpg'],
['GMX','Mobilfunk-Tarif','Vertrag','1&1','30 GB','5G','9.99','GM','assets/sim/gmx.jpg']
].map((x,i)=>({id:i+1,brand:x[0],name:x[1],type:x[2],network:x[3],data:x[4],speed:x[5],price:Number(x[6]),code:x[7],image:x[8],esim:i%3!==1}));

const state={items:[],network:'Alle',brand:'Alle'};
const $=s=>document.querySelector(s);
const euro=n=>n.toLocaleString('de-DE',{style:'currency',currency:'EUR'});

function renderProviderLogos(){
 const brands=[...new Set(products.map(p=>p.brand))];
 $('#providerLogos').innerHTML=brands.slice(0,18).map(b=>`<span class="provider-logo">${b}</span>`).join('');
}
function renderBrands(){
 const brands=['Alle',...new Set(products.map(p=>p.brand))];
 $('#brandFilters').innerHTML=brands.slice(0,18).map(b=>`<button class="chip ${state.brand===b?'active':''}" data-brand="${b}">${b}</button>`).join('')+(brands.length>18?'<span class="chip">+ weitere Marken im Katalog</span>':'');
 document.querySelectorAll('[data-brand]').forEach(b=>b.onclick=()=>{state.brand=b.dataset.brand;renderBrands();renderProducts()});
}
function renderProducts(){
 let list=products.filter(p=>state.network==='Alle'||p.network===state.network).filter(p=>state.brand==='Alle'||p.brand===state.brand);
 const q=$('#search').value.toLowerCase().trim(), type=$('#type').value, sort=$('#sort').value;
 if(q)list=list.filter(p=>`${p.brand} ${p.name} ${p.network}`.toLowerCase().includes(q));
 if(type!=='all')list=list.filter(p=>p.type===type||(type==='eSIM'&&p.esim));
 if(sort==='price')list.sort((a,b)=>a.price-b.price); if(sort==='data')list.sort((a,b)=>parseInt(b.data)-parseInt(a.data));
 $('#products').innerHTML=list.map(p=>`<article class="product"><div class="product-image">${p.image?`<img src="${p.image}" alt="${p.brand} ${p.name}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.hidden=false">`:''}<div class="image-fallback" ${p.image?'hidden':''}>${p.code}</div></div><div class="product-body"><div class="product-top"><span class="tag">${p.type}${p.esim?' • eSIM':''}</span></div><div class="provider">${p.brand} · ${p.network}</div><h3>${p.name}</h3><div class="specs"><span>▣ ${p.data}</span><span>↯ ${p.speed}</span><span>☎ Allnet</span></div><div class="product-bottom"><div class="price"><strong>${euro(p.price)}</strong><small>/ Monat bzw. Tarifzyklus*</small></div><button class="add" data-add="${p.id}">In den Warenkorb</button></div></div></article>`).join('')||'<div class="empty">Keine passenden Tarife gefunden.</div>';
 document.querySelectorAll('[data-add]').forEach(b=>b.onclick=()=>add(+b.dataset.add));
}
function add(id){const p=products.find(x=>x.id===id);const found=state.items.find(x=>x.id===id);if(found)found.qty++;else state.items.push({...p,qty:1});renderCart();openCart()}
function remove(id){state.items=state.items.filter(x=>x.id!==id);renderCart()}
function renderCart(){
 $('#cartCount').textContent=state.items.reduce((s,x)=>s+x.qty,0);
 $('#cartItems').innerHTML=state.items.length?state.items.map(x=>`<div class="cart-row"><div><strong>${x.brand}</strong><br><small>${x.name} · ${x.data}</small></div><div><strong>${euro(x.price*x.qty)}</strong><br><button class="remove" data-remove="${x.id}">Entfernen</button></div></div>`).join(''):'<div class="empty">Dein Warenkorb ist leer.</div>';
 $('#cartTotal').textContent=euro(state.items.reduce((s,x)=>s+x.price*x.qty,0));
 document.querySelectorAll('[data-remove]').forEach(b=>b.onclick=()=>remove(+b.dataset.remove));
}
function openCart(){$('#cartDrawer').classList.add('open');$('#cartDrawer').setAttribute('aria-hidden','false');$('#backdrop').classList.add('show')}
function closeAll(){$('#cartDrawer').classList.remove('open');$('#cartDrawer').setAttribute('aria-hidden','true');$('#backdrop').classList.remove('show');$('#checkoutModal').classList.remove('show')}
$('#cartOpen').onclick=openCart;$('#cartClose').onclick=closeAll;$('#backdrop').onclick=closeAll;
$('#checkout').onclick=()=>{if(!state.items.length)return alert('Bitte zuerst einen Tarif in den Warenkorb legen.');$('#checkoutModal').classList.add('show');$('#backdrop').classList.remove('show')};$('#checkoutClose').onclick=()=>$('#checkoutModal').classList.remove('show');
$('#checkoutForm').onsubmit=e=>{e.preventDefault();$('#checkoutForm').hidden=true;$('#success').hidden=false};
$('#search').oninput=renderProducts;$('#type').onchange=renderProducts;$('#sort').onchange=renderProducts;
document.querySelectorAll('[data-network]').forEach(b=>b.onclick=()=>{state.network=b.dataset.network;document.querySelectorAll('[data-network]').forEach(x=>x.classList.remove('active'));b.classList.add('active');renderProducts();document.querySelector('#tarife').scrollIntoView({behavior:'smooth'})});
document.querySelectorAll('[data-type-link]').forEach(b=>b.onclick=()=>{const t=b.dataset.typeLink;$('#type').value=t;renderProducts()});
renderProviderLogos();renderBrands();renderProducts();renderCart();
