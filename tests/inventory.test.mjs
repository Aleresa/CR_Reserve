import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {Inventory} from '../server/store.mjs';
import {authenticate} from '../server/auth.mjs';
import {createHmac} from 'node:crypto';
import {ReserveStore} from '../server/worker.mjs';

const user={id:'123',name:'Иван',username:'ivan'};
function fixture(){
  const db=new DatabaseSync(':memory:');
  const sql={exec(query,...args){const s=db.prepare(query);if(/^SELECT/i.test(query))return s.all(...args);s.run(...args);return [];}};
  const txn=fn=>{db.exec('BEGIN IMMEDIATE');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}};
  const inv=new Inventory(sql,txn);
  inv.saveManagers({managers:[{id:'manager-1',name:'Test manager',username:'test_manager'}]});
  const shipment={id:'sample',title:'Поставка',brand:'Test',status:'in_transit',eta:'2026-10-01',products:[{id:'p1',sku:'1',name:'Кабель',stock:10,price:16000},{id:'p2',sku:'2',name:'Чехол',stock:2,price:50000}]};
  inv.importShipment(shipment);
  return {inv,shipment,sql,txn};
}
const request=(key,qty=3)=>({shipmentId:'sample',requestKey:key,managerId:'manager-1',lines:[{id:'p1',quantity:qty}]});
test('reservation uses server price, deducts stock, creates notification in same transaction',()=>{
  const {inv}=fixture();const r=inv.reserve(user,{...request('key'),total:1,lines:[{id:'p1',quantity:3,price:1}]});
  assert.equal(r.total,48000);assert.equal(inv.catalog()[0].products[0].stock,7);assert.equal(inv.rows('SELECT * FROM outbox').length,1);
});
test('retries are idempotent and changed payload using same key is rejected',()=>{
  const {inv}=fixture();const a=inv.reserve(user,request('key'));const b=inv.reserve(user,request('key'));
  assert.equal(a.id,b.id);assert.equal(inv.catalog()[0].products[0].stock,7);assert.throws(()=>inv.reserve(user,request('key',4)),/другим содержимым/);
});
test('competing reservations cannot oversell the last units',async()=>{
  const {inv}=fixture();const results=await Promise.allSettled(Array.from({length:20},(_,i)=>Promise.resolve().then(()=>inv.reserve({id:String(i+1),name:'Buyer'},request('r-'+i,1)))));
  assert.equal(results.filter(x=>x.status==='fulfilled').length,10);assert.equal(results.filter(x=>x.status==='rejected').length,10);assert.equal(inv.catalog()[0].products[0].stock,0);
});
test('one unavailable item rolls back the entire cart',()=>{
  const {inv}=fixture();assert.throws(()=>inv.reserve(user,{...request('key'),lines:[{id:'p1',quantity:8},{id:'p2',quantity:3}]}),/свободно/);
  assert.equal(inv.catalog()[0].products[0].stock,10);assert.equal(inv.reservations(user).length,0);assert.equal(inv.rows('SELECT * FROM outbox').length,0);
});
test('failure writing notification rolls back reservation and stock',()=>{
  const {inv}=fixture();inv.enqueue=()=>{throw Error('disk full');};assert.throws(()=>inv.reserve(user,request('key')),/disk full/);assert.equal(inv.catalog()[0].products[0].stock,10);assert.equal(inv.reservations(user).length,0);
});
test('cancellation restores stock exactly once; other clients cannot cancel or read it',()=>{
  const {inv}=fixture();const r=inv.reserve(user,request('key'));assert.throws(()=>inv.changeReservation({id:'999'},r.id,'cancelled'),/не найден/);assert.equal(inv.reservations({id:'999'}).length,0);
  inv.changeReservation(user,r.id,'cancelled');inv.changeReservation(user,r.id,'cancelled');assert.equal(inv.catalog()[0].products[0].stock,10);
});
test('confirmation does not deduct twice; only admin can cancel confirmed reserve',()=>{
  const {inv}=fixture();const r=inv.reserve(user,request('key'));assert.throws(()=>inv.changeReservation(user,r.id,'confirmed'),/прав/);
  inv.changeReservation(user,r.id,'confirmed',true);assert.equal(inv.catalog()[0].products[0].stock,7);assert.throws(()=>inv.changeReservation(user,r.id,'cancelled'),/менеджером/);inv.changeReservation(user,r.id,'cancelled',true);assert.equal(inv.catalog()[0].products[0].stock,10);
});
test('updating shipment retains reservations and rejects totals below reserved',()=>{
  const {inv,shipment}=fixture();inv.reserve(user,request('key',7));shipment.products[0].stock=20;inv.importShipment(shipment);assert.equal(inv.catalog()[0].products[0].stock,13);
  shipment.products[0].stock=6;assert.throws(()=>inv.importShipment(shipment),/меньше уже/);assert.equal(inv.catalog()[0].products[0].stock,13);
  shipment.products=shipment.products.slice(1);assert.throws(()=>inv.importShipment(shipment),/удалить/);
});
test('drafts are private; closed and draft shipments cannot be reserved',()=>{
  const {inv,shipment}=fixture();for(const status of ['draft','closed']){inv.importShipment({...shipment,status});assert.throws(()=>inv.reserve(user,request(status)),/закрыт/);if(status==='draft')assert.equal(inv.catalog().length,0);}
});
test('invalid quantities, repeated items, negative stock and unsafe image URLs are rejected',()=>{
  const {inv,shipment}=fixture();for(const q of [0,-1,1.5,'3',Infinity])assert.throws(()=>inv.reserve(user,request('key',q)));
  assert.throws(()=>inv.reserve(user,{...request('dup'),lines:[{id:'p1',quantity:1},{id:'p1',quantity:1}]}));
  assert.throws(()=>inv.importShipment({...shipment,products:[{...shipment.products[0],stock:-1}]}));
  assert.throws(()=>inv.importShipment({...shipment,products:[{...shipment.products[0],image:'javascript:alert(1)'}]}));
});
function signedData(token,overrides={}){
  const params=new URLSearchParams({auth_date:String(Math.floor(Date.now()/1000)),user:JSON.stringify({id:123,first_name:'Иван'}),...overrides});
  const text=[...params.entries()].sort(([a],[b])=>a<b?-1:1).map(([k,v])=>`${k}=${v}`).join('\n');
  const secret=createHmac('sha256','WebAppData').update(token).digest();
  params.set('hash',createHmac('sha256',secret).update(text).digest('hex'));return params.toString();
}
test('Telegram signature validates; forged, expired, future and duplicate data fail',async()=>{
  const token='test:token',raw=signedData(token);assert.equal((await authenticate(raw,token)).id,'123');
  await assert.rejects(authenticate(raw,'other'));await assert.rejects(authenticate(raw.replace('123','124'),token));
  await assert.rejects(authenticate(signedData(token,{auth_date:'1'}),token));
  await assert.rejects(authenticate(signedData(token,{auth_date:String(Math.floor(Date.now()/1000)+500)}),token));
  await assert.rejects(authenticate(raw+'&auth_date=1',token));
});
test('worker rejects missing identity/admin rights, accepts signed client, and blocks unconfigured notifications',async()=>{
  const {sql,txn}=fixture(),token='test:token';let alarm=null;
  const ctx={storage:{sql,transactionSync:txn,getAlarm:async()=>alarm,setAlarm:async x=>alarm=x},waitUntil:()=>{}};
  const store=new ReserveStore(ctx,{BOT_TOKEN:token,ADMIN_IDS:'999'});
  assert.equal((await store.fetch(new Request('https://app/api/catalog'))).status,401);
  const headers={'Content-Type':'application/json','X-Telegram-Init-Data':signedData(token)};
  assert.equal((await store.fetch(new Request('https://app/api/catalog',{headers}))).status,200);
  assert.equal((await store.fetch(new Request('https://app/api/admin/shipments',{method:'POST',headers,body:'{}'}))).status,403);
  assert.equal((await store.fetch(new Request('https://app/api/reservations',{method:'POST',headers,body:JSON.stringify(request('key'))}))).status,503);
  assert.equal((await store.fetch(new Request('https://app/telegram/webhook',{method:'POST',headers,body:'{}'}))).status,403);
});

