import { cellToLatLng, cellToBoundary, latLngToCell, gridDisk, getHexagonEdgeLengthAvg } from "h3-js";
import { CONFIG, FACTIONS, getFaction } from "../shared/config.js";
import { decodeTile, cellIsLand } from "../shared/geography.js";
import worldMask from "../../data/world-mask.json" with {type:"json"};
import { skipCost } from "../shared/economy.js";
import { ABILITIES, factionAbilityName } from "../shared/abilities.js";
import { troopForAbility, troopFor, TROOP_CLASSES, TROOP_ANIMATIONS } from '../shared/troops.js';
import { createBattlefieldState } from './battlefield-state.js';
import { createLandscapeRenderer } from './landscape-renderer.js';
import { landscape } from '../shared/landscape.js';
import { DETAIL_ZOOM, MAP_LIMITS, mapDetail } from '../shared/map-view.js';
import { mapRequest } from './map-requests.js';
import { drawMapOverview, hitMapOverview } from './map-overview.js';
import { createWorldCamera, panWorld, anchorWorld, wrapLongitude } from './world-camera.js';
import { drawWorldGrid } from './world-grid.js';
import { BIOMES, CLIMATES } from '../shared/biomes.js';
import { worldLandAt } from '../shared/world-land.js';
import { footprintBounds, headquartersLayout, layoutTroops, spriteBounds } from './actor-layout.js';
import { headquartersFor } from "../shared/headquarters.js";
import { readTelegramInitData, removeTelegramInitData, telegramLink } from "./telegram.js";
import { getLang, setLang, t, LANGUAGES } from "./i18n.js";
import { ACHIEVEMENTS, playAchievementFanfare } from "./achievements.js";
import { initTutorial } from "./tutorial.js";
import { CLAN_HALL_CENTER_COORDS, isClanHallCell } from "../shared/clan-hall.js";
import { drawClanHallHexes, hitClanHall } from "./clan-hall-renderer.js";
import { createSurfaces } from './surfaces.js';
import { createTelegramShell } from './telegram-shell.js';
import { createMapPreview } from './map-preview.js';
import { profileStats, profileTooltip, promotionLink } from './player-profile.js';
import { drawConquestSites, drawDamageIndicators } from './conquest-view.js';
const $ = (id) => document.getElementById(id), canvas = $("worldCanvas"), displayCtx = canvas.getContext("2d", { alpha: false });
let ctx = displayCtx;
const mapLayer = document.createElement("canvas"), mapCtx = mapLayer.getContext("2d", { alpha: false });
const nf = new Intl.NumberFormat("ru-RU"), fmt = (n) => nf.format(Math.floor(Number(n) || 0)), escape = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
let account = null, csrfToken = "", providers = {}, model = null, leaderboard = [], selectedFaction = "protocol", placing = false, selecting = false, selectedCells = /* @__PURE__ */ new Set();
let cw = 0, ch = 0, dpr = 1, zoom = 1, cameraLat = CONFIG.REGION.center.lat, cameraLng = CONFIG.REGION.center.lng, mapMode = 'auto', drag = null, moved = false, mouse = null, serverOffset = 0, tilesBusy = false, pollBusy = false, connectionErrors = 0;
let lastRender = 0, lastDetails = 0, dirty = true, toastTimer, sound = false, audio, autoCentered = false, stopped = false, authGeneration = 0, deviceFingerprintSeed = "", activePanel = null, welcomeDismissed = false;
const profiles = /* @__PURE__ */ new Map(), tileCache = /* @__PURE__ */ new Map(), cellCache = /* @__PURE__ */ new Map(), boundaryCache = /* @__PURE__ */ new Map(), effects = [], events = [], seenEvents = /* @__PURE__ */ new Set(), emblems = /* @__PURE__ */ new Map();
const headquartersImages = /* @__PURE__ */ new Map(), abilityBursts = [], pointers = /* @__PURE__ */ new Map();
let abilityBusy = null, pendingAbilityReset = null, pinch = null, gestureMoved = false;
let headquarters3D = null, headquarters3DPromise = null, modelsUnavailable = false, inspectedFaction = "protocol", inlineModelFaction = null;
const telegramLaunchData = readTelegramInitData(location, window.Telegram?.WebApp);
let armyTargeting = false;
let captureFeedback = { at: 0, gained: 0 };
let viewRevision=0,mapRequestController=null,mapKind='tiles',lastMapRequest=null,mapOverview=null,troopsMapSuspended=false;
const overviewCache=new Map();
function cameraChanged(){$('mapTooltip').hidden=true;viewRevision++;mapRequestController?.abort();mapKind=mapDetail(zoom).detailed?'tiles':'overview';lastMapRequest=null;}
function detailedMap(){return zoom>=DETAIL_ZOOM&&mapKind==='tiles';}
const landscapeView = createLandscapeRenderer({ onReady: invalidate });
let sessionToken = '', loginToken = '', authBusy = false, launchExpired = false, lastLeaderboard = 0;
let frameHandle = null, tileTimer, pollTimer, neutralKey = '', drawingGeometry = null, ownership = new Map(), ownershipDirty = true;
let mapDirty=true,mapPaints=0,mapPaused=false,telegramActive=true,castleDraw=null,castleLoading=false;
const mapPreview=createMapPreview();
let cameraCache=null,cameraCacheInput=null;
const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches || false;
function paint() { dirty = true; requestFrame(); }
function invalidate() { mapDirty=true;paint(); }
function requestFrame() { if (frameHandle === null && !document.hidden&&telegramActive) frameHandle = requestAnimationFrame(frame); }
function scheduleTiles() { clearTimeout(tileTimer); tileTimer = setTimeout(refreshTiles, 160); }
function setText(id, value) { const node = $(id), text = String(value); if (node && node.textContent !== text) node.textContent = text; }
try { sessionToken = sessionStorage.getItem('pd-session') || ''; } catch {}
function saveSession(token = '') {
  sessionToken = token;
  try { token ? sessionStorage.setItem('pd-session', token) : sessionStorage.removeItem('pd-session'); } catch {}
}
const terrain = document.createElement("canvas");
terrain.width = 360;
terrain.height = 180;
const tctx = terrain.getContext("2d");
const terrainPixels=tctx.createImageData(360,180);
for(let i=0;i<worldMask.land.length;i++)if(worldLandAt(89.5-Math.floor(i/360),i%360-179.5,worldMask.land)){const at=i*4;terrainPixels.data[at]=23;terrainPixels.data[at+1]=43;terrainPixels.data[at+2]=55;terrainPixels.data[at+3]=255;}
tctx.putImageData(terrainPixels,0,0);

for (const f of FACTIONS) {
  const image = new Image();
  image.src = f.logo;
  image.onload = invalidate;
  emblems.set(f.id, image);
}
const battlefield = createBattlefieldState({ maxUnits: Math.min(window.innerWidth || 1280, screen.width) < 760 ? 24 : 36 });
const tileConflicts = new Map();
let troops3D = null, troopsPromise = null, troopsUnavailable = false, troopsEnabled = true, inspectingTroop = null, troopGeneration = 0;
let troopSprites=null,troopSpritesPromise=null,fallbackVisible=false;
let unitControls=null,unitControlsPromise=null;
async function ensureUnitControls(){
 if(!unitControlsPromise)unitControlsPromise=import('./unit-controls.js').then(({createUnitControls})=>{
  unitControls=createUnitControls({$,getPlayer:()=>model?.player,getUnits:()=>battlefield.units(serverNow()),getView:unitCommandView,
   send:input=>action(input.unitIds?'/api/army/unit-orders':'/api/army/unit-order',input,input.unitIds?`Приказ группе принят: ${input.unitIds.length}.`:'Приказ отряду принят.'),notify:toast,invalidate:paint,onChange:()=>surfaces.sync(),
   ownerAt:cell=>ownerCells().get(cell),onSelect:id=>battlefield.select(id),
   focus:cell=>focusAt(...cellToLatLng(cell),Math.max(2048,zoom)),
   onOpen(){armyTargeting=false;selecting=false;selectedCells.clear();surfaces.closeAll('unitPanel');updateUI();}});
  unitControls.update();paint();return unitControls;
 }).catch(()=>{unitControlsPromise=null;toast('Не удалось загрузить управление отрядами. Повторите.',true);return null;});
 return unitControlsPromise;
}
function unitCommandView(){const center=atPoint(cw/2,ch/2);return{...troopView(battlefield.units(serverNow())),now:serverNow(),detailed:detailedMap(),revision:viewRevision,centerCell:latLngToCell(center.lat,center.lng,8),targetData:{player:model?.player,owners:ownerCells(),profiles,tiles:tileCache,now:serverNow()},shapeCell:cell=>project.shape(border(cell)),cellLabel:cell=>{const[lat,lng]=cellToLatLng(cell);return `${lat.toFixed(3)}°, ${lng.toFixed(3)}°`;}};}
try { troopsEnabled = localStorage.getItem('pd-troops') !== 'off'; } catch {}
const animationLabels = { idle: 'Ожидание', walk: 'Шаг', run: 'Бег', attack: 'Атака', capture: 'Захват', death: 'Поражение' };
function syncBattlefield() {
  const now = serverNow();
  for (const [id, conflict] of tileConflicts) if ((conflict.lastResolvedAt || 0) < now - 15000) tileConflicts.delete(id);
  battlefield.sync({ player: model?.player, players: [...leaderboard, ...profiles.values()], conflicts: [...tileConflicts.values(), ...(model?.conflicts || [])] }, now);
  unitControls?.update();
}
async function ensureTroops3D() {
  if (troopsUnavailable) return null;
  if(typeof window.WebGL2RenderingContext === 'undefined'){troopsUnavailable=true;return null;}
  if (!troopsPromise) troopsPromise = import('./troops-3d.js').then(module => {
    troops3D = module.createTroops3D({ canvas: $('troopsCanvas'), reducedMotion, maxUnits: (window.innerWidth || 1280) < 760 ? 24 : 36, onReady: paint,
      onUnavailable(id) { if (!id||!$('troopsDialog').open) { troopsUnavailable = true;troops3D?.suspendMap(); }paint(); } });
    return troops3D;
  }).catch(() => { troopsUnavailable = true; return null; });
  return troopsPromise;
}
function troopView(units){return{width:cw,height:ch,zoom,units,footprintCell:cellFootprint,projectCell(cell){try{return project(...cellToLatLng(cell));}catch{return null;}}};}
function drawTroopFallback(units,now) {
  const target=$('troopsCanvas');target.hidden=!units.length;fallbackVisible=units.length>0;
  if(troopsUnavailable&&!troopSpritesPromise)troopSpritesPromise=import('./troops-sprites.js').then(module=>{troopSprites=module.createTroopSprites({onReady:paint,reducedMotion});paint();return troopSprites;}).catch(()=>null);
  if(troopSprites){troopSprites.render(now,{...troopView(units),canvas:target,serverNow:serverNow()});return;}
  const c=target.getContext('2d');target.width=Math.round(cw);target.height=Math.round(ch);c.clearRect(0,0,cw,ch);
  for(const{unit:u,x,y,span,elevation}of layoutTroops(units,troopView(units))){let img=troopPosters.get(u.id);if(!img){img=new Image();img.src=u.poster;img.onload=invalidate;troopPosters.set(u.id,img);}if(img.complete&&img.naturalWidth)c.drawImage(img,x-span*.7,y-span*1.18-elevation*.8,span*1.4,span*1.4);}
}
const troopPosters=new Map();
function troopsNeedFrame() {
 if($('troopsDialog').open)return !!troops3D&&!troopsUnavailable&&troops3D.needsFrame();
 if(mapPaused||!telegramActive)return false;
 return troopsEnabled&&detailedMap()&&(!troopsUnavailable&&troops3D?troops3D.needsFrame():troopSprites?troopSprites.needsFrame():fallbackVisible&&!reducedMotion);
}
function drawTroops(now) {
  const inspecting = $('troopsDialog').open;
  if(mapPaused&&!inspecting)return;
  if (!inspecting && (!troopsEnabled || !detailedMap())) { fallbackVisible=false;troopSprites?.suspend();$('troopsCanvas').hidden = true;if(!troopsMapSuspended){troops3D?.suspendMap();troopsMapSuspended=true;}return; }
  troopsMapSuspended=false;
  const units = battlefield.units(serverNow(),cell=>{try{const p=project(...cellToLatLng(cell)),margin=Math.max(160,geometry().size*.018);return p.x>=-margin&&p.x<=cw+margin&&p.y>=-margin*2&&p.y<=ch+margin;}catch{return false;}}).slice(0,mapDetail(zoom).unitLimit);
  if (!troops3D || troopsUnavailable) { if (!troopsUnavailable && (units.length || inspecting)) ensureTroops3D().then(engine => { if (engine) paint(); }); if(!inspecting)drawTroopFallback(units,now); return; }
  fallbackVisible=false;troopSprites?.suspend();
  $('troopsCanvas').hidden = inspecting ? $('troopsCanvas').hidden : !units.length;
  try{troops3D.render(now,troopView(units));}catch{troopsUnavailable=true;troops3D.dispose();troops3D=null;if(!inspecting)drawTroopFallback(units,now);}
}
async function inspectTroop(faction, type = 'infantry') {
  const spec = troopFor(faction, type), generation = ++troopGeneration;
  inspectingTroop = spec;
  setText('troopTitle', spec.name); setText('troopDescription', spec.label + ' · ' + spec.description);
  $('troopPoster').src = spec.poster; $('troopPoster').alt = spec.name; $('troopPoster').hidden = false;
  $('troopModelCanvas').hidden = true; $('troopAnimations').hidden = true; $('troopRotateControls').hidden = true;
  setText('troopStatus', 'Готовим модель и анимации…');
  $('troopRolePicker').innerHTML = TROOP_CLASSES.map(role => { const unit = troopFor(spec.faction, role.id); return `<button data-troop-role="${role.id}" aria-pressed="${role.id === spec.type}" class="${role.id === spec.type ? 'selected' : ''}"><img src="${unit.poster}" alt="" width="70" height="62"><b>${role.label}</b></button>`; }).join('');
  $('troopFactionPicker').innerHTML = FACTIONS.map(side => `<button data-troop-faction="${side.id}" style="--faction:${side.color}" aria-pressed="${side.id === spec.faction}" class="${side.id === spec.faction ? 'selected' : ''}"><img src="${side.logo}" alt=""><b>${side.name}</b></button>`).join('');
  $('troopAnimations').innerHTML = TROOP_ANIMATIONS.map(name => `<button data-troop-animation="${name}" aria-pressed="${name === 'walk'}" class="${name === 'walk' ? 'selected' : ''}">${animationLabels[name]}</button>`).join('');
  if (!$('troopsDialog').open) showDialog('troopsDialog');
  const fallback = () => { if (generation !== troopGeneration) return; $('troopPoster').hidden = false; $('troopModelCanvas').hidden = true; $('troopAnimations').hidden = true; $('troopRotateControls').hidden = true; setText('troopStatus', 'Сейчас доступно изображение отряда.'); };
  const engine = await ensureTroops3D();
  if (generation !== troopGeneration || !$('troopsDialog').open) return;
  if (!engine) { fallback(); return; }
  engine.inspect($('troopModelCanvas'), spec.faction, spec.type, { ready() { if (generation !== troopGeneration) return; $('troopPoster').hidden = true; $('troopModelCanvas').hidden = false; $('troopAnimations').hidden = false; $('troopRotateControls').hidden = false; setText('troopStatus', 'Выберите анимацию. Потяните модель в сторону для вращения.'); }, fallback });
  invalidate();
}

