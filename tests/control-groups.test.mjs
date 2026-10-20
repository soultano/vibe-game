import test from 'node:test';
import assert from 'node:assert/strict';
import {latLngToCell} from 'h3-js';
import {GameService} from '../src/server/game-service.js';
import {MemoryStore} from '../src/server/store.js';

const base=latLngToCell(41.3111,69.2797,8),now=1900000000000,ids=['a:infantry:0','a:infantry:1'];
async function fixture(){
 const store=new MemoryStore(),game=new GameService({store,clock:()=>now});
 await store.atomic({puts:[{key:'account:a',value:{id:'a',createdAt:now}}]});
 await game.placeBase('a',{cell:base,faction:'pack'});return{store,game};
}
test('five account groups persist across service restart; saving, replacing and clearing never change army, economy or simulation time',async()=>{
 const {store,game}=await fixture();assert.deepEqual((await game.state('a')).player.unitGroups,[[],[],[],[],[]]);
 const before=(await store.get('player:a')).value;
 const future=new GameService({store,clock:()=>now+60000});
 const result=await future.saveUnitGroup('a',{slot:1,unitIds:ids,mode:'attack',cell:base,hp:999999});
 assert.deepEqual(result,{unitGroups:[ids,[],[],[],[]],unitGroupsVersion:1});
 const after=(await store.get('player:a')).value;delete after.unitGroups;delete after.unitGroupsVersion;assert.deepEqual(after,before,'metadata saves must not settle NPCs or change their orders');
 await future.saveUnitGroup('a',{slot:5,unitIds:[ids[0]]});
 const restored=(await new GameService({store,clock:()=>now}).state('a')).player;assert.deepEqual(restored.unitGroups,[ids,[],[],[],[ids[0]]]);
 await game.saveUnitGroup('a',{slot:1,unitIds:[ids[1]]});await game.saveUnitGroup('a',{slot:1,unitIds:[]});
 assert.deepEqual((await game.state('a')).player.unitGroups,[[],[],[],[],[ids[0]]]);
});
test('invalid slots, forged/neutral/missing IDs, duplicates and oversized groups cannot partially overwrite a saved slot',async()=>{
 const {store,game}=await fixture();await game.saveUnitGroup('a',{slot:2,unitIds:ids});
 for(const input of[
  ...[0,6,-1,1.5,'1',null].map(slot=>({slot,unitIds:ids})),
  ...[null,'bad',[ids[0],ids[0]],[ids[0],'enemy:infantry:0'],[ids[0],'a:infantry:99'],['x'.repeat(161)],Array.from({length:37},(_,i)=>'a:infantry:'+i)].map(unitIds=>({slot:2,unitIds})),
 ]){
  const before=await store.get('player:a');await assert.rejects(()=>game.saveUnitGroup('a',input));assert.deepEqual(await store.get('player:a'),before);
 }
 const row=await store.get('player:a');row.value.army.units[1].neutral=true;await store.atomic({puts:[{key:'player:a',value:row.value}]});
 await assert.rejects(()=>game.saveUnitGroup('a',{slot:2,unitIds:ids}),/свои/);
 await assert.rejects(()=>game.saveUnitGroup(null,{slot:1,unitIds:[]}),error=>error.status===401);
 await assert.rejects(()=>game.saveUnitGroup('no-base',{slot:1,unitIds:[]}),error=>error.status===409);
});
test('dead units retain membership for respawn; concurrent saves of different slots preserve both and public tiles keep groups private',async()=>{
 const {store,game}=await fixture(),row=await store.get('player:a');row.value.army.units[0].hp=0;await store.atomic({puts:[{key:'player:a',value:row.value}]});
 await Promise.all([game.saveUnitGroup('a',{slot:1,unitIds:ids}),game.saveUnitGroup('a',{slot:2,unitIds:[ids[1]]})]);
 assert.deepEqual((await game.state('a')).player.unitGroups,[ids,[ids[1]],[],[],[]]);
 const overview=await game.overview({west:68,east:70,south:40,north:42,resolution:3});assert.doesNotMatch(JSON.stringify(overview),/unitGroups/);
});
