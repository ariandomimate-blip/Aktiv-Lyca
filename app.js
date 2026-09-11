const products=[
['Telekom','MagentaMobil Prepaid','Prepaid','Telekom','15 GB','5G','4.95','TK'],
['congstar','Prepaid Allnet M','Prepaid','Telekom','15 GB','5G','9.00','CG'],
['fraenk','fraenk 20 GB','Flex','Telekom','20 GB','5G','10.00','FR'],
['EDEKA smart','Kombi-Paket','Prepaid','Telekom','25 GB','5G','8.99','ES'],
['ja! mobil','Smart Tarif','Prepaid','Telekom','25 GB','LTE/5G','8.99','JA'],
['PENNY MOBIL','Prepaid Smart','Prepaid','Telekom','25 GB','LTE/5G','8.99','PE'],
['Kaufland mobil','Smart XS','Prepaid','Telekom','25 GB','LTE/5G','8.99','KM'],
['NORMA connect','Smart S','Prepaid','Telekom','15 GB','LTE','8.99','NC'],
['Vodafone','CallYa Allnet Flat S','Prepaid','Vodafone','20 GB','5G','9.99','VF'],
['otelo','Allnet-Flat Classic','Vertrag','Vodafone','30 GB','5G','14.99','OT'],
['SIMon mobile','SIMon 20 GB','Flex','Vodafone','20 GB','5G','9.99','SM'],
['Lidl Connect','Smart XL','Prepaid','Vodafone','25 GB','5G','8.99','LC'],
['freenet','Flex 20 GB','Flex','Vodafone','20 GB','5G','9.99','FN'],
['o2','o2 Prepaid S','Prepaid','o2','20 GB','5G','9.99','O2'],
['Blau','Allnet S Flex','Flex','o2','20 GB','5G','7.99','BL'],
['ALDI TALK','Kombi-Paket S','Prepaid','o2','25 GB','5G','8.99','AT'],
['LEBARA','Allnet Flat','Prepaid','o2','20 GB','5G','9.99','LE'],
['AY YILDIZ','Allnet Flat','Prepaid','o2','20 GB','5G','9.99','AY'],
['FONIC','Classic','Prepaid','o2','15 GB','LTE','9.99','FO'],
['Tchibo MOBIL','Prepaid Smart','Prepaid','o2','20 GB','5G','9.99','TC'],
['Ortel Mobile','Allnet Flat','Prepaid','o2','20 GB','LTE','9.99','OR'],
['NettoKOM','Smart','Prepaid','o2','20 GB','LTE','8.99','NK'],
['Lycamobile','All-in-One','Prepaid','o2','30 GB','5G','12.99','LY'],
['1&1','All-Net-Flat 50 GB','Vertrag','1&1','50 GB','5G','14.99','11'],
['sim.de','LTE All 50 GB','Vertrag','1&1','50 GB','5G','14.99','SD'],
['winSIM','LTE All 50 GB','Vertrag','1&1','50 GB','5G','14.99','WS'],
['PremiumSIM','LTE 50 GB','Vertrag','1&1','50 GB','5G','14.99','PS'],
['smartmobil.de','LTE 50 GB','Vertrag','1&1','50 GB','5G','14.99','SM'],
['sim24','LTE 50 GB','Vertrag','1&1','50 GB','5G','14.99','24'],
['yourfone','LTE 50 GB','Vertrag','1&1','50 GB','5G','14.99','YF'],
['handyvertrag.de','LTE 50 GB','Vertrag','1&1','50 GB','5G','14.99','HV'],
['maXXim','LTE 50 GB','Vertrag','1&1','50 GB','5G','14.99','MX'],
['simplytel','LTE 50 GB','Vertrag','1&1','50 GB','5G','14.99','ST'],
['WEB.DE','Mobilfunk-Tarif','Vertrag','1&1','30 GB','5G','9.99','WD'],
['GMX','Mobilfunk-Tarif','Vertrag','1&1','30 GB','5G','9.99','GM']
].map((x,i)=>({id:i+1,brand:x[0],name:x[1],type:x[2],network:x[3],data:x[4],speed:x[5],price:Number(x[6]),code:x[7],esim:i%3!==1}));

const state={items:[],network:'Alle',brand:'Alle'};
const $=s=>document.querySelector(s);
const euro=n=>n.toLocaleString('de-DE',{style:'currency',currency:'EUR'});

function renderBrands(){
 const brands=['Alle',...new Set(products.map(p=>p.brand))];
 $('#brandFilters').innerHTML=brands.slice(0,16).map(b=>`<button class="chip ${state.brand===b?'active':''}" data-brand="${b}">${b}</button>`).join('')+(brands.length>16?'<span class="chip">+ weitere im Katalog</span>':'');
 document.querySelectorAll('[data-brand]').forEach(b=>b.onclick=()=>{state.brand=b.dataset.brand;renderBrands();renderProducts()});
}
function renderProducts(){
 let list=products.filter(p=>state.network==='Alle'||p.network===state.network).filter(p=>state.brand==='Alle'||p.brand===state.brand);
 const q=$('#search').value.toLowerCase().trim(), type=$('#type').value, sort=$('#sort').value;
 if(q)list=list.filter(p=>`${p.brand} ${p.name} ${p.network}`.toLowerCase().includes(q));
 if(type!=='all')list=list.filter(p=>p.type===type||(type==='eSIM'&&p.esim));
 if(sort==='price')list.sort((a,b)=>a.price-b.price); if(sort==='data')list.sort((a,b)=>parseInt(b.data)-parseInt(a.data));
 $('#products').innerHTML=list.map(p=>`<article class="product"><div class="product-top"><div class="logo">${p.code}</div><span class="tag">${p.type}${p.esim?' • eSIM':''}</span></div><div class="provider">${p.brand} · ${p.network}</div><h3>${p.name}</h3><div class="specs"><span>▣ ${p.data}</span><span>↯ ${p.speed}</span><span>☎ Allnet</span></div><div class="product-bottom"><div class="price"><strong>${euro(p.price)}</strong><small>/ Monat bzw. Tarifzyklus*</small></div><button class="add" data-add="${p.id}">In den Warenkorb</button></div></article>`).join('')||'<div class="empty">Keine passenden Tarife gefunden.</div>';
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
function closeAll(){$('#cartDrawer').classList.remove('open');$('#backdrop').classList.remove('show');$('#checkoutModal').classList.remove('show')}
$('#cartOpen').onclick=openCart;$('#cartClose').onclick=closeAll;$('#backdrop').onclick=closeAll;
$('#checkout').onclick=()=>{if(!state.items.length)return alert('Bitte zuerst einen Tarif in den Warenkorb legen.');$('#checkoutModal').classList.add('show');$('#backdrop').classList.remove('show')};$('#checkoutClose').onclick=()=>$('#checkoutModal').classList.remove('show');
$('#checkoutForm').onsubmit=e=>{e.preventDefault();$('#checkoutForm').hidden=true;$('#success').hidden=false};
$('#search').oninput=renderProducts;$('#type').onchange=renderProducts;$('#sort').onchange=renderProducts;
document.querySelectorAll('.quick button').forEach(b=>b.onclick=()=>{state.network=b.dataset.network;document.querySelectorAll('.quick button').forEach(x=>x.classList.remove('active'));b.classList.add('active');renderProducts();document.querySelector('#tarife').scrollIntoView({behavior:'smooth'})});
renderBrands();renderProducts();renderCart();