function readySprite(sprite) {
  return !!sprite && !!(sprite.hq3dReady || sprite.complete && sprite.naturalWidth);
}
function headquartersSpriteBounds(sprite) {
  return spriteBounds(sprite);
}
function cellFootprint(cell){return footprintBounds(project.shape(border(cell)));}
function headquartersMapLayout(cell, center, sprite) {
  return headquartersLayout(center,cellFootprint(cell),headquartersSpriteBounds(sprite));
}
function drawHeadquarters(cell, center, sprite, layout, color) {
  const { crop, width, height, groundHeight, left, top } = layout;
  ctx.save();
  if (zoom >= 256) {
    cellPath(cell);
    ctx.fillStyle = color + "24"; ctx.fill();
    ctx.strokeStyle = color + "bb"; ctx.lineWidth = 1.5; ctx.stroke();
  }
  ctx.fillStyle = "#02080c99";
  ctx.beginPath();
  ctx.ellipse(center.x, center.y + groundHeight * .13, width * .46, groundHeight * .22, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(sprite, crop.x, crop.y, crop.width, crop.height, left, top, width, height);
  ctx.restore();
}
function headquartersDisplaySprite(faction) {
  return headquarters3D?.getCachedStamp(faction) || headquartersSprite(faction);
}
async function ensureHeadquarters3D() {
  if (modelsUnavailable || typeof window.WebGL2RenderingContext === "undefined") return null;
  if (!headquarters3DPromise) headquarters3DPromise = import("./headquarters-3d.js").then(module => {
    headquarters3D = module.createHeadquarters3D({
      onReady: invalidate,
      onUnavailable(id) {
        if (!id) modelsUnavailable = true;
        if (!id || id === selectedFaction) { $("spawnModelCanvas").hidden = true; $("headquartersPreview").hidden = false; }
        invalidate();
      },
    });
    return headquarters3D;
  }).catch(() => { modelsUnavailable = true; return null; });
  return headquarters3DPromise;
}
function syncHeadquartersPreview() {
  if (!account || modelsUnavailable || $("spawnCard").hidden || inlineModelFaction === selectedFaction) return;
  const faction = selectedFaction;
  inlineModelFaction = faction;
  $("spawnModelCanvas").hidden = true;
  $("headquartersPreview").hidden = false;
  ensureHeadquarters3D().then(engine => {
    if (!engine || selectedFaction !== faction || $("spawnCard").hidden) return;
    engine.show($("spawnModelCanvas"), faction, {
      ready() { if (selectedFaction !== faction) return; $("spawnModelCanvas").hidden = false; $("headquartersPreview").hidden = true; },
      fallback() { if (selectedFaction !== faction) return; $("spawnModelCanvas").hidden = true; $("headquartersPreview").hidden = false; },
    });
  });
}
async function inspectHeadquarters(faction) {
  const hq = headquartersFor(faction);
  inspectedFaction = hq.id;
  setText("modelTitle", hq.name);
  $("modelPoster").src = hq.poster;
  $("modelPoster").alt = hq.name;
  $("modelPoster").hidden = false;
  $("modelCanvas").hidden = true;
  $("modelControls").hidden = true;
  $("modelHelp").hidden = false;
  setText("modelStatus", "Загружаем модель…");
  $("modelFactionPicker").innerHTML = FACTIONS.map(f => `<button data-model-faction="${f.id}" style="--faction:${f.color}" aria-pressed="${f.id === hq.id}" class="${f.id === hq.id ? "selected" : ""}" aria-label="Осмотреть ${escape(headquartersFor(f.id).name)}"><img src="${f.logo}" alt=""><b>${f.name}</b></button>`).join("");
  if (!$("headquartersDialog").open) showDialog("headquartersDialog");
  const fallback = () => {
    if (inspectedFaction !== hq.id) return;
    $("modelPoster").hidden = false; $("modelCanvas").hidden = true; $("modelControls").hidden = true;
    $("modelHelp").hidden = true;
    setText("modelStatus", "Сейчас доступно изображение штаба. Попробуйте 3D-осмотр позже или на другом устройстве.");
  };
  const engine = await ensureHeadquarters3D();
  if (inspectedFaction !== hq.id) return;
  if (!engine) { fallback(); return; }
  engine.show($("modelCanvas"), hq.id, {
    ready() {
      if (inspectedFaction !== hq.id) return;
      $("modelPoster").hidden = true; $("modelCanvas").hidden = false; $("modelControls").hidden = false;
      setText("modelStatus", "Модель готова к осмотру");
    },
    fallback,
  });
}
function headquartersSprite(faction) {
  if(!headquartersImages.has(faction)){const image=new Image();image.src=headquartersFor(faction).sprite+'?v=hex-v2';image.onload=invalidate;headquartersImages.set(faction,image);}
  return headquartersImages.get(faction);
}
function mapColor(faction) {
  return getFaction(faction)?.color || "#7796ad";
}
function playerColor(playerOrId, fallbackFaction) {
  const p = typeof playerOrId === "object" ? playerOrId : playerById(playerOrId);
  if (p?.color && /^#[0-9a-fA-F]{6}$/i.test(p.color)) {
    return p.color;
  }
  return mapColor(p?.faction || fallbackFaction);
}
function closeAccount() {
  $("accountPanel").hidden = true;
  $("profileButton").setAttribute("aria-expanded", "false");
  surfaces.sync();
}
const surfaces=createSurfaces({document,closeUnits:()=>unitControls?.reset(),closeTutorial:()=>{if(tutorialController?.isActive())tutorialController.stop();},onChange(){
 activePanel=[...document.querySelectorAll('[data-panel]')].find(p=>!p.hidden)?.dataset.panel||null;
 mapPaused=surfaces.covered();$('gameRoot').classList.toggle('surface-open',mapPaused);
 if(mapPaused)cancelMapGesture();
 $('profileButton').setAttribute('aria-expanded',String(!$('accountPanel').hidden));
 document.querySelectorAll('[data-open]').forEach(b=>b.setAttribute('aria-expanded',String(b.dataset.open===activePanel)));
 $('armySquads').setAttribute('aria-expanded',String(!!unitControls?.isOpen()));
 telegramShell.backVisible(mapPaused||!!unitControls?.isOpen());paint();
}});
function showDialog(id){surfaces.showDialog(id);}
function closePanels() {
  surfaces.closeAll();
}
function openPanel(name) {
  const wasOpen = activePanel === name;
  closePanels();
  closeAccount();
  if (wasOpen) return;
  if (account && !model?.player) {
    $("spawnCard").hidden = placing;
    return;
  }
  if (placing) {
    placing = false;
    $("placementHint").hidden = true;
    canvas.classList.remove("placement");
  }
  if (selecting) {
    selecting = false;
    selectedCells.clear();
    updateUI();
  }
  welcomeDismissed = true;
  $("authCard").hidden = true;
  $("spawnCard").hidden = true;
  if (name === "base" && !model?.player) {
    welcomeDismissed = false;
    $(account ? "spawnCard" : "authCard").hidden = false;
    return;
  }
  if ((name === "sector" || name === "rewards") && !model?.player) return;
  activePanel = name;
  document.querySelectorAll("[data-panel]").forEach((p) => p.hidden = p.dataset.panel !== name);
  document.querySelectorAll("[data-open]").forEach((b) => b.setAttribute("aria-expanded", String(b.dataset.open === name)));
  surfaces.sync();paint();
}
function toast(message, error = false) {
  clearTimeout(toastTimer);
  setText("toast", message);
  $("toast").classList.toggle("error", error);
  $("toast").hidden = false;
  toastTimer = setTimeout(() => $("toast").hidden = true, 4300);
}
function beep(note = 520) {
  if (!sound) return;
  try {
    audio ||= new AudioContext();
    const o = audio.createOscillator(), g = audio.createGain();
    o.type = "sine";
    o.frequency.value = note;
    g.gain.setValueAtTime(0.025, audio.currentTime);
    g.gain.exponentialRampToValueAtTime(1e-3, audio.currentTime + 0.12);
    o.connect(g);
    g.connect(audio.destination);
    o.start();
    o.stop(audio.currentTime + 0.13);
  } catch {
  }
}
function serverNow() {
  return Date.now() + serverOffset;
}
function duration(ms) {
  if (ms <= 0) return "Готово";
  const minutes = Math.ceil(ms / 6e4);
  if (minutes >= 1440) {
    const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60);
    return `${days} дн.${hours ? ` ${hours} ч` : ""}`;
  }
  if (minutes >= 60) return `${Math.floor(minutes / 60)} ч${minutes % 60 ? ` ${minutes % 60} мин` : ""}`;
  return `${minutes} мин`;
}
function appendEvent(text, key = text) {
  if (seenEvents.has(key)) return;
  seenEvents.add(key);
  if (seenEvents.size > 256) seenEvents.delete(seenEvents.values().next().value);
  events.unshift({ text, at: serverNow() });
  events.length = Math.min(events.length, 30);
  $("eventLog").innerHTML = events.slice(0, 5).map((e) => `<div class="event-row"><time>${new Date(e.at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}</time><span>${escape(e.text)}</span></div>`).join("");
}
async function api(path, body, options = {}) {
  const headers = { ...(!options.public && sessionToken ? { Authorization: 'Bearer ' + sessionToken } : {}) };
  if (body !== undefined) {
    Object.assign(headers, { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken });
    if (loginToken && path.startsWith('/api/auth/')) headers['X-Login-Token'] = loginToken;
  }
  const controller = new AbortController();
  const forwardAbort=()=>controller.abort();
  if(options.signal?.aborted)controller.abort();else options.signal?.addEventListener('abort',forwardAbort,{once:true});
  const timeout = setTimeout(() => controller.abort(), 15000);
  let response,result;
  try {
    response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', credentials: options.public?'omit':'same-origin', cache: options.cache || 'no-store', signal: controller.signal, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    try{result=await response.json();}catch(error){if(controller.signal.aborted)throw error;throw new Error('Не удалось выполнить действие. Попробуйте ещё раз.');}
  }finally{clearTimeout(timeout);options.signal?.removeEventListener('abort',forwardAbort);}
  if (!response.ok) {
    const error = Object.assign(new Error(result.error || "Действие отклонено."), { status: response.status });
    throw error;
  }
  if (result.sessionToken) { saveSession(result.sessionToken); loginToken = ''; }
  return result;
}
async function action(path, body, message) {
  const generation = authGeneration, id = account?.id;
  try {
    const result = await api(path, body);
    if (generation !== authGeneration || account?.id !== id) return null;
    if (result.player !== void 0) acceptModel(result);
    if (message) toast(message);
    beep();
    if (result.player !== undefined) await refreshTiles(true);
    return result;
  } catch (e) {
    if (generation !== authGeneration) return null;
    toast(e.message, true);
    if (e.status === 401) {
      signedOut();
      await refreshAuth();
    }
    return null;
  }
}
async function fingerprint() {
  if (!deviceFingerprintSeed) {
    try {
      deviceFingerprintSeed = localStorage.getItem("pixel-dominion-device-v2") || crypto.randomUUID();
      localStorage.setItem("pixel-dominion-device-v2", deviceFingerprintSeed);
    } catch {
      deviceFingerprintSeed = crypto.randomUUID();
    }
  }
  const value = [deviceFingerprintSeed, navigator.userAgent, navigator.language, screen.width, screen.height, screen.colorDepth, Intl.DateTimeFormat().resolvedOptions().timeZone].join("|");
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function renderFactions() {
  $("factionPreview").innerHTML = FACTIONS.map((f) => `<button aria-label="${escape(f.name)}" data-preview="${f.id}"><img src="${f.logo}" alt=""></button>`).join("");
  $("factionPicker").innerHTML = FACTIONS.map((f) => `<button data-faction="${f.id}" style="--faction:${f.color}" aria-pressed="${f.id === selectedFaction}" class="${f.id === selectedFaction ? "selected" : ""}"><img src="${f.logo}" alt=""><b>${f.name}</b></button>`).join("");
  $("factionAtlas").innerHTML = FACTIONS.map((f) => `<article class="faction-sheet" style="--faction:${f.color}"><img src="${f.logo}" alt="${f.name}"><h3>${f.name}</h3><p>${escape(f.description)}</p><p class="faction-benefit">${escape(f.bonus)}</p><button class="model-inspect-button" data-model="${f.id}">Осмотреть базу <span aria-hidden="true">↗</span></button></article>`).join("");
  updateFaction();
}
function updateFaction() {
  const f = getFaction(selectedFaction), hq = headquartersFor(selectedFaction);
  $("headquartersPreview").src = hq.sprite;
  $("headquartersPreview").alt = hq.name;
  $("spawnModelCanvas").hidden = true;
  $("headquartersPreview").hidden = false;
  setText("headquartersName", hq.name);
  $("factionDescription").innerHTML = `<strong>${escape(f.name)}</strong>${escape(f.bonus)}`;
  document.querySelectorAll("[data-faction]").forEach((b) => {
    const selected = b.dataset.faction === selectedFaction;
    b.classList.toggle("selected", selected);
    b.setAttribute("aria-pressed", String(selected));
  });
  inlineModelFaction = null;
  syncHeadquartersPreview();
}
function resetWorldState() {
  unitControls?.reset();
  mapRequestController?.abort();viewRevision++;lastMapRequest=null;mapOverview=null;overviewCache.clear();
  armyTargeting=false;
  model = null;
  placing = false;
  selecting = false;
  autoCentered = false;
  inlineModelFaction = null;
  welcomeDismissed = false;
  selectedCells.clear();
  tileCache.clear();
  ownershipDirty = true;
  cellCache.clear();
  neutralKey = "";
  profiles.clear();
  effects.length = 0;
  battlefield.clear(); tileConflicts.clear(); troops3D?.clear();troopSprites?.suspend();fallbackVisible=false; inspectingTroop = null; troopGeneration++; $("troopsDialog").close();
  abilityBursts.length = 0;
  pointers.clear();
  pinch = null;
  abilityBusy = null;
  pendingAbilityReset = null;
  $("abilityDialog").close();
  events.length = 0;
  seenEvents.clear();
  captureFeedback = { at: 0, gained: 0 };
  setText('conquestNotice', '');
  unlockedAchievements.clear();
  achievementsInitialized = false;
  $("eventLog").innerHTML = '<p class="empty-state">Здесь появятся события вашей базы.</p>';
  $("placementHint").hidden = true;
  $("selectionBar").hidden = true;
  $("mapTooltip").hidden = true;
  canvas.classList.remove("placement");
  closePanels();
  closeAccount();
  pollBusy = false;
  tilesBusy = false;
  invalidate();
}
function signedOut() {
  authGeneration++;
  account = null;
  csrfToken = "";
  loginToken = '';
  saveSession();
  resetWorldState();
  $("logoutBtn").hidden = true;
  $("authCard").hidden = false;
  $("spawnCard").hidden = true;
  updateUI();
}
async function refreshAuth() {
  const generation = ++authGeneration, previousId = account?.id;
  const me = await api("/api/auth/me");
  if (generation !== authGeneration) return;
  account = me.account;
  if (!account) saveSession();
  csrfToken = me.csrfToken || "";
  loginToken = me.loginToken || '';
  if (previousId !== account?.id) resetWorldState();
  $("logoutBtn").hidden = !account;
  $("authCard").hidden = !!account;
  $("spawnCard").hidden = true;
  if (account) {
    if ($("authModal")?.open) $("authModal").close();
    await refreshState(true);
  }
  else {
    updateUI();
  }
}
async function autoMiniAppLogin() {
  const initData = telegramLaunchData || readTelegramInitData(location, window.Telegram?.WebApp);
  if (account || authBusy || !providers.telegram?.enabled || !initData) return;
  setAuthBusy(true);
  setAuthNotice('Подключаем ваш командный центр…');
  try {
    // A previous challenge may have expired while the app was suspended.
    await refreshAuth();
    if (account) return;
    await api("/api/auth/telegram/miniapp", { initData, fingerprint: await fingerprint() });
    await refreshAuth();
    if (!account) throw new Error('Не удалось сохранить вход. Попробуйте ещё раз.');
    removeTelegramInitData(location, history);
  } catch (e) {
    const message = ['TimeoutError', 'AbortError', 'TypeError'].includes(e.name) ? 'Нет связи с сервером. Нажмите «Войти», чтобы повторить.' : e.message;
    setAuthNotice(message);
    toast(message, true);
    if (e.status === 401) { launchExpired = true; $("telegramLogin").innerHTML = "Открыть игру заново ↗"; }
  } finally {
    setAuthBusy(false);
  }
}
function setAuthBusy(busy) {
  authBusy = busy;
  for (const id of ['telegramLogin', 'modalTelegramBtn', 'guestLogin']) {
    $(id).disabled = busy;
    $(id).setAttribute('aria-busy', String(busy));
  }
}
function setAuthNotice(message) {
  setText('authNotice', message);
  setText('modalAuthNotice', message);
}
async function initAuth() {
  providers = await api("/api/auth/providers");
  await refreshAuth();
  $('modalTelegramBtn').hidden = !providers.telegram?.enabled;
  $("telegramLogin").hidden = !providers.telegram?.enabled || !telegramLaunchData;
  $("devAuth").hidden = !providers.development;
  $('guestLogin').hidden = !providers.guest?.enabled;
  $('telegramBotLink').hidden = !providers.telegram?.enabled;
  $('telegramBotLink').href = telegramLink(providers.telegram?.botUsername, false) || '#';
  setAuthNotice(telegramLaunchData ? 'Входим через Telegram…' : providers.telegram?.enabled ? 'Войдите через Telegram — прогресс общий с Mini App.' : 'Вход через Telegram временно недоступен. Попробуйте позже.');
  await autoMiniAppLogin();
}
function acceptModel(next) {
  if (model && Number.isFinite(model.serverTime) && Number.isFinite(next.serverTime) && next.serverTime < model.serverTime) return;
  if (model?.player && !next.player) return;
  if (Number.isFinite(next.serverTime)) serverOffset = next.serverTime - Date.now();
  const prior = model?.player;
  for (const [id, conflict] of tileConflicts) if (conflict.players?.includes(account?.id)) tileConflicts.delete(id);
  model = next;
  syncBattlefield();
  if (next.player && prior?.level && prior.level !== next.player.level) appendEvent(`База достигла уровня ${next.player.level}.`, `level:${next.player.level}`);
  if (next.player && prior?.id === next.player.id && next.player.pixels > prior.pixels) {
    const gained = next.player.pixels - prior.pixels;
    captureFeedback = { at: serverNow(), gained };
    const message = `Захвачено +${fmt(gained)} ячеек · всего ${fmt(next.player.pixels)} · доход ${next.player.netPerHour >= 0 ? '+' : ''}${next.player.netPerHour.toFixed(1)} ⚡/ч`;
    appendEvent(message, `capture:${next.serverTime}`);
    setText('conquestNotice', message);
  }
  for (const event of next.player?.army?.events || []) if (event.kind === 'damage') {
    appendEvent(`Отряд получил −${event.damage} HP: ${event.sourceName}.`, `damage:${event.unitId}:${event.at}`);
  }
  for (const conflict of next.conflicts || []) {
    const status = conflict.status === "shielded" ? "Границу защищает щит." : conflict.status === "active" ? "На границе идёт борьба за ячейки." : "На границе установилось равновесие.";
    appendEvent(status, `conflict:${conflict.id || conflict.attackerId || ""}:${conflict.status}`);
  }
  if (next.player?.expansionBlocked) appendEvent("В направлении захвата не осталось свободной суши.", "blocked");
  $("authCard").hidden = !!account || welcomeDismissed;
  $("spawnCard").hidden = !account || !!next.player || placing;
  if (next.player && (!prior || prior.azimuth !== next.player.azimuth)) $("azimuth").value = next.player.azimuth;
  if (next.player && !autoCentered) {
    autoCentered = true;
    home();
  }
  if (next.player) {
    checkAchievements(next.player);
    $("refDot").hidden = !(next.player.reserveEnergy > 0);
  }
  updateUI();
  if(!prior||prior.baseCell!==next.player?.baseCell||prior.color!==next.player?.color||prior.azimuth!==next.player?.azimuth)invalidate();else paint();
}
async function refreshState(force = false) {
  if (!account || pollBusy || stopped || document.hidden && !force) return;
  const generation = authGeneration, id = account.id;
  pollBusy = true;
  try {
    const next = await api("/api/state");
    if (generation !== authGeneration || account?.id !== id) return;
    acceptModel(next);
    connectionErrors = 0;
    $("connectionNotice").hidden = true;
    if (!leaderboard.length || activePanel==='ranking' && Date.now()-lastLeaderboard>30000) await refreshLeaderboard().catch(()=>{});
    if (generation === authGeneration && account?.id === id) await refreshTiles();
  } catch (e) {
    if (generation !== authGeneration) return;
    connectionErrors++;
    $("connectionNotice").hidden = false;
    if (e.status === 401) {
      signedOut();
      await refreshAuth();
    }
  } finally {
    if (generation === authGeneration) pollBusy = false;
  }
}
async function refreshLeaderboard() {
  const result = await api("/api/leaderboard");
  lastLeaderboard = Date.now();
  leaderboard = result.players || [];
  $("rankings").innerHTML = leaderboard.slice(0, 10).map((p, i) => {
    const f = getFaction(p.faction);
    return `<div class="ranking ${p.id === account?.id ? "you" : ""}"><span class="ranking-position">${i + 1}</span><span class="ranking-symbol"><img src="${f.logo}" alt="${f.name}"></span><div class="ranking-name"><button class="ranking-profile" data-player-profile="${escape(p.id)}" aria-label="Статистика ${escape(p.name)}">${escape(p.name)}</button><small>${p.id === account?.id ? "Вы · " : ""}${p.level} уровень · ${fmt(p.battlesFought)} схваток</small>${promotionLink(p)}</div><span class="ranking-score">${fmt(p.pixels)}<small>ячеек</small></span></div>`;
  }).join("") || '<p class="empty-state">Станьте первым командиром.</p>';
  invalidate();
}
function showPlayerProfile(player) {
  if (!player) return;
  setText('publicPlayerName', player.name);
  setText('publicPlayerFaction', getFaction(player.faction).name);
  $('publicPlayerBody').innerHTML = profileStats(player) + promotionLink(player);
  showDialog('publicPlayerDialog');
}
$('rankings').onclick = event => {
  const button = event.target.closest('[data-player-profile]');
  if (button) showPlayerProfile(playerById(button.dataset.playerProfile));
};
function updateUI() {
  const p = model?.player, now = serverNow(), f = getFaction(p?.faction || selectedFaction);
  $("resourceBar").hidden = !p;
  $("gameNav").hidden = !p;
  $("abilityBar").hidden = !p;
  $("gameRoot").classList.toggle("has-base", !!p);
  updateAbilities();
  setText("profileName", account?.name?.split(" ")[0] || "Войти");
  setText("accountName", account?.name || "Командир");
  setText("commanderName", p?.name || account?.name || "Командир");
  setText("factionName", f.name.toLocaleLowerCase("ru-RU"));
  $("factionAvatar").src = f.logo;
  $("factionAvatar").alt = f.name;
  $("gameRoot").style.setProperty("--faction", f.color);
  setText("missionTitle", p ? `Штаб: уровень ${p.level}` : account ? "Время выбрать сторону" : "Ваша история начнётся здесь");
  setText("missionCopy", p ? `${fmt(p.pixels)} ячеек под вашим командованием. ${p.expansionBlocked ? "Смените направление, чтобы продолжить экспансию." : "Усильте базу, чтобы расширить пределы своей территории."}` : account ? "Изучите бонусы фракций. Затем выберите свободную сушу и разверните свой первый штаб." : "Пять фракций. Одна планета. Выберите сторону и превратите первую ячейку в империю.");
  $("missionSteps").hidden = !!p;
  $('worldIntel').hidden=!!p;
  $("missionBtn").hidden = !p;
  $("armyControls").hidden = !p;
  if(p&&!unitControls)ensureUnitControls();
  unitControls?.update();
  const armyUnits=p?.army?.units||[];
  setText('conquestTotals', p ? `${fmt(p.pixels)} ячеек · доход ${p.netPerHour >= 0 ? '+' : ''}${p.netPerHour.toFixed(1)} ⚡/ч` : '');
  setText("armyStatus",armyTargeting?"Укажите цель на карте":armyUnits.some(u=>u.state==='attack')?"Войска ведут бой":armyUnits.some(u=>u.state==='capture')?"Закрепляемся на территории":armyUnits.some(u=>u.activity==='regroup')?"Перегруппировка на своей территории":armyUnits.some(u=>u.activity==='patrol')?"Патрулируем свою территорию":p?.army?.order?.mode==='defend'?"Охрана штаба":"Автономное продвижение к фронтиру");
  $("missionSteps").children[0]?.classList.toggle("current", !account);
  $("missionSteps").children[1]?.classList.toggle("current", !!account && !placing);
  $("missionSteps").children[2]?.classList.toggle("current", placing);
  setText("levelBadge", `${p?.level || 1} ур.`);
  setText("energy", fmt(p?.energy));
  setText("income", p ? `${p.netPerHour >= 0 ? "+" : ""}${Number(p.netPerHour).toFixed(1)} / ч` : "+0 / ч");
  $("income").classList.toggle("negative", p?.netPerHour < 0);
  setText("storageInfo", p ? fmt(p.storage) : "—");
  setText("territory", fmt(p?.pixels));
  setText('territoryUnits', p && now - captureFeedback.at < 8000 ? `ячеек (+${fmt(captureFeedback.gained)})` : 'ячеек');
  setText("capInfo", p ? fmt(p.cap) : "—");
  setText("crystals", fmt(p?.crystals));
  setText("sectorAngle", `${Math.round(p?.sectorAngle || 36)}°`);
  setText("azimuthValue", `${$("azimuth").value}°`);
  setText("grossIncome", p ? `+${Number(p.grossPerHour).toFixed(1)}` : "—");
  setText("upkeep", p ? `−${Number(p.upkeepPerHour).toFixed(1)}` : "—");
  const conflicts = model?.conflicts || [];
  setText("frontStatus", conflicts.some((c) => c.status === "active") ? "Идёт борьба" : "Спокойно");
  setText("growthInfo", p ? `${Number(p.capturePerHour).toFixed(0)} ячеек / ч` : "—");
  $("shieldRow").hidden = !p || p.shieldUntil <= now;
  setText("shieldInfo", p ? duration(p.shieldUntil - now) : "—");
  const project2 = p?.project, building = project2?.status === "building", queue = p?.queuedProject;
  const canQueue = building && p?.queueSlots > 1 && p.level < 29 && !(queue && queue.invested >= queue.cost);
  setText("nextLevel", p?.level >= 30 ? "Максимальный уровень" : `${(p?.level || 1) + 1} уровень`);
  let progress = project2 ? project2.invested / project2.cost * 100 : 0;
  if (building) progress = 100 * (1 - (project2.completesAt - now) / project2.durationMs);
  $("projectBar").style.width = `${Math.max(0, Math.min(100, progress))}%`;
  setText("projectInfo", project2 ? building ? project2.completesAt > now ? `Готово через ${duration(project2.completesAt - now)}` : "Улучшение завершается…" : `${fmt(project2.invested)} из ${fmt(project2.cost)} энергии` : "База достигла максимального уровня.");
  if (queue) $("projectInfo").textContent += ` · В очереди: ${queue.targetLevel} ур., ${fmt(queue.invested)} из ${fmt(queue.cost)}`;
  $("fundingControls").hidden = !p || p.level >= 30 || building && !canQueue;
  $("fundBtn").disabled = !p || building && !canQueue || p.energy <= 0 || p.level >= 30;
  setText("fundBtn", canQueue ? "Вложить в следующий уровень" : "Вложить энергию ↗");
  $("skipBtn").hidden = !building;
  const cost = building ? skipCost(Math.max(0, (project2.completesAt - now) / 36e5)) : 0;
  $("skipBtn").disabled = !building || (p?.crystals || 0) < cost;
  setText("skipCost", `${cost} ◇`);
  $("buildDot").hidden = !building;
  setText("rotationCost", `${CONFIG.ROTATE_CRYSTAL_COST} ◇`);
  $("rotateBtn").disabled = !p || p.crystals < CONFIG.ROTATE_CRYSTAL_COST || !!(p.lastRotatedAt && now - p.lastRotatedAt < CONFIG.ROTATE_COOLDOWN_HOURS * 36e5);
  const daily = p?.daily, available = !!p && !!daily && !daily.claimed && daily.availableAt <= now;
  $("dailyBtn").disabled = !available;
  $("rewardDot").hidden = !available;
  setText("dailyInfo", !p ? "Награды откроются после основания базы." : daily?.claimed ? "Вы уже получили награду. Новая — завтра." : daily?.availableAt > now ? `Первая награда через ${duration(daily.availableAt - now)}.` : "Ваша ежедневная награда готова.");
  $("energyBtn").disabled = !p || p.crystals < 10 || (p.paidEnergy?.hoursUsed || 0) >= 16;
  setText("energyCapInfo", p ? `Сегодня доступно ещё ${Math.max(0, 16 - (p.paidEnergy?.hoursUsed || 0)).toFixed(0)} ч из 16` : "До 16 часов в день");
  $("sectorNav").disabled = !p;
  $("rewardsNav").disabled = !p;
  $("selectCellsBtn").disabled = !p;
  $("selectionBar").hidden = !selecting;
  setText("selectedCount", selectedCells.size);
  $("abandonBtn").disabled = !p || !selectedCells.size;
  $("billingBtn").hidden = !p?.subscriptionActive;
  $("cancelSubscriptionBtn").hidden = !p?.subscriptionActive;
  $("ownBasePoster").src = headquartersFor(p?.faction || selectedFaction).sprite;
  syncHeadquartersPreview();

}
function geometry() {
  const old=cameraCacheInput;
  if(!old||old.width!==cw||old.height!==ch||old.zoom!==zoom||old.lat!==cameraLat||old.lng!==cameraLng||old.mode!==mapMode){
    cameraCacheInput={width:cw,height:ch,zoom,lat:cameraLat,lng:cameraLng,mode:mapMode};cameraCache=createWorldCamera(cameraCacheInput);
  }
  return cameraCache;
}
function project(lat, lng) {
  return (drawingGeometry || geometry()).project(lat,lng);
}
project.points=(lat,lng)=>(drawingGeometry||geometry()).project.points(lat,lng);
project.shape=shape=>(drawingGeometry||geometry()).project.shape(shape);
project.rasterPatches=bounds=>(drawingGeometry||geometry()).rasterPatches(bounds);
project.requestView=()=>(drawingGeometry||geometry()).requestView();
function atPoint(px, py) {
  return (drawingGeometry || geometry()).atPoint(px,py);
}
function clampPan() {
  cameraLat=wrapLongitude(cameraLat);cameraLng=wrapLongitude(cameraLng);
}
function moveCamera(camera,dx,dy){
  const next=panWorld(camera,dx,dy);cameraLat=next.lat;cameraLng=next.lng;
}
function anchorCamera(world,x,y){
  const next=anchorWorld({width:cw,height:ch,zoom,lat:cameraLat,lng:cameraLng,mode:mapMode},world,x,y);
  cameraLat=next.lat;cameraLng=next.lng;
}
function setMapMode(mode){
  if(mode==='globe'){mapMode='auto';zoom=1;}else mapMode='flat';
  cameraChanged();invalidate();lastDetails=0;scheduleTiles();
}
function changeZoom(next, px = cw / 2, py = ch / 2) {
  const before = atPoint(px, py);
  zoom = Math.min(8192, Math.max(1, next));
  anchorCamera(before,px,py);
  cameraChanged();
  invalidate();
  lastDetails = 0;
  scheduleTiles();
}
function focusAt(lat, lng, nextZoom = 384) {
  zoom = nextZoom;
  cameraLat=lat;cameraLng=lng;
  clampPan();
  cameraChanged();
  invalidate();
  lastDetails = 0;
  scheduleTiles();
}
function home() {
  const center = model?.player?.baseCell ? cellToLatLng(model.player.baseCell) : [CONFIG.REGION.center.lat, CONFIG.REGION.center.lng];
  focusAt(...center,2048);
}
function fit() {
  const rect = $("mapViewport").getBoundingClientRect();
  const ratio=Math.min(devicePixelRatio || 1, 2, Math.sqrt(MAP_LIMITS.mapPixels/Math.max(1,rect.width*rect.height)));
  if(cw===rect.width&&ch===rect.height&&dpr===ratio&&canvas.width)return;
  cw = rect.width;ch = rect.height;dpr=ratio;
  canvas.width = Math.round(cw * dpr);
  canvas.height = Math.round(ch * dpr);
  mapLayer.width = canvas.width;
  mapLayer.height = canvas.height;
  for (const context of [displayCtx, mapCtx]) {
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.imageSmoothingEnabled = false;
  }
  scheduleTiles();
  clampPan();
  cameraChanged();
  invalidate();
  lastDetails = 0;
}
function pointFor(event) {
  const r = canvas.getBoundingClientRect();
  return { x: event.clientX - r.left, y: event.clientY - r.top };
}
function border(cell) {
  if (!boundaryCache.has(cell)) {
    if (boundaryCache.size > 16e3) boundaryCache.clear();
    boundaryCache.set(cell, cellToBoundary(cell));
  }
  return boundaryCache.get(cell);
}
function cellPath(cell) {
  const ring = border(cell);
  ctx.beginPath();
  project.shape(ring).forEach((p, i) => {
    i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y);
  });
  ctx.closePath();
}
function neutralDetail(now) {
  if (!detailedMap()) {
    cellCache.clear();
    neutralKey = "";
    return;
  }
  lastDetails = now;
  const center = atPoint(cw / 2, ch / 2), cell = latLngToCell(center.lat, center.lng, 8);
  const radius = Math.min(24, Math.max(5, Math.ceil(400 / zoom * 30)));
  const key = `${cell}:${radius}`;
  if (key === neutralKey) return;
  neutralKey = key;
  cellCache.clear();
  for (const index of gridDisk(cell, radius)) {
    if (cellIsLand(index)) cellCache.set(index, null);
  }
}
function ownerCells() {
  if (ownershipDirty) {
    ownership = new Map();
    for (const tile of tileCache.values()) for (const [cell, id] of tile.cells) ownership.set(cell, id);
    ownershipDirty = false;
  }
  return ownership;
}
function cellVisible(cell) {
  const point = project(...cellToLatLng(cell));
  const margin = geometry().size * .012 + 3;
  return point.x >= -margin && point.x <= cw + margin && point.y >= -margin && point.y <= ch + margin;
}

