import {authenticate,isAdmin,ApiError} from './auth.mjs';
import {Inventory} from './store.mjs';

function json(data,status=200) { return Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}}); }
async function readJson(request) {
  if(!request.headers.get('Content-Type')?.includes('application/json')) throw new ApiError(415,'Ожидается JSON.');
  if(Number(request.headers.get('Content-Length'))>15000000) throw new ApiError(413,'Файл слишком большой.');
  const body=await request.text();
  if(body.length>15000000) throw new ApiError(413,'Файл слишком большой.');
  try { const value=JSON.parse(body); if(!value || typeof value !== 'object' || Array.isArray(value)) throw Error(); return value; } catch { throw new ApiError(400,'Некорректный JSON.'); }
}
async function telegram(env,method,body) {
  const response=await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
  const result=await response.json();
  if(!response.ok || !result.ok) { const error=new Error('Telegram request failed');error.telegramCode=result.error_code;error.telegramDescription=result.description||'';throw error; }
  return result.result;
}

export class ReserveStore {
  constructor(ctx,env) {
    this.ctx=ctx; this.env=env;
    this.inventory=new Inventory(ctx.storage.sql,fn=>ctx.storage.transactionSync(fn));
    this.inventory.sql.exec('CREATE TABLE IF NOT EXISTS reservation_messages (reservation_id TEXT NOT NULL, target TEXT NOT NULL, part INTEGER NOT NULL, message_id INTEGER NOT NULL, text TEXT NOT NULL, PRIMARY KEY(reservation_id,target,part))');
    this.inventory.sql.exec('CREATE TABLE IF NOT EXISTS bot_updates (id INTEGER PRIMARY KEY)');
    this.inventory.sql.exec('CREATE TABLE IF NOT EXISTS bot_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  }
  async fetch(request) {
    try {
      const url=new URL(request.url),path=url.pathname;
      if(path==='/api/bootstrap') return json({mode:this.env.BOT_TOKEN?'live':'preview',notificationReady:Boolean(this.env.RESERVATION_CHAT_ID),botUsername:this.env.BOT_USERNAME});
      if(path==='/telegram/webhook') return await this.webhook(request);
      const user=await authenticate(request.headers.get('X-Telegram-Init-Data'),this.env.BOT_TOKEN);
      const admin=isAdmin(user,this.env);
      if(path==='/api/me' && request.method==='GET') return json({user,admin});
      if(path==='/api/managers' && request.method==='GET') return json({managers:this.inventory.managers()});
      if(path==='/api/admin/managers' && request.method==='PUT') {
        if(!admin) throw new ApiError(403,'Раздел доступен только владельцу.');
        return json({managers:this.inventory.saveManagers(await readJson(request))});
      }
      if(path==='/api/admin/setup-bot' && request.method==='POST') {
        if(!admin) throw new ApiError(403,'Раздел доступен только владельцу.');
        await readJson(request);
        return json(await this.setupBot(url.origin));
      }
      if(path==='/api/catalog' && request.method==='GET') return json({shipments:this.inventory.catalog(admin)});
      if(path==='/api/reservations' && request.method==='GET') return json({reservations:this.inventory.reservations(user,admin && url.searchParams.get('all')==='1')});
      if(path==='/api/reservations' && request.method==='POST') {
        if(!this.env.RESERVATION_CHAT_ID) throw new ApiError(503,'Приём резервов пока не открыт.');
        const input=await readJson(request);
        await this.ensureAlarm();
        const reservation=this.inventory.reserve(user,input);
        this.ctx.waitUntil(this.flush());
        return json({reservation},201);
      }
      if(/^\/api\/reservations\/[a-f0-9-]+$/.test(path) && request.method==='PATCH') {
        const input=await readJson(request);
        await this.ensureAlarm();
        const id=path.split('/').pop();
        if('lines' in input && 'status' in input) throw new ApiError(400,'Изменяйте состав и статус отдельными действиями.');
        const reservation='lines' in input?this.inventory.editReservation(user,id,input,admin):this.inventory.changeReservation(user,id,input.status,admin,input.expectedRevision);
        this.ctx.waitUntil(this.flush());
        return json({reservation});
      }
      if(/^\/api\/admin\/shipments\/[a-zA-Z0-9_-]{1,80}$/.test(path) && request.method==='DELETE') {
        if(!admin)throw new ApiError(403,'Раздел доступен только владельцу.');
        return json(this.inventory.deleteShipment(path.split('/').pop()));
      }
      if(path==='/api/admin/shipments' && request.method==='POST') {
        if(!admin) throw new ApiError(403,'Раздел доступен только владельцу.');
        return json({shipment:this.inventory.importShipment(await readJson(request))});
      }
      throw new ApiError(404,'Маршрут не найден.');
    } catch(error) {
      if(!(error instanceof ApiError)) console.error('Request failed:',error.name);
      return json({error:error instanceof ApiError?error.message:'Не удалось выполнить запрос. Попробуйте ещё раз.'},error.status || 500);
    }
  }
  webhookSecret() {
    return this.env.WEBHOOK_SECRET || this.inventory.one("SELECT value FROM bot_settings WHERE key='webhook_secret'")?.value;
  }
  async setupBot(origin) {
    if(!origin.startsWith('https://')) throw new ApiError(400,'Для подключения нужен HTTPS-адрес приложения.');
    if(!this.webhookSecret()) {
      const secret=Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');
      // Persist before registering with Telegram; repeated clicks and restarts reuse it.
      this.inventory.sql.exec("INSERT OR IGNORE INTO bot_settings(key,value) VALUES('webhook_secret',?)",secret);
    }
    const secret=this.webhookSecret();
    if(!/^[A-Za-z0-9_-]{16,256}$/.test(secret)) throw new ApiError(400,'Проверьте WEBHOOK_SECRET: от 16 до 256 латинских букв, цифр, дефисов или подчёркиваний.');
    try {
      await Promise.all([
        telegram(this.env,'setWebhook',{url:origin+'/telegram/webhook',secret_token:secret,allowed_updates:['message']}),
        telegram(this.env,'setChatMenuButton',{menu_button:{type:'web_app',text:'Поставки',web_app:{url:origin}}}),
        telegram(this.env,'setMyCommands',{commands:[{command:'start',description:'Открыть поставки'},{command:'id',description:'Узнать свой Telegram ID'},{command:'admin',description:'Управление поставками'}]})
      ]);
    } catch {
      throw new ApiError(502,'Не удалось завершить настройку бота. Повторите подключение; если ошибка сохранится, проверьте BOT_TOKEN в Cloudflare.');
    }
    return {ok:true};
  }
  async ensureAlarm() { if(!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now()+30000); }
  async flush() {
    if(this.flushing) return;
    this.flushing=true;
    try {
      if(!this.env.RESERVATION_CHAT_ID || !this.env.BOT_TOKEN) return;
      const budget={remaining:20};
      for(const row of this.inventory.rows('SELECT id,data FROM outbox WHERE sent=0 ORDER BY rowid LIMIT 20')) {
        const data=JSON.parse(row.data),id=data.reservationId||row.id.split(':')[0];
        if(!await this.syncReservationMessage(id,budget))break;
        this.inventory.sql.exec('UPDATE outbox SET sent=1 WHERE id=?',row.id);
      }
    } catch { console.warn('Notification pending; scheduled retry'); }
    finally {
      this.flushing=false;
      if(this.inventory.one('SELECT id FROM outbox WHERE sent=0 LIMIT 1')) await this.ensureAlarm();
    }
  }
  async syncReservationMessage(id,budget) {
    const row=this.inventory.one('SELECT data,status FROM reservations WHERE id=?',id);
    if(!row)throw new Error('Reservation notification missing');
    const data={...JSON.parse(row.data),status:row.status},target=String(this.env.RESERVATION_CHAT_ID);
    const text=this.inventory.notificationText(data),chunks=[];
    let chunk='';for(const char of text){if(chunk.length+char.length>3000){chunks.push(chunk);chunk='';}chunk+=char;}if(chunk)chunks.push(chunk);
    const previous=this.inventory.rows('SELECT * FROM reservation_messages WHERE reservation_id=? AND target=? ORDER BY part',id,target);
    // Old extra parts are cleared in place and can be reused if the reservation grows later.
    const count=Math.max(chunks.length,previous.length);
    for(let part=0;part<count;part++) {
      const content=chunks[part]||`Резерв №${id} · Эта часть больше не используется. Актуальный состав — в первом сообщении.`,old=previous.find(p=>p.part===part);
      if(old?.text===content)continue;
      if(budget.remaining<=0)return false;
      let messageId=old?.message_id;
      if(messageId){
        budget.remaining--;
        try{await telegram(this.env,'editMessageText',{chat_id:target,message_id:messageId,text:content});}
        catch(error){
          const description=error.telegramDescription||'';
          if(error.telegramCode===400 && /message is not modified/i.test(description)) { /* A previous edit succeeded before a lost response. */ }
          else if(error.telegramCode===400 && /message to edit not found|message can't be edited|message can not be edited/i.test(description))messageId=null;
          else throw error;
        }
      }
      if(!messageId){
        if(budget.remaining<=0)return false;
        budget.remaining--;
        const sent=await telegram(this.env,'sendMessage',{chat_id:target,text:content});
        if(!Number.isSafeInteger(sent?.message_id) || sent.message_id<=0)throw new Error('Telegram message ID missing');
        messageId=sent.message_id;
      }
      this.inventory.sql.exec('INSERT INTO reservation_messages(reservation_id,target,part,message_id,text) VALUES(?,?,?,?,?) ON CONFLICT(reservation_id,target,part) DO UPDATE SET message_id=excluded.message_id,text=excluded.text',id,target,part,messageId,content);
    }
    return true;
  }
  async alarm() {
    // Re-arm before external I/O. A crash cannot strand a committed notification.
    await this.ctx.storage.setAlarm(Date.now()+60000);
    await this.flush();
    if(!this.inventory.one('SELECT id FROM outbox WHERE sent=0 LIMIT 1')) await this.ctx.storage.deleteAlarm();
  }
  async webhook(request) {
    const secret=this.webhookSecret();
    if(request.method!=='POST' || !secret || request.headers.get('X-Telegram-Bot-Api-Secret-Token')!==secret) return json({error:'Forbidden'},403);
    const update=await readJson(request);
    if(!Number.isSafeInteger(update.update_id)) return json({error:'Invalid update'},400);
    if(this.inventory.one('SELECT id FROM bot_updates WHERE id=?',update.update_id)) return json({ok:true});
    const message=update.message;
    if(message?.chat?.type==='private' && message.from) {
      const command=(message.text || '').split(' ')[0];
      let text=null;
      if(command==='/id') text=`Ваш Telegram ID: ${message.from.id}`;
      if(command==='/start') text='Откройте поставки, выберите товары и оформите резерв. Свободное количество обновляется после каждого резерва.';
      const admin=isAdmin({id:message.from.id},this.env);
      if(command==='/admin' && admin) text='Откройте приложение → Управление. Здесь можно загрузить Excel, опубликовать поставку и обработать резервы.';
      if(message.forward_origin?.type==='channel' && admin) text=`ID канала: ${message.forward_origin.chat.id}\nДобавьте бота администратором с правом публикации, затем укажите этот ID в RESERVATION_CHAT_ID.`;
      if(message.document && admin) text='Для загрузки Excel откройте приложение → Управление → Новая поставка. Импорт покажет ошибки и позволит проверить данные до публикации.';
      if(text) await telegram(this.env,'sendMessage',{chat_id:message.chat.id,text,reply_markup:{inline_keyboard:[[{text:'Открыть поставки',url:this.env.MINI_APP_URL || 'https://t.me/CR_Reserve_Bot/CR_Reserve'}]]}});
    }
    this.inventory.sql.exec('INSERT OR IGNORE INTO bot_updates(id) VALUES(?)',update.update_id);
    this.inventory.sql.exec('DELETE FROM bot_updates WHERE id < ?',update.update_id-10000);
    return json({ok:true});
  }
}

export default {
  async fetch(request,env) {
    const path=new URL(request.url).pathname;
    if(path.startsWith('/api/') || path==='/telegram/webhook') {
      if(request.headers.get('Origin') && request.headers.get('Origin')!==new URL(request.url).origin) return json({error:'Forbidden'},403);
      return env.STORE.get(env.STORE.idFromName('cr-reserve-v1')).fetch(request);
    }
    const response=await env.ASSETS.fetch(request);
    const headers=new Headers(response.headers);
    headers.set('X-Content-Type-Options','nosniff');
    headers.set('Referrer-Policy','strict-origin-when-cross-origin');
    headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self' https://telegram.org; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors https://web.telegram.org https://*.telegram.org");
    return new Response(response.body,{status:response.status,headers});
  }
};
