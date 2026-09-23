import {parseSupplierRows} from './supplier-rows.js';
// Supplier XLSX reader: reads cells and DrawingML anchors, then compresses images.
// All processing stays in the owner's browser until Save is pressed.
const xml = text => {
  const doc=new DOMParser().parseFromString(text,'application/xml');
  if(doc.querySelector('parsererror')) throw Error('Повреждённый XML в Excel.');
  return doc;
};
const nodes=(el,tag)=>[...el.getElementsByTagNameNS('*',tag)];
const textOf=(el,tag)=>nodes(el,tag).map(x=>x.textContent).join('');
function resolve(base,target) {
  const parts=(target.startsWith('/')?target.slice(1):base.slice(0,base.lastIndexOf('/')+1)+target).split('/');
  const out=[];for(const p of parts) if(p==='..')out.pop();else if(p!=='.' && p)out.push(p);
  return out.join('/');
}
async function relations(zip,path) {
  const parts=path.split('/'),file=parts.pop();
  const entry=zip.file([...parts,'_rels',file+'.rels'].join('/'));
  if(!entry)return {};
  return Object.fromEntries(nodes(xml(await entry.async('text')),'Relationship').filter(r=>r.getAttribute('TargetMode')!=='External').map(r=>[r.getAttribute('Id'),resolve(path,r.getAttribute('Target'))]));
}
async function compress(bytes) {
  const blob=new Blob([bytes]),url=URL.createObjectURL(blob);
  try {
    const image=new Image();image.src=url;await image.decode();
    const ratio=Math.min(1,320/image.width,320/image.height);
    const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(image.width*ratio));canvas.height=Math.max(1,Math.round(image.height*ratio));
    const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(image,0,0,canvas.width,canvas.height);
    return canvas.toDataURL('image/webp',.7);
  } finally {URL.revokeObjectURL(url);}
}
export async function readSupplierExcel(file,{signal}={}) {
  if(!/\.xlsx?$/i.test(file.name))throw Error('Выберите файл .xls или .xlsx.');
  if(file.size>25*1024*1024)throw Error('Excel должен быть не больше 25 МБ.');
  signal?.throwIfAborted();
  const bytes=await file.arrayBuffer();
  signal?.throwIfAborted();
  if(new Uint8Array(bytes)[0]===0x50)return readXlsx(bytes,signal);
  const result=await readLegacy(bytes,signal);
  for(const picture of result.pictures) {
    signal?.throwIfAborted();
    const product=result.products.find(p=>p.id===picture.id);
    try{product.image=await compress(picture.bytes);}catch{result.warnings.push(`${product.sku}: не удалось прочитать фотографию.`);}
  }
  signal?.throwIfAborted();
  for(const product of result.products)if(!product.image)result.warnings.push(`${product.sku}: фотография отсутствует или её формат не поддерживается.`);
  return {products:result.products,warnings:result.warnings};
}
function readLegacy(bytes,signal) {
  return new Promise((resolve,reject)=>{
    const worker=new Worker(new URL('./xls-worker.js',import.meta.url));
    const finish=(error,result)=>{worker.terminate();signal?.removeEventListener('abort',abort);clearTimeout(timer);error?reject(error):resolve(result);};
    const abort=()=>finish(new DOMException('Импорт отменён','AbortError'));
    const timer=setTimeout(()=>finish(Error('Чтение Excel заняло слишком много времени. Попробуйте уменьшить файл.')),60000);
    signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted){abort();return;}
    worker.onerror=()=>finish(Error('Не удалось запустить обработчик XLS. Обновите приложение и повторите загрузку.'));
    worker.onmessage=({data})=>finish(data.error?Error(data.error):null,data);
    worker.postMessage(bytes,[bytes]);
  });
}
async function readXlsx(file,signal) {
  const zip=await window.JSZip.loadAsync(file);
  let unpacked=0;
  for(const f of Object.values(zip.files)) {
    unpacked+=f._data?.uncompressedSize || 0;
    if(unpacked>120*1024*1024)throw Error('Распакованный Excel слишком большой.');
  }
  const workbook=zip.file('xl/workbook.xml');if(!workbook)throw Error('Нужен файл .xlsx.');
  const wr=await relations(zip,'xl/workbook.xml');
  const sheet=nodes(xml(await workbook.async('text')),'sheet')[0];
  const path=sheet&&wr[sheet.getAttribute('r:id')];
  if(!path || !zip.file(path))throw Error('Лист Excel не найден.');
  const doc=xml(await zip.file(path).async('text'));
  const ss=zip.file('xl/sharedStrings.xml');
  const strings=ss?nodes(xml(await ss.async('text')),'si').map(x=>textOf(x,'t')):[];
  const rows=new Map();
  for(const r of nodes(doc,'row')) {
    const cells={};
    for(const c of nodes(r,'c')) {
      const col=c.getAttribute('r').replace(/\d/g,'');
      const value=textOf(c,'v');
      cells[col]=c.getAttribute('t')==='s'?strings[Number(value)]:c.getAttribute('t')==='inlineStr'?textOf(c,'t'):value;
    }
    rows.set(Number(r.getAttribute('r')),cells);
  }
  const {products,warnings,rowProducts}=parseSupplierRows(rows);
  const sr=await relations(zip,path);
  for(const drawing of nodes(doc,'drawing')) {
    const dp=sr[drawing.getAttribute('r:id')];if(!dp || !zip.file(dp))continue;
    const dd=xml(await zip.file(dp).async('text')),dr=await relations(zip,dp);
    for(const anchor of [...nodes(dd,'twoCellAnchor'),...nodes(dd,'oneCellAnchor')]) {
      signal?.throwIfAborted();
      const from=nodes(anchor,'from')[0];if(!from)continue;
      const row=Number(textOf(from,'row'))+1,p=rowProducts.get(row);if(!p)continue;
      const blip=nodes(anchor,'blip')[0],imagePath=blip && dr[blip.getAttribute('r:embed')];
      if(imagePath && zip.file(imagePath)) {
        try { p.image=await compress(await zip.file(imagePath).async('uint8array')); }
        catch { warnings.push(`${p.sku}: не удалось прочитать фотографию.`); }
      }
    }
  }
  signal?.throwIfAborted();
  for(const p of products)if(!p.image)warnings.push(`${p.sku}: фотография отсутствует.`);
  return {products,warnings};
}

