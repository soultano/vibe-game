import test from 'node:test';import assert from 'node:assert/strict';import{latLngToCell,gridDisk,gridRing,gridDistance}from'h3-js';
import{advanceArmies,createArmy,reconcileArmy,findRoute,publicArmy}from'../src/server/npc-simulation.js';
import{deriveLevel}from'../src/shared/economy.js';
const base=latLngToCell(41.31,69.28,8),at=1900000000000;
test('bounded long-distance routing returns a real partial route instead of permanently idling at the search limit',async()=>{
 const target=gridRing(base,30)[0],options={isTraversable:()=>true,limit:8};assert.equal(await findRoute(base,target,options),null);
 const route=await findRoute(base,target,{...options,allowPartial:true});assert.ok(route.length>0);let prior=base;for(const cell of route){assert.equal(gridDistance(prior,cell),1);prior=cell;}assert.ok(gridDistance(prior,target)<gridDistance(base,target));
});
async function patrolFixture(mode,full){
 const owned=new Set(gridDisk(base,2)),player={id:'p',faction:'pack',baseCell:base,seed:3,level:1,pixels:full?deriveLevel(1).cap:owned.size,azimuth:90,borderCells:gridRing(base,2)},army=createArmy(player,at);army.order={mode,cell:null};reconcileArmy(army,player,at);
 let moved=false;const occupied=new Set();for(let t=at+500;t<=at+25000;t+=500){await advanceArmies({players:[player],armies:new Map([[player.id,army]]),now:t,owner:async c=>owned.has(c)?player.id:null,locked:async()=>false,claim:async()=>assert.fail('guard patrol cannot change ownership'),canTraverse:c=>owned.has(c),terrain:()=>({speed:1,cover:0}),neutral:false});
  for(const u of army.units){if(u.move){moved=true;assert.ok(owned.has(u.move.to));}occupied.add(u.cell);assert.ok(owned.has(u.cell));}
 }
 assert.ok(moved);assert.ok(occupied.size>1);assert.ok(army.units.some(u=>u.activity==='patrol'));return army;
}
test('defend orders patrol actual owned cells with walking and pauses instead of freezing at HQ',async()=>{await patrolFixture('defend',false);});
test('armies at their territory cap patrol without spending capture credit or capturing extra cells',async()=>{const a=await patrolFixture('expand',true);assert.ok(a.credit<=2);});
test('private route retry and patrol bookkeeping are excluded from the army DTO',()=>{
 const army=createArmy({id:'p'},at);army.units=[{id:'u',cell:base,path:[base],blockedGoals:{[base]:at+1000},waitUntil:at+1000,patrolStep:3,frontierCursor:64,nextAttackAt:at,index:0,activity:'patrol'}];const u=publicArmy(army,at).units[0];assert.equal(u.activity,'patrol');for(const key of['path','blockedGoals','waitUntil','patrolStep','frontierCursor','nextAttackAt','index'])assert.ok(!(key in u));
});
test('guards stranded in protected foreign territory regroup through traversable cells to their own land',async()=>{
 const foreign=gridRing(base,4)[0],owned=new Set(gridDisk(base,1)),player={id:'p',faction:'pack',baseCell:base,seed:3,level:1,pixels:deriveLevel(1).cap},army=createArmy(player,at);army.order.mode='defend';reconcileArmy(army,player,at);for(const u of army.units)u.cell=foreign;
 await advanceArmies({players:[player],armies:new Map([[player.id,army]]),now:at+500,owner:async c=>owned.has(c)?player.id:'protected-enemy',locked:async()=>false,claim:async()=>assert.fail('regroup must not capture'),canTraverse:()=>true,terrain:()=>({speed:1,cover:0}),neutral:false});
 assert.ok(army.units.every(u=>u.move&&u.activity==='regroup'&&gridDistance(u.move.to,base)<gridDistance(foreign,base)));
});
test('bounded frontier batches eventually reach the outer border despite stale interior entries',async()=>{
 const owned=new Set(gridDisk(base,10)),player={id:'p',faction:'pack',baseCell:base,seed:3,level:3,pixels:owned.size,azimuth:0,borderCells:[...gridDisk(base,6),...gridRing(base,10)]},army=createArmy(player,at);reconcileArmy(army,player,at);let found=false;
 for(let t=at+500;t<=at+45000&&!found;t+=500){await advanceArmies({players:[player],armies:new Map([[player.id,army]]),now:t,owner:async c=>owned.has(c)?player.id:null,locked:async()=>false,claim:async()=>false,canTraverse:()=>true,terrain:()=>({speed:1,cover:0}),neutral:false});found=army.units.some(u=>u.move&&u.activity==='advance'&&gridDistance(base,u.targetCell)>10);}
 assert.ok(found,'old interior entries must not starve the real frontier');
});
test('guards can patrol their own frontier far from HQ instead of attempting an impossible return route',async()=>{
 const frontier=gridRing(base,18)[0],owned=new Set([base,...gridDisk(frontier,1)]),player={id:'p',faction:'pack',baseCell:base,seed:3,level:1,pixels:deriveLevel(1).cap},army=createArmy(player,at);army.order.mode='defend';reconcileArmy(army,player,at);for(const u of army.units)u.cell=frontier;
 await advanceArmies({players:[player],armies:new Map([[player.id,army]]),now:at+500,owner:async c=>owned.has(c)?player.id:null,locked:async()=>false,claim:async()=>assert.fail('patrol must not capture'),canTraverse:c=>owned.has(c),terrain:()=>({speed:1,cover:0}),neutral:false});
 assert.ok(army.units.every(u=>u.move&&gridDistance(frontier,u.move.to)===1&&owned.has(u.move.to)));
});
test('a queued patrol step rechecks ownership and locks when the world changes',async()=>{
 for(const reason of ['owner','lock']){
  const next=gridRing(base,1)[0],player={id:'p',faction:'pack',baseCell:base,seed:3,level:1,pixels:7},army=createArmy(player,at);army.order.mode='defend';reconcileArmy(army,player,at);
  for(const u of army.units){u.activity='patrol';u.path=[next];u.targetCell=next;}
  await advanceArmies({players:[player],armies:new Map([[player.id,army]]),now:at+500,owner:async c=>c===next&&reason==='owner'?'enemy':player.id,locked:async c=>c===next&&reason==='lock',claim:async()=>assert.fail('patrol must not capture'),canTraverse:()=>true,terrain:()=>({speed:1,cover:0}),neutral:false});
  for(const u of army.units){assert.ok(!u.move,reason);assert.deepEqual(u.path,[]);}
 }
});
