// Editable geometry only: a completed render changes metadata/revision, not user intent.
export const placementValue = card => ({variantId:card.variantId,selections:card.selections,annotateSize:!!card.annotateSize,layers:(card.layers||[]).map(({id,x,y,width})=>({id,x,y,width}))});
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function createPlacementWriter({initial,cardId,write,read,onChange=()=>{}}){
 let revision=initial.revision,base=placementValue(initial.cards.find(c=>c.id===cardId)),pending=null,flight=null,error=null;
 const snapshot=()=>({pending:!!pending||!!flight,error,revision});
 const notify=()=>onChange(snapshot());
 async function send(patch){
  const expected={...base,...patch};
  try{return await write({revision,...patch});}
  catch(e){
   const current=await read(),card=current.cards.find(c=>c.id===cardId);
   if(!card)throw Error('效果图已变化，当前调整保留，请核对后再保存');
   const value=placementValue(card);
   // A lost acknowledgement must be read before another write.
   if(equal(value,expected))return current;
   if(e.status===409&&equal(value,base))return write({revision:current.revision,...patch});
   throw equal(value,base)?e:Error('另一处已修改衣服或位置，当前调整保留，未覆盖其他修改');
  }
 }
 async function flush(){
  if(flight)return flight;
  if(error||!pending)return false;
  flight=(async()=>{
   while(pending&&!error){const patch=pending;pending=null;
    try{const saved=await send(patch);revision=saved.revision;base=placementValue(saved.cards.find(c=>c.id===cardId));}
    catch(e){pending={...patch,...pending};error=e.message||'保存失败';}
   }
  })();
  notify();await flight;flight=null;notify();return !error;
 }
 function submit(patch){pending={...pending,...structuredClone(patch)};notify();return flush();}
 async function retry(){error=null;notify();return flush();}
 return {submit,retry,snapshot};
}
