import {readSupplierXlsx,exportReservations} from './xlsx.js';

const $=s=>document.querySelector(s), app=$('#app'), dialog=$('#dialog');
const tg=window.Telegram?.WebApp;
const esc=s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
const money=n=>new Intl.NumberFormat('ru-RU',{style:'currency',currency:'RUB',maximumFractionDigits:n%100?2:0}).format(n/100);
const date=s=>s?new Date(s.length===10?s+'T12:00:00':s).toLocaleDateString('ru-RU',{day:'numeric',month:'long'}):'Дата уточняется';
const statuses={draft:'Черновик',in_transit:'В пути',arrived:'Прибыло',closed:'Резерв закрыт',reserved:'Зарезервировано',confirmed:'Подтверждено',cancelled:'Отменено'};
const state={preview:false,admin:false,ready:false,view:'shipments',shipments:[],current:null,filter:'all',sort:'new',search:'',cart:{},images:{},reservations:[],requestKey:null};
let toastTimer;
function toast(message){$('#toast').textContent=message;$('#toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').hidden=true,6500);}
function badge(status){return `<span class="badge ${esc(status)}">${esc(statuses[status]||status)}</span>`;}
function notice(text){$('#notice').textContent=text;$('#notice').hidden=!text;}
async function api(path,method='GET',body){
  const response=await fetch('/api'+path,{method,headers:{'Content-Type':'application/json','X-Telegram-Init-Data':tg?.initData||''},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(25000)});
  const data=await response.json();
  if(!response.ok)throw Error(data.error||'Не удалось выполнить запрос.');
  return data;
}
async function init(){
  try{
    tg?.ready();tg?.expand();
    if(tg?.isVersionAtLeast?.('6.1')){tg.setHeaderColor('#102b25');tg.setBackgroundColor('#f4f6f5');}
    const config=await api('/bootstrap');
    state.preview=config.mode==='preview';state.ready=Boolean(config.notificationReady);
    if(state.preview){state.shipments=(await (await fetch('./data/catalog.json')).json()).shipments;notice('Предпросмотр: условные товары для проверки интерфейса. Отправка резервов отключена.');}
    else{
      if(!tg?.initData){app.innerHTML=`<div class="empty"><strong>Откройте приложение в Telegram</strong>Ваши резервы привязаны к Telegram-аккаунту.<p><a class="primary" href="https://t.me/CR_Reserve_Bot/CR_Reserve">Открыть CR Reserve</a></p></div>`;return;}
      const me=await api('/me');state.admin=me.admin;state.user=me.user;
      state.shipments=(await api('/catalog')).shipments;
      $('#admin-tab').hidden=!state.admin;
      notice(state.ready?'':'Приём резервов откроется после подключения рабочего канала.');
    }
    render();
  }catch(e){app.innerHTML=`<div class="empty"><strong>Не удалось загрузить поставки</strong>${esc(e.message)}<p><button class="primary" id="retry">Попробовать ещё раз</button></p></div>`;$('#retry').onclick=init;}
}
async function loadImages(shipment){
  const keys=[...new Set(shipment.products.filter(p=>p.imageKey).map(p=>p.imageKey.split('/')[0]))];
  for(const key of keys){
    if(state.images[key])continue;
    try{state.images[key]=await (await fetch(`./data/${encodeURIComponent(key)}-images.json`)).json();}
    catch{state.images[key]={};}
  }
  hydrateImages();
}
function photo(p,cls='product-photo'){
  const key=p.imageKey,src=p.image || (key && state.images[key.split('/')[0]]?.[key.split('/')[1]]);
  if(!src&&!key)return `<div class="${cls} no-photo">Нет фото</div>`;
  return `<img class="${cls}" ${key?`data-image="${esc(key)}"`:''} ${src?`src="${esc(src)}"`:''} alt="${esc(p.name)}" loading="lazy">`;
}
function hydrateImages(){document.querySelectorAll('img[data-image]').forEach(el=>{const [key,sku]=el.dataset.image.split('/'),src=state.images[key]?.[sku];if(src)el.src=src;});}
function activeShipment(){return state.shipments.find(s=>s.id===state.current);}
function isOpen(s){return ['in_transit','arrived'].includes(s.status);}
function render(){
  document.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view===state.view));
  if(state.view==='shipments')state.current?renderDetail():renderShipments();
  else if(state.view==='reservations')renderReservations();
  else if(state.view==='admin')renderAdmin();
  cartBar();
  if(tg?.BackButton){if(state.current){tg.BackButton.show();}else{tg.BackButton.hide();}}
}
function renderShipments(){
  app.innerHTML=`<div class="page-heading"><div><p class="eyebrow">CR / RESERVE</p><h1>Поставки</h1><p class="subtitle">Товары в пути. Ваш резерв — заранее.</p></div><span class="count">${state.shipments.length} поставки</span></div>
  <div class="toolbar"><input class="search" id="shipment-search" type="search" placeholder="Найти поставку или бренд" aria-label="Поиск поставки" value="${esc(state.search)}"><select id="sort" aria-label="Сортировка"><option value="new">Сначала новые</option><option value="eta">По дате поступления</option><option value="old">Сначала старые</option></select></div>
  <div class="chips">${[['all','Все поставки'],['in_transit','В пути'],['arrived','Прибыло'],['closed','Закрытые']].map(([id,label])=>`<button class="chip ${state.filter===id?'active':''}" data-filter="${id}">${label}</button>`).join('')}</div><div class="shipment-grid" id="shipment-grid"></div>`;
  $('#sort').value=state.sort;
  $('#shipment-search').oninput=e=>{state.search=e.target.value;cards();};
  $('#sort').onchange=e=>{state.sort=e.target.value;cards();};
  document.querySelectorAll('[data-filter]').forEach(b=>b.onclick=()=>{state.filter=b.dataset.filter;document.querySelectorAll('[data-filter]').forEach(c=>c.classList.toggle('active',c===b));cards();});
  cards();
}
function cards(){
  const list=state.shipments.filter(s=>(state.filter==='all'||s.status===state.filter)&&`${s.title} ${s.brand}`.toLowerCase().includes(state.search.toLowerCase())).sort((a,b)=>{
    const key=state.sort==='eta'?'eta':'publishedAt',av=a[key],bv=b[key];
    if(!av)return bv?1:0;if(!bv)return -1;
    return state.sort==='new'?bv.localeCompare(av):av.localeCompare(bv);
  });
  $('#shipment-grid').innerHTML=list.length?list.map(s=>{
    const examples=s.products.filter(p=>p.image||p.imageKey).slice(0,2),min=Math.min(...s.products.map(p=>p.price));
    return `<article class="shipment-card"><button class="card-open" data-shipment="${esc(s.id)}"><div class="card-visual ${esc(s.brand.toLowerCase())}">${examples.map(p=>photo(p,'cover-photo')).join('')}<span class="brand-label">${esc(s.brand)}</span></div><div class="card-body"><div class="card-meta">${badge(s.status)}<span class="muted">${s.publishedAt?date(s.publishedAt):'Не опубликовано'}</span></div><h2>${esc(s.title)}</h2><span class="muted">${s.products.length} позиций · от ${money(min)}</span><div class="card-footer"><span>Поступление: ${date(s.eta)}</span><span class="arrow" aria-hidden="true">↗</span></div></div></button></article>`;
  }).join(''):'<div class="empty"><strong>Поставок пока нет</strong>Новые поставки появятся здесь после публикации.</div>';
  document.querySelectorAll('[data-shipment]').forEach(b=>b.onclick=()=>openShipment(b.dataset.shipment));
  list.forEach(loadImages);
}
function openShipment(id){if(state.current!==id){state.cart={};state.requestKey=null;}state.current=id;state.view='shipments';render();window.scrollTo(0,0);}
function renderDetail(){
  const s=activeShipment();if(!s){state.current=null;render();return;}
  app.innerHTML=`<button class="back" id="back">← Все поставки</button><section class="detail-head">${badge(s.status)}<h1>${esc(s.title)}</h1>${s.description?`<p class="subtitle">${esc(s.description).replaceAll('\n','<br>')}</p>`:''}<div class="detail-meta"><span>Поступление<strong>${date(s.eta)}</strong></span><span>В поставке<strong>${s.products.length} позиций</strong></span></div></section><div class="toolbar"><input class="search" type="search" id="product-search" placeholder="Название, модель или артикул" aria-label="Поиск товара"></div><div class="products" id="products"></div>`;
  $('#back').onclick=goBack;$('#product-search').oninput=e=>products(e.target.value);products('');loadImages(s);
}
function products(query){
  const s=activeShipment(),list=s.products.filter(p=>`${p.name} ${p.sku}`.toLowerCase().includes(query.toLowerCase()));
  $('#products').innerHTML=list.length?list.map(p=>{
    const qty=state.cart[p.id]||0,disabled=(!isOpen(s)&&!state.preview)||p.stock<=0;
    return `<article class="product ${qty?'selected':''}" data-product="${esc(p.id)}">${photo(p)}<div><span class="sku">АРТ. ${esc(p.sku)}</span><p class="product-title">${esc(p.name)}</p><span class="price">${money(p.price)}</span><div class="stock">${p.stock>0?`Свободно ${p.stock} шт.`:'Нет свободного остатка'}</div></div><div class="product-bottom"><span class="muted" style="font-size:13px">Количество</span><div class="stepper"><button data-step="-1" data-id="${esc(p.id)}" aria-label="Уменьшить количество" ${disabled?'disabled':''}>−</button><input data-qty="${esc(p.id)}" type="number" inputmode="numeric" min="0" max="${p.stock}" value="${qty}" aria-label="Количество ${esc(p.sku)}" ${disabled?'disabled':''}><button data-step="1" data-id="${esc(p.id)}" aria-label="Увеличить количество" ${disabled?'disabled':''}>+</button></div></div></article>`;
  }).join(''):'<p class="empty">Ничего не найдено.</p>';
  document.querySelectorAll('[data-step]').forEach(b=>b.onclick=()=>setQuantity(b.dataset.id,(state.cart[b.dataset.id]||0)+Number(b.dataset.step)));
  document.querySelectorAll('[data-qty]').forEach(input=>input.onchange=()=>setQuantity(input.dataset.qty,Number(input.value)));
  hydrateImages();
}
function setQuantity(id,value){
  const p=activeShipment()?.products.find(p=>p.id===id);if(!p)return;
  const qty=Math.max(0,Math.min(p.stock,Number.isFinite(value)?Math.floor(value):0));
  if(qty)state.cart[id]=qty;else delete state.cart[id];state.requestKey=null;
  const el=[...document.querySelectorAll('[data-qty]')].find(e=>e.dataset.qty===id);if(el){el.value=qty;el.closest('.product').classList.toggle('selected',qty>0);}
  cartBar();
}
function totals(){const s=activeShipment();return Object.entries(state.cart).reduce((r,[id,q])=>{const p=s?.products.find(p=>p.id===id);if(p){r.count+=q;r.total+=q*p.price;}return r;},{count:0,total:0});}
function cartBar(){
  const t=totals(),visible=state.view==='shipments'&&state.current&&t.count>0;
  $('#cart-bar').hidden=!visible;document.body.classList.toggle('has-cart',visible);
  if(visible){$('#cart-bar').innerHTML=`<button id="open-cart"><span>В резерве: ${t.count} шт.<br><small>Проверить и отправить</small></span><strong>${money(t.total)} →</strong></button>`;$('#open-cart').onclick=showCart;}
}
function closeDialog(){dialog.close();}
function showDialog(title,body){dialog.innerHTML=`<div class="dialog-header"><h2>${esc(title)}</h2><button class="icon-button" id="close-dialog" aria-label="Закрыть">×</button></div>${body}`;$('#close-dialog').onclick=closeDialog;if(!dialog.open)dialog.showModal();}
function showCart(){
  const s=activeShipment(),t=totals();
  showDialog('Ваш резерв',`<p class="muted">${esc(s.title)}</p>${Object.entries(state.cart).map(([id,q])=>{const p=s.products.find(p=>p.id===id);return `<div class="cart-line"><p>${esc(p.name)}</p><span class="muted">${esc(p.sku)} · ${q} шт. × ${money(p.price)}</span></div>`;}).join('')}<div class="cart-total"><span>${t.count} шт.</span><span>${money(t.total)}</span></div><label class="field">Комментарий<textarea id="comment" maxlength="1000" placeholder="Например, название магазина"></textarea></label><p class="fine-print">После отправки товары сразу вычитаются из свободного остатка.</p>${state.preview?'<p class="warning">Предпросмотр. Резерв не будет отправлен менеджеру.</p>':''}<p id="reserve-error" class="error" role="alert"></p><button class="primary full" id="submit-reserve" ${state.preview||!state.ready?'disabled':''}>Поставить в резерв</button>`);
  $('#comment').oninput=()=>state.requestKey=null;
  $('#submit-reserve').onclick=async()=>{
    const button=$('#submit-reserve');button.disabled=true;button.textContent='Отправляем…';$('#reserve-error').textContent='';$('#comment').disabled=true;
    state.requestKey ||= crypto.randomUUID();
    const key=state.requestKey;
    try{
      const {reservation}=await api('/reservations','POST',{shipmentId:s.id,requestKey:key,lines:Object.entries(state.cart).map(([id,quantity])=>({id,quantity})),comment:$('#comment').value});
      state.cart={};state.requestKey=null;closeDialog();cartBar();
      toast(`Резерв №${reservation.id.slice(0,8)} сохранён. Товары закреплены за вами.`);
      state.shipments=(await api('/catalog')).shipments;state.view='reservations';render();
    }catch(e){
      // Same idempotency key is retained for a network retry, even if response was lost.
      if(dialog.open&&$('#reserve-error')){$('#reserve-error').textContent=e.message;button.disabled=false;button.textContent='Повторить отправку';$('#comment').disabled=false;}
      else toast('Резерв сохранён. Обновите страницу, чтобы увидеть его в списке.');
    }
  };
}
async function renderReservations(all=false){
  app.innerHTML=`<div class="page-heading"><div><p class="eyebrow">CR / RESERVE</p><h1>${all?'Все резервы':'Мои резервы'}</h1></div>${all?'<button class="secondary" id="export">Excel ↓</button>':''}</div><div id="reservations"><p class="empty">Загружаем…</p></div>`;
  if(!all && !state.preview && state.user)$('#reservations').insertAdjacentHTML('beforebegin',`<p class="muted">Ваш Telegram ID: <strong id="telegram-user-id">${esc(state.user.id)}</strong></p>`);
  if(state.preview){$('#reservations').innerHTML='<div class="empty"><strong>Здесь будут ваши резервы</strong>Отправка появится после подключения бота и рабочего канала.</div>';return;}
  try{
    const {reservations}=await api('/reservations'+(all?'?all=1':''));state.reservations=reservations;
    if(!$('#reservations'))return;
    $('#reservations').innerHTML=reservations.length?reservations.map(r=>`<article class="reservation"><div class="top"><div><small>№ ${esc(r.id.slice(0,8))} · ${date(r.createdAt)}</small><h3 style="margin-top:8px">${esc(r.shipmentTitle)}</h3></div>${badge(r.status)}</div>${all?`<p>${esc(r.user.name)} ${r.user.username?'@'+esc(r.user.username):''}</p>`:''}<strong>${money(r.total)}</strong><span class="muted"> · ${r.lines.reduce((s,l)=>s+l.quantity,0)} шт.</span><details><summary>Состав резерва</summary><ul>${r.lines.map(l=>`<li>${esc(l.sku)} · ${esc(l.name)} — <b>${l.quantity} шт.</b></li>`).join('')}</ul>${r.comment?`<p>${esc(r.comment)}</p>`:''}</details><div class="actions">${all&&r.status==='reserved'?`<button class="primary" data-confirm="${r.id}">Подтвердить</button>`:''}${r.status==='reserved'||all&&r.status==='confirmed'?`<button class="danger" data-cancel="${r.id}">Отменить резерв</button>`:''}</div></article>`).join(''):'<div class="empty"><strong>Резервов пока нет</strong>Выберите поставку и добавьте нужные товары.</div>';
    document.querySelectorAll('[data-cancel]').forEach(b=>b.onclick=()=>changeReservation(b.dataset.cancel,'cancelled',all));
    document.querySelectorAll('[data-confirm]').forEach(b=>b.onclick=()=>changeReservation(b.dataset.confirm,'confirmed',all));
    if(all)$('#export').onclick=()=>exportReservations(reservations).catch(e=>toast(e.message));
  }catch(e){if($('#reservations'))$('#reservations').innerHTML=`<p class="empty error">${esc(e.message)}</p>`;}
}
function changeReservation(id,status,all){
  showDialog(status==='cancelled'?'Отменить резерв?':'Подтвердить резерв?',`<p class="status-message">${status==='cancelled'?'Товары вернутся в свободный остаток.':'Товары останутся закреплены за клиентом.'}</p><button class="primary full" id="confirm-action">${status==='cancelled'?'Да, отменить':'Подтвердить'}</button>`);
  $('#confirm-action').onclick=async()=>{const b=$('#confirm-action');b.disabled=true;try{await api('/reservations/'+id,'PATCH',{status});closeDialog();state.shipments=(await api('/catalog')).shipments;renderReservations(all);}catch(e){b.disabled=false;toast(e.message);}};
}
function renderAdmin(){
  if(!state.admin){state.view='shipments';render();return;}
  app.innerHTML=`<div class="page-heading"><div><p class="eyebrow">CR / RESERVE</p><h1>Управление</h1></div><button class="primary" id="new-shipment">+ Поставка</button></div><div class="actions"><button class="secondary" id="all-reservations">Все резервы</button><button class="secondary" id="setup-bot">Подключить бота</button></div><section class="admin-panel">${state.shipments.length?state.shipments.map(s=>`<div class="admin-row"><div><strong>${esc(s.title)}</strong><small>${s.products.length} позиций · ${date(s.eta)}</small>${badge(s.status)}</div><button class="secondary" data-edit="${esc(s.id)}">Изменить</button></div>`).join(''):'<p class="muted">Загрузите Excel, проверьте товары и опубликуйте поставку.</p>'}</section>`;
  $('#new-shipment').onclick=()=>editShipment();$('#all-reservations').onclick=()=>renderReservations(true);
  $('#setup-bot').onclick=showBotSetup;
  document.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>editShipment(state.shipments.find(s=>s.id===b.dataset.edit)));
}
function showBotSetup(){
  showDialog('Подключение бота',`<p>Подключим команды бота и кнопку открытия поставок.</p><p>Затем добавьте @CR_Reserve_Bot администратором рабочего канала с правом публикации и перешлите ему сообщение из этого канала. Бот ответит ID канала для настройки уведомлений.</p><p id="bot-setup-error" class="error" role="alert"></p><button class="primary full" id="connect-bot">Подключить</button>`);
  $('#connect-bot').onclick=async()=>{
    const button=$('#connect-bot'),error=$('#bot-setup-error');button.disabled=true;button.textContent='Подключаем…';error.textContent='';
    try{
      await api('/admin/setup-bot','POST',{});
      showDialog('Бот подключён',`<p>Добавьте @CR_Reserve_Bot администратором рабочего канала с правом публикации сообщений.</p><p>Перешлите сообщение из канала в личный чат с ботом, сохранив источник пересылки. Полученный ID укажите в Cloudflare как Secret <strong>RESERVATION_CHAT_ID</strong>, сохраните и переоткройте приложение.</p><p><a class="primary" href="https://t.me/CR_Reserve_Bot" target="_blank" rel="noopener">Открыть бота</a></p>`);
    }catch(e){error.textContent=e.message;button.disabled=false;button.textContent='Повторить подключение';}
  };
}
function editShipment(existing){
  let products=existing?.products.map(p=>({...p,total:p.total??p.stock})),warnings=[];
  showDialog(existing?'Настройки поставки':'Новая поставка',`<form id="shipment-form"><label class="field">Название<input name="title" required maxlength="160" value="${esc(existing?.title||'')}" placeholder="Например, Gurdini Slim Series"></label><div class="form-grid"><label class="field">Бренд<input name="brand" maxlength="80" value="${esc(existing?.brand||'')}"></label><label class="field">Статус<select name="status">${Object.entries(statuses).filter(([k])=>['draft','in_transit','arrived','closed'].includes(k)).map(([k,v])=>`<option value="${k}" ${existing?.status===k?'selected':''}>${v}</option>`).join('')}</select></label><label class="field">Ожидаемое поступление<input type="date" name="eta" value="${esc(existing?.eta||'')}"></label><label class="field">Дата публикации<input type="date" name="publishedAt" value="${esc(existing?.publishedAt||'')}"></label></div><label class="field">Описание<textarea name="description" maxlength="3000">${esc(existing?.description||'')}</textarea></label><label class="field">${existing?'Обновить товары из Excel':'Excel с товарами'}<input type="file" id="xlsx-file" accept=".xlsx"></label><p class="fine-print">Кол-во в Excel — общее количество поставки до вычета резервов. При обновлении действующие резервы сохраняются.</p><div id="import-info">${products?`<p class="import-summary">${products.length} позиций</p>`:''}</div><p id="import-error" class="error" role="alert"></p><button class="primary full" id="save-shipment" type="submit" ${products?'':'disabled'}>Сохранить поставку</button></form>`);
  const form=$('#shipment-form');
  $('#xlsx-file').onchange=async e=>{
    const file=e.target.files[0];if(!file)return;$('#save-shipment').disabled=true;$('#import-info').textContent='Читаем Excel и сжимаем фотографии…';$('#import-error').textContent='';
    try{
      const result=await readSupplierXlsx(file);products=result.products;warnings=result.warnings;
      if(!form.elements.title.value)form.elements.title.value=file.name.replace(/\.xlsx$/i,'');
      $('#import-info').innerHTML=`<div class="import-summary">${products.length} позиций · ${products.filter(p=>p.image).length} фотографий</div>${warnings.length?`<details class="warning"><summary>Замечания: ${warnings.length}</summary>${warnings.map(w=>`<div>${esc(w)}</div>`).join('')}</details><label class="field"><input id="accept-warnings" type="checkbox" style="width:auto;min-height:auto"> Проверил замечания</label>`:''}<div class="import-preview"><table><thead><tr><th>Товар</th><th>Кол-во</th><th>Цена</th></tr></thead><tbody>${products.map(p=>`<tr><td>${esc(p.name)}<br>${esc(p.sku)}</td><td>${p.stock}</td><td>${money(p.price)}</td></tr>`).join('')}</tbody></table></div>`;
      $('#save-shipment').disabled=false;
    }catch(e){products=null;$('#import-info').textContent='';$('#import-error').textContent=e.message;}
  };
  form.onsubmit=async e=>{
    e.preventDefault();if(!products)return;
    if(warnings.length&&!$('#accept-warnings')?.checked){$('#import-error').textContent='Подтвердите проверку замечаний.';return;}
    const b=$('#save-shipment');b.disabled=true;$('#import-error').textContent='';
    try{await api('/admin/shipments','POST',{id:existing?.id||crypto.randomUUID(),...Object.fromEntries(new FormData(form)),products});closeDialog();await refresh();toast('Поставка сохранена.');}catch(e){if($('#import-error')){$('#import-error').textContent=e.message;b.disabled=false;}else toast(e.message);}
  };
}
function goBack(){if(Object.keys(state.cart).length){showDialog('Вернуться к поставкам?',`<p>Выбранные количества будут сброшены.</p><button class="primary full" id="leave">Вернуться</button>`);$('#leave').onclick=()=>{closeDialog();state.cart={};state.current=null;state.requestKey=null;render();};}else{state.current=null;render();}}
async function refresh(){
  try{if(!state.preview)state.shipments=(await api('/catalog')).shipments;render();}catch(e){toast(e.message);}
}
document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>{state.view=b.dataset.view;render();window.scrollTo(0,0);});
$('#refresh').onclick=refresh;
$('.brand').onclick=e=>{e.preventDefault();state.view='shipments';if(state.current)goBack();else render();};
tg?.BackButton?.onClick(goBack);
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&!state.preview&&!dialog.open)refresh();});
setInterval(()=>{if(!state.preview&&!document.hidden&&!dialog.open&&state.view==='shipments'&&tg?.initData)refresh();},45000);
init();
