import test from'node:test';import assert from'node:assert/strict';import{latLngToCell,cellToParent}from'h3-js';import{readFile}from'node:fs/promises';import{createHash}from'node:crypto';import{createCanvas}from'@napi-rs/canvas';
import{mapDetail,MAP_LIMITS}from'../src/shared/map-view.js';import{mapRequest}from'../src/client/map-requests.js';import{aggregateOverview,mapEntry}from'../src/server/map-overview.js';import{GameService}from'../src/server/game-service.js';import{MemoryStore}from'../src/server/store.js';import{createLandscapeRenderer}from'../src/client/landscape-renderer.js';import{createAssetLibrary}from'../src/client/asset-library.js';import{createClientHarness}from'./helpers/client-harness.mjs';
const base=latLngToCell(41.3111,69.2797,8),bounds={west:-180,east:180,south:-85,north:85,resolution:5};
const player=i=>({id:'p'+i,name:'Player '+i,faction:['protocol','pack','swarm'][i%3],level:1,pixels:i+1,baseCell:latLngToCell(41.31+(i%15)*.002,69.28+Math.floor(i/15)*.002,8),tLast:100000,
 army:{version:1,at:100000,events:[],order:{mode:'expand',cell:null},units:[{id:'u'+i,owner:'p'+i,hp:100,state:'move',cell:base,path:Array(1000).fill(base)}]}});

test('overview aggregation has a strict marker budget and carries no full NPC or tile data',()=>{
 const entries=Array.from({length:5000},(_,i)=>mapEntry({...player(i),baseCell:latLngToCell(-75+(i%140),-175+(i*17%350),8)})),result=aggregateOverview(entries,bounds);
 assert.ok(result.regions.length<=MAP_LIMITS.overviewMarkers);assert.ok(result.armies.length<=MAP_LIMITS.overviewMarkers);assert.equal(result.regions.reduce((s,g)=>s+g.players,0),5000);assert.equal(result.armies.reduce((s,g)=>s+g.units,0),5000);
 assert.ok(JSON.stringify(result).length<90000);for(const value of['path','waypoints','owners','maxHp','nextAttackAt'])assert.ok(!JSON.stringify(result).includes('"'+value+'"'));
 const local=aggregateOverview(entries,{west:60,east:80,south:35,north:50,resolution:5});assert.ok(local.regions.every(g=>g.lat>=35&&g.lat<=50&&g.lng>=60&&g.lng<=80));
});
test('overview and leaderboard share compact cached metadata without reading player armies or simulating the world',async()=>{
 const store=new MemoryStore(),rows=Array.from({length:150},(_,i)=>player(i));await store.atomic({puts:[{key:'spatial:genesis-2026:test',value:{entries:Object.fromEntries(rows.map(p=>[p.id,{...mapEntry(p),radiusRings:50}]))}}]});
 const lists=[],reads=[];const list=store.list.bind(store),get=store.get.bind(store);store.list=async(...args)=>{lists.push(args[0]);return list(...args);};store.get=async key=>{reads.push(key);return get(key);};const game=new GameService({store,clock:()=>100000});
 await Promise.all([game.overview(bounds),game.leaderboard()]);await game.overview(bounds);assert.deepEqual(lists,['spatial:genesis-2026:']);assert.equal(reads.length,0);
 await assert.rejects(()=>game.overview({...bounds,resolution:9}),/область/);assert.equal(lists.length,1,'invalid queries do not initiate database work');
});
test('legacy map metadata migration reads at most 32 players and never loads the complete player table',async()=>{
 const store=new MemoryStore(),players=Array.from({length:100},(_,i)=>player(i));await store.atomic({puts:[...players.map(p=>({key:'player:'+p.id,value:p})),{key:'spatial:genesis-2026:legacy',value:{entries:Object.fromEntries(players.map(p=>[p.id,{id:p.id,baseCell:p.baseCell,radiusRings:50}]))}}]});
 const read=store.get.bind(store),keys=[];store.get=async key=>{keys.push(key);return read(key);};await new GameService({store,clock:()=>100000}).overview(bounds);assert.equal(keys.filter(k=>k.startsWith('player:')).length,32);
});
test('request planning uses summaries far away and only overlapping tile masks up close',()=>{
 const near={zoom:2048,nw:{lat:41.36,lng:69.2},se:{lat:41.26,lng:69.36}},request=mapRequest(near);assert.equal(request.kind,'tiles');assert.ok(request.parents.length<=6,'no seven-tile padding around each viewport sample');assert.ok(request.parents.includes(cellToParent(base,5)));
 const world=mapRequest({zoom:1,nw:{lat:85,lng:-180},se:{lat:-85,lng:180}});assert.equal(world.kind,'overview');assert.equal(world.parents,undefined);
 const oversized=mapRequest({zoom:8192,nw:{lat:85,lng:-180},se:{lat:-85,lng:180}});assert.equal(oversized.kind,'overview','huge requests fall back before enumerating the world in res-5 cells');assert.equal(mapDetail(128).pollMs,10000);assert.equal(mapDetail(2048).pollMs,2000);
});
test('landscape loads only the world raster far away and no object sprites at regional scale',()=>{
 const requested=[],renderer=createLandscapeRenderer({imageFactory:()=>({complete:false,naturalWidth:0,set src(value){requested.push(value);}})}),canvas=createCanvas(800,500),ctx=canvas.getContext('2d');
 const view=zoom=>{const scale=Math.min(800/360,500/180)*zoom;return{width:800,height:500,zoom,project:(lat,lng)=>({x:400+(lng-69.28)*scale,y:250-(lat-41.31)*scale}),atPoint:(x,y)=>({lat:41.31-(y-250)/scale,lng:69.28+(x-400)/scale})};};
 renderer.draw(ctx,view(1));assert.deepEqual(requested,['/assets/terrain/world-overview.webp?v=climate3']);renderer.draw(ctx,view(16));assert.equal(requested.length,1);renderer.draw(ctx,view(32));renderer.draw(ctx,view(256));assert.equal(requested.length,1,'no terrain material/model downloads before tactical mode');renderer.draw(ctx,view(2048));assert.ok(requested.some(p=>/(pine|oak)\.webp/.test(p)));
});
test('the global terrain asset is independently bounded below 80 KB and matches its digest',async()=>{
 const m=JSON.parse(await readFile(new URL('../src/client/assets/terrain/manifest.json',import.meta.url))),bytes=await readFile(new URL('../src/client/assets/terrain/world-overview.webp',import.meta.url));assert.ok(bytes.length<80000);assert.equal(bytes.length,m.overview.bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),m.overview.sha256);
});
test('model eviction frees idle GPU assets and preserves models used by visible actors',async()=>{
 const freed=[],library=createAssetLibrary({load:async id=>({id}),makeStamp:()=>null,disposeAsset:a=>freed.push(a.id)});for(const id of['a','b','c','d'])await library.ensure(id);await library.ensure('a');library.prune({keepIds:new Set(['b']),maxEntries:2});assert.deepEqual(freed,['c','d']);assert.equal((await library.ensure('b')).id,'b');assert.equal((await library.ensure('a')).id,'a');library.dispose();
});
test('zooming out shows a real world summary without requesting exact tiles or GLBs; zooming back requests the viewport',async()=>{
 const h=await createClientHarness();await h.$('guestLogin').onclick();await h.app.service.placeBase(h.client.state().account.id,{cell:base,faction:'pack'});await h.client.refreshState(true);
 h.requests.length=0;h.client.changeZoom(1);await h.client.refreshTiles(true);assert.equal(h.client.mapSnapshot().mapKind,'overview');assert.ok(h.client.mapSnapshot().overview.regions.length);assert.ok(h.client.mapSnapshot().overview.armies[0].units===3);assert.ok(h.requests.some(p=>p.startsWith('/api/map/overview?')));assert.ok(!h.requests.some(p=>p.startsWith('/api/tiles')||/\.glb/.test(p)));h.client.draw(200);
 h.requests.length=0;h.client.focusAt(41.3111,69.2797,2048);await h.client.refreshTiles(true);assert.equal(h.client.mapSnapshot().mapKind,'tiles');assert.ok(h.requests.some(p=>p.startsWith('/api/tiles')));
});
test('late map replies cannot replace the current viewport after a camera move',async()=>{
 const h=await createClientHarness();let release;h.client.changeZoom(1);h.network.beforeRequest=path=>path.startsWith('/api/map/overview?')?new Promise(r=>release=r):undefined;
 const old=h.client.refreshTiles(true);await new Promise(r=>setImmediate(r));assert.ok(release);h.client.focusAt(41.31,69.28,2048);release();await old;assert.equal(h.client.mapSnapshot().overview,null);h.network.beforeRequest=null;await h.client.refreshTiles(true);assert.equal(h.client.mapSnapshot().mapKind,'tiles');
});

