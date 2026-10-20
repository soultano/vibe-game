import { gridDistance } from 'h3-js';
import { deriveLevel } from '../shared/economy.js';
import { captureMultiplierAt } from '../shared/abilities.js';
import { troopDeployment } from '../shared/troops.js';
import { sectorAllows, captureHash } from '../shared/geography.js';
import { adjacentCells, landscape, traversable } from '../shared/landscape.js';

export const NPC_RULES = Object.freeze({ stepMs:500, maxCatchupMs:60000, captureMs:3000, respawnMs:18000,
  classes:{ infantry:{hp:100,damage:16,range:1,speed:3300,cooldown:1000},
    armor:{hp:420,damage:40,range:2,speed:5200,cooldown:1500},
    air:{hp:260,damage:55,range:3,speed:2100,cooldown:1400},
    ultimate:{hp:1100,damage:95,range:2,speed:4500,cooldown:1600} } });
const distance=(a,b)=>{try{return gridDistance(a,b);}catch{return Infinity;}};
const inExpansion=(p,cell)=>distance(p.baseCell,cell)<=1||sectorAllows(p.baseCell,cell,p.level,p.azimuth);
const priority={death:0,attack:1,capture:2,retreat:3,move:4,idle:5};
export function unitStats(faction,type){
  const values={...NPC_RULES.classes[type]};
  if(faction==='protocol'&&type==='infantry'){values.range=2;values.damage=14;}
  if(faction==='vanguard'&&type==='armor'){values.hp=500;values.damage=48;}
  if(faction==='bloom')values.hp=Math.round(values.hp*1.12);
  if(faction==='swarm'){values.speed*=.8;values.cooldown*=.85;}
  if(faction==='pack'){values.speed*=.85;if(type==='infantry')values.damage=20;}
  return values;
}
export function createArmy(player, now) { return {version:1,at:now,credit:0,units:[],events:[],order:{mode:'expand',cell:null}}; }

// Bounded A*: every waypoint is an actual H3 neighbour, including around lakes.
export async function findRoute(from,to,{type='infantry',baseCell=null,canEnter=()=>true,limit=240}={}) {
  if(from===to)return[];
  const open=[from],came=new Map(),g=new Map([[from,0]]),scores=new Map([[from,distance(from,to)]]),closed=new Set();
  while(open.length && closed.size<limit){
    open.sort((a,b)=>scores.get(a)-scores.get(b)||a.localeCompare(b));const cell=open.shift();
    if(cell===to){const route=[];for(let c=to;c!==from;c=came.get(c))route.unshift(c);return route;}
    closed.add(cell);
    for(const next of adjacentCells(cell)){
      if(closed.has(next)||!traversable(next,type,baseCell)||!await canEnter(next))continue;
      const cost=g.get(cell)+1/(type==='air'?1:landscape(next).speed);
      if(cost>=(g.get(next)??Infinity))continue;
      came.set(next,cell);g.set(next,cost);scores.set(next,cost+distance(next,to));if(!open.includes(next))open.push(next);
    }
  }return null;
}
function addUnit(army,player,type,index,at){
  const spec=unitStats(player.faction,type);
  army.units.push({id:`${player.id}:${type}:${index}`,owner:player.id,faction:player.faction,type,index,
    cell:player.baseCell,hp:spec.hp,maxHp:spec.hp,state:'idle',stateAt:at,createdAt:at,path:[],nextAttackAt:at,targetId:null,targetCell:null});
}
export function reconcileArmy(army,player,at){
  const wanted=new Map(troopDeployment(player,at).map(g=>[g.type,g.count]));
  army.units=army.units.filter(u=>u.neutral || u.index<(wanted.get(u.type)||0));
  for(const [type,count]of wanted)for(let i=0;i<count;i++)if(!army.units.some(u=>!u.neutral&&u.type===type&&u.index===i))addUnit(army,player,type,i,at);
}
function state(unit,value,at){if(unit.state!==value){unit.state=value;unit.stateAt=at;}}
function event(army,value){army.events.push(value);army.events=army.events.slice(-24);}

/** Persisted server simulation. No client positions, health, clocks or capture
 * requests are accepted. Every ownership mutation awaits the service transaction. */
