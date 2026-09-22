import {ApiError} from './auth.mjs';

const ACTIVE = new Set(['in_transit','arrived']);
const STATUSES = new Set(['draft','in_transit','arrived','closed']);
const validId = x => typeof x === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(x);
const trim = (s,n) => typeof s === 'string' ? s.trim().slice(0,n) : '';

export class Inventory {
  constructor(sql, transaction) {
    this.sql = sql;
    this.transaction = transaction;
    sql.exec(`CREATE TABLE IF NOT EXISTS shipments (id TEXT PRIMARY KEY, data TEXT NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS products (shipment TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, total INTEGER NOT NULL CHECK(total>=0), reserved INTEGER NOT NULL DEFAULT 0 CHECK(reserved>=0 AND reserved<=total), PRIMARY KEY(shipment,id))`);
    sql.exec(`CREATE TABLE IF NOT EXISTS reservations (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, request_key TEXT NOT NULL, fingerprint TEXT NOT NULL, shipment TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(user_id,request_key))`);
    sql.exec(`CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, data TEXT NOT NULL, sent INTEGER NOT NULL DEFAULT 0)`);
  }
  rows(query,...bindings) { return [...this.sql.exec(query,...bindings)]; }
  one(query,...bindings) { return this.rows(query,...bindings)[0]; }
  catalog(admin=false) {
    return this.rows('SELECT data FROM shipments').map(r=>JSON.parse(r.data)).filter(s=>admin || s.status !== 'draft').map(s=>({...s,products:this.rows('SELECT * FROM products WHERE shipment=?',s.id).map(p=>({...JSON.parse(p.data),stock:p.total-p.reserved,...(admin?{total:p.total,reserved:p.reserved}:{})}))}));
  }
  importShipment(input) {
    if (!validId(input.id) || !trim(input.title,160) || !STATUSES.has(input.status) || !Array.isArray(input.products) || !input.products.length || input.products.length>3000) throw new ApiError(400,'Проверьте название, статус и список товаров.');
    for (const d of [input.eta,input.publishedAt]) if (d != null && d !== '' && (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !Number.isFinite(Date.parse(d)) || new Date(d).toISOString().slice(0,10)!==d)) throw new ApiError(400,'Некорректная дата.');
    const old = this.one('SELECT data FROM shipments WHERE id=?',input.id);
    const previous = old ? JSON.parse(old.data) : null;
    const shipment = {id:input.id,title:trim(input.title,160),brand:trim(input.brand,80),description:trim(input.description,3000),status:input.status,eta:input.eta || null,
      publishedAt:input.publishedAt || previous?.publishedAt || (input.status === 'draft'?null:new Date().toISOString().slice(0,10))};
    const ids = new Set();
    const products = input.products.map(p=>{
      const total=p.total ?? p.stock;
      if (!validId(p.id) || ids.has(p.id) || !trim(p.name,500) || !Number.isSafeInteger(total) || total<0 || total>10000000 || !Number.isSafeInteger(p.price) || p.price<0 || p.price>100000000) throw new ApiError(400,'В товарах есть некорректный артикул, количество, цена или дубликат.');
      ids.add(p.id);
      if (p.image && (!/^data:image\/(webp|png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(p.image) || p.image.length>180000)) throw new ApiError(400,'Некорректное изображение.');
      if (p.imageKey && !/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$/.test(p.imageKey)) throw new ApiError(400,'Некорректное изображение.');
      return {id:p.id,sku:trim(p.sku || p.id,80),name:trim(p.name,500),price:p.price,unit:trim(p.unit || 'шт',20),image:p.image || null,imageKey:p.imageKey || null,total};
    });
    return this.transaction(()=>{
      const current=this.rows('SELECT id,reserved FROM products WHERE shipment=?',shipment.id);
      for(const p of current) if(p.reserved && !ids.has(p.id)) throw new ApiError(409,'Нельзя удалить товар с действующими резервами.');
      for(const p of products) {
        const existing=current.find(x=>x.id===p.id);
        if((existing?.reserved || 0)>p.total) throw new ApiError(409,`${p.sku}: количество меньше уже зарезервированного.`);
      }
      this.sql.exec('INSERT INTO shipments(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',shipment.id,JSON.stringify(shipment));
      for(const p of products) this.sql.exec('INSERT INTO products(shipment,id,data,total) VALUES(?,?,?,?) ON CONFLICT(shipment,id) DO UPDATE SET data=excluded.data,total=excluded.total',shipment.id,p.id,JSON.stringify(p),p.total);
      for(const p of current) if(!ids.has(p.id)) this.sql.exec('DELETE FROM products WHERE shipment=? AND id=?',shipment.id,p.id);
      return shipment;
    });
  }
  reserve(user,input) {
    if(!validId(input.shipmentId) || !validId(input.requestKey) || !Array.isArray(input.lines) || !input.lines.length || input.lines.length>100) throw new ApiError(400,'Выберите от 1 до 100 позиций.');
    const seen=new Set();
    const lines=input.lines.map(l=>{
      if(!validId(l.id) || seen.has(l.id) || !Number.isSafeInteger(l.quantity) || l.quantity<1 || l.quantity>10000000) throw new ApiError(400,'Некорректное количество или повтор товара.');
      seen.add(l.id); return {id:l.id,quantity:l.quantity};
    }).sort((a,b)=>a.id.localeCompare(b.id));
    const comment=trim(input.comment,1000);
    const fingerprint=JSON.stringify({shipment:input.shipmentId,lines,comment});
    return this.transaction(()=>{
      const previous=this.one('SELECT * FROM reservations WHERE user_id=? AND request_key=?',user.id,input.requestKey);
      if(previous) {
        if(previous.fingerprint!==fingerprint) throw new ApiError(409,'Повтор запроса с другим содержимым.');
        return {...JSON.parse(previous.data),status:previous.status,repeated:true};
      }
      const shipmentRow=this.one('SELECT data FROM shipments WHERE id=?',input.shipmentId);
      const shipment=shipmentRow && JSON.parse(shipmentRow.data);
      if(!shipment || !ACTIVE.has(shipment.status)) throw new ApiError(409,'Резерв этой поставки закрыт.');
      const detailed=lines.map(l=>{
        const row=this.one('SELECT * FROM products WHERE shipment=? AND id=?',input.shipmentId,l.id);
        if(!row) throw new ApiError(409,'Товар больше не доступен.');
        const product=JSON.parse(row.data);
        if(row.total-row.reserved<l.quantity) throw new ApiError(409,`${product.sku}: свободно ${row.total-row.reserved} шт. Обновите количество.`);
        return {id:l.id,sku:product.sku,name:product.name,quantity:l.quantity,price:product.price};
      });
      const data={id:crypto.randomUUID(),shipmentId:shipment.id,shipmentTitle:shipment.title,user,lines:detailed,comment,status:'reserved',createdAt:new Date().toISOString(),total:detailed.reduce((s,l)=>s+l.price*l.quantity,0)};
      if(!Number.isSafeInteger(data.total)) throw new ApiError(400,'Слишком большая сумма.');
      for(const l of detailed) this.sql.exec('UPDATE products SET reserved=reserved+? WHERE shipment=? AND id=?',l.quantity,shipment.id,l.id);
      this.sql.exec('INSERT INTO reservations(id,user_id,request_key,fingerprint,shipment,status,data) VALUES(?,?,?,?,?,?,?)',data.id,user.id,input.requestKey,fingerprint,shipment.id,data.status,JSON.stringify(data));
      this.enqueue(data,'created');
      return data;
    });
  }
  reservations(user,admin=false) {
    const rows=admin?this.rows('SELECT * FROM reservations ORDER BY rowid DESC LIMIT 1000'):this.rows('SELECT * FROM reservations WHERE user_id=? ORDER BY rowid DESC LIMIT 1000',user.id);
    return rows.map(r=>({...JSON.parse(r.data),status:r.status}));
  }
  changeReservation(user,id,status,admin=false) {
    if(!['cancelled','confirmed'].includes(status) || (!admin && status!=='cancelled')) throw new ApiError(403,'Недостаточно прав.');
    return this.transaction(()=>{
      const row=this.one('SELECT * FROM reservations WHERE id=?',id);
      if(!row || (!admin && row.user_id!==user.id)) throw new ApiError(404,'Резерв не найден.');
      const data=JSON.parse(row.data);
      if(row.status===status) return {...data,status};
      if(row.status==='cancelled' || (!admin && row.status==='confirmed')) throw new ApiError(409,'Для изменения подтверждённого резерва свяжитесь с менеджером.');
      if(status==='cancelled') for(const l of data.lines) this.sql.exec('UPDATE products SET reserved=reserved-? WHERE shipment=? AND id=?',l.quantity,data.shipmentId,l.id);
      this.sql.exec('UPDATE reservations SET status=? WHERE id=?',status,id);
      this.enqueue({...data,status},status);
      return {...data,status};
    });
  }
  enqueue(data,event) {
    const name={created:'Новый резерв',cancelled:'Резерв отменён',confirmed:'Резерв подтверждён'}[event];
    const who=`${data.user.name}${data.user.username?' @'+data.user.username:''} (ID ${data.user.id})`;
    const text=`${name} №${data.id}\nКлиент: ${who}\nПоставка: ${data.shipmentTitle}\n\n${data.lines.map(l=>`${l.sku} · ${l.name}\n${l.quantity} шт. × ${(l.price/100).toFixed(2)} ₽`).join('\n\n')}\n\nИтого: ${(data.total/100).toFixed(2)} ₽${data.comment?'\nКомментарий: '+data.comment:''}`;
    const chunks=[];
    for(let i=0;i<text.length;i+=3000) chunks.push(text.slice(i,i+3000));
    chunks.forEach((text,index)=>this.sql.exec('INSERT OR IGNORE INTO outbox(id,data) VALUES(?,?)',`${data.id}:${event}:${index}`,JSON.stringify({text,kind:'manager'})));
  }
}