test('detailed tile responses exclude remote component members and offscreen NPC routes',async()=>{
 const store=new MemoryStore(),a=player(0),b={...player(1),baseCell:latLngToCell(42,70,8)};a.army.units=[{id:'a-near',owner:a.id,hp:100,cell:base,state:'idle',path:[]}];b.army.units=[{id:'b-far',owner:b.id,hp:100,cell:b.baseCell,state:'idle',path:Array(20).fill(b.baseCell)}];
 await store.atomic({puts:[a,b].map(p=>({key:'player:'+p.id,value:p}))});const game=new GameService({store,clock:()=>100000});game.loadPlayers=async tx=>Promise.all([a.id,b.id].map(id=>tx.get('player:'+id)));game.settleFully=async()=>[];
 const parent=cellToParent(base,5);let result=await game.tiles({parents:[parent]});assert.deepEqual(result.players.map(p=>p.id),[a.id]);
 const row=await store.get('player:'+b.id);row.value.army.units.push({id:'b-near',owner:b.id,hp:100,cell:base,state:'idle',path:[]});await store.atomic({puts:[{key:'player:'+b.id,value:row.value}]});result=await game.tiles({parents:[parent]});assert.deepEqual(result.players.find(p=>p.id===b.id).army.units.map(u=>u.id),['b-near']);
});

test('overview badges focus their real map position rather than the screen label offset',async()=>{
 const{hitMapOverview}=await import('../src/client/map-overview.js');const overview=aggregateOverview([mapEntry(player(0))],bounds),project=()=>({x:400,y:250});const hit=hitMapOverview(overview,project,800,500,420,230);assert.ok(hit);assert.ok(Math.abs(hit.lat-41.3111)<.02);assert.ok(Math.abs(hit.lng-69.2797)<.02);
});