test('only the owner can configure bot; webhook secret survives restart and never reaches client',async t=>{
  const {sql,txn}=fixture(),token='test:setup',env={BOT_TOKEN:token,ADMIN_IDS:'123'};
  const ctx={storage:{sql,transactionSync:txn},waitUntil:()=>{}};
  const store=new ReserveStore(ctx,env),calls=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    calls.push({method:new URL(url).pathname.split('/').pop(),body:JSON.parse(options.body)});
    return Response.json({ok:true,result:true});
  });
  const configure=(data=signedData(token))=>new Request('https://app.example/api/admin/setup-bot',{method:'POST',headers:{'Content-Type':'application/json','X-Telegram-Init-Data':data},body:'{}'});
  assert.equal((await store.fetch(configure(''))).status,401);
  assert.equal((await store.fetch(configure(signedData(token,{user:JSON.stringify({id:456,first_name:'Buyer'})})))).status,403);
  assert.equal(calls.length,0);assert.equal(store.webhookSecret(),undefined);
  const result=await store.fetch(configure());assert.equal(result.status,200);assert.deepEqual(await result.json(),{ok:true});
  const secret=store.webhookSecret();assert.match(secret,/^[a-f0-9]{64}$/);
  assert.deepEqual(calls.map(c=>c.method).sort(),['setChatMenuButton','setMyCommands','setWebhook'].sort());
  assert.equal(calls.find(c=>c.method==='setWebhook').body.url,'https://app.example/telegram/webhook');
  assert.equal(calls.find(c=>c.method==='setWebhook').body.secret_token,secret);
  const restarted=new ReserveStore(ctx,env);assert.equal(restarted.webhookSecret(),secret);
  assert.equal((await restarted.fetch(configure())).status,200);assert.equal(restarted.webhookSecret(),secret);
  const webhook=value=>new Request('https://app.example/telegram/webhook',{method:'POST',headers:{'Content-Type':'application/json','X-Telegram-Bot-Api-Secret-Token':value},body:JSON.stringify({update_id:100})});
  assert.equal((await restarted.fetch(webhook('wrong'))).status,403);
  assert.equal((await restarted.fetch(webhook(secret))).status,200);
  const overridden=new ReserveStore(ctx,{...env,WEBHOOK_SECRET:'explicit-secret-123456789'});
  assert.equal((await overridden.fetch(webhook(secret))).status,403);
  assert.equal((await overridden.fetch(webhook('explicit-secret-123456789'))).status,200);
});

