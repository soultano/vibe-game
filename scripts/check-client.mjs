// Exercise the real client events against the real API without opening a browser.
// This DOM/canvas adapter checks behavior; it does not assert browser layout.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { webcrypto } from 'node:crypto';
import { build } from 'esbuild';
import { MemoryStore } from '../src/server/store.js';
import { createApp } from '../src/server/router.js';

const root=resolve(import.meta.dirname,'..'),html=await readFile(resolve(root,'src/client/index.html'),'utf8');
const nodes=new Set(),byId=new Map();
const context2d=new Proxy({measureText:text=>({width:text.length*6})},{get(target,key){return key in target?target[key]:()=>{};},set(target,key,value){target[key]=value;return true;}});
function matches(node,selector){
  if(selector==='dialog[open]')return node.tagName==='dialog'&&node.open;
  if(selector.includes(','))return selector.split(',').some(s=>matches(node,s));
  const attribute=selector.match(/^\[([^\]]+)\]$/);
  return attribute?node.attrs.has(attribute[1]):node.tagName===selector;
}
class Element {
  constructor(tagName,attrs={},parent=null){
    this.tagName=tagName;this.attrs=new Map(Object.entries(attrs));this.parent=parent;this.children=[];this.dataset={};this.style={};this.listeners=new Map();this.textContent='';this._html='';this.open=false;
    this.hidden=this.attrs.has('hidden');this.disabled=this.attrs.has('disabled');this.value=attrs.value||'';
    this.classList={toggle(){},add(){},remove(){}};
    for(const [key,value]of Object.entries(attrs))if(key.startsWith('data-'))this.dataset[key.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=value;
    if(attrs.id){assert.ok(!byId.has(attrs.id),'duplicate id '+attrs.id);this.id=attrs.id;byId.set(this.id,this);}
    if(parent)parent.children.push(this);nodes.add(this);
  }
  set innerHTML(value){const remove=node=>{for(const child of node.children)remove(child);nodes.delete(node);if(node.id)byId.delete(node.id);};for(const child of this.children)remove(child);this.children=[];this._html=value;parse(value,this);}
  get innerHTML(){return this._html;}
  setAttribute(key,value){this.attrs.set(key,String(value));}
  getAttribute(key){return this.attrs.get(key)??null;}
  addEventListener(name,handler){this.listeners.set(name,handler);}
  getContext(){return context2d;}
  getBoundingClientRect(){return {width:1280,height:800,left:0,top:0,right:1280,bottom:800};}
  setPointerCapture(){}
  showModal(){this.open=true;}
  close(){this.open=false;}
  closest(selector){return matches(this,selector)?this:this.parent?.closest(selector)||null;}
  matches(selector){return matches(this,selector);}
  contains(node){return node===this||this.children.some(child=>child.contains(node));}
  appendChild(node){this.children.push(node);node.parent=this;}
}
function parse(source,parent=null){
  const stack=parent?[parent]:[];
  for(const tag of source.matchAll(/<\/?([A-Za-z][\w-]*)\b([^>]*)>/g)){
    const closing=tag[0].startsWith('</'),name=tag[1].toLowerCase();
    if(closing){while(stack.length&&stack.at(-1).tagName!==name)stack.pop();if(stack.at(-1)?.tagName===name)stack.pop();continue;}
    const attrs={};for(const attribute of tag[2].matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s/>]+)))?/g))attrs[attribute[1]]=attribute[2]??attribute[3]??attribute[4]??'';
    const node=new Element(name,attrs,stack.at(-1));
    if(!['meta','link','input','img','br','hr'].includes(name)&&!tag[0].endsWith('/>'))stack.push(node);
  }
}
parse(html);
const document={hidden:false,getElementById:id=>byId.get(id)||null,createElement:tag=>new Element(tag),querySelectorAll:selector=>[...nodes].filter(node=>matches(node,selector)),querySelector:selector=>[...nodes].find(node=>matches(node,selector))||null,addEventListener(){}};
const app=createApp({store:new MemoryStore(),env:{LOCAL_DEV:true,APP_ORIGIN:'http://127.0.0.1:4173',GOOGLE_AUTH_ENABLED:'false'}});
const cookies=new Map(),storage=new Map(),requests=[];
let offline=false;
async function fetchApi(path,options={}){
  if(offline)throw new Error('offline');
  requests.push(path);const headers=new Headers(options.headers||{});
  headers.set('cookie',[...cookies].map(([key,value])=>key+'='+value).join('; '));
  if(options.method==='POST')headers.set('origin','http://127.0.0.1:4173');
  const response=await app.fetch(new Request('http://127.0.0.1:4173'+path,{...options,headers}));
  for(const cookie of response.headers.getSetCookie()){const pair=cookie.split(';')[0],split=pair.indexOf('='),key=pair.slice(0,split),value=pair.slice(split+1);if(value)cookies.set(key,value);else cookies.delete(key);}
  return response;
}
const source=await readFile(resolve(root,'src/client/main.js'),'utf8');
const augmented=source.replace(/\ninit\(\);\s*$/,'')+'\nglobalThis.clientCheck={ready:init(),refreshState,draw,openPanel,state:()=>({account,model,placing,selecting,activePanel})};';
const compiled=await build({stdin:{contents:augmented,resolveDir:resolve(root,'src/client'),sourcefile:'client-check.js'},bundle:true,write:false,format:'iife',platform:'browser',target:'es2022',logLevel:'silent'});
const globals={document,fetch:fetchApi,Image:class {complete=false;naturalWidth=0;},ResizeObserver:class {observe(){}},devicePixelRatio:1,requestAnimationFrame(){},setInterval(){},setTimeout(){return 1;},clearTimeout(){},console,URLSearchParams,TextEncoder,TextDecoder,crypto:webcrypto,atob,btoa,performance,navigator:{userAgent:'client-check',language:'ru'},screen:{width:1280,height:800,colorDepth:24},localStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value)},location:{hash:'',pathname:'/',search:'',assign(){},reload(){}},history:{replaceState(){}},addEventListener(){}};
const sandbox=vm.createContext(globals);sandbox.window=sandbox;
vm.runInContext(compiled.outputFiles[0].text,sandbox,{timeout:5000});
const client=sandbox.clientCheck,$=id=>{const node=byId.get(id);assert.ok(node,'missing element '+id);return node;};
await client.ready;
assert.equal($('mapLoading').hidden,true);assert.equal($('resourceBar').hidden,true);assert.equal($('authCard').hidden,false);assert.equal($('sectorNav').disabled,true);
assert.equal($('googleLogin').disabled,true);assert.match($('googleLogin').innerHTML,/скоро/);
client.draw(performance.now());
await $('devLogin').onclick();assert.ok(client.state().account);assert.equal($('spawnCard').hidden,false);
client.openPanel('ranking');assert.equal($('spawnCard').hidden,true);await client.refreshState(true);assert.equal($('spawnCard').hidden,true,'polling must not reopen onboarding over another panel');
client.openPanel('base');assert.equal($('spawnCard').hidden,false);
const swarm=document.querySelectorAll('[data-faction]').find(node=>node.dataset.faction==='swarm');$('factionPicker').onclick({target:swarm});
$('startBtn').onclick();assert.equal(client.state().placing,true);assert.equal($('placementHint').hidden,false);
await $('worldCanvas').listeners.get('pointerup')({clientX:640,clientY:400});
assert.equal(client.state().model.player.faction,'swarm');assert.equal(client.state().model.player.level,1);assert.equal($('resourceBar').hidden,false);assert.equal($('authCard').hidden,true);assert.equal($('spawnCard').hidden,true);
client.draw(performance.now());
const nav=name=>document.querySelectorAll('[data-open]').find(node=>node.dataset.open===name);
for(const name of ['base','sector','rewards','ranking']){nav(name).onclick();assert.equal(client.state().activePanel,name);assert.equal(document.querySelectorAll('[data-panel]').filter(node=>!node.hidden).length,1);assert.equal(nav(name).getAttribute('aria-expanded'),'true');}
nav('ranking').onclick();assert.equal(client.state().activePanel,null);assert.equal(document.querySelectorAll('[data-panel]').filter(node=>!node.hidden).length,0);
nav('sector').onclick();client.draw(performance.now());$('selectCellsBtn').onclick();assert.equal($('selectionBar').hidden,false);assert.equal(client.state().activePanel,null);$('cancelSelection').onclick();assert.equal($('selectionBar').hidden,true);
nav('base').onclick();await $('fundBtn').onclick();assert.equal(client.state().model.player.project.status,'building');assert.equal($('fundingControls').hidden,true);assert.equal($('skipBtn').hidden,false);assert.equal($('buildDot').hidden,false);
nav('rewards').onclick();assert.equal($('dailyBtn').disabled,true);assert.match($('dailyInfo').textContent,/через/);
offline=true;await client.refreshState(true);assert.equal($('connectionNotice').hidden,false);offline=false;await client.refreshState(true);assert.equal($('connectionNotice').hidden,true);
await $('shopBtn').onclick();assert.equal($('shopDialog').open,true);assert.doesNotMatch($('shopNotice').textContent,/Stripe|сервер|настро/);$('shopDialog').close();
$('profileButton').onclick();assert.equal($('accountPanel').hidden,false);assert.equal(document.querySelectorAll('[data-panel]').filter(node=>!node.hidden).length,0);
await $('logoutBtn').onclick();assert.equal(client.state().account,null);assert.equal($('resourceBar').hidden,true);assert.equal($('authCard').hidden,false);assert.equal($('accountPanel').hidden,true);
console.log(`Client flow OK: real API login, faction choice, placement, resource HUD, four exclusive panels, selection, upgrade, rewards, connection recovery, shop and logout (${requests.length} API requests).`);