function playerById(id) {
  return id && id === model?.player?.id ? model.player : profiles.get(id) || leaderboard.find((p) => p.id === id);
}
function drawCellMark(cell, factionId) {
  if (zoom < 1600) return;
  const [lat, lng] = cellToLatLng(cell), p = project(lat, lng), s = geometry().size * 3e-3;
  ctx.strokeStyle = "#ddf8ff77";
  ctx.lineWidth = 1;
  if (factionId === "protocol" || factionId === "vanguard") ctx.strokeRect(p.x - s / 2, p.y - s / 2, s, s);
  else if (factionId === "bloom") {
    ctx.beginPath();
    ctx.arc(p.x, p.y, s / 2, 0, Math.PI * 2);
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.moveTo(p.x - s / 2, p.y + s / 2);
    ctx.lineTo(p.x, p.y - s / 2);
    ctx.lineTo(p.x + s / 2, p.y + s / 2);
    ctx.stroke();
  }
}
function drawSector(p) {
  if (zoom < 32 || !p?.baseCell) return;
  const [lat, lng] = cellToLatLng(p.baseCell), base = project(lat, lng), f = getFaction(p.faction), km = Math.sqrt(p.cap / (3 * p.sectorAngle / 360)) * getHexagonEdgeLengthAvg(8, "km") * Math.sqrt(3);
  ctx.beginPath();
  ctx.moveTo(base.x, base.y);
  for (let i = 0; i <= 50; i++) {
    const angle = (p.azimuth - p.sectorAngle / 2 + p.sectorAngle * i / 50) * Math.PI / 180;
    const q = project(lat + Math.cos(angle) * km / 111.32, lng + Math.sin(angle) * km / (111.32 * Math.cos(lat * Math.PI / 180)));
    ctx.lineTo(q.x, q.y);
  }
  ctx.closePath();
  const color = playerColor(p, p.faction);
  ctx.fillStyle = color + "0a";
  ctx.fill();
  ctx.strokeStyle = color + "77";
  ctx.lineWidth = 1;
  ctx.setLineDash([5, 6]);
  ctx.stroke();
  ctx.setLineDash([]);
}
function drawMap(now) {
  ctx.fillStyle = "#0b1724";
  ctx.fillRect(0, 0, cw, ch);
  const g = geometry();
  ctx.imageSmoothingEnabled = false;
  if(!g.globe)for(const p of g.rasterPatches()){ctx.save();ctx.translate(p.x,p.y+(p.flipY?p.height:0));ctx.scale(1,p.flipY?-1:1);ctx.drawImage(terrain,0,0,p.width,p.height);ctx.restore();}
  landscapeView.draw(ctx,{width:cw,height:ch,zoom:detailedMap()?zoom:Math.min(767,zoom),project,atPoint,camera:g,moving:!!(moved||pinch),fallback:terrain,baseCells:[...profiles.values(),model?.player].filter(Boolean).map(p=>p.baseCell)});
  // Tactical latitude/longitude grid stays on the cached map layer.
  if (zoom < 12) drawWorldGrid(ctx,g);
  const center = atPoint(cw / 2, ch / 2);
  setText("mapCoordinates", `${Math.abs(center.lat).toFixed(2)}° ${center.lat >= 0 ? 'N' : 'S'} · ${Math.abs(center.lng).toFixed(2)}° ${center.lng >= 0 ? 'E' : 'W'}`);
  setText("mapScale", g.globe ? "ГЛОБУС · ВРАЩАЙТЕ В ЛЮБУЮ СТОРОНУ" : zoom < 16 ? "КАРТА БЕЗ ГРАНИЦ" : !detailedMap() ? "СТРАТЕГИЧЕСКИЙ ОБЗОР" : "ТАКТИЧЕСКИЙ РЕЖИМ");
  $('mapFlat').setAttribute('aria-pressed',String(!g.globe));$('mapGlobe').setAttribute('aria-pressed',String(g.globe));
  neutralDetail(now);
  if (detailedMap()) {
    ctx.strokeStyle = "#b6c49c18";
    ctx.lineWidth = 0.5;
    for (const cell of cellCache.keys()) {
      if (!cellVisible(cell)) continue;
      cellPath(cell);
      ctx.stroke();
    }
  }
  if(detailedMap())for (const [cell, id] of ownerCells()) {
    if (!cellVisible(cell)) continue;
    const owner = playerById(id), color = playerColor(owner, owner?.faction);
    cellPath(cell);
    ctx.fillStyle = color + "26";
    ctx.fill();
    if (detailedMap()) {
      ctx.strokeStyle = color + "88";
      ctx.lineWidth = 0.6;
      ctx.stroke();
      drawCellMark(cell, owner?.faction);
    }
  }
  if (detailedMap()) drawClanHallHexes(ctx, { cellPath, cellVisible });
  for (const cell of selectedCells) {
    cellPath(cell);
    ctx.fillStyle = "#faf6c383";
    ctx.fill();
    ctx.strokeStyle = "#b29b52";
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  if (zoom <= 3) {
    ctx.font = "500 12px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif";
    ctx.fillStyle = "#66869c";
    ctx.textAlign = "center";
    for (const [lat, lng, label] of [[32, -150, "Тихий океан"], [15, -35, "Атлантический океан"], [-25, 78, "Индийский океан"]]) {
      const p = project(lat, lng);
      ctx.fillText(label, p.x, p.y);
    }
    ctx.textAlign = "left";
  }
  if (zoom > 3 && !detailedMap()) for (const city of worldMask.cities || []) {
    const p = project(90 - city.y, city.x - 180);
    if (p.x > 0 && p.x < cw && p.y > 0 && p.y < ch) {
      ctx.fillStyle = "#69eed0";
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = "11px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif";
      ctx.fillStyle = "#a5c3d6";
      ctx.fillText(city.name, p.x + 7, p.y + 4);
    }
  }
  if(!detailedMap())drawMapOverview(ctx,{overview:mapOverview,project,width:cw,height:ch,zoom,showArmies:troopsEnabled});
  const visibleBases = detailedMap()?new Map(profiles):new Map();
  if(!detailedMap()&&!mapOverview)for(const p of leaderboard)visibleBases.set(p.id,p);
  if (model?.player) visibleBases.set(model.player.id, model.player);
  for (const p of visibleBases.values()) {
    if (!p.baseCell) continue;
    const [lat, lng] = cellToLatLng(p.baseCell), pos = project(lat, lng);
    const margin=Math.max(100,geometry().size*.04);
    if(pos.x < -margin || pos.x > cw+margin || pos.y < -margin || pos.y > ch+margin)continue;
    const own = p.id === account?.id, color = playerColor(p, p.faction), sprite = detailedMap()?headquartersDisplaySprite(p.faction):null;
    let labelY = pos.y + 42;
    if (detailedMap() && readySprite(sprite)) {
      const layout = headquartersMapLayout(p.baseCell, pos, sprite);
      if (layout.left + layout.width < 0 || layout.left > cw || layout.bottom < 0 || layout.top > ch) continue;
      drawHeadquarters(p.baseCell, pos, sprite, layout, color);
      labelY = layout.bottom + 24;

    } else {
      if (pos.x < -45 || pos.x > cw + 45 || pos.y < -45 || pos.y > ch + 45) continue;
      const r = own ? 18 : 14;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
      ctx.fillStyle = "#132737";
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = own ? 2 : 1;
      ctx.stroke();
      const emblem = emblems.get(p.faction);
      if (emblem?.complete && emblem.naturalWidth) ctx.drawImage(emblem, pos.x - r + 3, pos.y - r + 3, r * 2 - 6, r * 2 - 6);
      labelY = pos.y + r + 24;
    }
    if (own) {
      const label = `${p.name} · ${p.level} ур.`;
      ctx.font = "500 11px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif";
      const width = ctx.measureText(label).width + 18;
      ctx.fillStyle = "#101e2df5";
      ctx.beginPath();
      ctx.roundRect(pos.x - width / 2, labelY - 16, width, 24, 8);
      ctx.fill();
      ctx.textAlign = "center";
      ctx.fillStyle = "#bcf4e2";
      ctx.fillText(label, pos.x, labelY);
      ctx.textAlign = "left";
    }
  }
  const castle=project(CLAN_HALL_CENTER_COORDS.lat,CLAN_HALL_CENTER_COORDS.lng);
  if(castle.x>=-180&&castle.x<=cw+180&&castle.y>=-180&&castle.y<=ch+180){
   if(castleDraw)castleDraw(ctx,{project,zoom,cw,ch,detailed:detailedMap(),now});
   else if(!castleLoading){castleLoading=true;import('./clan-hall-castle.js').then(m=>{castleDraw=m.drawClanHallCastle;invalidate();}).catch(()=>{castleLoading=false;});}
  }
  if (mouse && placing && detailedMap()) {
    const p = atPoint(mouse.x, mouse.y), cell = latLngToCell(p.lat, p.lng, 8);
    cellPath(cell);
    ctx.fillStyle = cellIsLand(cell) ? "#6c9c7477" : "#c8847155";
    ctx.fill();
    const sprite = headquartersDisplaySprite(selectedFaction);
    if (readySprite(sprite)) {
      const at = project(...cellToLatLng(cell));
      ctx.globalAlpha = 0.75;
      drawHeadquarters(cell, at, sprite, headquartersMapLayout(cell, at, sprite), mapColor(selectedFaction));
      ctx.globalAlpha = 1;
    }
  }
}
function draw(now) {
  const camera=geometry(),moving=!!(moved&&drag||pinch);
  if (mapDirty&&(!mapPaused||!mapPaints)&&mapPreview.shouldPaint(camera,now,moving)) {
    ctx = mapCtx;
    drawingGeometry = geometry();
    try { drawMap(now); } finally { ctx = displayCtx; drawingGeometry = null; }
    mapDirty=false;mapPaints++;mapPreview.commit(camera,now);
  }
  ctx.fillStyle='#17372d';ctx.fillRect(0,0,cw,ch);
  if(moving&&!camera.globe)for(const p of camera.rasterPatches()){ctx.save();ctx.translate(p.x,p.y+(p.flipY?p.height:0));ctx.scale(1,p.flipY?-1:1);ctx.drawImage(terrain,0,0,p.width,p.height);ctx.restore();}
  mapPreview.draw(ctx,mapLayer,camera,cw,ch);
  if(activePanel==='sector')drawSector(model?.player);
  for (let i = effects.length - 1; i >= 0; i--) {
    const e = effects[i], age = (now - e.at) / 1500;
    if (age > 1) {
      effects.splice(i, 1);
      continue;
    }
    const [lat, lng] = cellToLatLng(e.cell), p = project(lat, lng);
    if (p.x < 0 || p.x > cw || p.y < 0 || p.y > ch) continue;
    ctx.globalAlpha = (1 - age) * 0.6;
    ctx.strokeStyle = playerColor(playerById(e.owner), playerById(e.owner)?.faction);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3 + age * 8, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  drawAbilityBursts(now);
  drawTroops(now);
  if (detailedMap() && !mapPaused) {
    const view = unitCommandView(), units = view.units;
    drawConquestSites(ctx, units.filter(unit => unit.capture), view, serverNow());
    drawDamageIndicators(ctx, units, view, serverNow());
  }
  if(detailedMap()&&unitControls?.isOpen())unitControls.draw(ctx,unitCommandView());
}

async function refreshTiles(force=false) {
  if(tilesBusy||stopped||document.hidden||drag||pinch)return;
  const request=mapRequest({zoom,view:geometry().requestView()});if(!request)return;
  const cadence=request.kind==='overview'?10000:1000;
  if(!force&&lastMapRequest?.key===request.key&&Date.now()-lastMapRequest.at<cadence)return;
  const generation=authGeneration,id=account?.id,revision=viewRevision,controller=new AbortController();
  mapRequestController=controller;tilesBusy=true;mapKind=request.kind;
  try{
    if(request.kind==='overview'){
      const cached=overviewCache.get(request.key);
      const result=!force&&cached&&Date.now()-cached.at<10000?cached.value:await api(request.url,undefined,{signal:controller.signal,cache:'default',public:true});
      if(generation!==authGeneration||revision!==viewRevision||controller.signal.aborted)return;
      mapOverview=result;battlefield.sync({player:model?.player},serverNow());unitControls?.update();
      while(tileCache.size>16){tileCache.delete(tileCache.keys().next().value);ownershipDirty=true;}
      ownership.clear();ownershipDirty=true;
      overviewCache.delete(request.key);overviewCache.set(request.key,{value:result,at:Date.now()});
      while(overviewCache.size>6)overviewCache.delete(overviewCache.keys().next().value);
      for(const [key,value]of profiles)if(key!==id&&value.army)profiles.set(key,{...value,army:null});
    }else{
      const versions={};for(const p of request.parents)if(tileCache.has(p))versions[p]=tileCache.get(p).version;
      const result=await api('/api/tiles?parents='+encodeURIComponent(request.parents.join(','))+'&versions='+encodeURIComponent(JSON.stringify(versions)),undefined,{signal:controller.signal,public:true});
      if(generation!==authGeneration||revision!==viewRevision||account?.id!==id||controller.signal.aborted)return;
      if(Number.isFinite(result.serverTime))serverOffset=result.serverTime-Date.now();
      let changed=false;
      for(const p of result.players||[]){const old=profiles.get(p.id);if(!old||old.baseCell!==p.baseCell||old.color!==p.color||old.faction!==p.faction)changed=true;profiles.delete(p.id);profiles.set(p.id,p);}
      for(const conflict of result.conflicts||[])tileConflicts.set(conflict.id,conflict);
      for(const t of result.tiles||[]){
        if(t.unchanged)continue;ownershipDirty=true;changed=true;
        const old=tileCache.get(t.parent),cells=t.full?new Map():new Map(old?.cells||[]);
        if(t.full){for(const [owner,bits]of Object.entries(t.owners||{}))for(const cell of decodeTile(t.parent,bits))cells.set(cell,owner);}
        else for(const change of t.changes||[]){if(change.owner){cells.set(change.cell,change.owner);if(!reducedMotion&&effects.length<40)effects.push({cell:change.cell,owner:change.owner,at:performance.now()});}else cells.delete(change.cell);}
        tileCache.delete(t.parent);tileCache.set(t.parent,{version:t.version,cells,locks:t.locks||{}});
      }
      const keep=new Set(request.parents);
      for(const key of tileCache.keys())if(tileCache.size>MAP_LIMITS.cachedTiles&&!keep.has(key)){tileCache.delete(key);ownershipDirty=true;}
      while(profiles.size>MAP_LIMITS.profiles){const key=profiles.keys().next().value;if(key===id){const value=profiles.get(key);profiles.delete(key);profiles.set(key,value);}else profiles.delete(key);}
      syncBattlefield();if(changed)mapDirty=true;
    }
    lastMapRequest={key:request.key,at:Date.now()};if(request.kind==='overview')mapDirty=true;paint();
  }catch(error){
    if(generation===authGeneration&&error.status===401){signedOut();await refreshAuth();}
  }finally{
    if(mapRequestController===controller){mapRequestController=null;tilesBusy=false;}
    if(revision!==viewRevision&&!drag&&!pinch)scheduleTiles();
  }
}

function beginPlacement() {
  if (!account) return;
  closePanels();
  closeAccount();
  placing = true;
  $("spawnCard").hidden = true;
  $("placementHint").hidden = false;
  canvas.classList.add("placement");
  updateUI();
  home();
}
canvas.addEventListener("pointerdown", (e) => {
  if(e.button===2)return;
  if(mapPaused&&!document.querySelector('dialog[open]'))surfaces.closeAll();
  if(e.pointerType==='touch')e.preventDefault?.();
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 1) {
    drag = { x: e.clientX, y: e.clientY, camera:geometry() };
    moved = false;
    gestureMoved = false;
    pinch = null;
  }
  if (pointers.size >= 2) {
    const [a, b] = [...pointers.values()], rect = canvas.getBoundingClientRect(), x = (a.x + b.x) / 2 - rect.left, y = (a.y + b.y) / 2 - rect.top;
    pinch = { distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), zoom, world: atPoint(x, y) };
    drag = null;
    moved = true;
    gestureMoved = true;
    unitControls?.gestures.cancel();
  }
  if(pointers.size===1&&model?.player&&detailedMap()&&!placing&&!selecting&&!armyTargeting){
    if(unitControls?.gestures.down(e,pointFor(e)))drag=null;
  }
});
canvas.addEventListener("pointermove", (e) => {
  if(pointers.has(e.pointerId))e.preventDefault?.();
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if(unitControls?.gestures.move(e,pointFor(e)))return;
  if (pinch && pointers.size >= 2) {
    const [a, b] = [...pointers.values()], rect = canvas.getBoundingClientRect(), x = (a.x + b.x) / 2 - rect.left, y = (a.y + b.y) / 2 - rect.top;
    zoom = Math.max(1, Math.min(8192, pinch.zoom * Math.hypot(a.x - b.x, a.y - b.y) / pinch.distance));
    anchorCamera(pinch.world,x,y);
    cameraChanged();
    invalidate();
    lastDetails = 0;
    $("mapTooltip").hidden = true;
    return;
  }
  if (drag) {
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.hypot(dx, dy) > 5) moved = true;
    if (moved) {
      moveCamera(drag.camera,dx,dy);
      cameraChanged();
      invalidate();
      lastDetails = 0;
      $("mapTooltip").hidden = true;
      return;
    }
  }
  if(e.pointerType==='touch')return;
  mouse = pointFor(e);
  const p = atPoint(mouse.x, mouse.y);
  if(!p.valid)return;
  if(unitControls?.state().targetMode){unitControls.hover(latLngToCell(p.lat,p.lng,8));$('mapTooltip').hidden=true;return;}
  if (detailedMap() && !placing) {
    const cell = latLngToCell(p.lat, p.lng, 8), owner = ownerCells().get(cell), known = playerById(owner);
    if (isClanHallCell(cell)) {
      let html = `<div class="tooltip-header"><span style="color:#f59e0b">🏰</span> <b>${escape(CLAN_HALL_CENTER_COORDS.name)}</b> <small style="color:#ef4444">(${escape(CLAN_HALL_CENTER_COORDS.subtitle)})</small></div>`;
      html += `<div style="font-size:11px;color:#fbbf24;margin-top:2px;font-weight:600;">🔒 ${escape(CLAN_HALL_CENTER_COORDS.eventShortMessage)}</div>`;
      html += `<small class="terrain-tooltip" style="color:#94a3b8">Огромная цитадель (40 гексов) · Центр Европы<br>Запечатан силовым барьером до 2-го сезона</small>`;
      $("mapTooltip").innerHTML = html;
    } else if (known) {
      const pCol = playerColor(known, known.faction);
      const html = `<div class="tooltip-header"><span style="color:${pCol}">●</span> <small>${escape(getFaction(known.faction).name)}</small></div>${profileTooltip(known)}`;
      $("mapTooltip").innerHTML = html;
    } else {
      const ground=landscape(cell);
      $("mapTooltip").innerHTML = (owner ? escape(t('occupied_cell')) : escape(BIOMES[ground.type].name)) + `<small class="terrain-tooltip">${escape(CLIMATES[ground.climate].name)} · ${ground.temperature}°C (игровой климат)<br>Высота: ${ground.elevation} · ${ground.water?'Наземным отрядам нужен обход':'Скорость: '+Math.round(ground.speed*100)+'%'}</small>`;
    }
    $("mapTooltip").style.left = `${Math.max(8, Math.min(cw - 280, mouse.x + 12))}px`;
    $("mapTooltip").style.top = `${Math.max(35, mouse.y - 48)}px`;
    $("mapTooltip").hidden = false;
  } else if (!detailedMap() && mouse) {
    if (hitClanHall(project, mouse.x, mouse.y, cw, ch)) {
      let html = `<div class="tooltip-header"><span style="color:#f59e0b">🏰</span> <b>${escape(CLAN_HALL_CENTER_COORDS.name)}</b> <small style="color:#ef4444">(${escape(CLAN_HALL_CENTER_COORDS.subtitle)})</small></div>`;
      html += `<div style="font-size:11px;color:#fbbf24;margin-top:2px;font-weight:600;">🔒 ${escape(CLAN_HALL_CENTER_COORDS.eventShortMessage)}</div>`;
      html += `<small class="terrain-tooltip" style="color:#94a3b8">Кликните, чтобы осмотреть цитадель Европы (40 гексов)</small>`;
      $("mapTooltip").innerHTML = html;
      $("mapTooltip").style.left = `${Math.max(8, Math.min(cw - 280, mouse.x + 12))}px`;
      $("mapTooltip").style.top = `${Math.max(35, mouse.y - 48)}px`;
      $("mapTooltip").hidden = false;
    } else {
      $("mapTooltip").hidden = true;
    }
  }
  if (placing) invalidate();
});
canvas.addEventListener("pointerup", async (e) => {
  if(e.button===2)return;
  const selectionGesture=unitControls?.gestures.up(e,pointFor(e));
  const didMove = moved || gestureMoved;
  pointers.delete(e.pointerId);
  pinch = null;
  drag = null;
  if (pointers.size) {
    const remaining = [...pointers.values()][0];
    drag = { x: remaining.x, y: remaining.y, camera:geometry() };
    moved = true;
    return;
  }
  if(selectionGesture){if(didMove){invalidate();refreshTiles();}else paint();return;}
  if (didMove) {
    invalidate();
    refreshTiles();
    return;
  }
  const point = pointFor(e), p = atPoint(point.x, point.y);
  if(!p.valid)return;
  const cell = latLngToCell(p.lat, p.lng, 8);
  const isClanHallHit = isClanHallCell(cell) || (!detailedMap() && hitClanHall(project, point.x, point.y, cw, ch));
  if (isClanHallHit) {
    if (placing) {
      toast("Территория Великого Кланхолла защищена. Размещение базы здесь запрещено!", true);
      return;
    }
    beep(360);
    showDialog("clanHallDialog");
    toast(CLAN_HALL_CENTER_COORDS.eventMessage, false);
    return;
  }
  if (armyTargeting && model?.player) {
    if(!detailedMap()){focusAt(p.lat,p.lng,2048);return;}
    armyTargeting=false;const result=await action("/api/army/order",{mode:"attack",cell},"Приказ передан войскам.");updateUI();return;
  }
  if (placing) {
    if (!detailedMap()) {
      focusAt(p.lat, p.lng, 2048);
      return;
    }
    const referrer = localStorage.getItem("pd_referrer") || undefined;
    const chosenColor = localStorage.getItem("pd_custom_color") || undefined;
    const result = await action("/api/base", { 
      cell, 
      azimuth: Number($("startAzimuth").value), 
      faction: selectedFaction, 
      name: account.name,
      referrer,
      color: chosenColor
    }, "База основана. Сектор активирован.");
    if (result) {
      placing = false;
      $("placementHint").hidden = true;
      $("mapTooltip").hidden = true;
      canvas.classList.remove("placement");
      await refreshLeaderboard();
      home();
      appendEvent("База основана. Началась экспансия.", "base-founded");
      toast('Штаб готов. Откройте «Отряды», чтобы управлять бойцами.');
    }
  } else if (selecting && model?.player) {
    if (ownerCells().get(cell) === account.id && cell !== model.player.baseCell) {
      selectedCells.has(cell) ? selectedCells.delete(cell) : selectedCells.add(cell);
      updateUI();
      invalidate();
    } else toast("Можно выделить только свою территорию, кроме базы.", true);
  } else if (!detailedMap()) {
    const hit=hitMapOverview(mapOverview,project,cw,ch,point.x,point.y);
    focusAt(hit?.lat??p.lat,hit?.lng??p.lng,hit&&hit.players>1?Math.min(2048,zoom*8):2048);
  } else {
    const owner = playerById(ownerCells().get(cell));
    if (owner && owner.baseCell === cell && owner.id !== account?.id && !unitControls?.state().targetMode) { showPlayerProfile(owner); return; }
    if (model?.player) await (await ensureUnitControls())?.click({x:point.x,y:point.y,cell,additive:!!e.shiftKey});
  }
});
canvas.addEventListener('touchmove',event=>event.preventDefault(),{passive:false});
canvas.addEventListener('contextmenu',async event=>{
 if(!model?.player||placing||selecting||!detailedMap())return;
 event.preventDefault();if(unitControls?.gestures.ignoreContextMenu(event))return;const point=pointFor(event),p=atPoint(point.x,point.y);if(!p.valid)return;
 await(await ensureUnitControls())?.click({x:point.x,y:point.y,cell:latLngToCell(p.lat,p.lng,8),right:true});
});
canvas.addEventListener("pointerleave", (e) => {
  if (e.relatedTarget && ($("mapTooltip").contains(e.relatedTarget) || e.relatedTarget === $("mapTooltip"))) return;
  mouse = null;
  if (placing) invalidate();
  $("mapTooltip").hidden = true;
});
$("mapTooltip").addEventListener("pointerleave", () => {
  $("mapTooltip").hidden = true;
});
function cancelMapGesture(){
  unitControls?.gestures.cancel();
  pointers.clear();
  pinch = null;
  drag = null;
  moved = true;
  gestureMoved = true;
}
canvas.addEventListener("pointercancel",()=>{cancelMapGesture();invalidate();scheduleTiles();});
canvas.addEventListener('lostpointercapture',event=>{if(pointers.has(event.pointerId)){cancelMapGesture();invalidate();scheduleTiles();}});
canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  if(!e.ctrlKey&&(e.deltaMode===0&&(Math.abs(e.deltaX)>1||Math.abs(e.deltaY)<40))){moveCamera(geometry(),-e.deltaX,-e.deltaY);cameraChanged();invalidate();lastDetails=0;scheduleTiles();return;}
  const p = pointFor(e);
  changeZoom(zoom * (e.deltaY < 0 ? 1.3 : 1 / 1.3), p.x, p.y);
}, { passive: false });
$("zoomIn").onclick = () => changeZoom(zoom * 2);
$("zoomOut").onclick = () => changeZoom(zoom / 2);
$("zoomReset").onclick = () => {closePanels();changeZoom(1);};
$("mapFlat").onclick = () => {closePanels();setMapMode('flat');};
$("mapGlobe").onclick = () => {closePanels();setMapMode('globe');};
$("homeBtn").onclick = home;
$("startBtn").onclick = beginPlacement;
$("cancelPlacement").onclick = () => {
  placing = false;
  $("placementHint").hidden = true;
  $("spawnCard").hidden = false;
  canvas.classList.remove("placement");
  updateUI();
};
$("factionPicker").onclick = (e) => {
  const b = e.target.closest("[data-faction]");
  if (b) {
    selectedFaction = b.dataset.faction;
    $("gameRoot").style.setProperty("--faction", getFaction(selectedFaction).color);
    updateFaction();
    beep(400);
  }
};
$("factionPreview").onclick = () => showDialog("factionsDialog");
$('troopsBtn').onclick = () => inspectTroop(model?.player?.faction || selectedFaction);
$('troopRolePicker').onclick = event => { const button = event.target.closest('[data-troop-role]'); if (button) return inspectTroop(inspectingTroop?.faction || selectedFaction, button.dataset.troopRole); };
$('troopFactionPicker').onclick = event => { const button = event.target.closest('[data-troop-faction]'); if (button) return inspectTroop(button.dataset.troopFaction, inspectingTroop?.type || 'infantry'); };
$('troopAnimations').onclick = event => { const button = event.target.closest('[data-troop-animation]'); if (!button) return; troops3D?.animate(button.dataset.troopAnimation); document.querySelectorAll('[data-troop-animation]').forEach(node => { const selected = node === button; node.classList.toggle('selected', selected); node.setAttribute('aria-pressed', String(selected)); }); invalidate(); };
$('troopRotateLeft').onclick = () => troops3D?.rotate(-.25);
$('troopRotateRight').onclick = () => troops3D?.rotate(.25);
$('troopsDialog').addEventListener('close', () => { troopGeneration++; troops3D?.close(); invalidate(); });
$('troopsToggle').setAttribute('aria-pressed', String(troopsEnabled));
$('troopsToggle').onclick = () => { closePanels();troopsEnabled = !troopsEnabled; $('troopsToggle').setAttribute('aria-pressed', String(troopsEnabled)); try { localStorage.setItem('pd-troops', troopsEnabled ? 'on' : 'off'); } catch {} invalidate(); };
let troopPointer = null;
$('troopModelCanvas').addEventListener('pointerdown', event => { troopPointer = { id: event.pointerId, x: event.clientX }; $('troopModelCanvas').setPointerCapture(event.pointerId); });
$('troopModelCanvas').addEventListener('pointermove', event => { if (troopPointer?.id !== event.pointerId) return; troops3D?.rotate((event.clientX - troopPointer.x) * .012); troopPointer.x = event.clientX; });
for (const name of ['pointerup','pointercancel','lostpointercapture']) $('troopModelCanvas').addEventListener(name, () => { troopPointer = null; });
$('troopModelCanvas').addEventListener('keydown', event => { if (!['ArrowLeft','ArrowRight'].includes(event.key)) return; event.preventDefault(); troops3D?.rotate(event.key === 'ArrowLeft' ? -.2 : .2); });