test('bot setup reports Telegram failures without exposing token or secret',async t=>{
  const {sql,txn}=fixture(),token='test:secret-token';
  const store=new ReserveStore({storage:{sql,transactionSync:txn}},{BOT_TOKEN:token,ADMIN_IDS:'123'});
  t.mock.method(globalThis,'fetch',async()=>Response.json({ok:false},{status:401}));
  const response=await store.fetch(new Request('https://app.example/api/admin/setup-bot',{method:'POST',headers:{'Content-Type':'application/json','X-Telegram-Init-Data':signedData(token)},body:'{}'}));
  assert.equal(response.status,502);const body=await response.text();
  assert(!body.includes(token));assert(!body.includes(store.webhookSecret()));
});

test('manager is required, validated on server, and included in notification',()=>{
  const {inv}=fixture();
  for(const managerId of [undefined,'missing'])assert.throws(()=>inv.reserve(user,{...request('bad'),managerId}),/менеджера/);
  assert.equal(inv.catalog()[0].products[0].stock,10);assert.equal(inv.rows('SELECT * FROM outbox').length,0);
  const r=inv.reserve(user,{...request('good'),manager:{name:'Forged',username:'wrong_person'}});
  assert.deepEqual(r.manager,{id:'manager-1',name:'Test manager',username:'test_manager'});
  assert.match(JSON.parse(inv.rows('SELECT data FROM outbox')[0].data).text,/Менеджер: Test manager @test_manager/);
});

