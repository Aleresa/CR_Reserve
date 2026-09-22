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
export async function readSupplierXlsx(file) {
  if(file.size>25*1024*1024)throw Error('Excel должен быть не больше 25 МБ.');
  const zip=await window.JSZip.loadAsync(file);
  let unpacked=0;
  for(const f of Object.values(zip.files)) {
    unpacked+=f._data?.uncompressedSize || 0;
    if(unpacked>120*1024*1024)throw Error('Распакованный Excel слишком большой.');
  }
  const workbook=zip.file('xl/workbook.xml');if(!workbook)throw Error('Нужен файл .xlsx.');
  const wr=await relations(zip,'xl/workbook.xml');
  const sheet=nodes(xml(await workbook.async('text')),'sheet')[0];
  const path=wr[sheet.getAttribute('r:id')];
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
  let header=null;
  for(const [n,r] of rows)if(Object.values(r).some(v=>/^наименование$/i.test((v||'').trim()))) {header=[n,r];break;}
  if(!header)throw Error('Не найден столбец «Наименование».');
  const col=(regex)=>Object.entries(header[1]).find(([,v])=>regex.test((v||'').trim()))?.[0];
  const c={name:col(/^наименование$/i),sku:col(/^артикул$/i),stock:col(/^кол-во$/i),price:col(/^опт\.?$/i),unit:col(/^ед\.\s*изм\.?$/i)};
  if(!c.sku || !c.stock || !c.price)throw Error('Нужны столбцы Артикул, Кол-во и Опт.');
  const products=[],warnings=[],rowProducts=new Map(),seen=new Set();
  for(const [n,r] of rows) {
    if(n<=header[0] || !r[c.name])continue;
    const sku=String(r[c.sku] || '').trim(),stock=Number(String(r[c.stock]??'').replace(',','.')),price=Number(String(r[c.price]??'').replace(',','.'));
    if(!/^[a-zA-Z0-9_-]{1,80}$/.test(sku) || seen.has(sku))throw Error(`Строка ${n}: некорректный или повторный артикул.`);
    if(!String(r[c.stock]??'').trim() || !String(r[c.price]??'').trim() || !Number.isSafeInteger(stock) || !Number.isFinite(price) || price<0)throw Error(`Строка ${n}: проверьте цену и количество.`);
    seen.add(sku);
    if(stock<0)warnings.push(`${sku}: количество ${stock} заменено на 0.`);
    const product={id:sku,sku,name:r[c.name].trim(),stock:Math.max(0,stock),price:Math.round(price*100),unit:r[c.unit]||'шт',image:null};
    products.push(product);rowProducts.set(n,product);
  }
  if(!products.length || products.length>3000)throw Error('Допустимо от 1 до 3000 товаров.');
  const sr=await relations(zip,path);
  for(const drawing of nodes(doc,'drawing')) {
    const dp=sr[drawing.getAttribute('r:id')];if(!dp || !zip.file(dp))continue;
    const dd=xml(await zip.file(dp).async('text')),dr=await relations(zip,dp);
    for(const anchor of [...nodes(dd,'twoCellAnchor'),...nodes(dd,'oneCellAnchor')]) {
      const from=nodes(anchor,'from')[0];if(!from)continue;
      const row=Number(textOf(from,'row'))+1,p=rowProducts.get(row);if(!p)continue;
      const blip=nodes(anchor,'blip')[0],imagePath=blip && dr[blip.getAttribute('r:embed')];
      if(imagePath && zip.file(imagePath)) {
        try { p.image=await compress(await zip.file(imagePath).async('uint8array')); }
        catch { warnings.push(`${p.sku}: не удалось прочитать фотографию.`); }
      }
    }
  }
  for(const p of products)if(!p.image)warnings.push(`${p.sku}: фотография отсутствует.`);
  return {products,warnings};
}

export async function exportReservations(reservations) {
  const esc=s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
  const rows=[['Резерв','Дата','Статус','Клиент','Telegram','Telegram ID','Поставка','Артикул','Наименование','Количество','Цена, ₽','Сумма, ₽','Комментарий']];
  for(const r of reservations)for(const l of r.lines)rows.push([r.id,r.createdAt,r.status,r.user.name,r.user.username,r.user.id,r.shipmentTitle,l.sku,l.name,l.quantity,l.price/100,l.quantity*l.price/100,r.comment]);
  const cells=rows.map((r,i)=>`<row r="${i+1}">${r.map((v,j)=>`<c r="${String.fromCharCode(65+j)}${i+1}" ${typeof v==='number'?'t="n"':'t="inlineStr"'}>${typeof v==='number'?`<v>${v}</v>`:`<is><t xml:space="preserve">${esc(v)}</t></is>`}</c>`).join('')}</row>`).join('');
  const zip=new window.JSZip();
  zip.file('[Content_Types].xml','<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>');
  zip.file('_rels/.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  zip.file('xl/workbook.xml','<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Резервы" sheetId="1" r:id="rId1"/></sheets></workbook>');
  zip.file('xl/_rels/workbook.xml.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>');
  zip.file('xl/worksheets/sheet1.xml',`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="13" width="22" customWidth="1"/><col min="9" max="9" width="65" customWidth="1"/></cols><sheetData>${cells}</sheetData><autoFilter ref="A1:M${rows.length}"/></worksheet>`);
  const blob=await zip.generateAsync({type:'blob',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}),url=URL.createObjectURL(blob);
  const a=document.createElement('a');a.href=url;a.download='CR_Reserve.xlsx';a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
}
