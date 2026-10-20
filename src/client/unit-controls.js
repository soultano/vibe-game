import {layoutTroops} from './actor-layout.js';
import {groupTarget,createTargetGuide} from './unit-targets.js';
import {UNIT_GROUP_LIMIT} from '../shared/unit-orders.js';
import {createUnitGestures} from './unit-gestures.js';
const MODES={move:'Идти',attack:'Атаковать',capture:'Захватить',hold:'Удерживать'};
const COLORS={move:'#8cf3c2',attack:'#ff9b88',capture:'#f0d17b',hold:'#a8cdf2'};
const REASONS={shield:'Цель защищена щитом.',headquarters:'Штабы нельзя захватывать.',air:'Авиация не захватывает землю.',cap:'Достигнут лимит территории.',locked:'Клетка временно заблокирована.',border:'Потеряна связь с вашей территорией.',terrain:'Цель стала непроходимой.',route:'Проходимый маршрут не найден.',ownership:'Владелец клетки изменился.'};
const STATUSES={queued:'Приказ принят',moving:'Выполняет приказ',attacking:'Ведёт бой',capturing:'Захватывает гекс',complete:'Цель достигнута · удерживает позицию','waiting-credit':'Ожидает ресурс захвата',blocked:'Приказ заблокирован'};
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function hitUnit(poses,x,y,owner){
 return poses.filter(p=>owner===undefined||p.unit.owner===owner&&!p.unit.neutral).map(p=>{
  const dx=(x-p.x)/Math.max(22,p.span*.48),dy=(y-(p.y-p.elevation*.8-p.span*.36))/Math.max(26,p.span*.66);
  return{...p,hit:dx*dx+dy*dy};
 }).filter(p=>p.hit<=1).sort((a,b)=>a.hit-b.hit||b.y-a.y)[0]?.unit||null;
}
export function orderRoute(unit,projectCell,routeStart){
 const goal=unit.order?.cell;if(!goal)return{points:[],goal:null};
 const from=projectCell(unit.fromCell||unit.cell),to=projectCell(unit.cell),p=unit.progress??1;
 const start=routeStart||(from&&to?{x:from.x+(to.x-from.x)*p,y:from.y+(to.y-from.y)*p}:to);
 const cells=[unit.cell,...(unit.waypoints||[])],points=[start,...cells.map(projectCell)].filter(Boolean);
 return{points,goal:projectCell(goal),partial:unit.routePartial};
}
export function drawUnitOrder(ctx,unit,view){
 const {points,goal}=orderRoute(unit,view.projectCell,view.routeStart),color=COLORS[unit.order?.mode]||COLORS.hold;
 ctx.save();ctx.lineCap='round';ctx.lineJoin='round';ctx.strokeStyle='#041710cf';ctx.lineWidth=7;ctx.beginPath();points.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));ctx.stroke();
 ctx.strokeStyle=color;ctx.lineWidth=2.5;ctx.setLineDash([8,6]);ctx.stroke();ctx.setLineDash([]);
 if(goal&&view.goalMarker!==false){
  const polygon=view.shapeCell?.(unit.order.cell);
  if(polygon){ctx.beginPath();polygon.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));ctx.closePath();ctx.fillStyle=color+'24';ctx.fill();ctx.lineWidth=2;ctx.stroke();}
  ctx.beginPath();ctx.arc(goal.x,goal.y,12,0,Math.PI*2);ctx.stroke();ctx.beginPath();ctx.moveTo(goal.x-19,goal.y);ctx.lineTo(goal.x+19,goal.y);ctx.moveTo(goal.x,goal.y-19);ctx.lineTo(goal.x,goal.y+19);ctx.stroke();
  ctx.font='600 12px sans-serif';const label=view.orderLabel||MODES[unit.order.mode]||'Цель',w=ctx.measureText(label).width+20;ctx.fillStyle='#091b20ed';ctx.fillRect(goal.x-w/2,goal.y+23,w,25);ctx.fillStyle=color;ctx.textAlign='center';ctx.fillText(label,goal.x,goal.y+40);
 }
 ctx.restore();
}
export function createUnitControls({$,getPlayer,getUnits,getView,send,notify,invalidate,focus,ownerAt,onSelect=()=>{},onOpen=()=>{},onChange=()=>{}}){
 let selected=new Set(),targetMode=null,opened=false,busy=false,rosterKey='',generation=0,hint='',groupSelecting=false;
 const guide=createTargetGuide();
 const ownUnits=()=>getUnits().filter(u=>u.owner===getPlayer()?.id&&!u.neutral);
 const chosen=()=>ownUnits().filter(u=>selected.has(u.key));
 const first=()=>chosen().find(u=>u.key===selected.values().next().value)||chosen()[0];
 const setText=(id,text)=>{if($(id).textContent!==text)$(id).textContent=text;};
 const publish=()=>{onSelect([...selected]);update();onChange();invalidate();};
 function update(){
  const player=getPlayer(),units=ownUnits();if(!player){reset();return;}
  const available=new Set(units.filter(u=>selected.size===1||u.hp>0).map(u=>u.key));
  const removed=[...selected].filter(id=>!available.has(id));
  if(removed.length){for(const id of removed)selected.delete(id);targetMode=null;hint='';guide.clear();onSelect([...selected]);notify('Состав выбора обновлён: отряд погиб или больше недоступен.');}
  const group=chosen(),unit=first(),multiple=group.length>1,hp=group.reduce((n,u)=>n+Math.max(0,u.hp),0),maxHp=group.reduce((n,u)=>n+u.maxHp,0);
  if(unit?.hp<=0||!unit)targetMode=null;
  $('unitPanel').hidden=!opened;$('armyControls').hidden=opened;if(!opened)return;
  const key=units.map(u=>[u.key,u.hp>0,selected.has(u.key)].join(':')).join('|');
  if(key!==rosterKey){rosterKey=key;$('unitRoster').innerHTML=units.map(u=>`<button type="button" data-unit-id="${escape(u.key)}" aria-pressed="${selected.has(u.key)}" aria-label="${escape(u.name)} ${Number(u.key.split(':').at(-1))+1}${u.hp<=0?', погиб':''}" class="${u.hp<=0?'unit-dead':''}"><img src="${escape(u.poster)}" alt="" width="42" height="42" loading="lazy"><span>${Number(u.key.split(':').at(-1))+1}</span></button>`).join('');}
  for(const id of ['unitExtra','unitDetail','unitCommandGrid','unitPortrait'])$(id).hidden=!unit;
  $('unitCancelTarget').hidden=!targetMode;
  $('unitPanel').classList.toggle('group-selecting',groupSelecting);
  setText('unitName',multiple?`Группа · выбрано ${group.length}`:unit?`${unit.name} · ${Number(unit.key.split(':').at(-1))+1}`:'Ваши отряды');
  setText('unitRole',groupSelecting?'Касайтесь бойцов, затем выберите команду':multiple?'Общий приказ выбранным бойцам':unit?unit.label:'Выберите бойца на карте или в списке');
  if(unit){
   if($('unitPortrait').getAttribute('src')!==unit.poster)$('unitPortrait').setAttribute('src',unit.poster);
   setText('unitHp',`${Math.ceil(hp)} / ${maxHp} HP`);$('unitHealth').style.setProperty('--health',Math.max(0,hp/maxHp)*100+'%');$('unitHealth').setAttribute('aria-valuenow',Math.ceil(hp));$('unitHealth').setAttribute('aria-valuemax',maxHp);
  }
  const order=unit?.order,orders=group.filter(u=>u.order),complete=orders.filter(u=>u.order.status==='complete').length;
  const escort=multiple&&group.some(u=>u.type==='air')&&group.some(u=>u.type!=='air');
  const status=busy?'Передаём общий приказ…':groupSelecting?'Добавляйте или убирайте бойцов касанием. Затем нажмите нужную команду.':!unit?'Выберите бойца. Удержание включает выбор нескольких.':unit.hp<=0?'Отряд погиб · ожидает возрождения':targetMode?hint||({move:'Зелёные гексы — доступные цели. Нажмите на нужный.',attack:'Красные — противник, зелёные — движение с атакой. Серые недоступны.',capture:escort?'Золотые — захват наземными бойцами. Авиация прикроет цель.':'Золотые — доступный захват рядом с вашей границей. Выберите гекс.'}[targetMode]):multiple?orders.length?`С приказом: ${orders.length}/${group.length} · достигли цели: ${complete}${orders.some(u=>u.order.status==='blocked')?' · '+(REASONS[orders.find(u=>u.order.status==='blocked').order.reason]||'Есть блокировка'):''}`:'Группа готова. Выберите команду.':order?`${STATUSES[order.status]||'Приказ принят'}${order.reason?' · '+(REASONS[order.reason]||'Укажите другую цель'):''}`:'Автономный отряд · ждёт вашего приказа';
  setText('unitOrderStatus',status);
  const goals=new Set(orders.map(u=>u.order.cell).filter(Boolean));
  setText('unitRouteInfo',goals.size===1?`${multiple?'Общая цель':MODES[order?.mode]} · ${getView().cellLabel([...goals][0])}${group.some(u=>u.routePartial)?' · ближайший участок пути':''}`:goals.size?`Целей: ${goals.size} · показаны ближайшие участки маршрутов`:'Выберите действие, затем гекс на карте');
  for(const mode of ['move','attack','capture','hold','auto','focus']){
   const button=$('unit-'+mode);button.disabled=!unit||busy||mode!=='focus'&&(hp<=0||mode==='capture'&&!group.some(u=>u.type!=='air'&&u.hp>0));
   if(['move','attack','capture'].includes(mode))button.setAttribute('aria-pressed',String(targetMode===mode));
  }
  $('unit-capture').title=escort?'Наземные бойцы захватят гекс, авиация прикроет цель':unit?.type==='air'?'Авиация не захватывает землю':'Захват соседнего с вашей территорией гекса';
  $('worldCanvas').classList.toggle('unit-targeting',!!targetMode);$('unitPanel').classList.toggle('targeting',!!targetMode);
 }
 function reset(){const changed=opened||selected.size||targetMode;generation++;selected.clear();targetMode=null;hint='';groupSelecting=false;opened=false;busy=false;rosterKey='';guide.clear();gestures.cancel();onSelect([]);$('unitPanel').hidden=true;$('armyControls').hidden=!getPlayer();$('worldCanvas').classList.remove('unit-targeting');if(changed)onChange();}
 function selectMany(ids,{add=false,touch=false,allowDead=false}={}){
  if(busy)return;const valid=new Set(ownUnits().filter(u=>allowDead||u.hp>0).map(u=>u.key));
  const next=[...new Set([...(add?selected:[]),...ids])].filter(id=>valid.has(id));
  if(next.length>UNIT_GROUP_LIMIT)notify('В группе может быть не более 36 отрядов.');
  onOpen();opened=true;selected=new Set(next.slice(0,UNIT_GROUP_LIMIT));targetMode=null;hint='';groupSelecting=touch;guide.clear();publish();
 }
 function select(id,{additive=groupSelecting,touch=groupSelecting}={}){
  if(additive){if(!ownUnits().some(u=>u.key===id&&u.hp>0))return;const ids=new Set(selected);ids.has(id)?ids.delete(id):ids.add(id);selectMany([...ids],{touch});}
  else selectMany([id],{touch,allowDead:true});
 }
 function beginSelection(id){selectMany(selected.has(id)?[...selected]:[...selected,id],{touch:true});}
 function open(){onOpen();opened=true;update();onChange();invalidate();}
 function close(){reset();invalidate();}
 function finishSelection(){groupSelecting=false;update();invalidate();}
 function arm(mode){
  const group=chosen();if(busy||!group.some(u=>u.hp>0))return;
  if(mode==='capture'&&!group.some(u=>u.type!=='air'&&u.hp>0)){notify('Авиация не захватывает землю.');return;}
  if(getView().detailed===false)focus(first().cell);
  groupSelecting=false;targetMode=targetMode===mode?null:mode;hint='';guide.clear();update();invalidate();
 }
 function hover(cell){if(!targetMode||!selected.size)return;const data=getView().targetData;if(!data)return;hint=groupTarget(chosen(),targetMode,cell,data).message;update();}
 function cancelTarget(){targetMode=null;hint='';update();invalidate();}
 async function issue(mode,cell){
  const group=chosen();if(!group.length||group.some(u=>u.hp<=0)||busy)return false;const view=getView();
  if(cell&&view.targetData){const target=groupTarget(group,mode,cell,view.targetData);if(!target.ok){hint=target.message;notify(hint,true);update();invalidate();return true;}}
  const epoch=generation,ids=group.map(u=>u.key);busy=true;groupSelecting=false;update();
  let result;try{result=await send({...(ids.length>1?{unitIds:ids}:{unitId:ids[0]}),mode,...(cell?{cell}:{})});}finally{if(epoch===generation){busy=false;update();invalidate();}}
  if(epoch!==generation)return true;if(result){targetMode=null;hint='';}update();invalidate();return true;
 }
 async function click({x,y,cell,right=false,additive=false}){
  if(busy)return true;const player=getPlayer();if(!player)return false;
  const view=getView(),poses=layoutTroops(view.units,view),own=hitUnit(poses,x,y,player.id);
  if((additive||groupSelecting)&&own&&!right){select(own.key,{additive:true});return true;}
  if(right){if(!selected.size)return false;const hit=hitUnit(poses,x,y),enemy=hit&&hit.owner!==player.id&&hit.hp>0?hit:view.units.find(u=>u.owner!==player.id&&u.cell===cell&&u.hp>0);return issue(enemy||ownerAt(cell)&&ownerAt(cell)!==player.id?'attack':'move',enemy?.cell||cell);}
  if(targetMode&&selected.size){const enemy=targetMode==='attack'?hitUnit(poses,x,y):null;return issue(targetMode,enemy&&enemy.owner!==player.id?enemy.cell:cell);}
  if(own){select(own.key);return true;}
  if(groupSelecting){finishSelection();return true;}
  if(opened){close();return true;}return false;
 }
 function key(event){
  if(!opened||event.repeat)return false;const k=event.code?.startsWith('Key')?event.code.slice(3).toLowerCase():event.key.toLowerCase();
  if(event.ctrlKey||event.metaKey){if(k==='a'){selectMany(ownUnits().filter(u=>u.hp>0).map(u=>u.key));return true;}return false;}
  if(event.altKey)return false;
  if(k==='escape'){targetMode?cancelTarget():groupSelecting?finishSelection():close();return true;}
  if(!selected.size)return false;
  if(['m','a','c'].includes(k)){arm({m:'move',a:'attack',c:'capture'}[k]);return true;}
  if(k==='s'||k==='u'){issue(k==='s'?'hold':'auto');return true;}
  if(k==='f'){focus(first().cell);return true;}return false;
 }
 function draw(ctx,view){
  gestures.draw(ctx);if(!opened)return;
  const group=view.units.filter(u=>selected.has(u.key)).sort((a,b)=>(b.order?.mode==='capture')-(a.order?.mode==='capture'));if(!group.length)return;
  guide.draw(ctx,group,targetMode,view);
  const poses=layoutTroops(view.units,view).filter(p=>selected.has(p.unit.key)),byId=new Map(poses.map(p=>[p.unit.key,p])),goals=new Set();
  for(const unit of group.slice(0,8))if(unit.order){const goal=unit.order.cell,goalMarker=!goals.has(goal);goals.add(goal);drawUnitOrder(ctx,unit,{...view,routeStart:byId.get(unit.key),goalMarker,orderLabel:group.length>1?`${MODES[unit.order.mode]} · ${group.length}`:null});}
  ctx.save();ctx.strokeStyle='#beff9c';ctx.lineWidth=3;
  for(const pose of poses){ctx.beginPath();ctx.ellipse(pose.x,pose.y,pose.span*.48,pose.span*.19,0,0,Math.PI*2);ctx.stroke();}ctx.restore();
 }
 const gestures=createUnitGestures({getView,getPlayer,ownUnits,hitUnit,layoutTroops,beginSelection,select,selectMany,open,invalidate,isBusy:()=>busy});
 const roster=$('unitRoster');
 roster.onclick=event=>{if(gestures.consumeRosterClick(event))return;const button=event.target.closest('[data-unit-id]');if(button)select(button.dataset.unitId,{additive:!!event.shiftKey||groupSelecting});};
 roster.addEventListener('pointerdown',event=>{const button=event.target.closest('[data-unit-id]');if(button){roster.setPointerCapture(event.pointerId);gestures.down(event,{x:event.clientX,y:event.clientY},button.dataset.unitId);}});
 roster.addEventListener('pointermove',event=>gestures.move(event,{x:event.clientX,y:event.clientY}));
 roster.addEventListener('pointerup',event=>gestures.up(event,{x:event.clientX,y:event.clientY}));
 for(const name of ['pointercancel','lostpointercapture'])roster.addEventListener(name,()=>gestures.cancel());
 for(const mode of ['move','attack','capture'])$('unit-'+mode).onclick=()=>arm(mode);
 for(const mode of ['hold','auto'])$('unit-'+mode).onclick=()=>issue(mode);
 $('unitCancelTarget').onclick=cancelTarget;
 $('unit-focus').onclick=()=>{if(first())focus(first().cell);};$('unitClose').onclick=close;
 return{open,select,selectMany,click,key,draw,update,reset,hover,gestures,isOpen:()=>opened,state:()=>({selected:selected.values().next().value||null,selectedIds:[...selected],groupSelecting,targetMode,opened,busy})};
}