test('manager snapshot survives edits/removal; retry cannot change assignment',()=>{
  const {inv}=fixture();const r=inv.reserve(user,request('original'));
  inv.saveManagers({managers:[{id:'manager-2',name:'Other manager',username:'other_manager'}]});
  assert.equal(inv.reserve(user,request('original')).id,r.id);
  assert.throws(()=>inv.reserve(user,{...request('original'),managerId:'manager-2'}),/другим содержимым/);
  assert.throws(()=>inv.reserve(user,request('new')),/менеджера/);
  const cancelled=inv.changeReservation(user,r.id,'cancelled');assert.equal(cancelled.manager.username,'test_manager');
  const messages=inv.rows('SELECT data FROM outbox').map(x=>JSON.parse(x.data).text);
  assert(messages.every(text=>text.includes('@test_manager')));assert.equal(inv.catalog()[0].products[0].stock,10);
});

test('manager list rejects duplicate usernames and invalid handles without losing existing list',()=>{
  const {inv}=fixture();
  for(const managers of [
    [{id:'a',name:'A',username:'@same_user'},{id:'b',name:'B',username:'SAME_USER'}],
    [{id:'a',name:'A',username:'https://t.me/person'}],
    [{id:'a',name:'A',username:'one_user\n@other_user'}]
  ])assert.throws(()=>inv.saveManagers({managers}));
  assert.equal(inv.managers()[0].id,'manager-1');
});

test('only admin can change managers; authenticated clients can read the choices',async()=>{
  const {sql,txn}=fixture(),token='test:managers';
  const store=new ReserveStore({storage:{sql,transactionSync:txn}},{BOT_TOKEN:token,ADMIN_IDS:'999'});
  const headers={'Content-Type':'application/json','X-Telegram-Init-Data':signedData(token)};
  assert.equal((await store.fetch(new Request('https://app/api/managers'))).status,401);
  assert.equal((await store.fetch(new Request('https://app/api/managers',{headers}))).status,200);
  assert.equal((await store.fetch(new Request('https://app/api/admin/managers',{method:'PUT',headers,body:'{"managers":[]}'}))).status,403);
  assert.equal(store.inventory.managers().length,1);
});

test('legacy reservations remain readable, cancellable, and retryable without a manager',()=>{
  const {inv}=fixture();const input=request('legacy'),r=inv.reserve(user,input);
  delete r.manager;
  inv.sql.exec('UPDATE reservations SET data=?,fingerprint=? WHERE id=?',JSON.stringify(r),JSON.stringify({shipment:input.shipmentId,lines:input.lines,comment:''}),r.id);
  const {managerId,...legacyInput}=input;
  assert.equal(inv.reserve(user,legacyInput).id,r.id);
  assert.equal(inv.reservations(user)[0].manager,undefined);
  inv.changeReservation(user,r.id,'cancelled');assert.equal(inv.catalog()[0].products[0].stock,10);
});

