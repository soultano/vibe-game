import { cellToLatLng, cellToBoundary, latLngToCell, cellToParent, gridDisk, polygonToCells, getHexagonEdgeLengthAvg } from "h3-js";
import { CONFIG, FACTIONS, getFaction } from "../shared/config.js";
import { decodeTile, cellIsLand } from "../shared/geography.js";
import worldMask from "../../data/world-mask.json";
import { skipCost } from "../shared/economy.js";
import { ABILITIES, factionAbilityName } from "../shared/abilities.js";
import { troopForAbility, troopFor, TROOP_CLASSES, TROOP_ANIMATIONS } from '../shared/troops.js';
import { createBattlefieldState } from './battlefield-state.js';
import { headquartersFor } from "../shared/headquarters.js";
import { readTelegramInitData, removeTelegramInitData, telegramLink } from "./telegram.js";
import { getLang, setLang, t, LANGUAGES } from "./i18n.js";
import { ACHIEVEMENTS, playAchievementFanfare, launchFireworks } from "./achievements.js";
import { initTutorial, isTutorialDone, setTutorialDone } from "./tutorial.js";
const $ = (id) => document.getElementById(id), canvas = $("worldCanvas"), displayCtx = canvas.getContext("2d", { alpha: false });
let ctx = displayCtx;
const mapLayer = document.createElement("canvas"), mapCtx = mapLayer.getContext("2d", { alpha: false });
const nf = new Intl.NumberFormat("ru-RU"), fmt = (n) => nf.format(Math.floor(Number(n) || 0)), escape = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
let account = null, csrfToken = "", providers = {}, model = null, leaderboard = [], selectedFaction = "protocol", placing = false, selecting = false, selectedCells = /* @__PURE__ */ new Set();
let cw = 0, ch = 0, dpr = 1, zoom = 1, panX = 0, panY = 0, drag = null, moved = false, mouse = null, serverOffset = 0, tilesBusy = false, pollBusy = false, connectionErrors = 0;
let lastRender = 0, lastDetails = 0, dirty = true, toastTimer, sound = false, audio, autoCentered = false, stopped = false, authGeneration = 0, deviceFingerprintSeed = "", activePanel = null, welcomeDismissed = false;
const profiles = /* @__PURE__ */ new Map(), tileCache = /* @__PURE__ */ new Map(), cellCache = /* @__PURE__ */ new Map(), boundaryCache = /* @__PURE__ */ new Map(), effects = [], events = [], seenEvents = /* @__PURE__ */ new Set(), emblems = /* @__PURE__ */ new Map();
const headquartersImages = /* @__PURE__ */ new Map(), abilityBursts = [], pointers = /* @__PURE__ */ new Map();
let abilityBusy = null, pendingAbilityReset = null, pinch = null, gestureMoved = false;
let headquarters3D = null, headquarters3DPromise = null, modelsUnavailable = false, inspectedFaction = "protocol", inlineModelFaction = null;
const telegramLaunchData = readTelegramInitData(location, window.Telegram?.WebApp);
let sessionToken = '', loginToken = '', authBusy = false, launchExpired = false, lastLeaderboard = 0;
let frameHandle = null, tileTimer, pollTimer, neutralKey = '', drawingGeometry = null, ownership = new Map(), ownershipDirty = true;
const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches || false;
function invalidate() { dirty = true; requestFrame(); }
function requestFrame() { if (frameHandle === null && !document.hidden) frameHandle = requestAnimationFrame(frame); }
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
for (let i = 0; i < worldMask.land.length; i++) if (worldMask.land[i]) {
  const x = i % 360, y = Math.floor(i / 360);
  tctx.fillStyle = "#172b37";
  tctx.fillRect(x, y, 1, 1);
}
for (const f of FACTIONS) {
  const image = new Image();
  image.src = f.logo;
  image.onload = invalidate;
  emblems.set(f.id, image);
}
const battlefield = createBattlefieldState({ maxUnits: Math.min(window.innerWidth || 1280, screen.width) < 760 ? 24 : 36 });
const tileConflicts = new Map();
let troops3D = null, troopsPromise = null, troopsUnavailable = false, troopsEnabled = true, inspectingTroop = null, troopGeneration = 0;
try { troopsEnabled = localStorage.getItem('pd-troops') !== 'off'; } catch {}
const animationLabels = { idle: 'Ожидание', walk: 'Шаг', run: 'Бег', attack: 'Атака', capture: 'Захват', death: 'Поражение' };
function syncBattlefield() {
  const now = serverNow();
  for (const [id, conflict] of tileConflicts) if ((conflict.lastResolvedAt || 0) < now - 15000) tileConflicts.delete(id);
  battlefield.sync({ player: model?.player, players: [...leaderboard, ...profiles.values()], conflicts: [...tileConflicts.values(), ...(model?.conflicts || [])] }, now);
}
async function ensureTroops3D() {
  if (troopsUnavailable || typeof window.WebGL2RenderingContext === 'undefined') return null;
  if (!troopsPromise) troopsPromise = import('./troops-3d.js').then(module => {
    troops3D = module.createTroops3D({ canvas: $('troopsCanvas'), reducedMotion, maxUnits: (window.innerWidth || 1280) < 760 ? 24 : 36, onReady: invalidate,
      onUnavailable(id) { if (!id) { troopsUnavailable = true; $('troopsCanvas').hidden = true; } } });
    return troops3D;
  }).catch(() => { troopsUnavailable = true; return null; });
  return troopsPromise;
}
function troopsNeedFrame() { return !!troops3D && ($('troopsDialog').open || troopsEnabled && zoom >= 512) && troops3D.needsFrame(); }
function drawTroops(now) {
  const inspecting = $('troopsDialog').open;
  if (!inspecting && (!troopsEnabled || zoom < 512 || !account)) { $('troopsCanvas').hidden = true; return; }
  const units = battlefield.units(serverNow());
  if (!troops3D) { if (units.length || inspecting) ensureTroops3D().then(engine => { if (engine) invalidate(); }); return; }
  $('troopsCanvas').hidden = inspecting ? $('troopsCanvas').hidden : !units.length;
  troops3D.render(now, { width: cw, height: ch, zoom, units, projectCell(cell) { try { return project(...cellToLatLng(cell)); } catch { return null; } } });
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
  if (!$('troopsDialog').open) $('troopsDialog').showModal();
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
function headquartersDisplaySprite(faction) {
  return headquarters3D?.getStamp(faction) || headquartersSprite(faction);
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
  if (!$("headquartersDialog").open) $("headquartersDialog").showModal();
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
  if(!headquartersImages.has(faction)){const image=new Image();image.src=headquartersFor(faction).sprite;image.onload=invalidate;headquartersImages.set(faction,image);}
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
}
function closePanels() {
  activePanel = null;
  document.querySelectorAll("[data-panel]").forEach((p) => p.hidden = true);
  document.querySelectorAll("[data-open]").forEach((b) => b.setAttribute("aria-expanded", "false"));
  invalidate();
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
  invalidate();
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
async function api(path, body) {
  const headers = { ...(sessionToken ? { Authorization: 'Bearer ' + sessionToken } : {}) };
  if (body !== undefined) {
    Object.assign(headers, { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken });
    if (loginToken && path.startsWith('/api/auth/')) headers['X-Login-Token'] = loginToken;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  let response;
  try {
    response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  } finally { clearTimeout(timeout); }
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error("Не удалось выполнить действие. Попробуйте ещё раз.");
  }
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
    if (result.player !== undefined) await refreshTiles();
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
  battlefield.clear(); tileConflicts.clear(); troops3D?.clear(); inspectingTroop = null; troopGeneration++; $("troopsDialog").close();
  abilityBursts.length = 0;
  pointers.clear();
  pinch = null;
  abilityBusy = null;
  pendingAbilityReset = null;
  $("abilityDialog").close();
  events.length = 0;
  seenEvents.clear();
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
  if (account) await refreshState(true);
  else {
    resetWorldState();
    updateUI();
  }
}
async function autoMiniAppLogin() {
  const initData = telegramLaunchData || readTelegramInitData(location, window.Telegram?.WebApp);
  if (account || authBusy || !providers.telegram?.enabled || !initData) return;
  authBusy = true;
  $('telegramLogin').disabled = true;
  $('telegramLogin').setAttribute('aria-busy', 'true');
  $('authNotice').textContent = 'Подключаем ваш командный центр…';
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
    $('authNotice').textContent = message;
    toast(message, true);
    if (e.status === 401) { launchExpired = true; $("telegramLogin").innerHTML = "Открыть игру заново ↗"; }
  } finally {
    authBusy = false;
    $('telegramLogin').disabled = false;
    $('telegramLogin').setAttribute('aria-busy', 'false');
  }
}
async function initAuth() {
  providers = await api("/api/auth/providers");
  await refreshAuth();
  $("googleLogin").hidden = !providers.google?.enabled;
  $("googleLogin").disabled = !providers.google?.enabled;
  $("googleLogin").innerHTML = providers.google?.enabled ? "Продолжить с Google" : 'Google <span class="soon-label">скоро</span>';
  $("telegramLogin").hidden = !providers.telegram?.enabled;
  $("devAuth").hidden = !providers.development;
  $('browserTelegramLogin').hidden = !providers.telegram?.enabled || !!telegramLaunchData;
  $('telegramBotLink').hidden = !providers.telegram?.enabled;
  $('telegramBotLink').href = telegramLink(providers.telegram?.botUsername, false) || '#';
  setText("authNotice", providers.telegram?.enabled ? telegramLaunchData ? 'Входим через Telegram…' : 'Откройте игру в Telegram или войдите прямо здесь.' : providers.development ? "" : "Вход через Telegram временно недоступен. Попробуйте позже.");
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
  invalidate();
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
    if (Date.now() - lastLeaderboard > 30000) await refreshLeaderboard().catch(() => {});
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
  for (const p of leaderboard) profiles.set(p.id, p);
  $("rankings").innerHTML = leaderboard.slice(0, 10).map((p, i) => {
    const f = getFaction(p.faction);
    return `<div class="ranking ${p.id === account?.id ? "you" : ""}"><span class="ranking-position">${i + 1}</span><span class="ranking-symbol"><img src="${f.logo}" alt="${f.name}"></span><span class="ranking-name">${escape(p.name)}<small>${p.id === account?.id ? "Вы · " : ""}${p.level} уровень</small></span><span class="ranking-score">${fmt(p.pixels)}<small>ячеек</small></span></div>`;
  }).join("") || '<p class="empty-state">Станьте первым командиром.</p>';
  invalidate();
}
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
  $("missionBtn").hidden = !p;
  $("missionSteps").children[0]?.classList.toggle("current", !account);
  $("missionSteps").children[1]?.classList.toggle("current", !!account && !placing);
  $("missionSteps").children[2]?.classList.toggle("current", placing);
  setText("levelBadge", `${p?.level || 1} ур.`);
  setText("energy", fmt(p?.energy));
  setText("income", p ? `${p.netPerHour >= 0 ? "+" : ""}${Number(p.netPerHour).toFixed(1)} / ч` : "+0 / ч");
  $("income").classList.toggle("negative", p?.netPerHour < 0);
  setText("storageInfo", p ? fmt(p.storage) : "—");
  setText("territory", fmt(p?.pixels));
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
  if (p && !headquarters3D) ensureHeadquarters3D().then(engine => { if (engine) { engine.getStamp(p.faction); invalidate(); } });
}
function geometry() {
  const size = Math.min(cw / 360, ch / 180) * zoom;
  return { size, ox: (cw - 360 * size) / 2 + panX, oy: (ch - 180 * size) / 2 + panY };
}
function project(lat, lng) {
  const g = drawingGeometry || geometry();
  return { x: g.ox + (lng + 180) * g.size, y: g.oy + (90 - lat) * g.size };
}
function atPoint(px, py) {
  const g = geometry();
  return { lat: Math.max(-85, Math.min(85, 90 - (py - g.oy) / g.size)), lng: Math.max(-179.999, Math.min(179.999, (px - g.ox) / g.size - 180)) };
}
function clampPan() {
  const g = geometry(), mx = Math.max(0, (360 * g.size - cw) / 2), my = Math.max(0, (180 * g.size - ch) / 2);
  panX = Math.max(-mx, Math.min(mx, panX));
  panY = Math.max(-my, Math.min(my, panY));
  if (zoom === 1) panX = panY = 0;
}
function changeZoom(next, px = cw / 2, py = ch / 2) {
  const before = atPoint(px, py);
  zoom = Math.min(8192, Math.max(1, next));
  const after = project(before.lat, before.lng);
  panX += px - after.x;
  panY += py - after.y;
  clampPan();
  invalidate();
  lastDetails = 0;
  scheduleTiles();
}
function focusAt(lat, lng, nextZoom = 384) {
  zoom = nextZoom;
  panX = panY = 0;
  const point = project(lat, lng);
  panX = cw / 2 - point.x;
  panY = ch / 2 - point.y;
  clampPan();
  invalidate();
  lastDetails = 0;
  scheduleTiles();
}
function home() {
  const center = model?.player?.baseCell ? cellToLatLng(model.player.baseCell) : [CONFIG.REGION.center.lat, CONFIG.REGION.center.lng];
  focusAt(...center);
}
function fit() {
  const rect = $("mapViewport").getBoundingClientRect();
  cw = rect.width;
  ch = rect.height;
  dpr = Math.min(devicePixelRatio || 1, 2);
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
  ring.forEach(([lat, lng], i) => {
    const p = project(lat, lng);
    i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y);
  });
  ctx.closePath();
}
function neutralDetail(now) {
  if (zoom < 256) {
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
  return id === model?.player?.id ? model.player : profiles.get(id) || leaderboard.find((p) => p.id === id);
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
  ctx.drawImage(terrain, g.ox, g.oy, 360 * g.size, 180 * g.size);
  // Tactical latitude/longitude grid stays on the cached map layer.
  if (zoom < 12) {
    ctx.strokeStyle = "#51748a18";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let lng = -180; lng <= 180; lng += 30) {
      const a = project(85, lng), b = project(-85, lng);
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    }
    for (let lat = -60; lat <= 60; lat += 30) {
      const a = project(lat, -180), b = project(lat, 180);
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    }
    ctx.stroke();
  }
  const center = atPoint(cw / 2, ch / 2);
  setText("mapCoordinates", `${Math.abs(center.lat).toFixed(2)}° ${center.lat >= 0 ? 'N' : 'S'} · ${Math.abs(center.lng).toFixed(2)}° ${center.lng >= 0 ? 'E' : 'W'}`);
  setText("mapScale", zoom < 12 ? "ОБЗОР МИРА" : zoom < 256 ? "ОПЕРАТИВНАЯ КАРТА" : "ТАКТИЧЕСКИЙ РЕЖИМ");
  neutralDetail(now);
  if (zoom >= 256) {
    ctx.strokeStyle = "#52768e45";
    ctx.lineWidth = 0.5;
    for (const cell of cellCache.keys()) {
      if (!cellVisible(cell)) continue;
      cellPath(cell);
      ctx.stroke();
    }
  }
  if (activePanel === "sector") drawSector(model?.player);
  for (const [cell, id] of ownerCells()) {
    if (!cellVisible(cell)) continue;
    const owner = playerById(id), color = playerColor(owner, owner?.faction);
    cellPath(cell);
    ctx.fillStyle = color + "ad";
    ctx.fill();
    if (zoom >= 256) {
      ctx.strokeStyle = color + "9a";
      ctx.lineWidth = 0.6;
      ctx.stroke();
      drawCellMark(cell, owner?.faction);
    }
  }
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
  if (zoom > 3 && zoom < 256) for (const city of worldMask.cities || []) {
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
  const visibleBases = new Map(profiles);
  for (const p of leaderboard) visibleBases.set(p.id, p);
  if (model?.player) visibleBases.set(model.player.id, model.player);
  for (const p of visibleBases.values()) {
    if (!p.baseCell) continue;
    const [lat, lng] = cellToLatLng(p.baseCell), pos = project(lat, lng);
    if (pos.x < -45 || pos.x > cw + 45 || pos.y < -45 || pos.y > ch + 45) continue;
    const own = p.id === account?.id, color = playerColor(p, p.faction), sprite = headquartersDisplaySprite(p.faction), size = own ? 78 : 60;
    let labelY = pos.y + 42;
    if (zoom >= 64 && readySprite(sprite)) {
      ctx.fillStyle = "#02080c77";
      ctx.beginPath();
      ctx.ellipse(pos.x, pos.y + 18, size * 0.38, size * 0.13, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.drawImage(sprite, pos.x - size / 2, pos.y - size * 0.77, size, size);
      labelY = pos.y + 42;
    } else {
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
  if (mouse && placing && zoom >= 256) {
    const p = atPoint(mouse.x, mouse.y), cell = latLngToCell(p.lat, p.lng, 8);
    cellPath(cell);
    ctx.fillStyle = cellIsLand(cell) ? "#6c9c7477" : "#c8847155";
    ctx.fill();
    const sprite = headquartersDisplaySprite(selectedFaction);
    if (readySprite(sprite)) {
      const at = project(...cellToLatLng(cell));
      ctx.globalAlpha = 0.75;
      ctx.drawImage(sprite, at.x - 35, at.y - 54, 70, 70);
      ctx.globalAlpha = 1;
    }
  }
}
function draw(now) {
  if (dirty) {
    ctx = mapCtx;
    drawingGeometry = geometry();
    try { drawMap(now); } finally { ctx = displayCtx; drawingGeometry = null; }
  }
  ctx.drawImage(mapLayer, 0, 0, cw, ch);
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
}

async function refreshTiles() {
  if (!account || tilesBusy || zoom < 256 || stopped) return;
  const generation = authGeneration, id = account.id;
  tilesBusy = true;
  try {
    const nw = atPoint(0, 0), se = atPoint(cw, ch), middle = atPoint(cw / 2, ch / 2);
    const polygon = [[nw.lat, nw.lng], [nw.lat, se.lng], [se.lat, se.lng], [se.lat, nw.lng], [nw.lat, nw.lng]];
    const visible = new Set(polygonToCells(polygon, 5));
    for (const c of [nw, se, { lat: nw.lat, lng: se.lng }, { lat: se.lat, lng: nw.lng }, middle]) for (const cell of gridDisk(cellToParent(latLngToCell(c.lat, c.lng, 8), 5), 1)) visible.add(cell);
    const requested = [...visible];
    if (requested.length > 256) throw new Error("Приблизьте карту для просмотра ячеек.");
    for (let offset = 0; offset < requested.length; offset += 48) {
      const parents = requested.slice(offset, offset + 48), versions = {};
      for (const p of parents) if (tileCache.has(p)) versions[p] = tileCache.get(p).version;
      const result = await api("/api/tiles?parents=" + encodeURIComponent(parents.join(",")) + "&versions=" + encodeURIComponent(JSON.stringify(versions)));
      if (generation !== authGeneration || account?.id !== id) return;
      for (const p of result.players || []) profiles.set(p.id, p);
      for (const conflict of result.conflicts || []) tileConflicts.set(conflict.id, conflict);
      for (const t of result.tiles || []) {
        if (!t.unchanged) ownershipDirty = true;
        if (t.unchanged) continue;
        const old = tileCache.get(t.parent), cells = t.full ? /* @__PURE__ */ new Map() : new Map(old?.cells || []);
        if (t.full) {
          for (const [owner, bits] of Object.entries(t.owners || {})) for (const cell of decodeTile(t.parent, bits)) cells.set(cell, owner);
        } else for (const change of t.changes || []) {
          if (change.owner) {
            cells.set(change.cell, change.owner);
            const fromCell = gridDisk(change.cell, 1).find(cell => cell !== change.cell && cells.get(cell) === change.owner);
            battlefield.capture({ ...change, fromCell }, serverNow());
            if (!reducedMotion && effects.length < 100) effects.push({ cell: change.cell, owner: change.owner, at: performance.now() });
          } else cells.delete(change.cell);
        }
        tileCache.set(t.parent, { version: t.version, cells });
      }
    }
    syncBattlefield();
    if (tileCache.size > 300) {
      const keep = visible;
      for (const key of tileCache.keys()) if (!keep.has(key) && tileCache.size > 100) tileCache.delete(key);
      ownershipDirty = true;
    }
    invalidate();
  } catch (e) {
    if (generation === authGeneration && e.status === 401) {
      signedOut();
      await refreshAuth();
    }
  } finally {
    if (generation === authGeneration) tilesBusy = false;
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
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 1) {
    drag = { x: e.clientX, y: e.clientY, panX, panY };
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
  }
});
canvas.addEventListener("pointermove", (e) => {
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch && pointers.size >= 2) {
    const [a, b] = [...pointers.values()], rect = canvas.getBoundingClientRect(), x = (a.x + b.x) / 2 - rect.left, y = (a.y + b.y) / 2 - rect.top;
    zoom = Math.max(1, Math.min(8192, pinch.zoom * Math.hypot(a.x - b.x, a.y - b.y) / pinch.distance));
    const anchor = project(pinch.world.lat, pinch.world.lng);
    panX += x - anchor.x;
    panY += y - anchor.y;
    clampPan();
    invalidate();
    lastDetails = 0;
    $("mapTooltip").hidden = true;
    return;
  }
  if (drag) {
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.hypot(dx, dy) > 5) moved = true;
    if (moved) {
      panX = drag.panX + dx;
      panY = drag.panY + dy;
      clampPan();
      invalidate();
      lastDetails = 0;
      $("mapTooltip").hidden = true;
      return;
    }
  }
  mouse = pointFor(e);
  const p = atPoint(mouse.x, mouse.y);
  if (zoom >= 256 && !placing) {
    const cell = latLngToCell(p.lat, p.lng, 8), owner = ownerCells().get(cell), known = playerById(owner);
    if (known) {
      const pCol = playerColor(known, known.faction);
      let html = `<div class="tooltip-header"><span style="color:${pCol}">●</span> <b>${escape(known.name)}</b> <small>(${escape(getFaction(known.faction).name)})</small></div>`;
      if (known.customLink) {
        const linkTitle = known.customLinkTitle || 'Канал / Сайт';
        html += `<a href="${escape(known.customLink)}" target="_blank" rel="noopener noreferrer" class="tooltip-social-link">🔗 ${escape(linkTitle)} ↗</a>`;
      }
      $("mapTooltip").innerHTML = html;
    } else {
      $("mapTooltip").innerHTML = owner ? escape(t('occupied_cell')) : cellIsLand(cell) ? escape(t('free_land')) : escape(t('water'));
    }
    $("mapTooltip").style.left = `${Math.max(8, Math.min(cw - 280, mouse.x + 12))}px`;
    $("mapTooltip").style.top = `${Math.max(35, mouse.y - 48)}px`;
    $("mapTooltip").hidden = false;
  }
  if (placing) invalidate();
});
canvas.addEventListener("pointerup", async (e) => {
  const didMove = moved || gestureMoved;
  pointers.delete(e.pointerId);
  pinch = null;
  drag = null;
  if (pointers.size) {
    const remaining = [...pointers.values()][0];
    drag = { x: remaining.x, y: remaining.y, panX, panY };
    moved = true;
    return;
  }
  if (didMove) {
    refreshTiles();
    return;
  }
  const point = pointFor(e), p = atPoint(point.x, point.y), cell = latLngToCell(p.lat, p.lng, 8);
  if (placing) {
    if (zoom < 256) {
      focusAt(p.lat, p.lng, 384);
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
      if (!isTutorialDone()) {
        setTimeout(() => {
          tutorialController?.start();
        }, 600);
      }
    }
  } else if (selecting && model?.player) {
    if (ownerCells().get(cell) === account.id && cell !== model.player.baseCell) {
      selectedCells.has(cell) ? selectedCells.delete(cell) : selectedCells.add(cell);
      updateUI();
      invalidate();
    } else toast("Можно выделить только свою территорию, кроме базы.", true);
  } else if (zoom < 256) {
    focusAt(p.lat, p.lng, 384);
  }
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
canvas.addEventListener("pointercancel", () => {
  pointers.clear();
  pinch = null;
  drag = null;
  moved = true;
  gestureMoved = true;
});
canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const p = pointFor(e);
  changeZoom(zoom * (e.deltaY < 0 ? 1.3 : 1 / 1.3), p.x, p.y);
}, { passive: false });
$("zoomIn").onclick = () => changeZoom(zoom * 2);
$("zoomOut").onclick = () => changeZoom(zoom / 2);
$("zoomReset").onclick = () => changeZoom(1);
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
$("factionPreview").onclick = () => $("factionsDialog").showModal();
$('troopsBtn').onclick = () => inspectTroop(model?.player?.faction || selectedFaction);
$('troopRolePicker').onclick = event => { const button = event.target.closest('[data-troop-role]'); if (button) return inspectTroop(inspectingTroop?.faction || selectedFaction, button.dataset.troopRole); };
$('troopFactionPicker').onclick = event => { const button = event.target.closest('[data-troop-faction]'); if (button) return inspectTroop(button.dataset.troopFaction, inspectingTroop?.type || 'infantry'); };
$('troopAnimations').onclick = event => { const button = event.target.closest('[data-troop-animation]'); if (!button) return; troops3D?.animate(button.dataset.troopAnimation); document.querySelectorAll('[data-troop-animation]').forEach(node => { const selected = node === button; node.classList.toggle('selected', selected); node.setAttribute('aria-pressed', String(selected)); }); invalidate(); };
$('troopRotateLeft').onclick = () => troops3D?.rotate(-.25);
$('troopRotateRight').onclick = () => troops3D?.rotate(.25);
$('troopsDialog').addEventListener('close', () => { troopGeneration++; troops3D?.close(); invalidate(); });
$('troopsToggle').setAttribute('aria-pressed', String(troopsEnabled));
$('troopsToggle').onclick = () => { troopsEnabled = !troopsEnabled; $('troopsToggle').setAttribute('aria-pressed', String(troopsEnabled)); try { localStorage.setItem('pd-troops', troopsEnabled ? 'on' : 'off'); } catch {} invalidate(); };
let troopPointer = null;
$('troopModelCanvas').addEventListener('pointerdown', event => { troopPointer = { id: event.pointerId, x: event.clientX }; $('troopModelCanvas').setPointerCapture(event.pointerId); });
$('troopModelCanvas').addEventListener('pointermove', event => { if (troopPointer?.id !== event.pointerId) return; troops3D?.rotate((event.clientX - troopPointer.x) * .012); troopPointer.x = event.clientX; });
for (const name of ['pointerup','pointercancel','lostpointercapture']) $('troopModelCanvas').addEventListener(name, () => { troopPointer = null; });
$('troopModelCanvas').addEventListener('keydown', event => { if (!['ArrowLeft','ArrowRight'].includes(event.key)) return; event.preventDefault(); troops3D?.rotate(event.key === 'ArrowLeft' ? -.2 : .2); });

$("factionsBtn").onclick = () => $("factionsDialog").showModal();
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
  $("helpDialog").showModal();
};
$("syncBtn").onclick = () => refreshState(true);
$("soundBtn").onclick = () => {
  sound = !sound;
  setText("soundState", sound ? "Включены" : "Выключены");
  $("soundBtn").setAttribute("aria-pressed", String(sound));
  $("soundBtn").setAttribute("aria-label", sound ? "Выключить звук" : "Включить звук");
  beep();
};
$("devLogin").onclick = async () => {
  const result = await action("/api/auth/dev", { name: $("devName").value.trim() || "Командир", fingerprint: await fingerprint() });
  if (result) await refreshAuth();
};
$("googleLogin").onclick = async (e) => {
  e.preventDefault();
  if (!providers.google?.enabled) return;
  location.href = "/api/auth/google/start?fingerprint=" + encodeURIComponent(await fingerprint());
};
window.onTelegramAuth = async (user) => {
  const result = await action("/api/auth/telegram", { telegram: user, fingerprint: await fingerprint() });
  if (result) await refreshAuth();
};
window.openTelegramWidget = () => {
  if (!providers.telegram?.enabled || $("telegramWidget").children.length) return;
  const script = document.createElement("script");
  script.src = "https://telegram.org/js/telegram-widget.js?22";
  script.async = true;
  script.setAttribute("data-telegram-login", providers.telegram.botUsername);
  script.setAttribute("data-size", "large");
  script.setAttribute("data-onauth", "onTelegramAuth(user)");
  script.onerror = () => {
    $('telegramWidget').innerHTML = '';
    setText('authNotice', 'Не удалось загрузить окно входа. Откройте чат бота и нажмите «Играть».');
  };
  $("telegramWidget").appendChild(script);
};
$("browserTelegramLogin").onclick = () => window.openTelegramWidget();
$("telegramLogin").onclick = () => {
  if (telegramLaunchData && !launchExpired) return autoMiniAppLogin();
  const url = telegramLink(providers.telegram?.botUsername);
  if (!url) return;
  const webApp = window.Telegram?.WebApp;
  if (webApp?.initData && webApp.openTelegramLink) webApp.openTelegramLink(url);
  else location.assign(url);
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
$("abandonBtn").onclick = () => $("abandonDialog").showModal();
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
  const shop = await api("/api/shop");
  setText("shopNotice", shop.payments.enabled ? "Выберите кристаллы или VIP для своей базы." : "Покупки скоро откроются. Кристаллы уже можно получать в наградах.");
  $("shopItems").innerHTML = shop.items.filter((item) => item.available !== false).map((item) => `<div class="shop-item"><b>${item.crystals ? fmt(item.crystals) + " кристаллов" : "VIP"}</b><span>${(item.priceCents / 100).toLocaleString("en-US", { style: "currency", currency: item.currency })}${item.vipDays ? " / месяц" : ""}</span><button class="primary-button" data-sku="${item.id}" ${!shop.payments.enabled || !model?.player ? "disabled" : ""}>${shop.payments.enabled ? "Купить" : "Скоро"}</button>${item.vipDays ? "<small>Две очереди улучшений</small>" : ""}</div>`).join("");
  $("shopDialog").showModal();
  updateUI();
}
$("shopBtn").onclick = $("crystalsBtn").onclick = () => openShop().catch((e) => toast(e.message, true));
$("shopItems").onclick = async (e) => {
  const button = e.target.closest("[data-sku]");
  if (!button) return;
  const result = await action("/api/checkout", { sku: button.dataset.sku });
  if (result?.url) location.assign(result.url);
};
$("billingBtn").onclick = async () => {
  const result = await action("/api/billing/portal", {});
  if (result?.url) location.assign(result.url);
};
$("cancelSubscriptionBtn").onclick = () => $("cancelBillingDialog").showModal();
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
    button.title = `${name} · +${definition.bonus * 100}% к захвату на ${effectTime(definition.durationMs)}`;
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
    $("abilityDialog").showModal();
    updateAbilities();
    return;
  }
  abilityBusy = id;
  updateAbilities();
  try {
    const result = await action("/api/abilities/use", { abilityId: id, resetCooldown, requestId: crypto.randomUUID() }, `${factionAbilityName(model.player.faction, id)}: захват +${definition.bonus * 100}%.`);
    if (result) {
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
    openPanel("base");
    return;
  }
  const wasOpen = !$("accountPanel").hidden;
  welcomeDismissed = !!model?.player;
  closePanels();
  $("authCard").hidden = true;
  $("spawnCard").hidden = !!model?.player || placing;
  $("accountPanel").hidden = wasOpen;
  $("profileButton").setAttribute("aria-expanded", String(!wasOpen));
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
  if (e.ctrlKey || e.metaKey || e.altKey || e.target.matches("input,textarea,select") || document.querySelector("dialog[open]")) return;
  if (/^[1-4]$/.test(e.key) && !e.repeat && model?.player) useAbility(ABILITIES[Number(e.key) - 1].id);
  if (e.key === "+" || e.key === "=") changeZoom(zoom * 2);
  if (e.key === "-") changeZoom(zoom / 2);
  if (e.key === "Escape") {
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

function showAchievementWoW(ach) {
  const lang = getLang();
  setText("wowTitle", ach.title[lang] || ach.title.ru);
  setText("wowDesc", ach.desc[lang] || ach.desc.ru);
  setText("wowPointsVal", `+${ach.points}`);
  const shield = $("wowAchievement")?.querySelector('.wow-shield');
  if (shield) shield.textContent = ach.icon || '🏆';

  if ($("wowAchievement")) {
    $("wowAchievement").hidden = false;
    $("wowAchievement").classList.remove("hide");
    $("wowAchievement").classList.add("show");
  }

  playAchievementFanfare();
  launchFireworks($("saluteCanvas"));

  setTimeout(() => {
    if ($("wowAchievement")) {
      $("wowAchievement").classList.remove("show");
      $("wowAchievement").classList.add("hide");
      setTimeout(() => {
        if ($("wowAchievement")) $("wowAchievement").hidden = true;
      }, 500);
    }
  }, 3500);
}

function checkAchievements(p) {
  if (!p) return;
  for (const ach of ACHIEVEMENTS) {
    if (ach.check(p)) {
      if (!unlockedAchievements.has(ach.id)) {
        unlockedAchievements.add(ach.id);
        if (achievementsInitialized) {
          showAchievementWoW(ach);
          appendEvent(`Достижение получено: ${ach.title[getLang()] || ach.title.ru}`, `ach:${ach.id}`);
        }
      }
    }
  }
  achievementsInitialized = true;
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
    $("referralDialog")?.showModal();
  };

  if ($("openAchFromProfile")) $("openAchFromProfile").onclick = () => {
    closeAccount();
    renderAchievementsDialog();
    $("achievementsDialog")?.showModal();
  };

  if ($("achievementsBtn")) $("achievementsBtn").onclick = () => {
    renderAchievementsDialog();
    $("achievementsDialog")?.showModal();
  };

  if ($("referralsBtn")) $("referralsBtn").onclick = () => {
    updateReferralsUI();
    $("referralDialog")?.showModal();
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
    const color = selectedCustomColor;
    const customLink = $("customLinkInput")?.value.trim() || '';
    const customLinkTitle = $("customLinkTitleInput")?.value.trim() || '';

    try {
      $("saveCustomizationBtn").disabled = true;
      const res = await action("/api/player/customization", {
        color,
        customLink,
        customLinkTitle,
      }, t('saved_ok'));
      if (res?.player) acceptModel({ ...model, player: res.player });
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
      if ($("tutorialOverlay")) $("tutorialOverlay").hidden = false;
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

function setupTelegram() {
  const webApp = window.Telegram?.WebApp;
  if (!webApp || !telegramLaunchData) return;
  webApp.ready?.();
  webApp.expand?.();
  try { webApp.setHeaderColor?.('#080f19'); webApp.setBackgroundColor?.('#080f19'); } catch {}
}
// SDK loading is optional for authentication and never blocks the game.
window.addEventListener("load", setupTelegram);
async function pollWorld() {
  clearTimeout(pollTimer);
  if (document.hidden || stopped) return;
  await refreshState();
  pollTimer = setTimeout(pollWorld, Math.min(30000, 5000 * 2 ** Math.min(connectionErrors, 3)));
}
new ResizeObserver(fit).observe($("mapViewport"));
function frame(now) {
  frameHandle = null;
  if (document.hidden) return;
  if (now - lastRender > 32 && (dirty || effects.length || abilityBursts.length || troopsNeedFrame())) {
    draw(now);
    lastRender = now;
    dirty = false;
  }
  if (dirty || effects.length || abilityBursts.length || troopsNeedFrame()) requestFrame();
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
    $("mapLoading").hidden = true;
    if (account && !model?.player && !welcomeDismissed) $("spawnCard").hidden = false;
    pollTimer = setTimeout(pollWorld, 5000);
    setInterval(() => { if (!document.hidden && model?.player) updateUI(); }, 1000);
  } catch (e) {
    $("mapLoading").innerHTML = '<span>Не удалось открыть мир.</span><button id="retryConnect" class="secondary-button">Повторить</button>';
    document.getElementById("retryConnect").onclick = () => location.reload();
  }
}
init();