$("factionsBtn").onclick = () => showDialog("factionsDialog");
$("factionAtlas").onclick = event => {
  const button = event.target.closest("[data-model]");
  if (!button) return;
  $("factionsDialog").close();
  return inspectHeadquarters(button.dataset.model);
};
$("spawnModelBtn").onclick = () => inspectHeadquarters(selectedFaction);
$("baseModelBtn").onclick = () => inspectHeadquarters(model?.player?.faction || selectedFaction);
$("modelFactionPicker").onclick = event => {
  const button = event.target.closest("[data-model-faction]");
  if (button) return inspectHeadquarters(button.dataset.modelFaction);
};
$("modelRotateLeft").onclick = () => headquarters3D?.rotate($("modelCanvas"), -.35);
$("modelRotateRight").onclick = () => headquarters3D?.rotate($("modelCanvas"), .35);
$("modelReset").onclick = () => headquarters3D?.reset($("modelCanvas"));
$("helpBtn").onclick = () => {
  closeAccount();
  showDialog("helpDialog");
};
$("syncBtn").onclick = () => refreshState(true);
$("soundBtn").onclick = () => {
  sound = !sound;
  setText("soundState", sound ? "Включены" : "Выключены");
  $("soundBtn").setAttribute("aria-pressed", String(sound));
  $("soundBtn").setAttribute("aria-label", sound ? "Выключить звук" : "Включить звук");
  beep();
};
$('guestLogin').onclick = async () => {
  if (authBusy) return;
  setAuthBusy(true);
  setText('modalAuthNotice', 'Открываем игру…');
  try {
    await refreshAuth();
    if (!account) {
      await api('/api/auth/guest', { name: 'Командир', fingerprint: await fingerprint() });
      await refreshAuth();
    }
    home();
  } catch (error) {
    setText('modalAuthNotice', 'Не удалось войти. Проверьте связь и нажмите «Играть без регистрации» ещё раз.');
    toast(error.message, true);
  } finally {
    setAuthBusy(false);
  }
};
$('armyExpand').onclick=()=>action('/api/army/order',{mode:'expand'},'Войска ищут свободную территорию.');
$('armyDefend').onclick=()=>action('/api/army/order',{mode:'defend'},'Войска возвращаются к штабу.');
$('armyAttack').onclick=()=>{closePanels();unitControls?.reset();armyTargeting=!armyTargeting;updateUI();toast(armyTargeting?'Нажмите на цель на карте.':'Выбор цели отменён.');};
$('armySquads').onclick=async()=>{(await ensureUnitControls())?.open();};
$("devLogin").onclick = async () => {
  const result = await action("/api/auth/dev", { name: $("devName").value.trim() || "Командир", fingerprint: await fingerprint() });
  if (result) await refreshAuth();
};
window.onTelegramAuth = async (user) => {
  if (authBusy) return;
  setAuthBusy(true);
  try {
    await refreshAuth();
    if (account) return;
    await api('/api/auth/telegram', { telegram: user, fingerprint: await fingerprint() });
    await refreshAuth();
  } catch (error) {
    setAuthNotice(error.message || 'Не удалось войти через Telegram. Повторите попытку.');
    toast(error.message, true);
  } finally {
    setAuthBusy(false);
  }
};
window.openTelegramWidget = () => {
  const target = $('modalTelegramWidget');
  if (!providers.telegram?.enabled || target.children.length) return;
  const script = document.createElement("script");
  script.src = "https://telegram.org/js/telegram-widget.js?22";
  script.async = true;
  script.setAttribute("data-telegram-login", providers.telegram.botUsername);
  script.setAttribute("data-size", "large");
  script.setAttribute("data-onauth", "onTelegramAuth(user)");
  script.onerror = () => {
    target.innerHTML = '';
    setAuthNotice('Не удалось загрузить вход Telegram. Нажмите «Через Telegram» ещё раз или выберите другой способ входа.');
  };
  target.appendChild(script);
};
$("telegramLogin").onclick = () => {
  if (telegramLaunchData && !launchExpired) return autoMiniAppLogin();
  const url = telegramLink(providers.telegram?.botUsername, false);
  if (!url) return;
  const webApp = window.Telegram?.WebApp;
  if (webApp?.initData && webApp.openTelegramLink) webApp.openTelegramLink(url);
  else location.assign(url);
};
function openAuthModal() {
  setText('modalAuthNotice', telegramLaunchData && !account ? $('authNotice').textContent : '');
  showDialog("authModal");
}
function closeAuthModal() {
  $("authModal")?.close();
}
if ($("openAuthModalBtn")) $("openAuthModalBtn").onclick = () => openAuthModal();
if ($("closeAuthModalBtn")) $("closeAuthModalBtn").onclick = () => closeAuthModal();