const editInput=(r,lines,extra={})=>({requestKey:crypto.randomUUID(),expectedRevision:r.revision||1,lines,comment:r.comment,...extra});
test('editing adjusts only stock differences, preserves agreed prices, and cancellation restores the edited quantities',()=>{
  const {inv,shipment}=fixture();const r=inv.reserve(user,request('first',3));
  inv.reserve({id:'other',name:'Other'},request('other',5));
  shipment.products[0].price=99000;inv.importShipment(shipment);
  const edit=editInput(r,[{id:'p1',quantity:4},{id:'p2',quantity:1}],{comment:'Updated'});
  const changed=inv.editReservation(user,r.id,edit);
  assert.equal(changed.total,4*16000+50000);assert.equal(changed.revision,2);assert.equal(changed.manager.username,'test_manager');
  assert.deepEqual(inv.catalog()[0].products.map(p=>p.stock),[1,1]);
  assert.equal(inv.editReservation(user,r.id,edit).repeated,true);assert.deepEqual(inv.catalog()[0].products.map(p=>p.stock),[1,1]);
  const shrunk=inv.editReservation(user,r.id,editInput(changed,[{id:'p2',quantity:2}]));
  assert.deepEqual(inv.catalog()[0].products.map(p=>p.stock),[5,0]);
  inv.changeReservation(user,shrunk.id,'cancelled');assert.deepEqual(inv.catalog()[0].products.map(p=>p.stock),[5,2]);
});
test('edit rejects overselling, stale versions, other users and invalid quantities without partial changes',()=>{
  const {inv}=fixture();const r=inv.reserve(user,request('first',3));
  inv.reserve({id:'other',name:'Other'},request('other',6));
  assert.throws(()=>inv.editReservation(user,r.id,editInput(r,[{id:'p1',quantity:5},{id:'p2',quantity:1}])),/максимум 4/);
  assert.deepEqual(inv.catalog()[0].products.map(p=>p.stock),[1,2]);
  assert.throws(()=>inv.editReservation({id:'stranger'},r.id,editInput(r,[{id:'p1',quantity:1}])),/не найден/);
  for(const quantity of [0,-1,1.5,'2'])assert.throws(()=>inv.editReservation(user,r.id,editInput(r,[{id:'p1',quantity}])));
  assert.throws(()=>inv.editReservation(user,r.id,editInput(r,[])));
  assert.throws(()=>inv.editReservation(user,r.id,editInput(r,[{id:'p1',quantity:1},{id:'p1',quantity:1}])));
  const updated=inv.editReservation(user,r.id,editInput(r,[{id:'p1',quantity:2}]));
  assert.throws(()=>inv.editReservation(user,r.id,editInput(r,[{id:'p1',quantity:1}])),/уже изменён/);
  assert.throws(()=>inv.changeReservation(user,r.id,'confirmed',true,1),/уже изменён/);
  assert.equal(updated.revision,2);
});
test('confirmed reservations require admin edits; closed shipments and cancelled reservations block client edits',()=>{
  const {inv,shipment}=fixture();const r=inv.reserve(user,request('first'));
  const confirmed=inv.changeReservation(user,r.id,'confirmed',true);
  assert.throws(()=>inv.editReservation(user,r.id,editInput(confirmed,[{id:'p1',quantity:1}])),/нельзя изменить/);
  const changed=inv.editReservation({id:'owner'},r.id,editInput(confirmed,[{id:'p1',quantity:2}]),true);
  assert.equal(changed.status,'confirmed');
  const cancelled=inv.changeReservation(user,r.id,'cancelled',true);
  assert.throws(()=>inv.editReservation(user,r.id,editInput(cancelled,[{id:'p1',quantity:1}]),true),/нельзя изменить/);
  const other=inv.reserve(user,request('open'));inv.importShipment({...shipment,status:'closed'});
  assert.throws(()=>inv.editReservation(user,other.id,editInput(other,[{id:'p1',quantity:1}])),/поставки закрыто/);
});
test('failed edit notification transaction rolls back stock, reservation and retry key',()=>{
  const {inv}=fixture();const r=inv.reserve(user,request('first'));
  inv.enqueue=()=>{throw Error('write failed');};
  assert.throws(()=>inv.editReservation(user,r.id,editInput(r,[{id:'p1',quantity:8}])),/write failed/);
  assert.equal(inv.catalog()[0].products[0].stock,7);assert.equal(inv.reservations(user)[0].revision,1);
  assert.equal(inv.rows('SELECT * FROM reservation_edits').length,0);
});
function deliveryFixture(){
  const {sql,txn}=fixture();let alarm=null;
  const ctx={storage:{sql,transactionSync:txn,getAlarm:async()=>alarm,setAlarm:async x=>alarm=x,deleteAlarm:async()=>alarm=null},waitUntil:()=>{}};
  const env={BOT_TOKEN:'test:delivery',RESERVATION_CHAT_ID:'-100123'};
  return {store:new ReserveStore(ctx,env),ctx,env};
}
test('Telegram send IDs persist across restarts; edit, confirm and cancel update the same message',async t=>{
  const {store,ctx,env}=deliveryFixture(),calls=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{calls.push({method:url.split('/').pop(),body:JSON.parse(options.body)});return Response.json({ok:true,result:{message_id:77}});});
  const r=store.inventory.reserve(user,request('first'));await store.flush();
  const restarted=new ReserveStore(ctx,env);
  const changed=restarted.inventory.editReservation(user,r.id,editInput(r,[{id:'p1',quantity:4}],{comment:'New comment'}));await restarted.flush();
  restarted.inventory.changeReservation(user,r.id,'confirmed',true);await restarted.flush();
  restarted.inventory.changeReservation(user,r.id,'cancelled',true);await restarted.flush();
  assert.deepEqual(calls.map(c=>c.method),['sendMessage','editMessageText','editMessageText','editMessageText']);
  assert(calls.slice(1).every(c=>c.body.message_id===77));
  assert.match(calls[1].body.text,/Резерв изменён/);assert.match(calls[1].body.text,/4 шт/);assert.match(calls[1].body.text,/@test_manager/);
  assert.match(calls[3].body.text,/Резерв отменён/);assert.equal(changed.revision,2);
});
test('queued updates send latest state once; transient edit errors retry without a new message',async t=>{
  const {store}=deliveryFixture(),calls=[];let fail=false;
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    const method=url.split('/').pop();calls.push({method,body:JSON.parse(options.body)});
    if(fail)return Response.json({ok:false,error_code:500,description:'Temporary failure'},{status:500});
    return Response.json({ok:true,result:{message_id:90}});
  });
  const r=store.inventory.reserve(user,request('first'));
  const changed=store.inventory.editReservation(user,r.id,editInput(r,[{id:'p1',quantity:2}]));await store.flush();
  assert.equal(calls.length,1);assert.match(calls[0].body.text,/2 шт/);
  store.inventory.editReservation(user,r.id,editInput(changed,[{id:'p1',quantity:4}]));fail=true;await store.flush();
  assert.equal(store.inventory.rows('SELECT * FROM outbox WHERE sent=0').length,1);
  fail=false;await store.flush();assert.equal(calls.filter(c=>c.method==='sendMessage').length,1);
  assert.equal(store.inventory.rows('SELECT * FROM outbox WHERE sent=0').length,0);
});
test('lost edit responses accept not-modified; deleted Telegram messages get a new tracked replacement',async t=>{
  const {store}=deliveryFixture(),calls=[];let editError='message is not modified';
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    const method=url.split('/').pop();calls.push({method,body:JSON.parse(options.body)});
    if(method==='editMessageText')return Response.json({ok:false,error_code:400,description:editError},{status:400});
    return Response.json({ok:true,result:{message_id:calls.length}});
  });
  const r=store.inventory.reserve(user,request('first'));await store.flush();
  const changed=store.inventory.editReservation(user,r.id,editInput(r,[{id:'p1',quantity:2}]));await store.flush();
  assert.equal(calls.length,2);assert.equal(store.inventory.rows('SELECT * FROM outbox WHERE sent=0').length,0);
  editError='Bad Request: message to edit not found';store.inventory.editReservation(user,r.id,editInput(changed,[{id:'p1',quantity:1}]));await store.flush();
  assert.deepEqual(calls.map(c=>c.method),['sendMessage','editMessageText','editMessageText','sendMessage']);
  assert.equal(store.inventory.one('SELECT message_id FROM reservation_messages').message_id,4);
});
test('long reservation parts are edited and cleared in place when the list shrinks',async t=>{
  const {store}=deliveryFixture(),calls=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{calls.push({method:url.split('/').pop(),body:JSON.parse(options.body)});return Response.json({ok:true,result:{message_id:calls.length}});});
  const products=Array.from({length:12},(_,i)=>({id:'long-'+i,sku:'long-'+i,name:'😀'.repeat(210),stock:5,price:100}));
  store.inventory.importShipment({id:'long',title:'Long shipment',status:'in_transit',products});
  const r=store.inventory.reserve(user,{...request('first'),shipmentId:'long',lines:products.map(p=>({id:p.id,quantity:1}))});await store.flush();
  const sent=calls.filter(c=>c.method==='sendMessage').length;assert(sent>1);
  assert(calls.every(c=>c.body.text.length<=3000&&!/[\uD800-\uDBFF]$/.test(c.body.text)));
  store.inventory.editReservation(user,r.id,editInput(r,[{id:products[0].id,quantity:1}]));await store.flush();
  assert.equal(calls.filter(c=>c.method==='sendMessage').length,sent);
  const messages=store.inventory.rows('SELECT * FROM reservation_messages ORDER BY part');
  assert(messages.slice(1).every(m=>m.text.includes('больше не используется')));
});
test('an update arriving during Telegram delivery is still queued and eventually edits the latest content',async t=>{
  const {store}=deliveryFixture(),calls=[];let release,started;
  const ready=new Promise(r=>started=r),gate=new Promise(r=>release=r);
  t.mock.method(globalThis,'fetch',async(url,options)=>{calls.push({method:url.split('/').pop(),body:JSON.parse(options.body)});if(calls.length===1){started();await gate;}return Response.json({ok:true,result:{message_id:10}});});
  const r=store.inventory.reserve(user,request('first'));const delivery=store.flush();await ready;
  store.inventory.editReservation(user,r.id,editInput(r,[{id:'p1',quantity:1}]));release();await delivery;
  assert.equal(store.inventory.rows('SELECT * FROM outbox WHERE sent=0').length,1);
  await store.flush();assert.deepEqual(calls.map(c=>c.method),['sendMessage','editMessageText']);assert.match(calls[1].body.text,/1 шт/);
});

