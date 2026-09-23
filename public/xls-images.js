// BIFF8 OfficeArt: match embedded JPEG/PNG pictures by pib and row anchor.
// Unsupported drawings are left unassigned, never guessed from file order.
const join = chunks => {
  const bytes=new Uint8Array(chunks.reduce((n,c)=>n+c.length,0));
  let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return bytes;
};
const view = bytes => new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
function records(bytes,visit,depth=0) {
  if(depth>32)throw Error('Слишком сложная структура фотографий XLS.');
  const data=view(bytes);
  for(let offset=0;offset+8<=bytes.length;) {
    const version=data.getUint16(offset,true),type=data.getUint16(offset+2,true),length=data.getUint32(offset+4,true),end=offset+8+length;
    if(end>bytes.length)throw Error('Повреждена структура фотографий XLS.');
    const body=bytes.subarray(offset+8,end);
    if(visit(type,version,body)!==false && (version&15)===15)records(body,visit,depth+1);
    offset=end;
  }
}
function embeddedPicture(body) {
  if(body.length<36)return null;
  const offset=36+body[33];if(offset+8>body.length)return null;
  const data=view(body),instance=data.getUint16(offset,true)>>4,type=data.getUint16(offset+2,true),length=data.getUint32(offset+4,true);
  const single=type===0xf01e?0x6e0:type===0xf01d?0x46a:null;
  if(single===null || ![single,single+1].includes(instance) || offset+8+length>body.length)return null;
  const start=offset+8+(instance===single?16:32)+1;
  if(start>=offset+8+length)return null;
  return body.slice(start,offset+8+length);
}
export function xlsPictures(stream) {
  const bytes=new Uint8Array(stream),data=view(bytes),global=[],sheet=[];
  let target=null,firstSheet=null,inFirst=false;
  for(let offset=0;offset+4<=bytes.length;) {
    const type=data.getUint16(offset,true),length=data.getUint16(offset+2,true),end=offset+4+length;
    if(end>bytes.length)throw Error('Повреждён файл XLS.');
    if(type===0x85 && firstSheet===null && length>=4)firstSheet=data.getUint32(offset+4,true);
    if(offset===firstSheet)inFirst=true;
    if(type===0xeb)target=global;
    else if(type===0xec && inFirst)target=sheet;
    else if(type!==0x3c)target=null;
    if(target)target.push(bytes.subarray(offset+4,end));
    if(type===0x0a && inFirst)inFirst=false;
    offset=end;
  }
  const pictures=[];
  records(join(global),(type,version,body)=>{if(type===0xf007)pictures.push(embeddedPicture(body));});
  const result=[];
  records(join(sheet),(type,version,body)=>{
    if(type!==0xf004)return;
    let row=null,index=null;
    records(body,(child,flags,value)=>{
      const d=view(value);
      if(child===0xf010 && value.length===18)row=d.getUint16(6,true)+1;
      if(child===0xf00b)for(let i=0;i<(flags>>4)&&i*6+6<=value.length;i++) {
        const property=d.getUint16(i*6,true);
        if((property&0x3fff)===0x104 && !(property&0x8000))index=d.getUint32(i*6+2,true)-1;
      }
    });
    if(row!==null && index!==null && pictures[index])result.push({row,bytes:pictures[index]});
    return false;
  });
  return result;
}