if ($("modalTelegramBtn")) $("modalTelegramBtn").onclick = () => {
  if (!providers.telegram?.enabled) return;
  if (telegramLaunchData) return $('telegramLogin').onclick();
  window.openTelegramWidget();
  setText('modalAuthNotice', 'Подтвердите вход в виджете Telegram. Игра продолжится в этом окне.');
};

$("logoutBtn").onclick = async () => {
  const result = await action("/api/auth/logout", {});
  if (!result) return;
  saveSession();
  tileCache.clear();
  ownershipDirty = true;
  await refreshAuth();
};
$("fundBtn").onclick = async () => {
  const raw = $("fundAmount").value;
  await action("/api/upgrades/fund", { amount: raw ? Number(raw) : "all" }, "Заряд вложен в проект.");
};
$("skipBtn").onclick = () => action("/api/crystals/spend", { kind: "skip" }, "Строительство завершено.");
$("azimuth").oninput = () => {
  setText("azimuthValue", `${$("azimuth").value}°`);
};
$("rotateBtn").onclick = () => action("/api/azimuth", { azimuth: Number($("azimuth").value) }, "Сектор повёрнут.");
$("dailyBtn").onclick = () => action("/api/daily/claim", {}, "Получено 40 кристаллов.");
$("energyBtn").onclick = () => action("/api/crystals/spend", { kind: "energy", crystals: 10 }, "Заряд добавлен на склад.");
$("selectCellsBtn").onclick = () => {
  selecting = true;
  selectedCells.clear();
  closePanels();
  closeAccount();
  updateUI();
  invalidate();
};
$("cancelSelection").onclick = () => {
  selecting = false;
  selectedCells.clear();
  updateUI();
  invalidate();
};
$("abandonBtn").onclick = () => showDialog("abandonDialog");
$("confirmAbandon").onclick = async () => {
  const result = await action("/api/abandon", { cells: [...selectedCells] }, "Ячейки освобождены и закрыты для захвата на 12 часов.");
  if (result) {
    selecting = false;
    selectedCells.clear();
    $("abandonDialog").close();
    updateUI();
  }
};
async function openShop() {
  closeAccount();
  showDialog('shopDialog');
  setText('shopNotice','Загружаем магазин…');$('shopItems').innerHTML='';
  let shop;
  try{shop=await api('/api/shop');}catch(error){if($('shopDialog').open){setText('shopNotice','Не удалось загрузить. Проверьте связь и повторите.');$('shopItems').innerHTML='<button class="secondary-button" data-shop-retry>Повторить</button>';}throw error;}
  if(!$('shopDialog').open)return;
  setText("shopNotice", shop.payments.enabled ? "Выберите кристаллы или VIP для своей базы." : "Покупки скоро откроются. Кристаллы уже можно получать в наградах.");
  $("shopItems").innerHTML = shop.items.filter((item) => item.available !== false).map((item) => `<div class="shop-item"><b>${item.crystals ? fmt(item.crystals) + " кристаллов" : "VIP"}</b><span>${(item.priceCents / 100).toLocaleString("en-US", { style: "currency", currency: item.currency })}${item.vipDays ? " / месяц" : ""}</span><button class="primary-button" data-sku="${item.id}" ${!shop.payments.enabled || !model?.player ? "disabled" : ""}>${shop.payments.enabled ? "Купить" : "Скоро"}</button>${item.vipDays ? "<small>Две очереди улучшений</small>" : ""}</div>`).join("");
  updateUI();
}
$("shopBtn").onclick = $("crystalsBtn").onclick = () => openShop().catch((e) => toast(e.message, true));
$("shopItems").onclick = async (e) => {
  if(e.target.closest('[data-shop-retry]')){await openShop().catch(error=>toast(error.message,true));return;}
  const button = e.target.closest("[data-sku]");
  if (!button) return;
  const result = await action("/api/checkout", { sku: button.dataset.sku });
  if (result?.url) location.assign(result.url);
};
$("billingBtn").onclick = async () => {
  const result = await action("/api/billing/portal", {});
  if (result?.url) location.assign(result.url);
};
$("cancelSubscriptionBtn").onclick = () => showDialog("cancelBillingDialog");
$("confirmCancelBilling").onclick = async () => {
  const result = await action("/api/billing/cancel", {}, "Продление VIP отключено. Оплаченный период сохранён.");
  if (result) {
    $("cancelBillingDialog").close();
    await refreshState();
  }
};
function abilityTime(ms) {
  const seconds = Math.max(0, Math.ceil(ms / 1e3));
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)} ч${Math.floor(seconds % 3600 / 60) ? " " + Math.floor(seconds % 3600 / 60) + " м" : ""}`;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
function effectTime(ms) {
  return ms < 6e4 ? `${ms / 1e3} с` : duration(ms);
}
function abilityState(id) {
  return model?.player?.abilities?.find?.((ability) => ability.id === id) || ABILITIES.find((ability) => ability.id === id);
}
function renderAbilities() {
  const labels = { infantry: "Пехота", field: "Тяжёлые", heavy: "Авиация", ultimate: "Ульта" };
  $("abilityBar").innerHTML = ABILITIES.map((a, index) => `<button id="ability-${a.id}" class="ability-button" data-ability="${a.id}"><span class="ability-key" aria-hidden="true">${index + 1}</span><span class="ability-icon"><img id="ability-unit-${a.id}" src="${troopForAbility(selectedFaction, a.id).poster}" alt="" width="38" height="30"></span><span class="ability-label">${labels[a.id]}</span><span class="ability-state" id="ability-state-${a.id}">Готово</span></button>`).join("");
}
function updateAbilities() {
  const p = model?.player, now = serverNow();
  for (const definition of ABILITIES) {
    const state = abilityState(definition.id), button = $(`ability-${definition.id}`), label = $(`ability-state-${definition.id}`);
    if (!button) continue;
    const unit = troopForAbility(p?.faction || selectedFaction, definition.id), image = $("ability-unit-" + definition.id);
    if (image.dataset.troop !== unit.id) { image.src = unit.poster; image.dataset.troop = unit.id; }
    const active = (state?.activeUntil || 0) > now, cooling = (state?.readyAt || 0) > now;
    button.disabled = !p || !!abilityBusy;
    button.classList.toggle("active", active);
    button.classList.toggle("cooling", cooling && !active);
    button.classList.toggle("ready", !cooling);
    const elapsed = cooling ? Math.max(0, Math.min(1, 1 - (state.readyAt - now) / definition.cooldownMs)) : 1;
    button.style.setProperty("--cooldown-progress", `${Math.round(elapsed * 100)}%`);
    label.textContent = abilityBusy === definition.id ? "…" : active ? `+${definition.bonus * 100}% · ${abilityTime(state.activeUntil - now)}` : cooling ? abilityTime(state.readyAt - now) : `+${definition.bonus * 100}%`;
    const name = factionAbilityName(p?.faction || selectedFaction, definition.id);
    button.title = `${name} · +${definition.bonus * 100}% к захвату на ${effectTime(definition.durationMs)}. ${unit.type === 'air' ? 'Прикрывает наземные отряды; землю не занимает.' : 'Занимает гексы автоматически или по команде «Захватить».'}`;
    button.setAttribute("aria-label", `${name}. ${label.textContent}${cooling ? ". Повторить за " + definition.resetCrystalCost + " кристаллов" : ". Запустить"}`);
  }
  if (pendingAbilityReset && $("abilityDialog").open) {
    const state = abilityState(pendingAbilityReset), definition = ABILITIES.find((a) => a.id === pendingAbilityReset), price = (state?.readyAt || 0) > now ? definition.resetCrystalCost : 0;
    $("confirmAbilityReset").disabled = !!abilityBusy || !p || p.crystals < price;
    setText("confirmAbilityReset", price ? `Запустить за ${price} ◇` : "Запустить бесплатно");
    $("abilityShopBtn").hidden = !p || p.crystals >= price;
  }
}
async function useAbility(id, resetCooldown = false) {
  if (!model?.player || abilityBusy) return;
  const state = abilityState(id), definition = ABILITIES.find((a) => a.id === id);
  if (!definition) return;
  if ((state?.readyAt || 0) > serverNow() && !resetCooldown) {
    pendingAbilityReset = id;
    setText("abilityDialogTitle", factionAbilityName(model.player.faction, id));
    setText("abilityDialogEffect", `+${definition.bonus * 100}% к скорости захвата на ${effectTime(definition.durationMs)}.`);
    setText("abilityDialogNote", (state.activeUntil || 0) > serverNow() ? "Повтор обновит длительность текущего эффекта. Его сила не складывается с предыдущим запуском." : "Сбросьте ожидание и запустите способность снова.");
    showDialog("abilityDialog");
    updateAbilities();
    return;
  }
  abilityBusy = id;
  updateAbilities();
  try {
    const result = await action("/api/abilities/use", { abilityId: id, resetCooldown, requestId: crypto.randomUUID() }, `${factionAbilityName(model.player.faction, id)}: захват +${definition.bonus * 100}%.`);
    if (result) {
      const type = troopForAbility(result.player.faction, id).type;
      const deployed = (result.player.army?.units || []).filter(unit => !unit.neutral && unit.type === type && unit.hp > 0).map(unit => unit.id);
      const controls = await ensureUnitControls();
      if (controls && deployed.length) controls.selectMany(deployed);
      if (!reducedMotion) abilityBursts.push({ id, at: performance.now(), cell: result.player.baseCell, faction: result.player.faction, azimuth: result.player.azimuth });
      invalidate();
      pendingAbilityReset = null;
      $("abilityDialog").close();
    }
  } finally {
    abilityBusy = null;
    updateAbilities();
  }
}
function drawAbilityBursts(now) {
  for (let i = abilityBursts.length - 1; i >= 0; i--) {
    const burst = abilityBursts[i], age = (now - burst.at) / 1800;
    if (age >= 1) {
      abilityBursts.splice(i, 1);
      continue;
    }
    const at = project(...cellToLatLng(burst.cell));
    if (at.x < -100 || at.x > cw + 100 || at.y < -100 || at.y > ch + 100) continue;
    ctx.globalAlpha = (1 - age) * 0.65;
    ctx.strokeStyle = ctx.fillStyle = mapColor(burst.faction);
    ctx.lineWidth = burst.id === "ultimate" ? 2 : 1;
    if (burst.id === "field" || burst.id === "ultimate") {
      ctx.beginPath();
      ctx.arc(at.x, at.y, 12 + age * (burst.id === "ultimate" ? 100 : 65), 0, Math.PI * 2);
      ctx.stroke();
    } else {
      const angle = (burst.azimuth - 90) * Math.PI / 180;
      for (let unit = 0; unit < (burst.id === "heavy" ? 1 : 3); unit++) {
        const t = age * 85 + unit * 8, x = at.x + Math.cos(angle) * t + Math.sin(angle) * (unit - 1) * 6, y = at.y + Math.sin(angle) * t - Math.cos(angle) * (unit - 1) * 6, size = burst.id === "heavy" ? 6 : 3;
        ctx.fillRect(x - size / 2, y - size / 2, size, size);
      }
    }
    ctx.globalAlpha = 1;
  }
}
$("abilityBar").onclick = (e) => {
  const button = e.target.closest("[data-ability]");
  if (button) return useAbility(button.dataset.ability);
};
$("confirmAbilityReset").onclick = () => {
  if (pendingAbilityReset) return useAbility(pendingAbilityReset, true);
};
$("abilityShopBtn").onclick = () => {
  $("abilityDialog").close();
  return openShop().catch((e) => toast(e.message, true));
};
for (const button of document.querySelectorAll("[data-open]")) button.onclick = () => openPanel(button.dataset.open);
for (const button of document.querySelectorAll("[data-panel-close]")) button.onclick = closePanels;
for (const button of document.querySelectorAll("[data-dismiss]")) button.onclick = () => {
  welcomeDismissed = true;
  $(button.dataset.dismiss).hidden = true;
};
$("profileButton").onclick = () => {
  if (!account) {
    openAuthModal();
    return;
  }
  const wasOpen = !$("accountPanel").hidden;
  welcomeDismissed = !!model?.player;
  closePanels();
  $("authCard").hidden = true;
  $("spawnCard").hidden = !!model?.player || placing;
  $("accountPanel").hidden = wasOpen;
  if (!wasOpen && model?.player) {
    $('customLinkInput').value = model.player.customLink || '';
    $('customLinkTitleInput').value = model.player.customLinkTitle || '';
    $('customColorPicker').value = model.player.color || getFaction(model.player.faction).color;
  }
  $("profileButton").setAttribute("aria-expanded", String(!wasOpen));
  surfaces.sync();
};
document.addEventListener("pointerdown", (e) => {
  if (!$("accountPanel").hidden && !$("accountPanel").contains(e.target) && !$("profileButton").contains(e.target)) closeAccount();
});
for (const b of document.querySelectorAll("[data-close]")) b.onclick = () => $(b.dataset.close).close();
for (const dialog of document.querySelectorAll("dialog")) dialog.onclick = (e) => {
  if (e.target === dialog) {
    const r = dialog.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close();
  }
};
window.addEventListener("keydown", (e) => {
  if (e.target.matches("input,textarea,select") || document.querySelector("dialog[open]")) return;
  if(mapPaused&&e.key!=='Escape')return;
  if(unitControls?.key(e)){e.preventDefault();return;}
  if(e.ctrlKey||e.metaKey||e.altKey)return;
  if (/^[1-4]$/.test(e.key) && !e.repeat && model?.player) useAbility(ABILITIES[Number(e.key) - 1].id);
  if (e.key === "+" || e.key === "=") changeZoom(zoom * 2);
  if (e.key === "-") changeZoom(zoom / 2);
  if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)){
    e.preventDefault();moveCamera(geometry(),e.key==='ArrowLeft'?100:e.key==='ArrowRight'?-100:0,e.key==='ArrowUp'?100:e.key==='ArrowDown'?-100:0);
    cameraChanged();invalidate();lastDetails=0;scheduleTiles();
  }
  if (e.key === "Escape") {
    armyTargeting=false;
    closePanels();
    closeAccount();
    if (placing) {
      placing = false;
      $("placementHint").hidden = true;
      $("spawnCard").hidden = false;
      canvas.classList.remove("placement");
    }
    $("mapTooltip").hidden = true;
    selecting = false;
    selectedCells.clear();
    updateUI();
    invalidate();
  }
});
document.addEventListener("visibilitychange", () => {
  clearTimeout(pollTimer);
  if (document.hidden) {
    cancelMapGesture();
    if (frameHandle !== null) cancelAnimationFrame(frameHandle);
    frameHandle = null;
    return;
  }
  invalidate();
  pollWorld();
});
window.addEventListener("online", () => { clearTimeout(pollTimer); pollWorld(); });
$("missionBtn").onclick = () => openPanel("base");

// ==========================================
// ACHIEVEMENTS & FANFARE
// ==========================================
const unlockedAchievements = new Set();
let achievementsInitialized = false;

function announceAchievement(ach,count) {
  toast(`Достижение: ${ach.title[getLang()] || ach.title.ru}${count>1?' · ещё '+(count-1):''}`);
  if(sound)playAchievementFanfare();
}
function checkAchievements(p) {
  if(!p)return;
  const earned=[];
  for(const ach of ACHIEVEMENTS)if(ach.check(p)&&!unlockedAchievements.has(ach.id)){
    unlockedAchievements.add(ach.id);
    if(achievementsInitialized){earned.push(ach);appendEvent(`Достижение получено: ${ach.title[getLang()]||ach.title.ru}`,`ach:${ach.id}`);}
  }
  // A single quiet notification avoids overlapping banners and particle loops.
  if(earned.length)announceAchievement(earned[0],earned.length);
  achievementsInitialized=true;
}

function renderAchievementsDialog() {
  if (!$("achievementsList")) return;
  const p = model?.player;
  const lang = getLang();
  let totalPoints = 0;
  let unlockedCount = 0;

  const html = ACHIEVEMENTS.map(ach => {
    const isUnlocked = p ? ach.check(p) : false;
    const progressVal = p ? ach.progress(p) : 0;
    const pct = Math.min(100, Math.round((progressVal / ach.target) * 100));
    if (isUnlocked) {
      totalPoints += ach.points;
      unlockedCount++;
    }
    const title = ach.title[lang] || ach.title.ru;
    const desc = ach.desc[lang] || ach.desc.ru;

    return `
      <div class="ach-card ${isUnlocked ? 'unlocked' : 'locked'}">
        <span class="ach-card-icon">${ach.icon}</span>
        <div class="ach-card-info">
          <h4>${escape(title)}</h4>
          <p>${escape(desc)}</p>
        </div>
        <div class="ach-card-meta">
          <span class="ach-card-points">+${ach.points} AP</span>
          <div class="ach-progress-bar">
            <i style="width: ${pct}%"></i>
          </div>
          <small style="color:var(--muted); font-size:10px;">${fmt(progressVal)} / ${fmt(ach.target)}</small>
        </div>
      </div>
    `;
  }).join('');

  $("achievementsList").innerHTML = html;
  setText("achPointsTotal", totalPoints);
  setText("achUnlockedCount", `${unlockedCount} / ${ACHIEVEMENTS.length}`);
}

// ==========================================
// REFERRAL & RESERVE ENERGY
// ==========================================
function captureReferralParam() {
  try {
    const params = new URLSearchParams(window.location.search);
    let ref = params.get('ref') || params.get('startapp') || params.get('start');
    if (!ref && window.Telegram?.WebApp?.initDataUnsafe?.start_param) {
      ref = window.Telegram.WebApp.initDataUnsafe.start_param;
    }
    if (ref) {
      if (ref.startsWith('ref_')) ref = ref.slice(4);
      localStorage.setItem('pd_referrer', ref.trim());
    }
  } catch {}
}

function updateReferralsUI() {
  const p = model?.player;
  const reserve = p?.reserveEnergy || 0;
  const friends = p?.referralsCount || 0;
  const claimed = p?.claimedReserveEnergy || 0;

  setText("refReserveVal", `${fmt(reserve)} ⚡`);
  setText("refFriendsCount", friends);
  setText("refClaimedTotal", `${fmt(claimed)} ⚡`);
  if ($("claimReserveBtn")) $("claimReserveBtn").disabled = !p || reserve <= 0;
  if ($("refDot")) $("refDot").hidden = reserve <= 0;

  const refCode = account?.id || '';
  const origin = window.location.origin;
  const webRefLink = `${origin}/?ref=${encodeURIComponent(refCode)}`;
  if ($("refLinkInput")) $("refLinkInput").value = webRefLink;
}

function setupReferralDialogButtons() {
  if ($("copyRefBtn")) $("copyRefBtn").onclick = async () => {
    const val = $("refLinkInput")?.value || '';
    try {
      await navigator.clipboard.writeText(val);
      toast(t('copied'));
    } catch {
      $("refLinkInput")?.select();
      document.execCommand('copy');
      toast(t('copied'));
    }
  };

  if ($("shareTelegramBtn")) $("shareTelegramBtn").onclick = () => {
    const val = $("refLinkInput")?.value || '';
    const text = encodeURIComponent("Присоединяйся к моей империи в геостратегии Pixel Dominion на реальной карте мира! ⚔️🌍");
    const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(val)}&text=${text}`;
    window.open(shareUrl, "_blank");
  };

  if ($("claimReserveBtn")) $("claimReserveBtn").onclick = async () => {
    $("claimReserveBtn").disabled = true;
    try {
      const res = await action("/api/referrals/claim", {}, t('ref_claimed_msg'));
      if (res?.player) acceptModel({ ...model, player: res.player });
      updateReferralsUI();
      beep(600);
    } catch (e) {
      toast(e.message, true);
    } finally {
      if ($("claimReserveBtn")) $("claimReserveBtn").disabled = (model?.player?.reserveEnergy || 0) <= 0;
    }
  };

  if ($("openRefFromProfile")) $("openRefFromProfile").onclick = () => {
    closeAccount();
    updateReferralsUI();
    showDialog("referralDialog");
  };

  if ($("openAchFromProfile")) $("openAchFromProfile").onclick = () => {
    closeAccount();
    renderAchievementsDialog();
    showDialog("achievementsDialog");
  };

  if ($("achievementsBtn")) $("achievementsBtn").onclick = () => {
    renderAchievementsDialog();
    showDialog("achievementsDialog");
  };

  if ($("referralsBtn")) $("referralsBtn").onclick = () => {
    updateReferralsUI();
    showDialog("referralDialog");
  };
}

