import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const context={};vm.runInNewContext(readFileSync(new URL('../public/vendor/sheetjs-0.20.3.min.js',import.meta.url),'utf8'),context);
export const XLSX=context.XLSX;
export function legacyFixture() {
  const workbook=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook,XLSX.utils.aoa_to_sheet([
    ['Synthetic purchase order'],[],
    ['Кол-во','Изображение','Цена шт','Наименование товара','Артикул','Код'],
    [5,'','','Test legacy product','xls-1','other-code'],
    [2,'',123.45,'Test priced product','xls-2','other-code-2']
  ]),'Test');
  return Buffer.from(XLSX.write(workbook,{type:'array',bookType:'biff8'}));
}
