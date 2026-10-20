import {controlGroups} from '../shared/unit-orders.js';

// Independent, deferred UI: five fixed slots, no per-frame work or map loads.
export function createControlGroups({$,getPlayer,getSelection,select,isBusy,save,focus,notify}) {
 let owner=null,epoch=0,saving=false,held=null,timer=null,suppressClick=false,last=null,activeSlot=0;
 const row=$('unitGroups'),buttons=[...row.querySelectorAll('[data-control-group]')];
 const units=()=>getPlayer()?.army?.units||[];
 const living=()=>new Set(units().filter(u=>u.owner===getPlayer()?.id&&!u.neutral&&u.hp>0).map(u=>u.id));
 const members=slot=>controlGroups(getPlayer())[slot-1];
 const matching=()=>{
  const selection=new Set(getSelection()),alive=living();
  const groups=controlGroups(getPlayer()),matches=ids=>{
   const ready=ids.filter(id=>alive.has(id));return ready.length===selection.size&&ready.every(id=>selection.has(id));
  };
  return selection.size?(activeSlot&&matches(groups[activeSlot-1])?activeSlot:groups.findIndex(matches)+1):0;
 };
 function cancel(){if(timer!==null)clearTimeout(timer);timer=null;if(held){suppressClick=true;last=null;}held=null;}
 function update(){
  const player=getPlayer();
  if(owner!==player?.id){owner=player?.id;epoch++;saving=false;cancel();last=null;activeSlot=0;}
  const alive=living(),active=matching();
  for(const button of buttons){
   const slot=Number(button.dataset.controlGroup),ids=members(slot),ready=ids.filter(id=>alive.has(id)).length;
   button.disabled=!player||saving||isBusy();button.setAttribute('aria-pressed',String(active===slot));
   button.setAttribute('data-count',ids.length?`${ready}/${ids.length}`:'+');
   const label=ids.length?`Группа ${slot}: доступно ${ready} из ${ids.length}. Выбрать; двойное нажатие — к группе. Удержать — заменить состав.`:`Группа ${slot} пуста. Нажмите, чтобы сохранить выбранные отряды.`;
   if(button.getAttribute('aria-label')!==label){button.setAttribute('aria-label',label);button.title=label;}
  }
  $('unitForgetGroup').hidden=!active;
  $('unitForgetGroup').disabled=saving||isBusy();
  $('unitForgetGroup').textContent=active?`Забыть группу ${active}`:'Забыть группу';
  row.setAttribute('aria-busy',String(saving));
 }
 async function store(slot,clear=false){
  if(saving||isBusy()||!getPlayer())return;
  const unitIds=clear?[]:[...getSelection()];
  if(!clear&&!unitIds.length){notify('Сначала выберите отряды.');return;}
  const generation=epoch;saving=true;update();
  try{
   const result=await save({slot,unitIds});
   if(generation===epoch&&result){activeSlot=clear?0:slot;notify(clear?`Группа ${slot} удалена.`:`Группа ${slot} сохранена · ${unitIds.length} отр.`);}
  }catch{if(generation===epoch)notify('Не удалось сохранить группу. Повторите.',true);
  }finally{if(generation===epoch){saving=false;update();}}
 }
 function recall(slot,event={}){
  if(saving||isBusy()||!getPlayer())return;
  const ids=members(slot),alive=living(),ready=ids.filter(id=>alive.has(id));
  if(!ids.length){notify(`Группа ${slot} пуста. Выберите отряды и сохраните состав.`);last=null;return;}
  if(!ready.length){select([]);notify(`В группе ${slot} сейчас нет доступных бойцов. Состав сохранён до их возвращения.`);last=null;update();return;}
  const at=event.timeStamp??Date.now(),again=last?.slot===slot&&at-last.at>=0&&at-last.at<450;
  activeSlot=slot;select(ready);last=again?null:{slot,at};update();
  if(again){const unit=units().find(u=>u.id===ready[0]);if(unit)focus(unit.cell);}
  if(ready.length<ids.length)notify(`Группа ${slot}: выбрано ${ready.length} из ${ids.length}. Остальные недоступны; состав сохранён.`);
 }
 function key(event){
  if(!getPlayer()||event.altKey||event.isComposing)return false;
  const digit=/^(?:Digit|Numpad)([1-5])$/.exec(event.code||'')?.[1]||(/^[1-5]$/.test(event.key)?event.key:null);
  if(!digit||event.shiftKey)return false;
  if(!event.repeat){if(event.ctrlKey||event.metaKey)store(Number(digit));else recall(Number(digit),event);}
  return true;
 }
 row.onclick=event=>{
  if(suppressClick&&event.detail!==0){suppressClick=false;return;}
  suppressClick=false;
  const button=event.target.closest('[data-control-group]');if(!button)return;
  const slot=Number(button.dataset.controlGroup);
  if(event.ctrlKey||event.metaKey||!members(slot).length)return store(slot);
  recall(slot,event);
 };
 row.addEventListener('pointerdown',event=>{
  cancel();suppressClick=false;if(saving||isBusy()||event.button>0)return;
  if(event.isPrimary===false){suppressClick=true;return;}
  const button=event.target.closest('[data-control-group]');if(!button)return;
  held={id:event.pointerId,x:event.clientX,y:event.clientY,slot:Number(button.dataset.controlGroup)};
  button.setPointerCapture(event.pointerId);
  timer=setTimeout(()=>{timer=null;if(!held)return;suppressClick=true;return store(held.slot);},480);
 });
 row.addEventListener('pointermove',event=>{if(held&&held.id===event.pointerId&&Math.hypot(event.clientX-held.x,event.clientY-held.y)>8)cancel();});
 row.addEventListener('pointerup',event=>{if(held?.id===event.pointerId){if(timer!==null)clearTimeout(timer);timer=null;held=null;}});
 for(const name of ['pointercancel','lostpointercapture'])row.addEventListener(name,cancel);
 row.addEventListener('contextmenu',event=>event.preventDefault());
 $('unitForgetGroup').onclick=()=>{const slot=matching();if(slot)return store(slot,true);};
 update();
 return{update,cancel,key};
}
