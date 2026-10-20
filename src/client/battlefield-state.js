import { troopFor } from '../shared/troops.js';
export function unitSeed(key) { let value=2166136261;for(const c of key)value=Math.imul(value^c.charCodeAt(0),16777619);return(value>>>0)/4294967296; }
const modes={idle:'idle',move:'walk',retreat:'run',attack:'attack',capture:'capture',death:'death'};
// This adapter only interpolates persisted server NPC positions. It neither
// invents patrols nor predicts damage, victories, or ownership changes.
export function createBattlefieldState({maxUnits=36}={}){
 let actors=[],syncedAt=0,ownId=null;
 return{
  sync(snapshot,now){
   ownId=snapshot.player?.id||null;
   const players=new Map((snapshot.players||[]).filter(p=>p?.id).map(p=>[p.id,p]));if(snapshot.player)players.set(snapshot.player.id,snapshot.player);
   const units=new Map();
   for(const player of players.values())for(const u of player.army?.units||[])if(u?.id&&u.cell&&(!units.has(u.id)||player.id===ownId))units.set(u.id,{...u,at:player.army.at});
   actors=[...units.values()].sort((a,b)=>(b.owner===ownId)-(a.owner===ownId)||a.id.localeCompare(b.id));syncedAt=now;
  },
  capture(){return false;},
  units(now,isVisible=()=>true){
   const byId=new Map(actors.map(u=>[u.id,u]));
   return actors.filter(u=>isVisible(u.move?.to||u.cell)).slice(0,maxUnits).map(u=>{
    const fresh=now-syncedAt<10000&&now-u.at<10000;
    const spec=troopFor(u.faction,u.type),move=u.move;
    const progress=move?Math.max(0,Math.min(1,((fresh?now:syncedAt)-move.startedAt)/(move.endsAt-move.startedAt))):1;
    const target=byId.get(u.targetId);
    return{...spec,key:u.id,owner:u.owner,cell:move?.to||u.cell,fromCell:move?.from,
     progress,animation:fresh?modes[u.state]||'idle':u.hp<=0?'death':'idle',
     phase:unitSeed(u.id),offsetX:((unitSeed(u.id+':x')-.5)*9),offsetY:((unitSeed(u.id+':y')-.5)*7),
     target:target?.move?.to||target?.cell||null,hp:u.hp,maxHp:u.maxHp,neutral:!!u.neutral,
     capture:fresh&&u.state==='capture',ultimate:u.type==='ultimate',azimuth:0,
     state:u.state,stateAt:u.stateAt,at:u.at,
    };
   });
  },
  clear(){actors=[];syncedAt=0;ownId=null;},
 };
}
