import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseSupplierRows} from '../public/supplier-rows.js';
import {xlsPictures} from '../public/xls-images.js';
import {XLSX,legacyFixture} from './excel-fixtures.mjs';

test('binary XLS keeps Cyrillic header aliases, reordered columns and missing prices',()=>{
  const bytes=legacyFixture();assert.equal(bytes.subarray(0,8).toString('hex'),'d0cf11e0a1b11ae1');
  const book=XLSX.read(bytes,{type:'array'}),sheet=book.Sheets[book.SheetNames[0]],rows=new Map();
  for(const [address,cell]of Object.entries(sheet)){
    if(!/^[A-Z]+\d+$/.test(address))continue;
    const {r,c}=XLSX.utils.decode_cell(address);if(!rows.has(r+1))rows.set(r+1,{});rows.get(r+1)[c]=cell.w??cell.v;
  }
  const result=parseSupplierRows(rows);
  assert.equal(result.products.length,2);assert.equal(result.products[0].id,'xls-1');
  assert.equal(result.products[0].price,null);assert.equal(result.products[1].price,12345);
  assert.match(result.warnings[0],/цена не заполнена/);
});
test('shared Excel validator handles spaces and totals without inventing stock or prices',()=>{
  const rows=new Map([[1,{A:'Артикул',B:'Наименование',C:'Опт.',D:'Кол-во'}],[2,{A:'00123',B:'Товар',C:'1\u00a0234,56',D:'1 000'}],[3,{B:'Итого:',C:123456,D:1000}]]);
  const {products}=parseSupplierRows(rows);assert.equal(products.length,1);assert.equal(products[0].id,'00123');assert.equal(products[0].price,123456);assert.equal(products[0].stock,1000);
  rows.get(2).D='';assert.throws(()=>parseSupplierRows(rows),/количество/);
  rows.get(2).D=1;rows.get(2).C='ошибка';assert.throws(()=>parseSupplierRows(rows),/цену/);
});
function art(type,body,flags=0){const h=Buffer.alloc(8);h.writeUInt16LE(flags);h.writeUInt16LE(type,2);h.writeUInt32LE(body.length,4);return Buffer.concat([h,body]);}
function biff(type,body){const h=Buffer.alloc(4);h.writeUInt16LE(type);h.writeUInt16LE(body.length,2);return Buffer.concat([h,body]);}
test('legacy drawings map pictures to anchors, support continuations and exclude a second sheet',()=>{
  const jpeg=Buffer.from([255,216,255,217]),blip=art(0xf01d,Buffer.concat([Buffer.alloc(16),Buffer.from([255]),jpeg]),0x46a0);
  const group=art(0xf000,art(0xf001,art(0xf007,Buffer.concat([Buffer.alloc(36),blip]),2),15),15);
  const property=Buffer.alloc(6);property.writeUInt16LE(0x4104);property.writeUInt32LE(1,2);
  const anchor=Buffer.alloc(18);anchor.writeUInt16LE(7,6);
  const drawing=art(0xf002,art(0xf004,Buffer.concat([art(0xf00b,property,0x13),art(0xf010,anchor)]),15),15);
  const bounds=Buffer.alloc(4),head=[biff(0x85,bounds),biff(0xeb,group.subarray(0,30)),biff(0x3c,group.subarray(30)),biff(0x0a,Buffer.alloc(0))];
  head[0].writeUInt32LE(head.reduce((n,b)=>n+b.length,0),4);
  const bytes=Buffer.concat([...head,biff(0x809,Buffer.alloc(4)),biff(0xec,drawing),biff(0x0a,Buffer.alloc(0)),biff(0x809,Buffer.alloc(4)),biff(0xec,drawing),biff(0x0a,Buffer.alloc(0))]);
  const pictures=xlsPictures(bytes);assert.equal(pictures.length,1);assert.equal(pictures[0].row,8);assert.deepEqual(Buffer.from(pictures[0].bytes),jpeg);
  assert.throws(()=>xlsPictures(bytes.subarray(0,20)),/Повреждён/);
});
