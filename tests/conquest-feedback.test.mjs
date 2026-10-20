import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { latLngToCell, gridDisk } from 'h3-js';
import { GameService } from '../src/server/game-service.js';
import { MemoryStore } from '../src/server/store.js';
import { createArmy, reconcileArmy, advanceArmies, publicArmy } from '../src/server/npc-simulation.js';
import { CAPTURE_DEPLOY_MS, captureProgress, healthExplanation } from '../src/shared/conquest.js';
import { decodeTile, tileForCell } from '../src/shared/geography.js';
import { traversable } from '../src/shared/landscape.js';
import { ACHIEVEMENTS } from '../src/client/achievements.js';
import { profileTooltip } from '../src/client/player-profile.js';
import { drawConquestSites } from '../src/client/conquest-view.js';
import { createBattlefieldState } from '../src/client/battlefield-state.js';
import { createClientHarness } from './helpers/client-harness.mjs';

const base=latLngToCell(41.3111,69.2797,8),next=gridDisk(base,1).find(c=>c!==base&&traversable(c)),start=1900000000000;
const player=(id='a',cell=base)=>({id,name:id==='a'?'Альфа':'Браво',baseCell:cell,faction:'protocol',level:1,pixels:1,azimuth:0,shieldUntil:0,borderCells:[cell]});
function simulation(players=[player()]) {
  const armies=new Map(players.map(p=>[p.id,createArmy(p,start)])),owners=new Map(players.map(p=>[p.baseCell,p.id]));
  for(const p of players)reconcileArmy(armies.get(p.id),p,start);
  const claims=[];
  const run=now=>advanceArmies({players,armies,now,neutral:false,owner:async c=>owners.get(c)||null,locked:async()=>false,canTraverse:()=>true,terrain:()=>({speed:1,cover:0}),claim:async(cell,previous,id,at)=>{owners.set(cell,id);players.find(p=>p.id===id).pixels++;claims.push({cell,id,at});return true;}});
  return{players,armies,owners,claims,run};
}

test('marching and occupation do not drain HP in the absence of enemies',async()=>{
  const h=simulation();
  await h.run(start+60000);
  assert.ok(h.claims.length>0);
  for(const unit of h.armies.get('a').units){assert.equal(unit.hp,unit.maxHp);assert.equal(unit.lastDamage,undefined);}
  assert.equal(h.players[0].battlesFought,undefined);
});

test('real combat attributes incoming HP loss and counts one encounter per unit pair',async()=>{
  const h=simulation([player(),player('b',next)]);
  for(const army of h.armies.values())for(const [i,u]of army.units.entries()){
    u.hp=i?0:1000;u.maxHp=1000;u.state=i?'death':'idle';u.stateAt=start;u.order={mode:'hold',cell:u.cell,status:'queued'};
  }
  await h.run(start+3000);
  for(const p of h.players){
    assert.equal(p.battlesFought,1,'successive hits are not new encounters');
    const army=h.armies.get(p.id),unit=army.units[0];
    assert.ok(unit.hp<1000);assert.equal(unit.lastDamage.sourceName,p.id==='a'?'Браво':'Альфа');
    assert.ok(army.events.some(e=>e.kind==='damage'&&e.unitId===unit.id));
    assert.match(healthExplanation(unit,start+3000),/HP/);
    assert.equal(publicArmy(army,start+3000).encounters,undefined);
  }
});

test('occupation begins after credit is available and takes a full deployment interval',async()=>{
  const h=simulation(),army=h.armies.get('a'),unit=army.units[0];
  for(const u of army.units)u.order={mode:'hold',cell:u.cell,status:'queued'};
  unit.cell=next;unit.order={mode:'capture',cell:next,status:'queued'};
  await h.run(start+4000);
  assert.equal(unit.activity,'waiting-capture');assert.equal(captureProgress(unit,start+4000),null);assert.equal(h.claims.length,0);
  army.credit=2;
  await h.run(start+4500);assert.equal(unit.state,'capture');assert.equal(unit.stateAt,start+4500);
  await h.run(start+4500+CAPTURE_DEPLOY_MS-500);assert.equal(h.claims.length,0);
  await h.run(start+4500+CAPTURE_DEPLOY_MS);assert.equal(h.claims.length,1);assert.equal(h.owners.get(next),'a');assert.equal(unit.order.status,'complete');
  await h.run(start+9500);assert.equal(h.claims.length,1);assert.equal(unit.hp,unit.maxHp);
});

