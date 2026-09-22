// Secrets are read only from environment; do not put tokens in command arguments.
const {BOT_TOKEN,APP_URL,WEBHOOK_SECRET}=process.env;
if(!BOT_TOKEN || !APP_URL?.startsWith('https://') || !/^[A-Za-z0-9_-]{16,256}$/.test(WEBHOOK_SECRET||''))throw Error('Set BOT_TOKEN, APP_URL and WEBHOOK_SECRET (16+ URL-safe characters).');
const call=async(method,body)=>{
  const response=await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const data=await response.json();if(!data.ok)throw Error(`${method} failed. Check bot configuration.`);
  console.log(`${method}: OK`);
};
await call('setWebhook',{url:new URL('/telegram/webhook',APP_URL).href,secret_token:WEBHOOK_SECRET,allowed_updates:['message']});
await call('setChatMenuButton',{menu_button:{type:'web_app',text:'Поставки',web_app:{url:APP_URL}}});
await call('setMyCommands',{commands:[{command:'start',description:'Открыть поставки'},{command:'id',description:'Узнать свой Telegram ID'},{command:'admin',description:'Управление поставками'}]});