export async function advanceArmies({players,armies,now,owner,locked,claim,terrain=landscape,canTraverse=traversable,neutral=true}){
  const byId=new Map(players.map(p=>[p.id,p]));
  let cursor=Math.max(now-NPC_RULES.maxCatchupMs,Math.min(now,...[...armies.values()].map(a=>a.at)));
  // Long absence holds armies in place; economy still accrues for the full time.
  for(const p of players){const a=armies.get(p.id);if(a.at<cursor){a.at=cursor;for(const u of a.units)if(u.move){u.cell=u.move.to;delete u.move;} }
    reconcileArmy(a,p,Math.max(a.at,cursor));a.events=a.events.filter(e=>now-e.at<15000);}
  while(cursor<now){
    const at=Math.min(now,cursor+NPC_RULES.stepMs),all=[...armies.values()].flatMap(a=>a.units);
    for(const player of [...players].sort((a,b)=>a.id.localeCompare(b.id))){
      const army=armies.get(player.id);if(at<=army.at)continue;
      const dt=at-Math.max(cursor,army.at);reconcileArmy(army,player,at);
      const stats=deriveLevel(player.level,player.faction);
      army.credit=Math.min(2,(army.credit||0)+stats.capturePerHour*captureMultiplierAt(player,at)*dt/3600000);
      const reservations=new Set(army.units.filter(u=>u.hp>0).map(u=>u.targetCell).filter(Boolean));
      for(const unit of [...army.units].sort((a,b)=>a.id.localeCompare(b.id))){
        const spec=unitStats(unit.faction,unit.type);
        if(unit.hp<=0){state(unit,'death',at);if(!unit.neutral&&at-unit.stateAt>=NPC_RULES.respawnMs){unit.hp=unit.maxHp;unit.cell=player.baseCell;unit.path=[];delete unit.move;unit.targetCell=null;state(unit,'idle',at);}continue;}
        if(unit.move){if(at<unit.move.endsAt)continue;unit.cell=unit.move.to;delete unit.move;}
        const currentOwner=await owner(unit.cell);
        const enemies=all.filter(other=>other.hp>0&&other.owner!==unit.owner && (other.createdAt||0)<=at && (armies.get(other.owner)?.at||0)<=at
          && !(other.neutral&&unit.neutral)
          && (other.neutral || unit.neutral || ((byId.get(other.owner)?.shieldUntil||0)<=at&&(player.shieldUntil||0)<=at)));
        const wounded=!unit.neutral && unit.hp<unit.maxHp*.24 && unit.cell!==player.baseCell;
        const target=!wounded && enemies.filter(other=>distance(unit.cell,other.cell)<=spec.range).sort((a,b)=>distance(unit.cell,a.cell)-distance(unit.cell,b.cell)||a.hp-b.hp||a.id.localeCompare(b.id))[0];
        if(target){
          state(unit,'attack',at);unit.targetId=target.id;unit.targetCell=target.cell;unit.path=[];
          if(at>=(unit.nextAttackAt||0)){
            const cover=target.type==='air'?0:terrain(target.cell).cover;
            const shield=all.some(ally=>ally.owner===target.owner&&ally.hp>0&&ally.faction==='protocol'&&ally.type==='ultimate'&&distance(ally.cell,target.cell)<=2)?.7:1;
            const damage=Math.max(1,Math.round(spec.damage*(1-cover)*shield*(unit.neutral?.65:1)));
            target.hp=Math.max(0,target.hp-damage);unit.nextAttackAt=at+spec.cooldown;
            if(unit.faction==='bloom')unit.hp=Math.min(unit.maxHp,unit.hp+damage*.15);
            event(army,{kind:'hit',at,unitId:unit.id,targetId:target.id,cell:target.cell,damage});
            if(!target.hp){target.path=[];delete target.move;state(target,'death',at);event(army,{kind:'death',at,unitId:target.id,cell:target.cell});}
          }continue;
        }
        unit.targetId=null;
        if(unit.neutral){state(unit,'idle',at);continue;}
        // Wounded units return to the HQ; recovery is visible, not a free teleport.
        const retreat=unit.hp<unit.maxHp*.24;
        if(unit.cell===player.baseCell&&unit.hp<unit.maxHp){unit.hp=Math.min(unit.maxHp,unit.hp+dt*.012);state(unit,'idle',at);if(unit.hp<unit.maxHp*.8)continue;}
        const hostile=currentOwner&&currentOwner!==player.id;
        const safeToCapture=!enemies.some(e=>distance(unit.cell,e.cell)<=1);
        const adjacentOwned=(await Promise.all(adjacentCells(unit.cell).map(owner))).includes(player.id);
        if(!retreat && army.order.mode!=='defend' && currentOwner!==player.id && adjacentOwned && safeToCapture && unit.type!=='air'
          && (inExpansion(player,unit.cell)||army.order.mode==='attack')
          && (!hostile || ((byId.get(currentOwner)?.shieldUntil||0)<=at && (player.shieldUntil||0)<=at))
          && !await locked(unit.cell,at)){
          state(unit,'capture',at);unit.targetCell=unit.cell;
          const sufficient=army.credit>=(hostile?1.5:1);
          if(sufficient&&at-unit.stateAt>=NPC_RULES.captureMs && player.pixels<stats.cap){
            if(await claim(unit.cell,currentOwner,player.id,at)){
              army.credit-=hostile?1.5:1;event(army,{kind:'capture',at,unitId:unit.id,cell:unit.cell,previous:currentOwner});
              unit.targetCell=null;unit.path=[];state(unit,'idle',at);
            }
          }continue;
        }
        const chase=enemies.filter(other=>distance(unit.cell,other.cell)<=5 && (army.order.mode!=='defend'||distance(other.cell,player.baseCell)<=3))
          .sort((a,b)=>distance(unit.cell,a.cell)-distance(unit.cell,b.cell)||a.hp-b.hp||a.id.localeCompare(b.id))[0];
        let goal=retreat?player.baseCell:chase?.cell || (army.order.mode==='defend'?player.baseCell:army.order.cell);
        if(!goal && unit.path.length)goal=unit.targetCell;
        if(!goal){
          const border=(player.borderCells||[player.baseCell]).slice(0,128),candidates=new Set();
          for(const cell of border)for(const n of adjacentCells(cell))candidates.add(n);
          const choices=[];
          for(const c of candidates){
            if(!canTraverse(c,unit.type,player.baseCell)||!inExpansion(player,c)||await locked(c,at))continue;
            const owned=await owner(c);if(owned===player.id)continue;
            if(owned&&((byId.get(owned)?.shieldUntil||0)>at||(player.shieldUntil||0)>at))continue;
            choices.push(c);
          }
          choices.sort((a,b)=>(reservations.has(a)*5+distance(unit.cell,a))-(reservations.has(b)*5+distance(unit.cell,b))||captureHash(a,player.seed)-captureHash(b,player.seed));
          goal=choices[0]||player.baseCell;
          if(goal!==player.baseCell&&neutral&&!(await owner(goal))&&captureHash(goal,97)%4===0){
            const campId=`wild:${goal}`;
            if(!all.some(u=>u.id===campId)&&!army.units.some(u=>u.id===campId)){
              const wild={id:campId,owner:campId,faction:captureHash(goal,11)%2?'swarm':'pack',type:'infantry',index:0,
                cell:goal,hp:65,maxHp:65,state:'idle',stateAt:at,createdAt:at,path:[],neutral:true,nextAttackAt:at};army.units.push(wild);all.push(wild);
            }
          }
        }
        if(goal===unit.cell){unit.path=[];unit.targetCell=null;state(unit,'idle',at);continue;}
        if(goal!==unit.targetCell||!unit.path.length){
          const route=await findRoute(unit.cell,goal,{type:unit.type,baseCell:player.baseCell,
            canEnter:async cell=>canTraverse(cell,unit.type,player.baseCell)&&!await locked(cell,at)});
          unit.path=route||[];unit.targetCell=goal;
        }
        const next=unit.path.shift();
        if(next && canTraverse(next,unit.type,player.baseCell)){
          const speed=spec.speed/(unit.type==='air'?1:terrain(next).speed);
          unit.move={from:unit.cell,to:next,startedAt:at,endsAt:at+speed};state(unit,retreat?'retreat':'move',at);reservations.add(goal);
        }else{state(unit,'idle',at);unit.targetCell=null;}
      }
      army.units=army.units.filter(u=>!u.neutral||u.hp>0||at-u.stateAt<10000).slice(0,16);
      army.at=at;
    }
    cursor=at;
  }
  for(const army of armies.values())army.events=army.events.filter(e=>now-e.at<15000);
  return [...armies.values()].flatMap(a=>a.units).sort((a,b)=>priority[a.state]-priority[b.state]||a.id.localeCompare(b.id));
}

export function publicArmy(army,now){
  if(!army)return null;
  return {version:1,at:army.at,order:army.order,events:army.events.filter(e=>now-e.at<15000),
    units:army.units.map(({path,nextAttackAt,index,...unit})=>({...unit,waypoints:path.slice(0,8)}))};
}
