// Shared validation for XLS and XLSX. Column positions may vary.
const normalize = value => String(value ?? '').trim().toLowerCase().replace(/ё/g,'е').replace(/[.\s_-]+/g,'');
const aliases = {
  name:['наименование','наименованиетовара','название','названиетовара'],
  sku:['артикул','кодтовара','код'],
  stock:['колво','количество','остаток'],
  price:['опт','оптоваяцена','ценашт','ценазашт','цена'],
  unit:['едизм','единицаизмерения']
};
const numeric = value => Number(String(value ?? '').replace(/\s/g,'').replace(',','.'));
export function parseSupplierRows(rows) {
  let header;
  for (const [number,row] of rows) {
    const entries=Object.entries(row).map(([column,value])=>[column,normalize(value)]);
    const columns=Object.fromEntries(Object.entries(aliases).map(([field,names])=>[field,names.map(name=>entries.find(([,value])=>value===name)?.[0]).find(column=>column!==undefined)]));
    if (columns.name!==undefined && columns.sku!==undefined && columns.stock!==undefined && columns.price!==undefined) {header={number,columns};break;}
  }
  if (!header) throw Error('Нужны столбцы Наименование, Артикул, Кол-во и Опт или Цена шт. Порядок не важен.');
  const {columns:c}=header,products=[],warnings=[],rowProducts=new Map(),seen=new Set();
  for (const [number,row] of rows) {
    const name=String(row[c.name]??'').trim(),sku=String(row[c.sku]??'').trim();
    if (number<=header.number || !name) continue;
    if (!sku && /^(итого|всего)(\s|:|$)/i.test(name)) continue;
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(sku) || seen.has(sku)) throw Error(`Строка ${number}: некорректный или повторный артикул.`);
    const stock=numeric(row[c.stock]),blankPrice=!String(row[c.price]??'').trim();
    const price=blankPrice?null:Math.round(numeric(row[c.price])*100);
    if (!String(row[c.stock]??'').trim() || !Number.isSafeInteger(stock) || stock>10000000 || (!blankPrice && (!Number.isSafeInteger(price) || price<0 || price>100000000))) throw Error(`Строка ${number}: проверьте цену и количество.`);
    seen.add(sku);
    if (stock<0) warnings.push(`${sku}: количество ${stock} заменено на 0.`);
    if (blankPrice) warnings.push(`${sku}: цена не заполнена — укажите её перед сохранением.`);
    const product={id:sku,sku,name,stock:Math.max(0,stock),price,unit:String(row[c.unit]||'шт'),image:null};
    products.push(product);rowProducts.set(number,product);
  }
  if (!products.length || products.length>3000) throw Error('Допустимо от 1 до 3000 товаров.');
  return {products,warnings,rowProducts};
}
