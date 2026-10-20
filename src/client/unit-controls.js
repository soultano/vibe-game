import {layoutTroops} from './actor-layout.js';
import {unitTarget,createTargetGuide} from './unit-targets.js';
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
 if(goal){
  const polygon=view.shapeCell?.(unit.order.cell);
  if(polygon){ctx.beginPath();polygon.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));ctx.closePath();ctx.fillStyle=color+'24';ctx.fill();ctx.lineWidth=2;ctx.stroke();}
  ctx.beginPath();ctx.arc(goal.x,goal.y,12,0,Math.PI*2);ctx.stroke();ctx.beginPath();ctx.moveTo(goal.x-19,goal.y);ctx.lineTo(goal.x+19,goal.y);ctx.moveTo(goal.x,goal.y-19);ctx.lineTo(goal.x,goal.y+19);ctx.stroke();
  ctx.font='600 12px sans-serif';const label=MODES[unit.order.mode]||'Цель',w=ctx.measureText(label).width+20;ctx.fillStyle='#091b20ed';ctx.fillRect(goal.x-w/2,goal.y+23,w,25);ctx.fillStyle=color;ctx.textAlign='center';ctx.fillText(label,goal.x,goal.y+40);
 }
 ctx.restore();
}
export function createUnitControls({$,getPlayer,getUnits,getView,send,notify,invalidate,focus,ownerAt,onSelect=()=>{},onOpen=()=>{},onChange=()=>{}}){
 let selected=null,targetMode=null,opened=false,busy=false,rosterKey='',generation=0,hint='';
 const guide=createTargetGuide();
 const ownUnits=()=>getUnits().filter(u=>u.owner===getPlayer()?.id&&!u.neutral),current=()=>ownUnits().find(u=>u.key===selected);
 const setText=(id,text)=>{if($(id).textContent!==text)$(id).textContent=text;};
 function update(){
  const player=getPlayer(),units=ownUnits(),unit=current();
  if(!player){reset();return;}
  if(selected&&!unit){selected=null;targetMode=null;onSelect(null);notify('Отряд больше недоступен.');}
  $('unitPanel').hidden=!opened;$('armyControls').hidden=opened;
  if(!opened)return;
  const key=units.map(u=>[u.key,u.hp>0,u.key===selected].join(':')).join('|');
  if(key!==rosterKey){rosterKey=key;$('unitRoster').innerHTML=units.map(u=>`<button type="button" data-unit-id="${escape(u.key)}" aria-pressed="${u.key===selected}" aria-label="${escape(u.name)} ${Number(u.key.split(':').at(-1))+1}${u.hp<=0?', погиб':''}" class="${u.hp<=0?'unit-dead':''}"><img src="${escape(u.poster)}" alt="" width="42" height="42" loading="lazy"><span>${Number(u.key.split(':').at(-1))+1}</span></button>`).join('');}
  $('unitExtra').hidden=!unit;$('unitCancelTarget').hidden=!targetMode;
  $('unitDetail').hidden=!unit;$('unitCommandGrid').hidden=!unit;$('unitPortrait').hidden=!unit;
  setText('unitName',unit?`${unit.name} · ${Number(unit.key.split(':').at(-1))+1}`:'Ваши отряды');
  setText('unitRole',unit?unit.label:'Выберите бойца на карте или в списке');
  if(unit){
   if($('unitPortrait').getAttribute('src')!==unit.poster)$('unitPortrait').setAttribute('src',unit.poster);
   setText('unitHp',`${Math.ceil(unit.hp)} / ${unit.maxHp} HP`);$('unitHealth').style.setProperty('--health',Math.max(0,unit.hp/unit.maxHp)*100+'%');$('unitHealth').setAttribute('aria-valuenow',Math.ceil(unit.hp));$('unitHealth').setAttribute('aria-valuemax',unit.maxHp);
  }
  if(unit?.hp<=0)targetMode=null;
  const order=unit?.order;
  setText('unitOrderStatus',busy?'Передаём приказ…':!unit?'Выберите отряд в списке или нажмите на бойца на карте':unit.hp<=0?'Отряд погиб · ожидает возрождения':targetMode?hint||({move:'Зелёные гексы — доступные цели. Нажмите на нужный.',attack:'Красные — противник, зелёные — движение с атакой. Серые недоступны.',capture:'Золотые — доступный захват рядом с вашей границей. Выберите гекс.'}[targetMode]):order?`${STATUSES[order.status]||'Приказ принят'}${order.reason?' · '+(REASONS[order.reason]||'Укажите другую цель'):''}`:'Автономный отряд · ждёт вашего приказа');
  setText('unitRouteInfo',order?.cell?`${MODES[order.mode]} · ${getView().cellLabel(order.cell)}${unit.routePartial?' · показан ближайший участок пути':''}`:'Выберите действие, затем гекс на карте');
  for(const mode of ['move','attack','capture','hold','auto','focus']){
   const button=$('unit-'+mode);button.disabled=!unit||busy||mode!=='focus'&&(unit.hp<=0||mode==='capture'&&unit.type==='air');
   if(['move','attack','capture'].includes(mode))button.setAttribute('aria-pressed',String(targetMode===mode));
  }
  $('unit-capture').title=unit?.type==='air'?'Авиация не захватывает землю':'Захват соседнего с вашей территорией гекса';
  $('worldCanvas').classList.toggle('unit-targeting',!!targetMode);$('unitPanel').classList.toggle('targeting',!!targetMode);
 }
 function reset(){const changed=opened||selected||targetMode;generation++;selected=null;targetMode=null;hint='';opened=false;busy=false;rosterKey='';guide.clear();onSelect(null);$('unitPanel').hidden=true;$('armyControls').hidden=!getPlayer();$('worldCanvas').classList.remove('unit-targeting');if(changed)onChange();}
 function select(id){if(busy)return;onOpen();selected=id;targetMode=null;hint='';opened=true;onSelect(id);update();onChange();invalidate();}
 function open(){onOpen();opened=true;update();onChange();invalidate();}
 function close(){reset();$('armyControls').hidden=!getPlayer();invalidate();}
 function arm(mode){if(busy||!current()||current().hp<=0)return;if(mode==='capture'&&current().type==='air'){notify('Авиация не захватывает землю.');return;}if(getView().detailed===false)focus(current().cell);targetMode=targetMode===mode?null:mode;hint='';guide.clear();update();invalidate();}
 function hover(cell){if(!targetMode||!current())return;const data=getView().targetData;if(!data)return;const result=unitTarget(current(),targetMode,cell,data);hint=result.message;update();}
 function cancelTarget(){targetMode=null;hint='';update();invalidate();}
 async function issue(mode,cell){
  const unit=current();if(!unit||unit.hp<=0||busy)return false;const view=getView();
  if(cell&&view.targetData){const target=unitTarget(unit,mode,cell,view.targetData);if(!target.ok){hint=target.message;notify(hint,true);update();invalidate();return true;}}
  const epoch=generation;
  busy=true;update();const result=await send({unitId:unit.key,mode,...(cell?{cell}:{})});
  if(epoch!==generation)return true;busy=false;if(result){targetMode=null;hint='';}update();invalidate();return true;
 }
 async function click({x,y,cell,right=false}){
  if(busy)return true;const player=getPlayer();if(!player)return false;
  if(right){if(!current())return false;const view=getView(),hit=hitUnit(layoutTroops(view.units,view),x,y),enemy=hit&&hit.owner!==player.id&&hit.hp>0?hit:view.units.find(u=>u.owner!==player.id&&u.cell===cell&&u.hp>0);return issue(enemy||ownerAt(cell)&&ownerAt(cell)!==player.id?'attack':'move',enemy?.cell||cell);}
  if(targetMode&&current()){const view=getView(),enemy=targetMode==='attack'?hitUnit(layoutTroops(view.units,view),x,y):null;return issue(targetMode,enemy&&enemy.owner!==player.id?enemy.cell:cell);}
  const hit=hitUnit(layoutTroops(getView().units,getView()),x,y,player.id);
  if(hit){select(hit.key);return true;}
  if(opened){close();return true;}return false;
 }
 function key(event){
  if(!opened||event.repeat)return false;const k=event.code?.startsWith('Key')?event.code.slice(3).toLowerCase():event.key.toLowerCase();
  if(k==='escape'){targetMode?cancelTarget():close();update();invalidate();return true;}
  if(!current())return false;
  if(['m','a','c'].includes(k)){arm({m:'move',a:'attack',c:'capture'}[k]);return true;}
  if(k==='s'||k==='u'){issue(k==='s'?'hold':'auto');return true;}
  if(k==='f'){focus(current().cell);return true;}return false;
 }
 function draw(ctx,view){
  if(!opened)return;const unit=view.units.find(u=>u.key===selected);if(!unit)return;
  guide.draw(ctx,unit,targetMode,view);
  const pose=layoutTroops(view.units,view).find(p=>p.unit.key===selected);
  if(unit.order)drawUnitOrder(ctx,unit,{...view,routeStart:pose});
  if(pose){ctx.save();ctx.strokeStyle='#beff9c';ctx.lineWidth=3;ctx.shadowColor='#9fff72';ctx.shadowBlur=8;ctx.beginPath();ctx.ellipse(pose.x,pose.y,pose.span*.48,pose.span*.19,0,0,Math.PI*2);ctx.stroke();ctx.restore();}
 }
 $('unitRoster').onclick=event=>{const button=event.target.closest('[data-unit-id]');if(button)select(button.dataset.unitId);};
 for(const mode of ['move','attack','capture'])$('unit-'+mode).onclick=()=>arm(mode);
 for(const mode of ['hold','auto'])$('unit-'+mode).onclick=()=>issue(mode);
 $('unitCancelTarget').onclick=cancelTarget;
 $('unit-focus').onclick=()=>{if(current())focus(current().cell);};$('unitClose').onclick=close;
 return{open,select,click,key,draw,update,reset,hover,isOpen:()=>opened,state:()=>({selected,targetMode,opened,busy})};
}