test('cancelled reservations leave client list but stay in admin history',()=>{
  const {inv}=fixture();const cancelled=inv.reserve(user,request('cancel-me'));
  const active=inv.reserve(user,request('keep-me',1));
  inv.changeReservation(user,cancelled.id,'cancelled');
  assert.deepEqual(inv.reservations(user).map(r=>r.id),[active.id]);
  assert.equal(inv.reservations(user,true).find(r=>r.id===cancelled.id).status,'cancelled');
});
test('shipment deletion blocks active and confirmed reserves, preserves cancelled history and retry keys',()=>{
  const {inv}=fixture(),r=inv.reserve(user,request('key'));
  assert.throws(()=>inv.deleteShipment('sample'),/действующие резервы/);
  inv.changeReservation(user,r.id,'confirmed',true);assert.throws(()=>inv.deleteShipment('sample'),/действующие резервы/);
  assert.equal(inv.catalog()[0].products[0].stock,7);
  inv.changeReservation(user,r.id,'cancelled',true);
  assert.deepEqual(inv.deleteShipment('sample'),{deleted:true});
  assert.equal(inv.catalog(true).length,0);assert.equal(inv.rows('SELECT * FROM products').length,0);
  assert.equal(inv.reservations(user,true)[0].status,'cancelled');
  assert.equal(inv.reserve(user,request('key')).status,'cancelled');
  assert.deepEqual(inv.deleteShipment('sample'),{deleted:true});
  assert.throws(()=>inv.reserve(user,request('new')),/закрыт/);
});
test('shipment deletion requires administrator identity and is transactional',async()=>{
  const {sql,txn,inv}=fixture(),token='test:delete';
  const store=new ReserveStore({storage:{sql,transactionSync:txn},waitUntil:()=>{}},{BOT_TOKEN:token,ADMIN_IDS:'999'});
  const remove=data=>store.fetch(new Request('https://app/api/admin/shipments/sample',{method:'DELETE',headers:{'X-Telegram-Init-Data':data}}));
  assert.equal((await remove('')).status,401);assert.equal((await remove(signedData(token))).status,403);
  const exec=sql.exec;sql.exec=(q,...args)=>{if(q==='DELETE FROM shipments WHERE id=?')throw Error('disk full');return exec(q,...args);};
  assert.throws(()=>inv.deleteShipment('sample'),/disk full/);assert.equal(inv.catalog()[0].products.length,2);
  sql.exec=exec;
  const owner=signedData(token,{user:JSON.stringify({id:999,first_name:'Owner'})});
  assert.equal((await remove(owner)).status,200);assert.equal(inv.catalog(true).length,0);
});
