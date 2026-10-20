import {cellToParent,gridDisk,gridDistance} from 'h3-js';
import {traversable} from '../shared/landscape.js';
import {deriveLevel} from '../shared/economy.js';
import {isClanHallCell} from '../shared/clan-hall.js';
const distance=(a,b)=>{try{return gridDistance(a,b);}catch{return Infinity;}};
// Advisory snapshot check only. The server rechecks ownership, shields and the
// actual traversable route atomically when accepting each order.
export function unitTarget(unit,mode,cell,data){
 const {player,owners,profiles,tiles,now}=data,fail=message=>({ok:false,message,kind:'blocked'});
 if(!cell||!traversable(cell,unit.type,player.baseCell))return fail('Нужен проходимый гекс суши. Вода недоступна этому отряду.');
 if(distance(unit.cell,cell)>64)return fail('Слишком далеко: выберите цель в пределах 64 гексов от отряда.');
 const level=Math.max(player.level,player.upgradeTargetLevel||1,player.queuedProject?.targetLevel||1);
 if(distance(player.baseCell,cell)>Math.max(12,deriveLevel(level,player.faction).radiusRings*4+8))return fail('Цель за пределами радиуса действий базы.');
 const tile=tiles.get(cellToParent(cell,5));
 if(!tile)return fail('Эта область ещё загружается. Приблизьте карту или дождитесь загрузки.');
 if(tile.locks?.[cell]>now)return fail('Этот гекс временно заблокирован.');
 const owner=owners.get(cell),defender=owner&&owner!==player.id?profiles.get(owner):null;
 if(owner&&owner!==player.id&&!defender)return fail('Данные противника ещё загружаются.');
 if(mode!=='move'&&defender&&((defender.shieldUntil||0)>now||(player.shieldUntil||0)>now))return fail('Действует защитный щит. Атаковать эту территорию сейчас нельзя.');
 if(mode==='capture'){
  if(isClanHallCell(cell))return fail('Кланхолл защищён до следующего сезона.');
  if(unit.type==='air')return fail('Авиация сражается, но не захватывает землю.');
  if(cell===player.baseCell||cell===defender?.baseCell)return fail('Штаб нельзя захватить.');
  if(owner===player.id)return fail('Этот гекс уже ваш. Выберите соседнюю свободную или вражескую землю.');
  if(player.pixels>=(player.cap??deriveLevel(player.level,player.faction).cap))return fail('Лимит территории достигнут. Улучшите базу.');
  if(!gridDisk(cell,1).some(c=>c!==cell&&owners.get(c)===player.id))return fail('Захват возможен только рядом с вашей территорией.');
 }
 const enemy=owner&&owner!==player.id;
 return{ok:true,kind:enemy?'enemy':'free',message:mode==='capture'?'Захватить этот гекс':mode==='attack'?enemy?'Атаковать территорию противника':'Идти с атакой: вступать в бой по пути':'Идти в этот гекс'};
}
export function createTargetGuide(){
 let key='',shapes=[];
 return{draw(ctx,unit,mode,view){
  if(!mode||!view.targetData||!view.detailed)return;
  const data=view.targetData,next=[unit.key,unit.cell,mode,view.revision,Math.floor(data.now/1500),unit.type].join(':');
  if(next!==key){
   key=next;shapes=[];
   // Screen-bounded candidates; no path search or whole-world scans per frame.
   const radius=Math.min(12,Math.ceil(Math.max(view.width,view.height)/Math.max(20,view.footprintCell(view.centerCell).width))+2);
   for(const cell of gridDisk(view.centerCell,radius)){
    const p=view.projectCell(cell);if(!p||p.x<-50||p.y<-50||p.x>view.width+50||p.y>view.height+50)continue;
    const result=unitTarget(unit,mode,cell,data);shapes.push({cell,result,polygon:view.shapeCell(cell)});if(shapes.length>=192)break;
   }
  }
  ctx.save();ctx.lineWidth=1.5;
  for(const{result,polygon}of shapes){
   if(!polygon?.length)continue;ctx.beginPath();polygon.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));ctx.closePath();
   const color=!result.ok?'#71808a':result.kind==='enemy'?'#ff705d':mode==='capture'?'#f6d16b':'#6ee9b0';
   ctx.fillStyle=color+(result.ok?'32':'0c');ctx.strokeStyle=color+(result.ok?'ba':'35');ctx.fill();ctx.stroke();
  }
  ctx.restore();
 },clear(){key='';shapes=[];}};
}