export async function exportReservations(reservations) {
  const esc=s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
  const rows=[['Резерв','Дата','Статус','Клиент','Telegram','Telegram ID','Поставка','Артикул','Наименование','Количество','Цена, ₽','Сумма, ₽','Комментарий','Менеджер','Telegram менеджера']];
  for(const r of reservations)for(const l of r.lines)rows.push([r.id,r.createdAt,r.status,r.user.name,r.user.username,r.user.id,r.shipmentTitle,l.sku,l.name,l.quantity,l.price/100,l.quantity*l.price/100,r.comment,r.manager?.name||'',r.manager?.username?'@'+r.manager.username:'']);
  const cells=rows.map((r,i)=>`<row r="${i+1}">${r.map((v,j)=>`<c r="${String.fromCharCode(65+j)}${i+1}" ${typeof v==='number'?'t="n"':'t="inlineStr"'}>${typeof v==='number'?`<v>${v}</v>`:`<is><t xml:space="preserve">${esc(v)}</t></is>`}</c>`).join('')}</row>`).join('');
  const zip=new window.JSZip();
  zip.file('[Content_Types].xml','<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>');
  zip.file('_rels/.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  zip.file('xl/workbook.xml','<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Резервы" sheetId="1" r:id="rId1"/></sheets></workbook>');
  zip.file('xl/_rels/workbook.xml.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>');
  zip.file('xl/worksheets/sheet1.xml',`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="15" width="22" customWidth="1"/><col min="9" max="9" width="65" customWidth="1"/></cols><sheetData>${cells}</sheetData><autoFilter ref="A1:O${rows.length}"/></worksheet>`);
  const blob=await zip.generateAsync({type:'blob',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}),url=URL.createObjectURL(blob);
  const a=document.createElement('a');a.href=url;a.download='CR_Reserve.xlsx';a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
}
