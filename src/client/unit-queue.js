import {UNIT_ORDER_LIMIT,remainingOrders} from '../shared/unit-orders.js';
import {groupTarget,queuedTargetUnits} from './unit-targets.js';
import {MODES,drawQueuedGoals} from './unit-order-view.js';

export function createUnitQueue({$,getUnits,isBusy,getView,arm,submit,changed,notify}){
 let active=false,kind=null,draft=[],timer=null,held=null,suppress=false,autoCommit=false;
 const count=()=>Math.max(0,...getUnits().map(u=>remainingOrders(u).length));
 function cancelGesture(){if(timer!==null)clearTimeout(timer);timer=null;if(held)suppress=true;held=null;}
 function pause(){cancelGesture();const wasAuto=autoCommit;autoCommit=false;if(wasAuto)update();}
 function reset(){cancelGesture();active=false;kind=null;draft=[];autoCommit=false;}
 function start(mode,source){
  if(isBusy()||!getUnits().some(u=>u.hp>0))return;
  active=true;kind=source;autoCommit=source==='keyboard';arm(mode);changed();
 }
 function add(mode,cell,source='keyboard'){
  if(!active)start(mode,source);if(!active||isBusy())return true;
  if(count()+draft.length>=UNIT_ORDER_LIMIT){notify('Очередь заполнена: не более 12 приказов.',true);return true;}
  const data=getView().targetData;
  if(data){const result=groupTarget(queuedTargetUnits(getUnits(),draft),mode,cell,data);if(!result.ok){notify(result.message,true);return true;}}
  draft.push({mode,cell});changed();return true;
 }
 async function commit(){if(isBusy())return;if(!draft.length){reset();arm(null);changed();return;}autoCommit=false;await submit(draft.map(o=>({...o})));}
 function keyUp(event){if(event.key==='Shift'&&!event.shiftKey&&active&&kind==='keyboard'&&autoCommit){commit();return true;}return false;}
 function key(event){if(!active||event.key!=='Enter'||event.target?.matches('button,summary,a'))return false;if(!event.repeat)commit();return true;}
 function update(){
  $('unitPanel').classList.toggle('queue-planning',active);
  $('unitQueueUndo').hidden=!active||!draft.length;$('unitQueueUndo').disabled=isBusy();
  $('unitCancelTarget').disabled=isBusy();
  if(active)$('unitCancelTarget').textContent=isBusy()?'Передаём очередь…':draft.length?`Отдать очередь · ${draft.length}`:'Закончить очередь';
  else $('unitCancelTarget').textContent='Отмена выбора цели';
  const units=getUnits(),unit=units[0],steps=unit?remainingOrders(unit):[],all=[...steps,...draft];
  $('unitQueueInfo').hidden=!active&&count()<2;
  const different=units.some(u=>JSON.stringify(remainingOrders(u))!==JSON.stringify(steps));
  const commonEnd=new Set(units.map(u=>remainingOrders(u).at(-1)?.cell)).size===1,end=(!different||commonEnd)&&all.at(-1)?.cell;
  $('unitQueueInfo').textContent=active?`Очередь ${count()+draft.length}/${UNIT_ORDER_LIMIT}. Касайтесь гексов; смените команду для атаки или захвата. ${kind==='keyboard'&&autoCommit?'Отпустите Shift или подтвердите.':'Подтвердите очередь.'}`:(different?'Разные очереди · до '+count()+' приказов':all.map((o,i)=>`${i+1}. ${MODES[o.mode]}`).join(' → '))+(end?` · цель: ${getView().cellLabel(end)}`:'');
 }
 function draw(ctx,view){if(active&&draft.length)drawQueuedGoals(ctx,draft,view,{offset:count(),draft:true});}
 for(const mode of ['move','attack','capture']){
  const button=$('unit-'+mode);
  button.addEventListener('pointerdown',event=>{
   cancelGesture();suppress=false;if(event.button>0||event.isPrimary===false||isBusy())return;
   held={id:event.pointerId,x:event.clientX,y:event.clientY};button.setPointerCapture(event.pointerId);
   timer=setTimeout(()=>{timer=null;if(held){suppress=true;start(mode,'touch');}},480);
  });
  button.addEventListener('pointermove',event=>{if(held?.id===event.pointerId&&Math.hypot(event.clientX-held.x,event.clientY-held.y)>8)cancelGesture();});
  button.addEventListener('pointerup',event=>{if(held?.id===event.pointerId){if(timer!==null)clearTimeout(timer);timer=null;held=null;}});
  for(const name of ['pointercancel','lostpointercapture'])button.addEventListener(name,cancelGesture);
  button.addEventListener('contextmenu',event=>event.preventDefault());
 }
 $('unitQueueUndo').onclick=()=>{if(!isBusy()){draft.pop();changed();}};
 return{reset,pause,cancelGesture,add,commit,draw,update,key,keyUp,
  active:()=>active,units:()=>queuedTargetUnits(getUnits(),draft),
  consumeClick:event=>{const value=suppress&&event?.detail!==0;suppress=false;return value;},
  state:()=>({active,kind,draft:draft.map(o=>({...o}))})};
}
