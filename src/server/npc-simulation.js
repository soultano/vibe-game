import { gridDistance } from 'h3-js';
import { deriveLevel } from '../shared/economy.js';
import { captureMultiplierAt } from '../shared/abilities.js';
import { troopDeployment } from '../shared/troops.js';
import { sectorAllows, captureHash } from '../shared/geography.js';
import { adjacentCells, landscape, traversable } from '../shared/landscape.js';
import { CAPTURE_DEPLOY_MS } from '../shared/conquest.js';

export const NPC_RULES = Object.freeze({ stepMs:500, maxCatchupMs:60000, captureMs:CAPTURE_DEPLOY_MS, respawnMs:18000,
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
export async function findRoute(from,to,{type='infantry',baseCell=null,canEnter=()=>true,isTraversable=traversable,limit=240,allowPartial=false}={}) {
  if(from===to)return[];
  const open=[from],came=new Map(),g=new Map([[from,0]]),scores=new Map([[from,distance(from,to)]]),closed=new Set();
  let nearest=from,nearestDistance=distance(from,to);
  const routeTo=target=>{const route=[];for(let c=target;c!==from;c=came.get(c))route.unshift(c);return route;};
  while(open.length && closed.size<limit){
    open.sort((a,b)=>scores.get(a)-scores.get(b)||a.localeCompare(b));const cell=open.shift();
    if(cell===to)return routeTo(to);
    const remaining=distance(cell,to);if(remaining<nearestDistance){nearest=cell;nearestDistance=remaining;}
    closed.add(cell);
    for(const next of adjacentCells(cell)){
      if(closed.has(next)||!isTraversable(next,type,baseCell)||!await canEnter(next))continue;
      const cost=g.get(cell)+1/(type==='air'?1:landscape(next).speed);
      if(cost>=(g.get(next)??Infinity))continue;
      came.set(next,cell);g.set(next,cost);scores.set(next,cost+distance(next,to));if(!open.includes(next))open.push(next);
    }
  }return allowPartial&&closed.size>=limit&&nearest!==from?routeTo(nearest):null;
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

// Explicit squad orders use the same clock, pathfinder, damage and ownership
// transactions as autonomous NPCs. Reaching a goal holds position until a new
// order (or auto) is issued; move/attack never silently capture another cell.
async function followUnitOrder({unit,player,army,at,dt,stats,currentOwner,byId,headquarters,owner,locked,claim,terrain,canTraverse}){
  const order=unit.order,goal=order.cell;
  const hold=(status,reason=null)=>{order.status=status;order.reason=reason;unit.path=[];unit.targetCell=goal;unit.activity=status==='waiting-credit'?'waiting-capture':'hold';state(unit,'idle',at);};
  if(unit.cell===player.baseCell&&unit.hp<unit.maxHp)unit.hp=Math.min(unit.maxHp,unit.hp+dt*.012);
  if(order.status==='blocked'){hold('blocked',order.reason);return;}
  if(order.mode==='hold'){hold('complete');return;}
  if(['attack','capture'].includes(order.mode)){
    const defender=byId.get(await owner(goal));
    if(defender&&defender.id!==player.id&&((defender.shieldUntil||0)>at||(player.shieldUntil||0)>at)){hold('blocked','shield');return;}
  }
  if(unit.cell===goal){
    if(order.mode!=='capture'||currentOwner===player.id){hold('complete');return;}
    let reason=null;
    if(headquarters.has(goal))reason='headquarters';
    else if(unit.type==='air')reason='air';
    else if(player.pixels>=stats.cap)reason='cap';
    else if(await locked(goal,at))reason='locked';
    else if(!(await Promise.all(adjacentCells(goal).map(owner))).includes(player.id))reason='border';
    if(reason){hold('blocked',reason);return;}
    const cost=currentOwner?1.5:1;
    if(army.credit<cost){hold('waiting-credit');return;}
    order.status='capturing';order.reason=null;unit.activity='capture';unit.targetCell=goal;state(unit,'capture',at);
    if(at-unit.stateAt>=NPC_RULES.captureMs){
      if(await claim(goal,currentOwner,player.id,at)){army.credit-=cost;event(army,{kind:'capture',at,unitId:unit.id,cell:goal,previous:currentOwner});hold('complete');}
      else hold('blocked','ownership');
    }
    return;
  }
  if(!canTraverse(goal,unit.type,player.baseCell)||await locked(goal,at)){hold('blocked','terrain');return;}
  if(unit.targetCell!==goal||!unit.path.length||await locked(unit.path[0],at)||!canTraverse(unit.path[0],unit.type,player.baseCell)){
    unit.path=await findRoute(unit.cell,goal,{type:unit.type,baseCell:player.baseCell,isTraversable:canTraverse,allowPartial:true,canEnter:async c=>!await locked(c,at)})||[];
    unit.targetCell=goal;
  }
  const next=unit.path.shift();
  if(!next){hold('blocked','route');return;}
  const speed=unitStats(unit.faction,unit.type).speed/(unit.type==='air'?1:terrain(next).speed);
  order.status='moving';order.reason=null;unit.activity='command';unit.move={from:unit.cell,to:next,startedAt:at,endsAt:at+speed};state(unit,'move',at);
}

/** Persisted server simulation. No client positions, health, clocks or capture
 * requests are accepted. Every ownership mutation awaits the service transaction. */
export async function advanceArmies({players,armies,now,owner,locked,claim,terrain=landscape,canTraverse=traversable,neutral=true}){
  const byId=new Map(players.map(p=>[p.id,p]));
  const headquarters=new Set(players.map(p=>p.baseCell));
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
        if(unit.hp<=0){state(unit,'death',at);if(!unit.neutral&&at-unit.stateAt>=NPC_RULES.respawnMs){unit.hp=unit.maxHp;unit.life=(unit.life||0)+1;unit.cell=player.baseCell;unit.path=[];delete unit.move;delete unit.order;delete unit.lastDamage;unit.targetCell=null;state(unit,'idle',at);}continue;}
        if(unit.move){if(at<unit.move.endsAt)continue;unit.cell=unit.move.to;delete unit.move;
          if(unit.activity==='patrol'&&!unit.path.length){unit.patrolStep=(unit.patrolStep||0)+1;unit.waitUntil=at+2000+captureHash(unit.cell,unit.index+unit.patrolStep)%2000;state(unit,'idle',at);}}
        const currentOwner=await owner(unit.cell);
        const enemies=all.filter(other=>other.hp>0&&other.owner!==unit.owner && (other.createdAt||0)<=at && (armies.get(other.owner)?.at||0)<=at
          && !(other.neutral&&unit.neutral)
          && (other.neutral || unit.neutral || ((byId.get(other.owner)?.shieldUntil||0)<=at&&(player.shieldUntil||0)<=at)));
        const wounded=!unit.neutral && !unit.order && unit.hp<unit.maxHp*.24 && unit.cell!==player.baseCell;
        const walkingOrder=unit.order?.mode==='move'&&unit.order.status!=='blocked'&&unit.cell!==unit.order.cell;
        const target=!wounded&&!walkingOrder && enemies.filter(other=>distance(unit.cell,other.cell)<=spec.range).sort((a,b)=>(b.cell===unit.order?.cell)-(a.cell===unit.order?.cell)||distance(unit.cell,a.cell)-distance(unit.cell,b.cell)||a.hp-b.hp||a.id.localeCompare(b.id))[0];
        if(target){
          unit.activity='combat';unit.waitUntil=0;
          if(unit.order)unit.order.status='attacking';
          state(unit,'attack',at);unit.targetId=target.id;unit.targetCell=target.cell;unit.path=[];
          if(at>=(unit.nextAttackAt||0)){
            const cover=target.type==='air'?0:terrain(target.cell).cover;
            const shield=all.some(ally=>ally.owner===target.owner&&ally.hp>0&&ally.faction==='protocol'&&ally.type==='ultimate'&&distance(ally.cell,target.cell)<=2)?.7:1;
            const damage=Math.max(1,Math.round(spec.damage*(1-cover)*shield*(unit.neutral?.65:1)));
            const encounter=[`${unit.id}@${unit.life||0}`,`${target.id}@${target.life||0}`].sort().join('|');
            for(const ownerId of new Set([unit.owner,target.owner])) {
              const combatant=byId.get(ownerId),combatArmy=armies.get(ownerId);
              if(!combatant||!combatArmy)continue;
              combatArmy.encounters??=[];
              if(!combatArmy.encounters.includes(encounter)){
                combatArmy.encounters.push(encounter);combatArmy.encounters=combatArmy.encounters.slice(-128);
                combatant.battlesFought=(combatant.battlesFought||0)+1;
              }
            }
            const sourceName=unit.neutral?'Нейтральный защитник':byId.get(unit.owner)?.name||'Вражеский отряд';
            target.lastDamage={at,amount:Math.min(target.hp,damage),sourceId:unit.id,sourceOwner:unit.owner,sourceName};
            target.hp=Math.max(0,target.hp-damage);unit.nextAttackAt=at+spec.cooldown;
            if(unit.faction==='bloom')unit.hp=Math.min(unit.maxHp,unit.hp+damage*.15);
            event(army,{kind:'hit',at,unitId:unit.id,targetId:target.id,cell:target.cell,damage});
            const victimArmy=armies.get(target.owner);
            if(victimArmy)event(victimArmy,{kind:'damage',at,unitId:target.id,sourceId:unit.id,sourceName,cell:target.cell,damage:target.lastDamage.amount});
            if(!target.hp){
              const attacker=byId.get(unit.owner);if(attacker)attacker.unitsDefeated=(attacker.unitsDefeated||0)+1;
              target.path=[];delete target.move;state(target,'death',at);event(army,{kind:'death',at,unitId:target.id,cell:target.cell});
            }
          }continue;
        }
        unit.targetId=null;
        if(unit.neutral){unit.activity='guard';state(unit,'idle',at);continue;}
        if(unit.order){await followUnitOrder({unit,player,army,at,dt,stats,currentOwner,byId,headquarters,owner,locked,claim,terrain,canTraverse});continue;}
        // Wounded units return to the HQ; recovery is visible, not a free teleport.
        const retreat=unit.hp<unit.maxHp*.24;
        if(unit.cell===player.baseCell&&unit.hp<unit.maxHp){unit.hp=Math.min(unit.maxHp,unit.hp+dt*.012);unit.activity='recover';state(unit,'idle',at);if(unit.hp<unit.maxHp*.8)continue;}
        const hostile=currentOwner&&currentOwner!==player.id;
        const safeToCapture=!enemies.some(e=>distance(unit.cell,e.cell)<=1);
        const adjacentOwned=(await Promise.all(adjacentCells(unit.cell).map(owner))).includes(player.id);
        if(!retreat && player.pixels<stats.cap && !headquarters.has(unit.cell) && army.order.mode!=='defend' && currentOwner!==player.id && adjacentOwned && safeToCapture && unit.type!=='air'
          && (inExpansion(player,unit.cell)||army.order.mode==='attack')
          && (!hostile || ((byId.get(currentOwner)?.shieldUntil||0)<=at && (player.shieldUntil||0)<=at))
          && !await locked(unit.cell,at)){
          const sufficient=army.credit>=(hostile?1.5:1);
          unit.targetCell=unit.cell;
          if(!sufficient){unit.activity='waiting-capture';state(unit,'idle',at);continue;}
          unit.activity='capture';state(unit,'capture',at);
          if(sufficient&&at-unit.stateAt>=NPC_RULES.captureMs && player.pixels<stats.cap){
            if(await claim(unit.cell,currentOwner,player.id,at)){
              army.credit-=hostile?1.5:1;event(army,{kind:'capture',at,unitId:unit.id,cell:unit.cell,previous:currentOwner});
              unit.targetCell=null;unit.path=[];state(unit,'idle',at);
            }
          }continue;
        }
        const chase=enemies.filter(other=>distance(unit.cell,other.cell)<=5 && (army.order.mode!=='defend'||distance(other.cell,player.baseCell)<=3))
          .sort((a,b)=>distance(unit.cell,a.cell)-distance(unit.cell,b.cell)||a.hp-b.hp||a.id.localeCompare(b.id))[0];
        if(!retreat&&!chase&&(unit.waitUntil||0)>at){state(unit,'idle',at);continue;}
        unit.blockedGoals=Object.fromEntries(Object.entries(unit.blockedGoals||{}).filter(([,until])=>until>at).slice(-8));
        const escort=unit.type==='air'&&army.order.mode!=='defend'&&!retreat&&!chase;
        const ground=escort?army.units.filter(ally=>!ally.neutral&&ally.type!=='air'&&ally.hp>0)
          .sort((a,b)=>(b.state==='capture'||b.activity==='waiting-capture')-(a.state==='capture'||a.activity==='waiting-capture')||distance(unit.cell,a.move?.to||a.cell)-distance(unit.cell,b.move?.to||b.cell)||a.id.localeCompare(b.id))[0]:null;
        let goal=retreat?player.baseCell:chase?.cell || (army.order.mode==='defend'?null:army.order.cell) || (ground?.targetCell||ground?.move?.to||ground?.cell);
        let patrol=unit.activity==='patrol'&&!!unit.path.length&&!retreat&&!chase,regroup=unit.activity==='regroup'&&!!unit.path.length&&!retreat&&!chase;
        if(goal&&currentOwner===player.id&&goal===unit.cell&&!retreat&&!chase)goal=null;
        if(!goal && unit.path.length)goal=unit.targetCell;
        if(!goal&&unit.type!=='air'&&army.order.mode!=='defend'&&player.pixels<stats.cap){
          const border=[...(player.borderCells||[player.baseCell])].sort((a,b)=>distance(unit.cell,a)-distance(unit.cell,b)||a.localeCompare(b)),candidates=new Set();
          const start=(unit.frontierCursor||0)%Math.max(1,border.length),batch=Array.from({length:Math.min(64,border.length)},(_,i)=>border[(start+i)%border.length]);
          unit.frontierCursor=(start+batch.length)%Math.max(1,border.length);
          for(const cell of batch)if(await owner(cell)===player.id)for(const n of adjacentCells(cell))candidates.add(n);
          const choices=[];
          for(const c of candidates){
            if(c===unit.cell||headquarters.has(c)||unit.blockedGoals[c]||!canTraverse(c,unit.type,player.baseCell)||!inExpansion(player,c)||await locked(c,at))continue;
            const owned=await owner(c);if(owned===player.id)continue;
            if(owned&&((byId.get(owned)?.shieldUntil||0)>at||(player.shieldUntil||0)>at))continue;
            choices.push(c);
          }
          choices.sort((a,b)=>(reservations.has(a)*5+distance(unit.cell,a))-(reservations.has(b)*5+distance(unit.cell,b))||captureHash(a,player.seed)-captureHash(b,player.seed));
          goal=choices[0];
          if(goal&&neutral&&!(await owner(goal))&&captureHash(goal,97)%4===0){
            const campId=`wild:${goal}`;
            if(!all.some(u=>u.id===campId)&&!army.units.some(u=>u.id===campId)){
              const wild={id:campId,owner:campId,faction:captureHash(goal,11)%2?'swarm':'pack',type:'infantry',index:0,
                cell:goal,hp:65,maxHp:65,state:'idle',stateAt:at,createdAt:at,path:[],neutral:true,nextAttackAt:at};army.units.push(wild);all.push(wild);
            }
          }
        }
        if(!goal){
          // Guard duty is real server movement between owned cells. It never
          // spends capture credit, steps into protected territory or orbits HQ.
          const near=new Set([player.baseCell,...adjacentCells(unit.cell),...adjacentCells(player.baseCell)]),choices=[];
          for(const c of near)if(c!==unit.cell&&!unit.blockedGoals[c]&&canTraverse(c,unit.type,player.baseCell)&&!await locked(c,at)&&await owner(c)===player.id)choices.push(c);
          choices.sort((a,b)=>distance(unit.cell,a)-distance(unit.cell,b)||captureHash(a,(player.seed||0)+(unit.index||0)*41+(unit.patrolStep||0)*97)-captureHash(b,(player.seed||0)+(unit.index||0)*41+(unit.patrolStep||0)*97));
          goal=choices[0]||player.baseCell;regroup=currentOwner!==player.id;patrol=!regroup;
        }
        if(goal===unit.cell){unit.path=[];unit.targetCell=null;unit.activity=escort?'escort':'guard';state(unit,'idle',at);continue;}
        if(goal!==unit.targetCell||!unit.path.length){
          const route=await findRoute(unit.cell,goal,{type:unit.type,baseCell:player.baseCell,isTraversable:canTraverse,allowPartial:!patrol,
            canEnter:async cell=>!await locked(cell,at)&&(!patrol||await owner(cell)===player.id)});
          unit.path=route||[];unit.targetCell=goal;
        }
        const next=unit.path.shift();
        if(next && canTraverse(next,unit.type,player.baseCell) && !await locked(next,at) && (!patrol||await owner(next)===player.id)){
          const speed=spec.speed/(unit.type==='air'?1:terrain(next).speed);
          unit.activity=retreat?'retreat':patrol?'patrol':regroup?'regroup':escort?'escort':'advance';unit.waitUntil=0;unit.move={from:unit.cell,to:next,startedAt:at,endsAt:at+speed};state(unit,retreat?'retreat':'move',at);reservations.add(goal);
        }else{unit.path=[];unit.activity='guard';unit.blockedGoals[goal]=at+8000;unit.waitUntil=at+1000;state(unit,'idle',at);unit.targetCell=null;}
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
    units:army.units.map(({path,nextAttackAt,index,blockedGoals,waitUntil,patrolStep,frontierCursor,...unit})=>({...unit,waypoints:path.slice(0,8),...(unit.order?{routePartial:path.length>8||(path.at(-1)||unit.move?.to||unit.cell)!==unit.order.cell}:{} )}))};
}