// ==========================================
// PROFILE CUSTOMIZATION (COLOR & SOCIAL LINK)
// ==========================================
const PALETTE_COLORS = [
  "#00d4ff", "#ff3366", "#00ff88", "#ffd700", "#a855f7",
  "#ff7849", "#06b6d4", "#ec4899", "#84cc16", "#eab308"
];
let selectedCustomColor = localStorage.getItem('pd_custom_color') || '#00d4ff';

function initCustomization() {
  const p = model?.player;
  if (p?.color) selectedCustomColor = p.color;

  const palette = $("colorPalette");
  if (palette) {
    palette.innerHTML = PALETTE_COLORS.map(c => `
      <button type="button" class="color-swatch ${c.toLowerCase() === selectedCustomColor.toLowerCase() ? 'selected' : ''}" data-color="${c}" style="background-color: ${c}" aria-label="Color ${c}"></button>
    `).join('');

    palette.onclick = (e) => {
      const swatch = e.target.closest('[data-color]');
      if (!swatch) return;
      selectedCustomColor = swatch.dataset.color;
      if ($("customColorPicker")) $("customColorPicker").value = selectedCustomColor;
      palette.querySelectorAll('.color-swatch').forEach(s => s.classList.toggle('selected', s === swatch));
      try { localStorage.setItem('pd_custom_color', selectedCustomColor); } catch {}
    };
  }

  if ($("customColorPicker")) {
    $("customColorPicker").value = selectedCustomColor;
    $("customColorPicker").oninput = (e) => {
      selectedCustomColor = e.target.value;
      if (palette) palette.querySelectorAll('.color-swatch').forEach(s => s.classList.toggle('selected', s.dataset.color.toLowerCase() === selectedCustomColor.toLowerCase()));
      try { localStorage.setItem('pd_custom_color', selectedCustomColor); } catch {}
    };
  }

  if ($("customLinkInput") && p?.customLink) $("customLinkInput").value = p.customLink;
  if ($("customLinkTitleInput") && p?.customLinkTitle) $("customLinkTitleInput").value = p.customLinkTitle;

  if ($("saveCustomizationBtn")) $("saveCustomizationBtn").onclick = async () => {
    const color = $('customColorPicker').value || selectedCustomColor;
    const customLink = $("customLinkInput")?.value.trim() || '';
    const customLinkTitle = $("customLinkTitleInput")?.value.trim() || '';
    const firstPromotion = !!customLink && !model?.player?.customLink && !model?.player?.achievements?.includes('promotion_link');

    try {
      $("saveCustomizationBtn").disabled = true;
      const res = await action("/api/player/customization", {
        color,
        customLink,
        customLinkTitle,
      }, firstPromotion ? undefined : t('saved_ok'));
      if (res?.player) acceptModel({ ...model, player: res.player });
      if (res) await refreshLeaderboard();
      invalidate();
    } catch (e) {
      toast(e.message, true);
    } finally {
      if ($("saveCustomizationBtn")) $("saveCustomizationBtn").disabled = false;
    }
  };
}

