// Loaded only when importing legacy Excel, away from the UI thread.
importScripts('./vendor/sheetjs-0.20.3.min.js');
self.onmessage=async({data:buffer})=>{
  try {
    const [{parseSupplierRows},{xlsPictures}]=await Promise.all([import('./supplier-rows.js'),import('./xls-images.js')]);
    const workbook=XLSX.read(buffer,{type:'array',bookFiles:true,cellFormula:false,cellHTML:false,cellStyles:false});
    const sheet=workbook.Sheets[workbook.SheetNames[0]];
    if(!sheet)throw Error('Лист Excel не найден.');
    const rows=new Map();let count=0;
    for(const [address,cell] of Object.entries(sheet)) {
      if(!/^[A-Z]+\d+$/.test(address))continue;
      if(++count>200000)throw Error('В листе слишком много заполненных ячеек.');
      const {r,c}=XLSX.utils.decode_cell(address),number=r+1;
      if(!rows.has(number))rows.set(number,{});
      // Preserve formatted article codes, including leading zeroes.
      rows.get(number)[c]=cell.t==='n'?(cell.w??cell.v):(cell.v??'');
    }
    const parsed=parseSupplierRows(new Map([...rows].sort(([a],[b])=>a-b)));
    const stream=workbook.cfb?.FileIndex.find(f=>f.name==='Workbook'||f.name==='Book')?.content;
    let pictures=[];
    if(stream)try{pictures=xlsPictures(stream);}catch{parsed.warnings.push('Часть фотографий XLS не удалось прочитать. Проверьте предпросмотр.');}
    self.postMessage({products:parsed.products,warnings:parsed.warnings,pictures:pictures.filter(p=>parsed.rowProducts.has(p.row)).map(p=>({id:parsed.rowProducts.get(p.row).id,bytes:p.bytes}))});
  }catch(error){self.postMessage({error:error.message||'Не удалось прочитать XLS.'});}
};
