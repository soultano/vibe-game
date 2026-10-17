import { cellToLatLng, cellToBoundary, latLngToCell, cellToParent, gridDisk, polygonToCells, getHexagonEdgeLengthAvg } from "h3-js";
import { CONFIG, FACTIONS, getFaction } from "../shared/config.js";
import { decodeTile, cellIsLand } from "../shared/geography.js";
import worldMask from "../../data/world-mask.json";
import { skipCost } from "../shared/economy.js";
const $ = (id) => document.getElementById(id), canvas = $("worldCanvas"), ctx = canvas.getContext("2d", { alpha: false });
const nf = new Intl.NumberFormat("ru-RU"), fmt = (n) => nf.format(Math.floor(Number(n) || 0)), escape = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
let account = null, csrfToken = "", providers = {}, model = null, leaderboard = [], selectedFaction = "protocol", placing = false, selecting = false, selectedCells = /* @__PURE__ */ new Set();
let cw = 0, ch = 0, dpr = 1, zoom = 1, panX = 0, panY = 0, drag = null, moved = false, mouse = null, serverOffset = 0, tilesBusy = false, pollBusy = false, connectionErrors = 0;
let lastRender = 0, lastDetails = 0, dirty = true, toastTimer, sound = false, audio, autoCentered = false, stopped = false, authGeneration = 0, deviceFingerprintSeed = "", activePanel = null, welcomeDismissed = false;
const profiles = /* @__PURE__ */ new Map(), tileCache = /* @__PURE__ */ new Map(), cellCache = /* @__PURE__ */ new Map(), boundaryCache = /* @__PURE__ */ new Map(), effects = [], events = [], seenEvents = /* @__PURE__ */ new Set(), emblems = /* @__PURE__ */ new Map();
const terrain = document.createElement("canvas");
terrain.width = 360;
terrain.height = 180;
const tctx = terrain.getContext("2d");
for (let i = 0; i < worldMask.land.length; i++) if (worldMask.land[i]) {
  const x = i % 360, y = Math.floor(i / 360);
  tctx.fillStyle = "#d9e5cd";
  tctx.fillRect(x, y, 1, 1);
}
for (const f of FACTIONS) {
  const image = new Image();
  image.src = f.logo;
  image.onload = () => dirty = true;
  emblems.set(f.id, image);
}
function mapColor(faction) {
  return { protocol: "#649eac", vanguard: "#d4a16e", bloom: "#aa8dbc", swarm: "#95b66f", pack: "#85a7be" }[faction] || "#a2ad9d";
}
function closeAccount() {
  $("accountPanel").hidden = true;
  $("profileButton").setAttribute("aria-expanded", "false");
}
function closePanels() {
  activePanel = null;
  document.querySelectorAll("[data-panel]").forEach((p) => p.hidden = true);
  document.querySelectorAll("[data-open]").forEach((b) => b.setAttribute("aria-expanded", "false"));
  dirty = true;
}
function openPanel(name) {
  const wasOpen = activePanel === name;
  closePanels();
  closeAccount();
  if (wasOpen) return;
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
  dirty = true;
}
function toast(message, error = false) {
  clearTimeout(toastTimer);
  $("toast").textContent = message;
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
  events.unshift({ text, at: serverNow() });
  events.length = Math.min(events.length, 30);
  $("eventLog").innerHTML = events.slice(0, 5).map((e) => `<div class="event-row"><time>${new Date(e.at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}</time><span>${escape(e.text)}</span></div>`).join("");
}
async function api(path, body) {
  const response = await fetch(path, { method: body === void 0 ? "GET" : "POST", credentials: "same-origin", headers: body === void 0 ? {} : { "Content-Type": "application/json", "X-CSRF-Token": csrfToken }, ...body === void 0 ? {} : { body: JSON.stringify(body) } });
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
    await refreshTiles();
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
  $("factionPicker").innerHTML = FACTIONS.map((f) => `<button data-faction="${f.id}" aria-pressed="${f.id === selectedFaction}" class="${f.id === selectedFaction ? "selected" : ""}"><img src="${f.logo}" alt=""><b>${f.name}</b></button>`).join("");
  $("factionAtlas").innerHTML = FACTIONS.map((f) => `<article class="faction-sheet"><img src="${f.logo}" alt="${f.name}"><h3>${f.name}</h3><p>${escape(f.description)}</p><p class="faction-benefit">${escape(f.bonus)}</p></article>`).join("");
  updateFaction();
}
function updateFaction() {
  const f = getFaction(selectedFaction);
  $("factionDescription").innerHTML = `<strong>${escape(f.description)}</strong>${escape(f.bonus)}`;
  document.querySelectorAll("[data-faction]").forEach((b) => {
    const selected = b.dataset.faction === selectedFaction;
    b.classList.toggle("selected", selected);
    b.setAttribute("aria-pressed", String(selected));
  });
}
function resetWorldState() {
  model = null;
  placing = false;
  selecting = false;
  autoCentered = false;
  welcomeDismissed = false;
  selectedCells.clear();
  tileCache.clear();
  cellCache.clear();
  profiles.clear();
  effects.length = 0;
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
  dirty = true;
}
function signedOut() {
  authGeneration++;
  account = null;
  csrfToken = "";
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
  csrfToken = me.csrfToken || "";
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
function miniAppInitData() {
  let fragmentData = "";
  try {
    const fragment = new URLSearchParams(location.hash.slice(1));
    fragmentData = fragment.get("tgWebAppData") || "";
    if (fragment.has("tgWebAppData")) {
      fragment.delete("tgWebAppData");
      const rest = fragment.toString();
      history.replaceState(history.state, "", location.pathname + location.search + (rest ? "#" + rest : ""));
    }
  } catch {
  }
  const sdk = window.Telegram?.WebApp?.initData;
  return typeof sdk === "string" && sdk ? sdk : fragmentData;
}
async function autoMiniAppLogin() {
  const initData = miniAppInitData();
  if (account || !providers.telegram?.enabled || !initData) return;
  try {
    await api("/api/auth/telegram/miniapp", { initData, fingerprint: await fingerprint() });
    await refreshAuth();
    window.Telegram?.WebApp?.ready();
    window.Telegram?.WebApp?.expand();
  } catch (e) {
    $("authNotice").textContent = e.message + " Откройте игру заново через меню бота.";
    toast(e.message, true);
  }
}
async function initAuth() {
  providers = await api("/api/auth/providers");
  await refreshAuth();
  $("googleLogin").hidden = false;
  $("googleLogin").disabled = !providers.google?.enabled;
  $("googleLogin").innerHTML = providers.google?.enabled ? "Продолжить с Google" : 'Google <span class="soon-label">скоро</span>';
  $("telegramLogin").hidden = !providers.telegram?.enabled;
  $("devAuth").hidden = !providers.development;
  $("authNotice").textContent = providers.telegram?.enabled ? "В боте нажмите «Играть»." : providers.development ? "" : "Вход скоро откроется.";
  await autoMiniAppLogin();
}
function acceptModel(next) {
  if (model && Number.isFinite(model.serverTime) && Number.isFinite(next.serverTime) && next.serverTime < model.serverTime) return;
  if (model?.player && !next.player) return;
  if (Number.isFinite(next.serverTime)) serverOffset = next.serverTime - Date.now();
  const prior = model?.player;
  model = next;
  if (next.player && prior?.level && prior.level !== next.player.level) appendEvent(`База достигла уровня ${next.player.level}.`, `level:${next.player.level}`);
  for (const conflict of next.conflicts || []) {
    const status = conflict.status === "shielded" ? "Границу защищает щит." : conflict.status === "active" ? "На границе идёт борьба за ячейки." : "На границе установилось равновесие.";
    appendEvent(status, `conflict:${conflict.id || conflict.attackerId || ""}:${conflict.status}`);
  }
  if (next.player?.expansionBlocked) appendEvent("В направлении захвата не осталось свободной суши.", "blocked");
  $("authCard").hidden = !!account || welcomeDismissed;
  $("spawnCard").hidden = !account || !!next.player || placing || welcomeDismissed;
  if (next.player && (!prior || prior.azimuth !== next.player.azimuth)) $("azimuth").value = next.player.azimuth;
  if (next.player && !autoCentered) {
    autoCentered = true;
    home();
  }
  updateUI();
  dirty = true;
}
async function refreshState(force = false) {
  if (!account || pollBusy && !force || stopped) return;
  const generation = authGeneration, id = account.id;
  pollBusy = true;
  try {
    const next = await api("/api/state");
    if (generation !== authGeneration || account?.id !== id) return;
    acceptModel(next);
    connectionErrors = 0;
    $("connectionNotice").hidden = true;
    await refreshLeaderboard();
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
  leaderboard = result.players || [];
  for (const p of leaderboard) profiles.set(p.id, p);
  $("rankings").innerHTML = leaderboard.slice(0, 10).map((p, i) => {
    const f = getFaction(p.faction);
    return `<div class="ranking ${p.id === account?.id ? "you" : ""}"><span class="ranking-position">${i + 1}</span><span class="ranking-symbol"><img src="${f.logo}" alt="${f.name}"></span><span class="ranking-name">${escape(p.name)}<small>${p.id === account?.id ? "Вы · " : ""}${p.level} уровень</small></span><span class="ranking-score">${fmt(p.pixels)}<small>ячеек</small></span></div>`;
  }).join("") || '<p class="empty-state">Станьте первым командиром.</p>';
  dirty = true;
}
function updateUI() {
  const p = model?.player, now = serverNow(), f = getFaction(p?.faction || selectedFaction);
  $("resourceBar").hidden = !p;
  $("profileName").textContent = account?.name?.split(" ")[0] || "Войти";
  $("accountName").textContent = account?.name || "Командир";
  $("commanderName").textContent = p?.name || account?.name || "Командир";
  $("factionName").textContent = f.name.toLocaleLowerCase("ru-RU");
  $("factionAvatar").src = f.logo;
  $("factionAvatar").alt = f.name;
  $("levelBadge").textContent = `${p?.level || 1} ур.`;
  $("energy").textContent = fmt(p?.energy);
  $("income").textContent = p ? `${p.netPerHour >= 0 ? "+" : ""}${Number(p.netPerHour).toFixed(1)} / ч` : "+0 / ч";
  $("income").classList.toggle("negative", p?.netPerHour < 0);
  $("storageInfo").textContent = p ? fmt(p.storage) : "—";
  $("territory").textContent = fmt(p?.pixels);
  $("capInfo").textContent = p ? fmt(p.cap) : "—";
  $("crystals").textContent = fmt(p?.crystals);
  $("sectorAngle").textContent = `${Math.round(p?.sectorAngle || 36)}°`;
  $("azimuthValue").textContent = `${$("azimuth").value}°`;
  $("grossIncome").textContent = p ? `+${Number(p.grossPerHour).toFixed(1)}` : "—";
  $("upkeep").textContent = p ? `−${Number(p.upkeepPerHour).toFixed(1)}` : "—";
  const conflicts = model?.conflicts || [];
  $("frontStatus").textContent = conflicts.some((c) => c.status === "active") ? "Идёт борьба" : "Спокойно";
  $("growthInfo").textContent = p ? `${Number(p.capturePerHour).toFixed(0)} ячеек / ч` : "—";
  $("shieldRow").hidden = !p || p.shieldUntil <= now;
  $("shieldInfo").textContent = p ? duration(p.shieldUntil - now) : "—";
  const project2 = p?.project, building = project2?.status === "building", queue = p?.queuedProject;
  const canQueue = building && p?.queueSlots > 1 && p.level < 29 && !(queue && queue.invested >= queue.cost);
  $("nextLevel").textContent = p?.level >= 30 ? "Максимальный уровень" : `${(p?.level || 1) + 1} уровень`;
  let progress = project2 ? project2.invested / project2.cost * 100 : 0;
  if (building) progress = 100 * (1 - (project2.completesAt - now) / project2.durationMs);
  $("projectBar").style.width = `${Math.max(0, Math.min(100, progress))}%`;
  $("projectInfo").textContent = project2 ? building ? project2.completesAt > now ? `Готово через ${duration(project2.completesAt - now)}` : "Улучшение завершается…" : `${fmt(project2.invested)} из ${fmt(project2.cost)} энергии` : "База достигла максимального уровня.";
  if (queue) $("projectInfo").textContent += ` · В очереди: ${queue.targetLevel} ур., ${fmt(queue.invested)} из ${fmt(queue.cost)}`;
  $("fundingControls").hidden = !p || p.level >= 30 || building && !canQueue;
  $("fundBtn").disabled = !p || building && !canQueue || p.energy <= 0 || p.level >= 30;
  $("fundBtn").textContent = canQueue ? "Вложить в следующий уровень" : "Вложить энергию ↗";
  $("skipBtn").hidden = !building;
  const cost = building ? skipCost(Math.max(0, (project2.completesAt - now) / 36e5)) : 0;
  $("skipBtn").disabled = !building || (p?.crystals || 0) < cost;
  $("skipCost").textContent = `${cost} ◇`;
  $("buildDot").hidden = !building;
  $("rotationCost").textContent = `${CONFIG.ROTATE_CRYSTAL_COST} ◇`;
  $("rotateBtn").disabled = !p || p.crystals < CONFIG.ROTATE_CRYSTAL_COST || !!(p.lastRotatedAt && now - p.lastRotatedAt < CONFIG.ROTATE_COOLDOWN_HOURS * 36e5);
  const daily = p?.daily, available = !!p && !!daily && !daily.claimed && daily.availableAt <= now;
  $("dailyBtn").disabled = !available;
  $("rewardDot").hidden = !available;
  $("dailyInfo").textContent = !p ? "Награды откроются после основания базы." : daily?.claimed ? "Вы уже получили награду. Новая — завтра." : daily?.availableAt > now ? `Первая награда через ${duration(daily.availableAt - now)}.` : "Ваша ежедневная награда готова.";
  $("energyBtn").disabled = !p || p.crystals < 10 || (p.paidEnergy?.hoursUsed || 0) >= 16;
  $("energyCapInfo").textContent = p ? `Сегодня доступно ещё ${Math.max(0, 16 - (p.paidEnergy?.hoursUsed || 0)).toFixed(0)} ч из 16` : "До 16 часов в день";
  $("sectorNav").disabled = !p;
  $("rewardsNav").disabled = !p;
  $("selectCellsBtn").disabled = !p;
  $("selectionBar").hidden = !selecting;
  $("selectedCount").textContent = selectedCells.size;
  $("abandonBtn").disabled = !p || !selectedCells.size;
  $("billingBtn").hidden = !p?.subscriptionActive;
  $("cancelSubscriptionBtn").hidden = !p?.subscriptionActive;
}
function geometry() {
  const size = Math.min(cw / 360, ch / 180) * zoom;
  return { size, ox: (cw - 360 * size) / 2 + panX, oy: (ch - 180 * size) / 2 + panY };
}
function project(lat, lng) {
  const g = geometry();
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
  dirty = true;
  lastDetails = 0;
  refreshTiles();
}
function focusAt(lat, lng, nextZoom = 384) {
  zoom = nextZoom;
  panX = panY = 0;
  const point = project(lat, lng);
  panX = cw / 2 - point.x;
  panY = ch / 2 - point.y;
  clampPan();
  dirty = true;
  lastDetails = 0;
  refreshTiles();
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
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;
  clampPan();
  dirty = true;
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
    return;
  }
  if (now - lastDetails < 750 && cellCache.size) return;
  lastDetails = now;
  const center = atPoint(cw / 2, ch / 2), cell = latLngToCell(center.lat, center.lng, 8);
  cellCache.clear();
  const radius = Math.min(38, Math.max(5, Math.ceil(400 / zoom * 30)));
  for (const index of gridDisk(cell, radius)) {
    if (cellIsLand(index)) cellCache.set(index, null);
  }
}
function ownerCells() {
  const cells = /* @__PURE__ */ new Map();
  for (const tile of tileCache.values()) for (const [cell, id] of tile.cells) cells.set(cell, id);
  return cells;
}
function playerById(id) {
  return id === model?.player?.id ? model.player : profiles.get(id) || leaderboard.find((p) => p.id === id);
}
function drawCellMark(cell, factionId) {
  if (zoom < 1600) return;
  const [lat, lng] = cellToLatLng(cell), p = project(lat, lng), s = geometry().size * 3e-3;
  ctx.strokeStyle = "#536c5966";
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
  ctx.fillStyle = mapColor(p.faction) + "0a";
  ctx.fill();
  ctx.strokeStyle = mapColor(p.faction) + "77";
  ctx.lineWidth = 1;
  ctx.setLineDash([5, 6]);
  ctx.stroke();
  ctx.setLineDash([]);
}
function draw(now) {
  ctx.fillStyle = "#e7eff0";
  ctx.fillRect(0, 0, cw, ch);
  const g = geometry();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(terrain, g.ox, g.oy, 360 * g.size, 180 * g.size);
  neutralDetail(now);
  if (zoom >= 256) {
    ctx.strokeStyle = "#b5c6a94d";
    ctx.lineWidth = 0.5;
    for (const cell of cellCache.keys()) {
      cellPath(cell);
      ctx.stroke();
    }
  }
  if (activePanel === "sector") drawSector(model?.player);
  for (const [cell, id] of ownerCells()) {
    const owner = playerById(id), color = mapColor(owner?.faction);
    cellPath(cell);
    ctx.fillStyle = color + "ad";
    ctx.fill();
    if (zoom >= 256) {
      ctx.strokeStyle = "#fffefa85";
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
    ctx.fillStyle = "#87a5a6";
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
      ctx.fillStyle = "#8c9f7b";
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = "11px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif";
      ctx.fillStyle = "#7c906c";
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
    const own = p.id === account?.id, r = own ? 20 : 16, color = mapColor(p.faction);
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, r + 3, 0, Math.PI * 2);
    ctx.fillStyle = "#334a3412";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
    ctx.fillStyle = "#fffefa";
    ctx.fill();
    ctx.strokeStyle = own ? "#799b6e" : color + "55";
    ctx.lineWidth = own ? 2 : 1;
    ctx.stroke();
    const emblem = emblems.get(p.faction);
    if (emblem?.complete && emblem.naturalWidth) ctx.drawImage(emblem, pos.x - r + 3, pos.y - r + 3, r * 2 - 6, r * 2 - 6);
    else {
      ctx.fillStyle = color;
      ctx.fillRect(pos.x - 3, pos.y - 3, 6, 6);
    }
    if (own) {
      const label = `${p.name} · ${p.level} ур.`;
      ctx.font = "500 11px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif";
      const width = ctx.measureText(label).width + 18;
      ctx.fillStyle = "#fffefaed";
      ctx.beginPath();
      ctx.roundRect(pos.x - width / 2, pos.y + r + 8, width, 24, 8);
      ctx.fill();
      ctx.textAlign = "center";
      ctx.fillStyle = "#59724f";
      ctx.fillText(label, pos.x, pos.y + r + 24);
      ctx.textAlign = "left";
    }
  }
  for (let i = effects.length - 1; i >= 0; i--) {
    const e = effects[i], age = (now - e.at) / 1500;
    if (age > 1) {
      effects.splice(i, 1);
      continue;
    }
    const [lat, lng] = cellToLatLng(e.cell), p = project(lat, lng);
    if (p.x < 0 || p.x > cw || p.y < 0 || p.y > ch) continue;
    ctx.globalAlpha = (1 - age) * 0.6;
    ctx.strokeStyle = mapColor(playerById(e.owner)?.faction);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3 + age * 8, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  if (mouse && placing && zoom >= 256) {
    const p = atPoint(mouse.x, mouse.y), cell = latLngToCell(p.lat, p.lng, 8);
    cellPath(cell);
    ctx.fillStyle = cellIsLand(cell) ? "#6c9c7477" : "#c8847155";
    ctx.fill();
  }
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
      for (const t of result.tiles || []) {
        if (t.unchanged) continue;
        const old = tileCache.get(t.parent), cells = t.full ? /* @__PURE__ */ new Map() : new Map(old?.cells || []);
        if (t.full) {
          for (const [owner, bits] of Object.entries(t.owners || {})) for (const cell of decodeTile(t.parent, bits)) cells.set(cell, owner);
        } else for (const change of t.changes || []) {
          if (change.owner) {
            cells.set(change.cell, change.owner);
            if (effects.length < 100) effects.push({ cell: change.cell, owner: change.owner, at: performance.now() });
          } else cells.delete(change.cell);
        }
        tileCache.set(t.parent, { version: t.version, cells });
      }
    }
    if (tileCache.size > 300) {
      const keep = visible;
      for (const key of tileCache.keys()) if (!keep.has(key) && tileCache.size > 100) tileCache.delete(key);
    }
    dirty = true;
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
  home();
}
canvas.addEventListener("pointerdown", (e) => {
  canvas.setPointerCapture(e.pointerId);
  drag = { x: e.clientX, y: e.clientY, panX, panY };
  moved = false;
});
canvas.addEventListener("pointermove", (e) => {
  if (drag) {
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.hypot(dx, dy) > 5) moved = true;
    if (moved) {
      panX = drag.panX + dx;
      panY = drag.panY + dy;
      clampPan();
      dirty = true;
      lastDetails = 0;
      $("mapTooltip").hidden = true;
      return;
    }
  }
  mouse = pointFor(e);
  const p = atPoint(mouse.x, mouse.y);
  if (zoom >= 256) {
    const cell = latLngToCell(p.lat, p.lng, 8), owner = ownerCells().get(cell), known = playerById(owner);
    $("mapTooltip").textContent = known ? `${known.name} · ${getFaction(known.faction).name}` : owner ? "Занятая ячейка" : cellIsLand(cell) ? "Свободная ячейка" : "Вода";
    $("mapTooltip").style.left = `${Math.max(8, Math.min(cw - 225, mouse.x + 12))}px`;
    $("mapTooltip").style.top = `${Math.max(35, mouse.y - 38)}px`;
    $("mapTooltip").hidden = false;
  }
  dirty = true;
});
canvas.addEventListener("pointerup", async (e) => {
  const didMove = moved;
  drag = null;
  if (didMove) {
    refreshTiles();
    return;
  }
  const point = pointFor(e), p = atPoint(point.x, point.y), cell = latLngToCell(p.lat, p.lng, 8);
  if (placing) {
    const result = await action("/api/base", { cell, azimuth: Number($("startAzimuth").value), faction: selectedFaction, name: account.name }, "База основана. Сектор активирован.");
    if (result) {
      placing = false;
      $("placementHint").hidden = true;
      $("mapTooltip").hidden = true;
      canvas.classList.remove("placement");
      await refreshLeaderboard();
      home();
      appendEvent("База основана. Началась экспансия.", "base-founded");
    }
  } else if (selecting && model?.player) {
    if (ownerCells().get(cell) === account.id && cell !== model.player.baseCell) {
      selectedCells.has(cell) ? selectedCells.delete(cell) : selectedCells.add(cell);
      updateUI();
      dirty = true;
    } else toast("Можно выделить только свою территорию, кроме базы.", true);
  } else if (zoom < 256) {
    focusAt(p.lat, p.lng, 384);
  }
});
canvas.addEventListener("pointerleave", () => {
  mouse = null;
  $("mapTooltip").hidden = true;
});
canvas.addEventListener("pointercancel", () => drag = null);
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
};
$("factionPicker").onclick = (e) => {
  const b = e.target.closest("[data-faction]");
  if (b) {
    selectedFaction = b.dataset.faction;
    updateFaction();
    beep(400);
  }
};
$("factionPreview").onclick = () => $("factionsDialog").showModal();
$("factionsBtn").onclick = () => $("factionsDialog").showModal();
$("helpBtn").onclick = () => {
  closeAccount();
  $("helpDialog").showModal();
};
$("syncBtn").onclick = () => refreshState(true);
$("soundBtn").onclick = () => {
  sound = !sound;
  $("soundState").textContent = sound ? "Включены" : "Выключены";
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
  $("telegramWidget").appendChild(script);
};
$("telegramLogin").onclick = () => {
  const username = providers.telegram?.botUsername;
  if (!/^[A-Za-z0-9_]{5,32}$/.test(username || "")) return;
  const url = "https://t.me/" + username;
  if (window.Telegram?.WebApp?.openTelegramLink) window.Telegram.WebApp.openTelegramLink(url);
  else location.assign(url);
};
$("logoutBtn").onclick = async () => {
  await action("/api/auth/logout", {});
  tileCache.clear();
  await refreshAuth();
};
$("fundBtn").onclick = async () => {
  const raw = $("fundAmount").value;
  await action("/api/upgrades/fund", { amount: raw ? Number(raw) : "all" }, "Заряд вложен в проект.");
};
$("skipBtn").onclick = () => action("/api/crystals/spend", { kind: "skip" }, "Строительство завершено.");
$("azimuth").oninput = () => {
  $("azimuthValue").textContent = `${$("azimuth").value}°`;
};
$("startAzimuth").oninput = () => {
  $("startBearing").textContent = `${$("startAzimuth").value}°`;
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
  dirty = true;
};
$("cancelSelection").onclick = () => {
  selecting = false;
  selectedCells.clear();
  updateUI();
  dirty = true;
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
  $("shopNotice").textContent = shop.payments.enabled ? "Выберите кристаллы или VIP для своей базы." : "Покупки скоро откроются. Кристаллы уже можно получать в наградах.";
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
  welcomeDismissed = true;
  closePanels();
  $("authCard").hidden = true;
  $("spawnCard").hidden = true;
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
  if (e.target.matches("input,textarea") || document.querySelector("dialog[open]")) return;
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
    dirty = true;
  }
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshState();
});
new ResizeObserver(fit).observe($("mapViewport"));
function frame(now) {
  if (now - lastRender > 32 && (dirty || effects.length)) {
    draw(now);
    lastRender = now;
    dirty = false;
  }
  requestAnimationFrame(frame);
}
async function init() {
  renderFactions();
  fit();
  updateUI();
  requestAnimationFrame(frame);
  try {
    await api("/api/config");
    await initAuth();
    await refreshLeaderboard();
    $("mapLoading").hidden = true;
    if (account && !model?.player && !welcomeDismissed) $("spawnCard").hidden = false;
    setInterval(() => {
      if (!document.hidden) refreshState();
    }, 5e3);
    setInterval(updateUI, 1e3);
  } catch (e) {
    $("mapLoading").innerHTML = '<span>Не удалось открыть мир.</span><button id="retryConnect" class="secondary-button">Повторить</button>';
    document.getElementById("retryConnect").onclick = () => location.reload();
  }
}
init();