// ==========================================
// THEME & LANGUAGE
// ==========================================
function initTheme() {
  let theme = 'dark';
  try {
    theme = localStorage.getItem('pixel-theme') || 'dark';
  } catch {}
  document.documentElement.setAttribute('data-theme', theme);
  updateThemeButton(theme);

  if ($("themeToggleBtn")) {
    $("themeToggleBtn").onclick = () => {
      const current = document.documentElement.getAttribute('data-theme') || 'dark';
      const next = current === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem('pixel-theme', next); } catch {}
      updateThemeButton(next);
      invalidate();
    };
  }
}

function updateThemeButton(theme) {
  if (!$("themeToggleBtn")) return;
  const isLight = theme === 'light';
  $("themeToggleBtn").setAttribute('aria-label', isLight ? t('theme_dark') : t('theme_light'));
  $("themeToggleBtn").innerHTML = isLight 
    ? '<svg><use href="#i-moon"/></svg>' 
    : '<svg><use href="#i-sun"/></svg>';
}

function initLang() {
  const current = getLang();
  setText("langCode", current.toUpperCase());
  const curObj = LANGUAGES.find(l => l.code === current);
  if (curObj) setText("langFlag", curObj.flag);

  if ($("langDropdown")) {
    $("langDropdown").innerHTML = LANGUAGES.map(l => `
      <button class="lang-opt ${l.code === current ? 'active' : ''}" data-lang="${l.code}">
        <span>${l.flag}</span>
        <span>${l.label}</span>
      </button>
    `).join('');

    $("langDropdown").onclick = (e) => {
      const opt = e.target.closest('[data-lang]');
      if (!opt) return;
      const langCode = opt.dataset.lang;
      setLang(langCode);
      setText("langCode", langCode.toUpperCase());
      const selectedObj = LANGUAGES.find(l => l.code === langCode);
      if (selectedObj) setText("langFlag", selectedObj.flag);
      $("langDropdown").querySelectorAll('.lang-opt').forEach(b => b.classList.toggle('active', b === opt));
      $("langDropdown").hidden = true;
      renderAchievementsDialog();
      updateUI();
    };
  }

  if ($("langBtn")) {
    $("langBtn").onclick = (e) => {
      e.stopPropagation();
      if ($("langDropdown")) $("langDropdown").hidden = !$("langDropdown").hidden;
    };
  }

  document.addEventListener('pointerdown', (e) => {
    if ($("langDropdown") && !$("langDropdown").hidden && !$("langDropdown").contains(e.target) && $("langBtn") && !$("langBtn").contains(e.target)) {
      $("langDropdown").hidden = true;
    }
  });
}