test('autonomous aviation escorts a ground occupation instead of seeking empty conquest targets',async()=>{
  const h=simulation(),p=h.players[0],army=h.armies.get('a');
  p.abilities={heavy:{activeFrom:start,activeUntil:start+60000}};reconcileArmy(army,p,start);army.credit=2;
  for(const unit of army.units.filter(u=>u.type==='infantry')){unit.cell=next;unit.state='capture';unit.stateAt=start;unit.targetCell=next;}
  await h.run(start+500);
  const air=army.units.find(u=>u.type==='air');assert.equal(air.activity,'escort');assert.equal(air.move.to,next);assert.notEqual(air.state,'capture');
});

async function fixture(){
  let now=start;const store=new MemoryStore(),game=new GameService({store,clock:()=>now});
  await store.atomic({puts:[{key:'account:a',value:{id:'a',name:'Альфа',provider:'telegram',createdAt:now}}]});
  await game.placeBase('a',{cell:base,faction:'protocol'});
  return{store,game,advance:ms=>now+=ms,now:()=>now,edit:async fn=>{const row=await store.get('player:a');fn(row.value);await store.atomic({checks:[{key:'player:a',version:row.version}],puts:[{key:'player:a',value:row.value}]});}};
}

test('a real occupied hex changes server ownership, cell count, production and accrued energy',async()=>{
  const h=await fixture();
  await h.edit(p=>{
    p.energy=0;p.army.credit=2;p.army.order.mode='defend';
    for(const u of p.army.units)u.order={mode:'hold',cell:u.cell,status:'queued'};
    const u=p.army.units[0];u.cell=next;u.order={mode:'capture',cell:next,status:'capturing'};u.state='capture';u.stateAt=start-CAPTURE_DEPLOY_MS;
  });
  const before=h.game.publicPlayer((await h.store.get('player:a')).value,h.now());
  h.advance(500);const result=await h.game.state('a');
  const tile=(await h.store.get('tile:'+tileForCell(next))).value;
  assert.ok(decodeTile(tile.parent,tile.owners.a).includes(next));
  assert.equal(result.player.pixels,before.pixels+1);assert.ok(result.player.grossPerHour>before.grossPerHour);
  h.advance(60000);assert.ok((await h.game.state('a')).player.energy>result.player.energy);
});

test('one promotion link yields a permanent achievement once and is public in tiles and ranking',async()=>{
  const h=await fixture();await h.game.leaderboard();
  const first=await h.game.updateCustomization('a',{customLink:'https://t.me/alpha',customLinkTitle:'Мой канал'}),award=first.player.promotionLinkedAt;
  assert.deepEqual(first.player.achievements,['promotion_link']);
  assert.equal((await h.game.leaderboard()).players[0].customLink,'https://t.me/alpha');
  await h.game.updateCustomization('a',{customLink:'https://instagram.com/alpha',customLinkTitle:'Instagram'});
  const tiles=await h.game.tiles({parents:[tileForCell(base)]});assert.equal(tiles.players[0].customLink,'https://instagram.com/alpha');
  await assert.rejects(()=>h.game.updateCustomization('a',{customLink:'javascript:alert(1)'}),/ссылку/);
  await assert.rejects(()=>h.game.updateCustomization('a',{customLink:'https://user:secret@example.com'}),/ссылку/);
  const cleared=await h.game.updateCustomization('a',{customLink:''});
  assert.equal(cleared.player.customLink,null);assert.deepEqual(cleared.player.achievements,['promotion_link']);assert.equal(cleared.player.promotionLinkedAt,award);
  const restarted=new GameService({store:h.store,clock:h.now}),p=(await restarted.state('a')).player;
  assert.equal(ACHIEVEMENTS.find(a=>a.id==='promotion_link').check(p),true);
  assert.equal((await restarted.leaderboard()).players[0].customLink,null);
});

