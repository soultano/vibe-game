import {queueEntries} from '../shared/unit-orders.js';
import {MODES} from './unit-order-view.js';

// One contextual toolbar for the selected point; native position picker on touch.
export function createQueueEditor({$,getUnits,getDraft,isDraft,setDraft,save,changed,notify,isBusy,labelForCell}){
 let base=null,items=[],selected=-1,busy=false,error='',epoch=0,renderKey='';
 const panel=$('unitQueueEditor'),list=$('unitQueueList');
 const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 function snapshot(){
  if(isDraft())return{draft:true,units:[],rows:getDraft().map((o,i)=>({...o,key:String(i)})),count:getDraft().length};
  const units=getUnits().map(u=>({id:u.key,orders:queueEntries(u)}));let count=Math.min(12,...units.map(u=>u.orders.length)),matched=0;
  if(!units.length)return{draft:false,units,rows:[],count:0};
  while(matched<count){const points=units.map(u=>u.orders.at(-1-matched));if(points.some(p=>p.cell!==points[0].cell))break;matched++;}
  const rows=(units[0]?.orders.slice(-matched)||[]).slice(matched?0:12);
  return{draft:false,units,rows:matched?rows:[],count:matched};
 }
 function reset(){epoch++;base=null;items=[];selected=-1;busy=false;error='';renderKey='';}
 function choose(index){if(busy||isBusy())return;if(!base){base=snapshot();items=base.rows.map((_,i)=>i);}selected=index;update();changed();}
 function update(){
  const current=base||snapshot(),rows=base?items.map(i=>base.rows[i]):current.rows,count=rows.length;
  panel.hidden=!count&&!base;$('unitQueueEditorTitle').textContent=`Приказы · ${count}`;
  const key=JSON.stringify([rows,selected,busy,error,current.draft]);
  if(key!==renderKey){renderKey=key;list.innerHTML=rows.map((o,i)=>`<li><button type="button" data-queue-point="${i}" aria-pressed="${i===selected}" ${busy?'disabled':''}><span>${i+1}</span><span>${escape(MODES[o.mode]||'Приказ')}<small>${escape(labelForCell(o.cell))}</small></span></button></li>`).join('');}
  $('unitQueuePointActions').hidden=selected<0||!count;
  const picker=$('unitQueuePosition');picker.disabled=busy;picker.innerHTML=rows.map((_,i)=>`<option value="${i}">${i+1}</option>`).join('');picker.value=String(selected);
  $('unitQueueDelete').disabled=busy;$('unitQueueEditRetry').hidden=!error;$('unitQueueEditRetry').disabled=busy;
  $('unitQueueEditStatus').textContent=busy?'Сохраняем изменение…':error||(!current.draft&&getUnits().some(u=>queueEntries(u).length!==count)?'Показан общий конец маршрутов группы.':'Выберите точку: можно удалить или изменить позицию.');
  panel.setAttribute('aria-busy',String(busy));
 }
 async function apply(){
  if(!base||busy||isBusy())return;
  if(base.draft){setDraft(items.map(i=>{const {key,...o}=base.rows[i];return o;}));base=null;selected=-1;error='';changed();return;}
  const edits=base.units.map(u=>{
   const start=u.orders.length-base.count,tail=u.orders.slice(start);
   return{unitId:u.id,expectedKeys:u.orders.map(o=>o.key),keys:[...u.orders.slice(0,start).map(o=>o.key),...items.map(i=>tail[i].key)]};
  });
  const generation=epoch,focusIndex=selected;busy=true;error='';update();
  try{const result=await save(edits);if(generation!==epoch)return;
   if(result){base=null;selected=-1;items=[];notify('Очередь обновлена.');}
   else error='Изменение не сохранено. Повторите или заново выберите отряд, если очередь изменилась.';
  }finally{if(generation===epoch){busy=false;update();changed();list.querySelectorAll('[data-queue-point]')[Math.max(0,focusIndex)]?.focus?.({preventScroll:true});}}
 }
 function remove(){if(selected<0||busy)return;items.splice(selected,1);selected=Math.min(selected,items.length-1);return apply();}
 function move(to){if(selected<0||busy||!Number.isInteger(to)||to<0||to>=items.length)return;const [item]=items.splice(selected,1);items.splice(to,0,item);selected=to;return apply();}
 list.onclick=event=>{const button=event.target.closest('[data-queue-point]');if(button)choose(Number(button.dataset.queuePoint));};
 list.addEventListener('keydown',event=>{const button=event.target.closest('[data-queue-point]');if(!button||busy)return;const index=Number(button.dataset.queuePoint);
  if(event.key==='Delete'||event.key==='Backspace'){event.preventDefault();choose(index);remove();}
  else if(event.altKey&&['ArrowUp','ArrowDown'].includes(event.key)){event.preventDefault();choose(index);move(index+(event.key==='ArrowUp'?-1:1));}
 });
 $('unitQueuePosition').onchange=()=>move(Number($('unitQueuePosition').value));$('unitQueueDelete').onclick=remove;$('unitQueueEditRetry').onclick=apply;
 return{reset,update,busy:()=>busy,state:()=>({selected,busy,error}),draw(ctx,view){const cell=base?.rows[items[selected]]?.cell,p=cell&&view.projectCell(cell);if(!panel.open||!p)return;ctx.save();ctx.strokeStyle='#fff6ce';ctx.lineWidth=3;ctx.beginPath();ctx.arc(p.x,p.y-17,17,0,Math.PI*2);ctx.stroke();ctx.restore();},invalidate(){if(!busy){base=null;selected=-1;error='';}update();}};
}
