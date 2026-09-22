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
  const shipment={id:'sample',title:'Поставка',brand:'Test',status:'in_transit',eta:'2026-10-01',products:[{id:'p1',sku:'1',name:'Кабель',stock:10,price:16000},{id:'p2',sku:'2',name:'Чехол',stock:2,price:50000}]};
  inv.importShipment(shipment);
  return {inv,shipment,sql,txn};
}
const request=(key,qty=3)=>({shipmentId:'sample',requestKey:key,lines:[{id:'p1',quantity:qty}]});
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