// ==========================================
// INTERACTIVE TUTORIAL
// ==========================================
let tutorialController = null;

function setupTutorial() {
  tutorialController = initTutorial({
    onStepChange: ({ index, total, step, title, desc, isFirst, isLast }) => {
      surfaces.closeAll('tutorialOverlay');
      if ($("tutorialOverlay")) $("tutorialOverlay").hidden = false;
      surfaces.sync();
      setText("tutStepBadge", `${index + 1} / ${total}`);
      setText("tutTitle", title);
      setText("tutDesc", desc);
      setText("tutIcon", step.icon);

      if ($("tutPrevBtn")) $("tutPrevBtn").hidden = isFirst;
      setText("tutNextBtn", isLast ? t('tut_finish') : t('tut_next'));

      document.querySelectorAll('.tutorial-highlight').forEach(el => el.classList.remove('tutorial-highlight'));
      if (step.target) {
        const el = document.querySelector(step.target);
        if (el && !el.hidden) {
          el.classList.add('tutorial-highlight');
        }
      }
    },
    onComplete: () => {
      if ($("tutorialOverlay")) $("tutorialOverlay").hidden = true;
      document.querySelectorAll('.tutorial-highlight').forEach(el => el.classList.remove('tutorial-highlight'));
      surfaces.sync();
    }
  });

  if ($("tutNextBtn")) $("tutNextBtn").onclick = () => tutorialController.next();
  if ($("tutPrevBtn")) $("tutPrevBtn").onclick = () => tutorialController.prev();
  if ($("tutSkipBtn")) $("tutSkipBtn").onclick = () => tutorialController.skip();

  if ($("tutorialBtn")) $("tutorialBtn").onclick = () => {
    tutorialController.start();
  };

  if ($("helpBtn")) $("helpBtn").onclick = () => {
    closeAccount();
    tutorialController.start();
  };
}

const telegramShell=createTelegramShell({getApp:()=>window.Telegram?.WebApp,launchData:telegramLaunchData,style:document.documentElement.style,
 onViewport:fit,onBack:()=>surfaces.back(),onActivity(active){telegramActive=active;if(active){paint();pollWorld();}else{cancelMapGesture();clearTimeout(pollTimer);if(frameHandle!==null)cancelAnimationFrame(frameHandle);frameHandle=null;}}
});
function setupTelegram(){telegramShell.setup();surfaces.sync();}
// SDK loading is optional for authentication and never blocks the game.
window.addEventListener("load", setupTelegram);
async function pollWorld() {
  clearTimeout(pollTimer);
  if (document.hidden || stopped||!telegramActive) return;
  if(account)await refreshState();else await refreshTiles();
  pollTimer = setTimeout(pollWorld, Math.min(30000, mapDetail(zoom).pollMs * 2 ** Math.min(connectionErrors, 3)));
}
new ResizeObserver(fit).observe($("mapViewport"));
function frame(now) {
  frameHandle = null;
  if (document.hidden||!telegramActive) return;
  const animated=(!mapPaused&&(effects.length||abilityBursts.length))||troopsNeedFrame();
  if (now - lastRender > 32 && (dirty || animated)) {
    draw(now);
    lastRender = now;
    dirty = false;
  }
  if (dirty || animated) requestFrame();
}
async function init() {
  captureReferralParam();
  initTheme();
  initLang();
  setupTutorial();
  initCustomization();
  setupReferralDialogButtons();
  renderFactions();
  renderAbilities();
  fit();
  updateUI();
  requestFrame();
  setupTelegram();
  try {
    await initAuth();
    await refreshLeaderboard().catch(() => {});
    if(!account){const first=leaderboard.find(p=>p.baseCell);if(first)focusAt(...cellToLatLng(first.baseCell),2048);else home();await refreshTiles();}
    $("mapLoading").hidden = true;
    if (account && !model?.player && !welcomeDismissed) $("spawnCard").hidden = false;
    pollTimer = setTimeout(pollWorld, 2000);
    setInterval(() => { if (!document.hidden && telegramActive && model?.player) updateUI(); }, 1000);
  } catch (e) {
    $("mapLoading").innerHTML = '<span>Не удалось открыть мир.</span><button id="retryConnect" class="secondary-button">Повторить</button>';
    document.getElementById("retryConnect").onclick = () => location.reload();
  }
}
init();