test('public profile stats and promotion labels are escaped and do not render unsafe links',()=>{
  const html=profileTooltip({name:'<img src=x>',level:7,pixels:42,battlesFought:9,battlesWon:3,unitsDefeated:5,customLink:'https://t.me/alpha',customLinkTitle:'<script>alert(1)</script>'});
  assert.ok(html.includes('42'));assert.ok(html.includes('9'));assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('rel="noopener noreferrer ugc"'));
  assert.ok(!profileTooltip({customLink:'javascript:alert(1)'}).includes('href='));
});

test('occupation draws an unfolding control point while the soldier uses an idle pose',()=>{
  const actor=createBattlefieldState();
  const u={id:'a:infantry:0',owner:'a',faction:'protocol',type:'infantry',cell:next,hp:100,maxHp:100,state:'capture',stateAt:start};
  actor.sync({player:{id:'a',baseCell:base,army:{at:start,units:[u]}}},start);
  const units=actor.units(start+1500);assert.equal(units[0].animation,'idle');assert.equal(captureProgress(units[0],start+1500),.5);
  const labels=[],ctx=new Proxy({measureText:text=>({width:text.length*6}),fillText:text=>labels.push(text)},{get:(target,key)=>key in target?target[key]:()=>{}});
  drawConquestSites(ctx,units,{width:300,height:200,projectCell:()=>({x:150,y:100}),shapeCell:()=>[{x:130,y:100},{x:150,y:80},{x:170,y:100},{x:150,y:120}]},start+1500);
  assert.deepEqual(labels,['Развёртывание 50%']);
});

const botToken='123456:promotion-client-fixture';
function proof(mini){
  const fields=mini?{auth_date:String(Math.floor(Date.now()/1000)),user:JSON.stringify({id:88776655,first_name:'Альфа'}),query_id:crypto.randomUUID()}:{id:88776655,first_name:'Альфа',auth_date:Math.floor(Date.now()/1000)};
  const key=mini?createHmac('sha256','WebAppData').update(botToken).digest():createHash('sha256').update(botToken).digest();
  const hash=createHmac('sha256',key).update(Object.keys(fields).sort().map(k=>`${k}=${fields[k]}`).join('\n')).digest('hex');
  return mini?new URLSearchParams({...fields,hash}).toString():{...fields,hash};
}
for(const platform of ['website','miniapp'])test(`${platform}: adding a promotion announces the achievement and opens its ranked profile`,async()=>{
  const h=await createClientHarness({env:{LOCAL_DEV:false,TELEGRAM_BOT_TOKEN:botToken,TELEGRAM_BOT_USERNAME:'DominionTestBot'},origin:'https://game.example',cookieBlocked:true,launchData:platform==='miniapp'?proof(true):''});
  if(platform==='website'){await h.click('openAuthModalBtn');await h.click('modalTelegramBtn');await h.sandbox.onTelegramAuth(proof(false));}
  await h.app.service.placeBase(h.client.state().account.id,{cell:base,faction:'protocol'});await h.client.refreshState(true);
  await h.click('profileButton');h.$('customLinkInput').value='https://t.me/alpha';h.$('customLinkTitleInput').value='Канал Альфа';await h.click('saveCustomizationBtn');
  assert.equal(h.client.state().model.player.achievements.includes('promotion_link'),true);
  assert.match(h.$('toast').textContent,/Достижение/);
  h.client.openPanel('ranking');
  const button=h.document.querySelectorAll('[data-player-profile]')[0];assert.ok(button);
  await h.click('rankings',{target:button});assert.equal(h.$('publicPlayerDialog').open,true);assert.match(h.$('publicPlayerBody').innerHTML,/https:\/\/t.me\/alpha/);
  assert.match(h.$('publicPlayerBody').innerHTML,/Захвачено ячеек/);
});
