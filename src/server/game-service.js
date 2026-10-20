import { gridDisk, gridDistance, isValidCell, getResolution, cellToLatLng, greatCircleDistance, latLngToCell } from 'h3-js';
import { CONFIG, FACTIONS, getFaction } from '../shared/config.js';
import { deriveLevel, netIncome, optimumNetIncome, upgradeCost, upgradeDurationMs, storageCapacity, skipCost, powerAt } from '../shared/economy.js';
import { advanceProgression, progressionArrivalTime } from '../shared/progression.js';
import { ABILITIES, abilityDefinition, factionAbilityName, captureMultiplierAt } from '../shared/abilities.js';
import { CATALOG } from '../shared/catalog.js';
import { resolveCombat } from '../shared/combat.js';
import { troopDeployment } from '../shared/troops.js';
import { createArmy, advanceArmies, publicArmy, reconcileArmy, findRoute } from './npc-simulation.js';
import { traversable, adjacentCells } from '../shared/landscape.js';
import { aggregateOverview, mapEntry } from './map-overview.js';
import { nearbyPlayerIds, indexPlayer, projectedRadius } from './spatial-index.js';
export { CATALOG } from '../shared/catalog.js';
import { sectorCellIterator, terrainForCell, validatePlayableCell, tileForCell, encodeTile, decodeTile } from '../shared/geography.js';
import { isClanHallCell } from '../shared/clan-hall.js';
import { UNIT_GROUP_LIMIT, UNIT_CONTROL_SLOTS, controlGroups, groupOrderMode } from '../shared/unit-orders.js';
import { playerProfile, promotionUrl } from '../shared/player-profile.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// This limit is deliberately immutable: production must never disable the payment safeguard.
const PAID_ENERGY_HOURS_PER_DAY = 16;

export class GameError extends Error {
  constructor(message, status = 400, code = 'INVALID_ACTION') { super(message); this.status = status; this.code = code; }
}

function fail(condition, message, status = 400, code) { if (!condition) throw new GameError(message, status, code); }
const hash = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value))))].map(b => b.toString(16).padStart(2, '0')).join('');
const dayAt = time => new Date(time).toISOString().slice(0, 10);
const clone = value => structuredClone(value);
const factionId = faction => typeof faction === 'string' ? faction : faction?.id;
const distance = (a, b) => { try { return gridDistance(a, b); } catch { return Infinity; } };
const validCell = cell => typeof cell === 'string' && isValidCell(cell) && getResolution(cell) === 8;
const normalizeAngle = value => ((value % 360) + 360) % 360;

// With discrete authoritative ownership the continuous upkeep integral is
// piecewise constant between claim arrivals, rather than a hypothetical area.
function settleActualEnergy(start, captures, now) {
  let energy = start.energy, pixels = start.energyPixels ?? start.pixels;
  let terrain = start.energyTerrainAverage ?? start.terrainAverage ?? 1, cursor = start.energyTLast ?? start.tLast;
  const timeline = start.levelTimeline ?? [{ at: start.createdAt, level: start.level }];
  let level = [...timeline].reverse().find(event => event.at <= cursor)?.level ?? 1;
  const events = [...captures.filter(c => c.at <= now), ...timeline.filter(event => event.at > cursor && event.at <= now)];
  events.push({ at: now });
  events.sort((a, b) => a.at - b.at);
  for (const event of events) {
    const at = Math.max(cursor, Math.min(now, event.at));
    const delta = netIncome(pixels, level, terrain, start.faction) * (at - cursor) / HOUR;
    const storage = storageCapacity(level, terrain, start.faction);
    if (delta <= 0) energy = Math.max(0, energy + delta);
    else {
      const room = Math.max(0, storage - energy);
      energy = Math.min(storage * 3, energy + Math.min(room, delta) + Math.max(0, delta - room) * 0.25);
    }
    if (event.delta) { terrain = (terrain * pixels + event.terrain * event.delta) / (pixels + event.delta); pixels += event.delta; }
    if (event.level) level = event.level;
    cursor = at;
  }
  return { energy, energyPixels: pixels, energyTerrainAverage: terrain, energyTLast: now };
}

class Transaction {
  constructor(store) { this.store = store; this.rows = new Map(); this.dirty = new Set(); this.deleted = new Set(); this.settled = new Set(); this.reads = new Set(); this.tiles = new Map(); this.initialPlayers = new Map(); this.captureEvents = new Map(); }
  async get(key) {
    this.reads.add(key);
    if (!this.rows.has(key)) this.rows.set(key, await this.store.get(key));
    return this.rows.get(key)?.value ?? null;
  }
  seed(row) { if (!this.rows.has(row.key)) this.rows.set(row.key, { value: clone(row.value), version: row.version }); }
  async put(key, value) { await this.get(key); this.rows.get(key) ? this.rows.get(key).value = value : this.rows.set(key, { value, version: null }); this.dirty.add(key); this.deleted.delete(key); }
  async delete(key) { await this.get(key); this.deleted.add(key); this.dirty.delete(key); }
  flushTile(tile) {
    if (!tile._needsEncoding) return;
    const grouped = new Map();
    for (const [index, id] of tile._cells) { if (!grouped.has(id)) grouped.set(id, []); grouped.get(id).push(index); }
    tile.owners = Object.fromEntries([...grouped].map(([id, cells]) => [id, encodeTile(tile.parent, cells).bitmask]));
    tile._needsEncoding = false;
  }
  async commit() {
    for (const tile of this.tiles.values()) this.flushTile(tile);
    return this.store.atomic({
      checks: [...this.reads].map(key => ({ key, version: this.rows.get(key)?.version ?? null })),
      puts: [...this.dirty].map(key => ({ key, value: this.rows.get(key).value })),
      deletes: [...this.deleted],
    });
  }
}

/** Server-authoritative lazy MMO state. Only packed tile masks persist normal cells. */
export class GameService {
  constructor({ store, clock = () => Date.now(), config = {} }) {
    this.store = store; this.clock = clock;
    this.config = { seasonId: 'genesis-2026', shieldHours: CONFIG.NEW_PLAYER_SHIELD_HOURS ?? 48,
      rotateCooldownHours: CONFIG.ROTATE_COOLDOWN_HOURS ?? 24, rotateCrystalCost: CONFIG.ROTATE_CRYSTAL_COST ?? 20,
      maxNewCells: 1024, battleThreshold: CONFIG.COMBAT_RATIO_THRESHOLD ?? 1.15,
      battleCellsPerContactHour: CONFIG.COMBAT_CONTACT_CELLS_PER_HOUR ?? 0.5,
      abandonCooldownHours: 6, abandonLockHours: 12,
      npcEnabled: true, ...config };
  }

  async transaction(fn) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const tx = new Transaction(this.store);
      const result = await fn(tx, this.clock());
      if (!tx.dirty.size && !tx.deleted.size) return result;
      if (await tx.commit()) {if([...tx.dirty].some(key=>key.startsWith('spatial:')))this.mapEntriesCache=null;return result;}
    }
    throw new GameError('Мир изменился одновременно с запросом. Повторите действие.', 409, 'CONCURRENT_UPDATE');
  }

  async loadPlayers(tx, centers) {
    await tx.get(`world-index:${this.config.seasonId}`);
    const ids = await nearbyPlayerIds(this.store, tx, this.config.seasonId, centers);
    const players = [];
    for (const id of ids) { const player = await tx.get(`player:${id}`); if (player) players.push(player); }
    return players;
  }

  async tile(tx, parent) {
    if (tx.tiles.has(parent)) return tx.tiles.get(parent);
    const key = `tile:${parent}`;
    const stored = await tx.get(key);
    const data = stored ?? { parent, revision: 0, owners: {}, locks: {}, history: [] };
    if (!data._cells) {
      Object.defineProperty(data, '_cells', { value: new Map(), configurable: true });
      Object.defineProperty(data, '_needsEncoding', { value: false, writable: true });
      for (const [owner, bits] of Object.entries(data.owners)) for (const cell of decodeTile(parent, bits)) data._cells.set(cell, owner);
    }
    tx.tiles.set(parent, data);
    return data;
  }

  async owner(tx, cell) { return (await this.tile(tx, tileForCell(cell)))._cells.get(cell) ?? null; }

  async writeOwner(tx, cell, owner, now, lockUntil = null) {
    const tile = await this.tile(tx, tileForCell(cell));
    const previous = tile._cells.get(cell) ?? null;
    if (previous === owner && !lockUntil) return;
    if (owner) tile._cells.set(cell, owner); else tile._cells.delete(cell);
    if (lockUntil) tile.locks[cell] = lockUntil; else if (tile.locks[cell] <= now) delete tile.locks[cell];
    tile.revision++;
    tile.history.push({ version: tile.revision, cell, owner, previous, at: now });
    tile.history = tile.history.slice(-512);
    tile._needsEncoding = true;
    await tx.put(`tile:${tile.parent}`, tile);
  }

  publicPlayer(player, now) {
    if (!player) return null;
    const stats = deriveLevel(player.level, player.faction);
    const income = netIncome(player.pixels, player.level, player.terrainAverage ?? 1, player.faction);
    const net = typeof income === 'number' ? income : income.net;
    const faction = getFaction(player.faction);
    const gross = CONFIG.ENERGY_PER_PIXEL_HOUR * stats.levelMultiplier * player.pixels * (player.terrainAverage ?? 1) * faction.income;
    const upkeep = CONFIG.ENERGY_PER_PIXEL_HOUR * stats.levelMultiplier * stats.cap * (player.pixels / stats.cap) ** CONFIG.UPKEEP_BETA * faction.upkeep;
    const cost = player.level < 30 ? upgradeCost(player.level) : null;
    const project = player.level < 30 ? { targetLevel: player.level + 1, invested: player.upgradeInvestment ?? 0,
      cost, status: player.upgradeCompletesAt ? 'building' : 'funding', startedAt: player.upgradeStartedAt ?? null,
      completesAt: player.upgradeCompletesAt ?? null, durationMs: upgradeDurationMs(player.level) } : null;
    const { fingerprintHash, seed, captureDebts, captureCursors, levelTimeline, energyPixels, energyTerrainAverage,
      stripeCustomerId, stripeSubscriptionId, borderCells, frontierBirths, abilities, abilityReceipts, army, ...safe } = player;
    const multiplier = captureMultiplierAt(player, now);
    return { ...safe, pixels: Math.floor(player.pixels), cap: stats.cap, sectorAngle: stats.sectorAngle ?? stats.angle,
      capturePerHour: stats.capturePerHour * multiplier, baseCapturePerHour: stats.capturePerHour,
      captureMultiplier: multiplier, netPerHour: net, grossPerHour: gross,
      troops: troopDeployment(player, now), frontier: (borderCells ?? [player.baseCell]).slice(0, 8),
      army: publicArmy(army, now), unitGroups: controlGroups(player), unitGroupsVersion: player.unitGroupsVersion||0,
      abilities: ABILITIES.map(definition => ({ ...definition, name: factionAbilityName(player.faction, definition.id),
        readyAt: abilities?.[definition.id]?.readyAt ?? 0, activeFrom: abilities?.[definition.id]?.activeFrom ?? 0,
        activeUntil: abilities?.[definition.id]?.activeUntil ?? 0 })),
      upkeepPerHour: upkeep, storage: storageCapacity(player.level, player.terrainAverage ?? 1, player.faction),
      optimumNetPerHour: optimumNetIncome(player.level, player.terrainAverage ?? 1, player.faction),
      project, queuedProject: player.queuedProject ?? null, catchingUp: (player.pendingCaptures ?? 0) > 0,
      daily: { availableAt: Math.max(player.accountCreatedAt + 72 * HOUR, new Date(`${dayAt(now)}T00:00:00.000Z`).getTime()),
        claimed: player.dailyClaimDay === dayAt(now), reward: 40 },
      paidEnergy: { hoursUsed: player.paidEnergyDay === dayAt(now) ? player.paidEnergyHours ?? 0 : 0, maxHours: PAID_ENERGY_HOURS_PER_DAY },
      queueSlots: player.vipUntil > now ? 2 : 1, subscriptionActive: player.vipUntil > now && Boolean(stripeSubscriptionId) };
  }

  async model(tx, accountId, now, conflicts = []) {
    const player = await tx.get(`player:${accountId}`);
    return { serverTime: now, seasonId: this.config.seasonId, player: this.publicPlayer(player, now),
      factions: Object.values(FACTIONS), conflicts, region: CONFIG.REGION,
      notices: ['Общий серверный мир. Захват и экономика считаются по серверному времени.',
        'Карта рельефа и баланс предварительные; покупка второй базы и передача ресурсов отключены.'] };
  }

  /** Resolve the interacting component before answering or changing it. No global recurring tick. */
  async settle(tx, accountId, now) {
    if (tx.settled.has(accountId)) return [];
    const own = await tx.get(`player:${accountId}`);
    if (!own) return [];
    const all = await this.loadPlayers(tx, [{ cell: own.baseCell, radiusRings: projectedRadius(own) }]);
    if (!all.some(p => p.id === own.id)) all.push(own);
    // The spatial index already computes the complete interacting component.
    const players = all;
    for (const p of players) {
      tx.settled.add(p.id);
      for (const parent of new Set([tileForCell(p.baseCell), ...(p.contactTiles ?? [])])) await this.tile(tx, parent);
    }
    for (const p of players) {
      if (!tx.initialPlayers.has(p.id)) tx.initialPlayers.set(p.id, clone(p));
      if (!tx.captureEvents.has(p.id)) tx.captureEvents.set(p.id, []);
    }
    const captures = tx.captureEvents;
    const initialPlayers = tx.initialPlayers;
    if (this.config.npcEnabled) return this.settleArmies(tx, players, accountId, now);
    if (players.length > 1) return this.settleCoupled(tx, players, accountId, now);
    const initialPixels = new Map(players.map(p => [p.id, p.pixels]));
    for (const original of players) {
      const pending = (original.captureDebts ?? []).reduce((sum, debt) => sum + debt.endOrdinal - debt.nextOrdinal + 1, 0);
      const anchor = { ...original, pixels: original.pixels + pending + (original.growthRemainder ?? 0) };
      delete anchor.captureDebts; delete anchor.captureCursors; delete anchor.contactTiles;
      const advanced = advanceProgression(anchor, now);
      Object.assign(original, advanced);
      original.growthRemainder = original.pixels - Math.floor(original.pixels);
      const first = Math.floor(anchor.pixels) + 1, last = Math.floor(original.pixels);
      original.pixels = initialPixels.get(original.id);
      original.captureDebts ??= [];
      original.captureCursors ??= {};
      if (last >= first) original.captureDebts.push({ anchor: {
        pixels: anchor.pixels, tLast: anchor.tLast, level: anchor.level, faction: anchor.faction,
        upgradeTargetLevel: anchor.upgradeTargetLevel, upgradeStartedAt: anchor.upgradeStartedAt,
        upgradeCompletesAt: anchor.upgradeCompletesAt, queuedProject: anchor.queuedProject,
        azimuth: anchor.azimuth, levelTimeline: anchor.levelTimeline,
        abilities: clone(anchor.abilities ?? {}),
      }, nextOrdinal: first, endOrdinal: last });
    }
    // Simultaneous contenders are ordered by theoretical arrival time, then stable account id.
    // A blocked destination is skipped at that same arrival slot, so coastlines redirect expansion.
    const events = [];
    const changedCells = new Set();
    for (const p of players) {
      let budget = this.config.maxNewCells;
      for (const debt of p.captureDebts) {
        for (let ordinal = debt.nextOrdinal; ordinal <= debt.endOrdinal && budget > 0; ordinal++, budget--) {
          const at = progressionArrivalTime(debt.anchor, ordinal);
          events.push({ player: p, debt, at: Math.min(now, at), ordinal });
        }
        if (!budget) break;
      }
    }
    events.sort((a, b) => a.at - b.at || a.player.id.localeCompare(b.player.id));
    const iterators = new Map();
    for (const event of events) {
      const p = event.player;
      if (event.ordinal < event.debt.nextOrdinal) continue;
      const level = [...(p.levelTimeline ?? [])].reverse().find(item => item.at <= event.at)?.level ?? event.debt.anchor.level;
      const azimuth = event.debt.anchor.azimuth, cursorKey = `${level}:${azimuth}`, key = `${p.id}:${cursorKey}`;
      if (!iterators.has(key)) {
        const cursor = p.captureCursors[cursorKey] ?? { ring: 0, offset: 0 };
        iterators.set(key, sectorCellIterator(p.baseCell, level, azimuth, p.seed,
          { startRing: cursor.ring, startOffset: cursor.offset, maxRings: Math.ceil(deriveLevel(level).radiusRings * 4), isLand: validatePlayableCell }));
      }
      let claimed = false;
      while (true) {
        const step = iterators.get(key).next();
        if (step.done) break;
        const candidate = step.value;
        const { cell } = candidate, tile = await this.tile(tx, tileForCell(cell));
        p.captureCursors[cursorKey] = { ring: candidate.nextRing, offset: candidate.nextOffset };
        if (tile._cells.has(cell) || tile.locks[cell] > event.at) continue;
        await this.writeOwner(tx, cell, p.id, event.at);
        changedCells.add(cell);
        p.pixels++;
        const terrain = terrainForCell(cell);
        const multiplier = typeof terrain === 'number' ? terrain : terrain?.multiplier ?? terrain?.yieldMultiplier ?? 1;
        p.terrainAverage = ((p.terrainAverage ?? 1) * (p.pixels - 1) + multiplier) / p.pixels;
        captures.get(p.id).push({ cell, at: event.at, delta: 1, terrain: multiplier });
        event.debt.nextOrdinal++;
        claimed = true;
        break;
      }
      if (!claimed) { p.expansionBlocked = (p.expansionBlocked ?? 0) + event.debt.endOrdinal - event.debt.nextOrdinal + 1; event.debt.nextOrdinal = event.debt.endOrdinal + 1; }
    }
    await this.refreshFrontier(tx, players, changedCells);
    for (const p of players) {
      p.captureDebts = p.captureDebts.filter(debt => debt.nextOrdinal <= debt.endOrdinal);
      p.pendingCaptures = p.captureDebts.reduce((sum, debt) => sum + debt.endOrdinal - debt.nextOrdinal + 1, 0);
      const horizon = p.captureDebts.length ? Math.min(now, progressionArrivalTime(p.captureDebts[0].anchor, p.captureDebts[0].nextOrdinal)) : now;
      p._energyHorizon = horizon;
    }
    const conflicts = await this.resolveBattles(tx, players, now);
    for (const p of players) {
      Object.assign(p, settleActualEnergy({ ...initialPlayers.get(p.id), levelTimeline: p.levelTimeline }, captures.get(p.id), p._energyHorizon));
      delete p._energyHorizon;
      p.desiredPixels = p.pixels + p.pendingCaptures;
      if (!p.pendingCaptures) { p.energyPixels = p.pixels; p.energyTerrainAverage = p.terrainAverage; }
      p.tLast = now;
      await tx.put(`player:${p.id}`, p);
      await indexPlayer(tx, p);
    }
    return conflicts.filter(c => c.players.includes(accountId));
  }

  async settleCoupled(tx, players, accountId, now) {
    for (const p of players) {
      const advanced = advanceProgression(p, now);
      // Construction is deterministic in server time. Land and income are
      // resolved by the combined claim/war event clock, never projected first.
      for (const field of ['level', 'levelTimeline', 'upgradeTargetLevel', 'upgradeStartedAt', 'upgradeCompletesAt', 'upgradeInvestment', 'queuedProject']) p[field] = advanced[field] ?? null;
      p.captureCursors ??= {};
      p.pendingCaptures = 0;
    }
    const conflicts = await this.resolveBattles(tx, players, now, { coupled: true });
    for (const p of players) {
      Object.assign(p, settleActualEnergy({ ...tx.initialPlayers.get(p.id), levelTimeline: p.levelTimeline }, tx.captureEvents.get(p.id), now));
      p.tLast = now; p.energyTLast = now; p.energyPixels = p.pixels; p.energyTerrainAverage = p.terrainAverage;
      p.desiredPixels = p.pixels; p.pendingCaptures = 0; p.captureDebts = [];
      await tx.put(`player:${p.id}`, p); await indexPlayer(tx, p);
    }
    return conflicts.filter(c => c.players.includes(accountId));
  }

  async settleArmies(tx, players, accountId, now) {
    const armies = new Map(), changed = new Set(), byId = new Map(players.map(p => [p.id,p]));
    for (const p of players) {
      const advanced = advanceProgression(p, now);
      for (const field of ['level','levelTimeline','upgradeTargetLevel','upgradeStartedAt','upgradeCompletesAt','upgradeInvestment','queuedProject']) p[field] = advanced[field] ?? null;
      p.army ??= createArmy(p, now);
      armies.set(p.id,p.army);
    }
    await advanceArmies({ players,armies,now,
      owner: cell => this.owner(tx,cell),
      locked: async (cell,at) => (await this.tile(tx,tileForCell(cell))).locks[cell] > at,
      claim: async (cell,previous,id,at) => {
        const p=byId.get(id), defender=byId.get(previous);
        if (!p || await this.owner(tx,cell)!==previous || players.some(other=>other.baseCell===cell)
          || previous&&!defender || defender&&((defender.shieldUntil||0)>at||(p.shieldUntil||0)>at)) return false;
        const multiplier=terrainForCell(cell).multiplier||1;
        await this.writeOwner(tx,cell,id,at);changed.add(cell);
        p.terrainAverage=((p.terrainAverage||1)*p.pixels+multiplier)/(p.pixels+1);p.pixels++;
        tx.captureEvents.get(id).push({cell,at,terrain:multiplier,delta:1});
        if(defender){defender.terrainAverage=((defender.terrainAverage||1)*defender.pixels-multiplier)/Math.max(1,defender.pixels-1);defender.pixels--;
          tx.captureEvents.get(previous).push({cell,at,terrain:multiplier,delta:-1});p.battlesWon=(p.battlesWon||0)+1;}
        // Routes in the same simulation discover the newly connected frontier.
        await this.refreshFrontier(tx,players,[cell]);
        return true;
      },
    });
    for(const p of players){
      Object.assign(p,settleActualEnergy({...tx.initialPlayers.get(p.id),levelTimeline:p.levelTimeline},tx.captureEvents.get(p.id),now));
      p.tLast=now;p.energyTLast=now;p.energyPixels=p.pixels;p.energyTerrainAverage=p.terrainAverage;
      p.pendingCaptures=0;p.captureDebts=[];p.desiredPixels=p.pixels;
      await tx.put(`player:${p.id}`,p);await indexPlayer(tx,p);
    }
    const fronts=await this.borderContacts(tx,players), grouped=new Map();
    for(const edge of fronts){const id=[edge.aId,edge.bId].sort().join(':');if(!grouped.has(id))grouped.set(id,[]);grouped.get(id).push(edge);}
    return [...grouped].map(([id,edges])=>({id,players:id.split(':'),fronts:edges.slice(0,6),lastResolvedAt:now,
      status:players.filter(p=>id.split(':').includes(p.id)).some(p=>p.shieldUntil>now)?'shielded':'active',contactLength:edges.length}));
  }

  async commandArmy(accountId, input={}) {
    fail(['expand','defend','attack'].includes(input.mode),'Неизвестный приказ.');
    return this.action(accountId, async (p,tx,now) => {
      fail(this.config.npcEnabled,'Войска пока недоступны.');
      if(input.mode==='attack'){
        fail(validCell(input.cell)&&traversable(input.cell,'air',p.baseCell),'Укажите цель в игровом регионе.');
        fail(distance(p.baseCell,input.cell)<=Math.max(12,projectedRadius(p)+8),'Цель слишком далеко.');
      }
      p.army??=createArmy(p,now);p.army.order={mode:input.mode,cell:input.mode==='attack'?input.cell:null};
      for(const u of p.army.units){delete u.order;u.path=[];u.targetCell=null;u.waitUntil=0;u.blockedGoals={};u.activity=input.mode==='defend'?'guard':'advance';}
    });
  }

  async commandUnit(accountId,input={}){
    fail(['move','attack','capture','hold','auto'].includes(input.mode),'Неизвестный приказ отряду.');
    fail(typeof input.unitId==='string'&&input.unitId.length<=160,'Укажите отряд.');
    return this.action(accountId,async(p,tx,now)=>{
      fail(this.config.npcEnabled,'Войска пока недоступны.');
      const unit=this.commandableUnit(p,input.unitId);
      const plan=await this.planUnitOrder(p,unit,input.mode,input.cell,tx,now);
      this.applyUnitOrder(unit,plan,now);
    });
  }

  async commandUnits(accountId,input={}){
    fail(['move','attack','capture','hold','auto'].includes(input.mode),'Неизвестный приказ группе.');
    const ids=input.unitIds;
    fail(Array.isArray(ids)&&ids.length>0&&ids.length<=UNIT_GROUP_LIMIT&&ids.every(id=>typeof id==='string'&&id.length>0&&id.length<=160)&&new Set(ids).size===ids.length,'Выберите от 1 до 36 разных отрядов.');
    return this.action(accountId,async(p,tx,now)=>{
      fail(this.config.npcEnabled,'Войска пока недоступны.');
      const units=ids.map(id=>this.commandableUnit(p,id)),routes=new Map(),plans=[];
      if(input.mode==='capture')fail(units.some(unit=>unit.type!=='air'),'Авиация сражается, но не захватывает землю.');
      // Prepare every route before changing any order. A failure rejects the
      // entire group transaction; shared routes are planned only once.
      for(const unit of units)plans.push(await this.planUnitOrder(p,unit,groupOrderMode(input.mode,unit),input.cell,tx,now,routes));
      units.forEach((unit,index)=>this.applyUnitOrder(unit,plans[index],now));
    });
  }

  async saveUnitGroup(accountId, input={}) {
    fail(accountId,'Необходим вход.',401,'AUTH_REQUIRED');
    fail(Number.isInteger(input.slot)&&input.slot>=1&&input.slot<=UNIT_CONTROL_SLOTS,'Выберите группу от 1 до 5.');
    const ids=input.unitIds;
    fail(Array.isArray(ids)&&ids.length<=UNIT_GROUP_LIMIT&&ids.every(id=>typeof id==='string'&&id.length>0&&id.length<=160)&&new Set(ids).size===ids.length,'В группе может быть до 36 разных отрядов.');
    // Group membership is account metadata. Saving it must not tick the world,
    // compute routes, change orders, or force a terrain refresh.
    return this.transaction(async tx=>{
      const player=await tx.get(`player:${accountId}`);
      fail(player,'Сначала поставьте базу.',409,'NO_BASE');
      const owned=new Set((player.army?.units||[]).filter(u=>u.owner===accountId&&!u.neutral).map(u=>u.id));
      fail(ids.every(id=>owned.has(id)),'Сохранять можно только свои отряды.',403);
      player.unitGroups=controlGroups(player);
      player.unitGroups[input.slot-1]=[...ids];
      player.unitGroupsVersion=(player.unitGroupsVersion||0)+1;
      await tx.put(`player:${accountId}`,player);
      return {unitGroups:player.unitGroups,unitGroupsVersion:player.unitGroupsVersion};
    });
  }

  commandableUnit(player,id){
    const unit=player.army?.units.find(u=>u.id===id&&!u.neutral&&u.owner===player.id);
    fail(unit,'Можно управлять только своим отрядом.',403);fail(unit.hp>0,'Отряд погиб. Дождитесь возрождения.');
    return unit;
  }

  async planUnitOrder(p,unit,mode,cell,tx,now,routes=new Map()){
    const from=unit.move?.to||unit.cell;
    let goal=mode==='hold'?from:cell,path=[];
    if(['move','attack','capture'].includes(mode)){
      fail(validCell(goal)&&traversable(goal,unit.type,p.baseCell),'Выберите проходимый гекс в игровом регионе.');
      fail(distance(from,goal)<=64,'Цель слишком далеко: не более 64 гексов от отряда.');
      fail(distance(p.baseCell,goal)<=Math.max(12,projectedRadius(p)+8),'Цель за пределами радиуса действий базы.');
      fail(!((await this.tile(tx,tileForCell(goal))).locks[goal]>now),'Этот гекс временно заблокирован.');
      const previous=await this.owner(tx,goal),defender=previous&&previous!==p.id?await tx.get('player:'+previous):null;
      if(['attack','capture'].includes(mode))fail(!defender||((defender.shieldUntil||0)<=now&&(p.shieldUntil||0)<=now),'Территорию защищает щит.');
      if(mode==='capture'){
        fail(!isClanHallCell(goal), 'Великий Кланхолл защищён. Ивент откроется в следующем сезоне.', 403, 'EVENT_LOCKED');
        fail(unit.type!=='air','Авиация сражается, но не захватывает землю.');
        fail(goal!==p.baseCell&&goal!==defender?.baseCell,'Захват штаба запрещён.');
        fail(previous!==p.id,'Этот гекс уже принадлежит вам.');
        fail(p.pixels<deriveLevel(p.level,p.faction).cap,'Достигнут лимит территории. Улучшите штаб.');
        fail((await Promise.all(adjacentCells(goal).map(c=>this.owner(tx,c)))).includes(p.id),'Захватывать можно только гекс рядом со своей территорией.');
      }
      const key=[from,goal,unit.type==='air'?'air':'ground'].join(':');
      if(!routes.has(key))routes.set(key,await findRoute(from,goal,{type:unit.type,baseCell:p.baseCell,allowPartial:true,canEnter:async c=>!((await this.tile(tx,tileForCell(c))).locks[c]>now)}));
      path=routes.get(key);
      fail(path!==null,'Путь к этому гексу не найден. Выберите другую цель.');
    }
    return {mode,goal,path};
  }

  applyUnitOrder(unit,{mode,goal,path},now){
    unit.path=[...path];unit.targetId=null;unit.targetCell=mode==='auto'?null:goal;unit.waitUntil=0;unit.blockedGoals={};
    if(mode==='auto'){delete unit.order;unit.activity='advance';}
    else{unit.order={mode,cell:goal,status:unit.move||path.length?'moving':'queued',issuedAt:now,reason:null};unit.activity='command';}
    // The current adjacent step finishes without teleporting, even on retarget.
  }

  async refreshFrontier(tx, players, changedCells) {
    const byId = new Map(players.map(p => [p.id, p]));
    const borders = new Map(players.map(p => [p.id, new Set(p.borderCells ?? [p.baseCell])]));
    const affected = new Set([...changedCells].flatMap(cell => gridDisk(cell, 1)));
    for (const cell of affected) {
      const owner = await this.owner(tx, cell);
      for (const p of players) if (p.id !== owner) { borders.get(p.id).delete(cell); if (p.frontierBirths) delete p.frontierBirths[cell]; }
      const player = byId.get(owner);
      if (!player) continue;
      const adjacent = gridDisk(cell, 1).filter(other => other !== cell);
      const owners = await Promise.all(adjacent.map(other => this.owner(tx, other)));
      player.frontierBirths ??= {};
      if (owners.some(other => other !== owner)) {
        borders.get(owner).add(cell);
        if (!player.frontierBirths[cell]) {
          const tile = await this.tile(tx, tileForCell(cell));
          player.frontierBirths[cell] = [...tile.history].reverse().find(event => event.cell === cell && event.owner === owner)?.at ?? player.createdAt;
        }
      } else { borders.get(owner).delete(cell); delete player.frontierBirths[cell]; }
    }
    for (const p of players) p.borderCells = [...borders.get(p.id)];
    if (tx.contactsCache) for (const cell of changedCells) {
      for (const key of [...(tx.contactByCell.get(cell) ?? [])]) {
        const old = tx.contactsCache.get(key);
        if (!old) continue;
        tx.contactsCache.delete(key);
        tx.contactByCell.get(old.aCell)?.delete(key); tx.contactByCell.get(old.bCell)?.delete(key);
      }
      const owner = await this.owner(tx, cell);
      if (!byId.has(owner)) continue;
      for (const neighbor of gridDisk(cell, 1)) {
        if (neighbor === cell) continue;
        const other = await this.owner(tx, neighbor);
        if (other && other !== owner && byId.has(other)) this.cacheContact(tx, { aId: owner, bId: other, aCell: cell, bCell: neighbor });
      }
    }
  }

  cacheContact(tx, edge) {
    const key = [edge.aCell, edge.bCell].sort().join(':');
    tx.contactsCache.set(key, edge);
    for (const cell of [edge.aCell, edge.bCell]) {
      if (!tx.contactByCell.has(cell)) tx.contactByCell.set(cell, new Set());
      tx.contactByCell.get(cell).add(key);
    }
  }

  async borderContacts(tx, players) {
    const byId = new Map(players.map(p => [p.id, p]));
    tx.contactsCache ??= new Map(); tx.contactByCell ??= new Map(); tx.contactInitializedPlayers ??= new Set();
    for (const p of players) if (!tx.contactInitializedPlayers.has(p.id)) {
      tx.contactInitializedPlayers.add(p.id);
      for (const cell of p.borderCells ?? [p.baseCell]) {
      if (await this.owner(tx, cell) !== p.id) continue;
      for (const neighbor of gridDisk(cell, 1)) {
        if (neighbor === cell) continue;
        const other = await this.owner(tx, neighbor);
        if (!other || other === p.id || !byId.has(other)) continue;
        this.cacheContact(tx, { aId: p.id, bId: other, aCell: cell, bCell: neighbor });
      }
      }
    }
    return [...tx.contactsCache.values()].filter(edge => byId.has(edge.aId) && byId.has(edge.bId));
  }

  async resolveBattles(tx, players, now, { coupled = false } = {}) {
    if (players.some(player => player.pendingCaptures)) return [];
    const byId = new Map(players.map(player => [player.id, player]));
    const initialContacts = await this.borderContacts(tx, players);
    if (!initialContacts.length && !coupled) return [];
    const prior = new Map();
    for (const edge of initialContacts) {
      const id = [edge.aId, edge.bId].sort().join(':');
      if (!prior.has(id)) prior.set(id, await tx.get(`conflict:${id}`));
    }
    const iterators = new Map();
    const result = await resolveCombat({ players, now, initialPlayers: tx.initialPlayers, captures: tx.captureEvents,
      prior, config: this.config,
      growth: coupled ? { claim: async ({ playerId, at, level, azimuth }) => {
        const player = byId.get(playerId), cursorKey = `${level}:${azimuth}`, key = `${playerId}:${cursorKey}`;
        if (!iterators.has(key)) {
          const cursor = player.captureCursors[cursorKey] ?? { ring: 0, offset: 0 };
          iterators.set(key, sectorCellIterator(player.baseCell, level, azimuth, player.seed,
            { startRing: cursor.ring, startOffset: cursor.offset, maxRings: Math.ceil(deriveLevel(level).radiusRings * 4), isLand: validatePlayableCell }));
        }
        while (true) {
          const step = iterators.get(key).next();
          if (step.done) return null;
          const candidate = step.value, tile = await this.tile(tx, tileForCell(candidate.cell));
          player.captureCursors[cursorKey] = { ring: candidate.nextRing, offset: candidate.nextOffset };
          if (tile._cells.has(candidate.cell) || tile.locks[candidate.cell] > at) continue;
          await this.writeOwner(tx, candidate.cell, playerId, at);
          await this.refreshFrontier(tx, players, [candidate.cell]);
          return { cell: candidate.cell, terrain: terrainForCell(candidate.cell).multiplier ?? 1 };
        }
      } } : undefined,
      contacts: () => this.borderContacts(tx, players),
      readOwner: cell => this.owner(tx, cell),
      readClaimedAt: async (cell, owner) => {
        const player = byId.get(owner);
        if (player?.frontierBirths?.[cell] !== undefined) return player.frontierBirths[cell];
        const tile = await this.tile(tx, tileForCell(cell));
        return [...tile.history].reverse().find(event => event.cell === cell && event.owner === owner)?.at ?? player?.createdAt ?? now;
      },
      transfer: async (cell, from, to, at) => {
        if (await this.owner(tx, cell) !== from) return false;
        await this.writeOwner(tx, cell, to, at);
        await this.refreshFrontier(tx, players, [cell]);
        return true;
      },
    });
    for (const conflict of result.conflicts) await tx.put(`conflict:${conflict.id}`, conflict);
    return result.conflicts;
  }

  async state(accountId) {
    return this.transaction(async (tx, now) => {
      const conflicts = accountId ? await this.settleFully(tx, accountId, now) : [];
      return this.model(tx, accountId, now, conflicts);
    });
  }

  async settleFully(tx, accountId, now) {
    const conflicts = new Map();
    for (let batch = 0; batch < 2048; batch++) {
      for (const conflict of await this.settle(tx, accountId, now)) conflicts.set(conflict.id, conflict);
      const pending = [...tx.settled].some(id => (tx.rows.get(`player:${id}`)?.value?.pendingCaptures ?? 0) > 0);
      if (!pending) return [...conflicts.values()];
      tx.settled.clear();
    }
    throw new GameError('Восстановление большого региона ещё не завершено.', 503, 'WORLD_CATCHUP');
  }

  async placeBase(accountId, input = {}) {
    fail(accountId, 'Войдите через Google или Telegram.', 401, 'AUTH_REQUIRED');
    const { cell, faction = 'protocol', azimuth = 0 } = input;
    fail(!isClanHallCell(cell), 'Территория Великого Кланхолла защищена. Ивент откроется в следующем сезоне.', 403, 'EVENT_LOCKED');
    fail(validCell(cell) && validatePlayableCell(cell), 'База должна находиться на суше в стартовом регионе Ташкента.');
    if(this.config.npcEnabled)fail(traversable(cell),'Штаб нельзя поставить в воде. Выберите берег или сушу.');
    fail(Number.isFinite(azimuth), 'Азимут должен быть числом.');
    fail(Object.values(FACTIONS).some(f => factionId(f) === faction), 'Неизвестная фракция.');
    return this.transaction(async (tx, now) => {
      fail(!await tx.get(`player:${accountId}`), 'У аккаунта уже есть база.', 409, 'BASE_EXISTS');
      const account = await tx.get(`account:${accountId}`);
      fail(account, 'Аккаунт не найден. Войдите заново.', 401, 'AUTH_REQUIRED');
      const players = await this.loadPlayers(tx, [{ cell, radiusRings: 0 }]);
      const fingerprintHash = account.fingerprintHash || (input.fingerprint ? await hash(String(input.fingerprint).slice(0, 256)) : null);
      const fingerprintKey = fingerprintHash ? `placement-device:${fingerprintHash}` : null;
      const fingerprintPlacement = fingerprintKey ? await tx.get(fingerprintKey) : null;
      fail(!fingerprintPlacement || now - fingerprintPlacement.lastPlacedAt >= (CONFIG.BASE_PLACEMENT_COOLDOWN_PER_FINGERPRINT_MS ?? DAY), 'Для устройства действует задержка постановки базы.', 429);
      for (const oldBase of fingerprintPlacement?.bases ?? []) {
        fail(greatCircleDistance(cellToLatLng(cell), cellToLatLng(oldBase), 'km') >= (CONFIG.SAME_FINGERPRINT_MIN_DISTANCE_KM ?? 5), 'Базы этого устройства расположены слишком близко.');
      }
      for (const p of players) {
        if (p.baseCell === cell) throw new GameError('Эта ячейка уже занята.', 409, 'CELL_OCCUPIED');
        if (fingerprintHash && p.fingerprintHash === fingerprintHash) {
          fail(now - p.createdAt >= (CONFIG.BASE_PLACEMENT_COOLDOWN_PER_FINGERPRINT_MS ?? DAY), 'Для устройства действует задержка постановки базы.', 429);
          const km = greatCircleDistance(cellToLatLng(cell), cellToLatLng(p.baseCell), 'km');
          fail(km >= (CONFIG.SAME_FINGERPRINT_MIN_DISTANCE_KM ?? 5), 'Базы этого устройства расположены слишком близко.');
        }
      }
      for (const p of players) if (distance(cell, p.baseCell) <= projectedRadius(p) + 1) await this.settleFully(tx, p.id, now);
      const tile = await this.tile(tx, tileForCell(cell));
      fail(!tile._cells.has(cell) && !(tile.locks[cell] > now), 'Ячейка занята или временно закрыта.', 409, 'CELL_OCCUPIED');
      const name = String(input.name || account.name || 'Оператор').trim().slice(0, 32);
      const terrain = terrainForCell(cell);
      const player = { id: accountId, name, baseCell: cell, level: 1, pixels: 1, energy: 75, crystals: 0,
        azimuth: normalizeAngle(azimuth), faction, seed: Number.parseInt((await hash(accountId)).slice(0, 8), 16),
        terrainAverage: typeof terrain === 'number' ? terrain : terrain?.multiplier ?? 1,
        tLast: now, energyTLast: now, createdAt: now, accountCreatedAt: account.createdAt ?? now,
        shieldUntil: now + this.config.shieldHours * HOUR, fingerprintHash, seasonId: this.config.seasonId,
        levelTimeline: [{ at: now, level: 1 }], energyPixels: 1, borderCells: [cell], frontierBirths: { [cell]: now },
        upgradeInvestment: 0, upgradeStartedAt: null, upgradeCompletesAt: null, upgradeTargetLevel: null,
        abilities: {}, abilityReceipts: [],
        color: (typeof input.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(input.color.trim())) ? input.color.trim() : null,
        customLink: null, customLinkTitle: null,
        referralsCount: 0, reserveEnergy: 0, claimedReserveEnergy: 0,
        battlesWon: 0, achievements: [] };
      if(this.config.npcEnabled){player.army=createArmy(player,now);reconcileArmy(player.army,player,now);}
      if (input.referrer && typeof input.referrer === 'string' && input.referrer !== accountId) {
        const referrer = await tx.get(`player:${input.referrer}`);
        if (referrer) {
          const refKey = `referral:${input.referrer}:${accountId}`;
          if (!await tx.get(refKey)) {
            referrer.referralsCount = (referrer.referralsCount ?? 0) + 1;
            referrer.reserveEnergy = (referrer.reserveEnergy ?? 0) + 200;
            await tx.put(`player:${input.referrer}`, referrer);
            await tx.put(refKey, { at: now, referred: accountId });
            player.referredBy = input.referrer;
          }
        }
      }
      await this.writeOwner(tx, cell, accountId, now);
      await tx.put(`player:${accountId}`, player);
      await indexPlayer(tx, player);
      const epochKey = `world-index:${this.config.seasonId}`, epoch = await tx.get(epochKey);
      await tx.put(epochKey, { epoch: (epoch?.epoch ?? 0) + 1 });
      if (fingerprintKey) await tx.put(fingerprintKey, { lastPlacedAt: now, bases: [...(fingerprintPlacement?.bases ?? []), cell], accountId });
      return this.model(tx, accountId, now);
    });
  }

  async action(accountId, fn) {
    fail(accountId, 'Необходим вход.', 401, 'AUTH_REQUIRED');
    return this.transaction(async (tx, now) => {
      const conflicts = await this.settleFully(tx, accountId, now);
      const player = await tx.get(`player:${accountId}`);
      fail(player, 'Сначала поставьте базу.', 409, 'NO_BASE');
      await fn(player, tx, now);
      await tx.put(`player:${accountId}`, player);
      await indexPlayer(tx, player);
      return this.model(tx, accountId, now, conflicts);
    });
  }

  async useAbility(accountId, { abilityId, resetCooldown = false, requestId } = {}) {
    const definition = abilityDefinition(abilityId);
    fail(definition, 'Неизвестная способность.');
    fail(typeof resetCooldown === 'boolean', 'Некорректный способ запуска.');
    fail(typeof requestId === 'string' && /^[A-Za-z0-9_-]{16,80}$/.test(requestId), 'Повторите запуск способности.');
    return this.action(accountId, async (player, tx, now) => {
      const paymentKey = `ability-payment:${accountId}:${requestId}`;
      const paidReceipt = await tx.get(paymentKey);
      if (paidReceipt) {
        fail(paidReceipt.abilityId === abilityId, 'Этот запуск уже использован другой способностью.', 409);
        return;
      }
      const receipts = Array.isArray(player.abilityReceipts) ? player.abilityReceipts : [];
      const previous = receipts.find(receipt => receipt.requestId === requestId);
      if (previous) {
        fail(previous.abilityId === abilityId, 'Этот запуск уже использован другой способностью.', 409);
        return;
      }
      const state = player.abilities?.[abilityId];
      const cooling = (state?.readyAt ?? 0) > now;
      fail(!cooling || resetCooldown, 'Способность восстанавливается.', 429, 'ABILITY_COOLDOWN');
      const price = cooling ? definition.resetCrystalCost : 0;
      fail(player.crystals >= price, 'Недостаточно кристаллов для повторного запуска.', 409, 'INSUFFICIENT_CRYSTALS');
      player.crystals -= price;
      player.abilities ??= {};
      player.abilities[abilityId] = { lastUsedAt: now, readyAt: now + definition.cooldownMs,
        activeFrom: now, activeUntil: now + definition.durationMs };
      if (price > 0) await tx.put(paymentKey, { accountId, abilityId, crystals: price, activatedAt: now });
      // A duplicate network request returns the result without another charge.
      player.abilityReceipts = [...receipts, { requestId, abilityId, at: now, price }].slice(-64);
    });
  }

  async fundUpgrade(accountId, { amount } = {}) {
    fail(amount === 'all' || Number.isFinite(amount) && amount > 0, 'Укажите положительный взнос энергии.');
    return this.action(accountId, (p, tx, now) => {
      fail(p.level < 30, 'Достигнут максимальный уровень.');
      if (p.upgradeCompletesAt) {
        fail(p.vipUntil > now && p.upgradeTargetLevel < 30, 'Строительство уже идёт. Вторая очередь доступна с VIP.');
        const project = p.queuedProject ?? { targetLevel: p.upgradeTargetLevel + 1, invested: 0, cost: upgradeCost(p.upgradeTargetLevel), status: 'funding' };
        const contribution = Math.min(amount === 'all' ? p.energy : amount, p.energy, project.cost - project.invested);
        fail(contribution > 0, 'Проект уже профинансирован или недостаточно энергии.');
        p.energy -= contribution; project.invested += contribution;
        if (project.invested >= project.cost - 1e-8) project.status = 'funded';
        p.queuedProject = project;
        return;
      }
      const cost = upgradeCost(p.level), left = cost - (p.upgradeInvestment ?? 0);
      const contribution = Math.min(amount === 'all' ? p.energy : amount, p.energy, left);
      fail(contribution > 0, 'Недостаточно энергии.');
      p.energy -= contribution; p.upgradeInvestment = (p.upgradeInvestment ?? 0) + contribution;
      if (p.upgradeInvestment >= cost - 1e-8) {
        p.upgradeStartedAt = now; p.upgradeCompletesAt = now + upgradeDurationMs(p.level); p.upgradeTargetLevel = p.level + 1;
      }
    });
  }

  async rotate(accountId, { azimuth } = {}) {
    fail(Number.isFinite(azimuth), 'Азимут должен быть числом.');
    return this.action(accountId, (p, tx, now) => {
      fail(!p.lastRotatedAt || now - p.lastRotatedAt >= this.config.rotateCooldownHours * HOUR, `Поворот доступен раз в ${this.config.rotateCooldownHours} часов.`);
      fail(p.crystals >= this.config.rotateCrystalCost, 'Недостаточно кристаллов для поворота.');
      p.crystals -= this.config.rotateCrystalCost; p.azimuth = normalizeAngle(azimuth); p.lastRotatedAt = now;
    });
  }

  async abandon(accountId, { cells } = {}) {
    fail(Array.isArray(cells) && cells.length > 0 && cells.length <= 2000 && cells.every(validCell), 'Укажите ячейки для освобождения.');
    const unique = [...new Set(cells)];
    return this.action(accountId, async (p, tx, now) => {
      fail(!p.lastAbandonedAt || now - p.lastAbandonedAt >= this.config.abandonCooldownHours * HOUR, 'Освобождение доступно раз в 6 часов.');
      fail(!unique.includes(p.baseCell), 'Базовую ячейку освобождать нельзя.');
      const today = dayAt(now), dailyBase = p.abandonDay === today ? p.abandonDayBase : p.pixels;
      const already = p.abandonDay === today ? p.abandonedToday ?? 0 : 0;
      fail(unique.length + already <= Math.floor(dailyBase * 0.15), 'Дневной лимит освобождения — 15% территории.');
      for (const cell of unique) fail(await this.owner(tx, cell) === p.id, 'Можно освободить только свою территорию.');
      for (const cell of unique) await this.writeOwner(tx, cell, null, now, now + this.config.abandonLockHours * HOUR);
      await this.refreshFrontier(tx, [p], unique);
      const oldTerrainSum = p.terrainAverage * p.pixels;
      const removedTerrain = unique.reduce((sum, cell) => sum + (terrainForCell(cell).multiplier ?? 1), 0);
      p.pixels -= unique.length; p.terrainAverage = (oldTerrainSum - removedTerrain) / p.pixels;
      p.energyTerrainAverage = p.terrainAverage; p.lastAbandonedAt = now; p.abandonDay = today;
      p.energyPixels = p.pixels;
      p.abandonDayBase = dailyBase; p.abandonedToday = already + unique.length;
    });
  }

  async claimDaily(accountId) {
    return this.action(accountId, (p, tx, now) => {
      fail(p.fingerprintHash, 'Для ежедневной награды требуется fingerprint браузера.');
      fail(now - p.accountCreatedAt >= 72 * HOUR, 'Ежедневные кристаллы доступны через 72 часа после регистрации.');
      fail(p.dailyClaimDay !== dayAt(now), 'Сегодняшняя награда уже получена.', 409, 'ALREADY_CLAIMED');
      p.crystals += 40; p.dailyClaimDay = dayAt(now);
    });
  }

  async spendCrystals(accountId, input = {}) {
    fail(['energy', 'skip'].includes(input.kind), 'Неизвестный вид покупки.');
    return this.action(accountId, (p, tx, now) => {
      if (input.kind === 'energy') {
        const crystals = input.crystals ?? input.amount;
        fail(Number.isInteger(crystals) && crystals > 0, 'Укажите целое количество кристаллов.');
        const today = dayAt(now), used = p.paidEnergyDay === today ? p.paidEnergyHours ?? 0 : 0;
        const hours = crystals * 0.1;
        fail(used + hours <= PAID_ENERGY_HOURS_PER_DAY + 1e-8, 'Достигнут дневной лимит покупки энергии: 16 часов оптимального дохода.');
        fail(p.crystals >= crystals, 'Недостаточно кристаллов.');
        const storage = storageCapacity(p.level, p.terrainAverage ?? 1, p.faction);
        const energy = optimumNetIncome(p.level, p.terrainAverage ?? 1, p.faction) * hours;
        fail(p.energy + energy <= storage * 3, 'Недостаточно места на складе.');
        p.crystals -= crystals; p.energy += energy; p.paidEnergyDay = today; p.paidEnergyHours = used + hours;
      } else {
        fail(p.upgradeCompletesAt > now, 'Нет активной стройки.');
        const cost = skipCost((p.upgradeCompletesAt - now) / HOUR);
        fail(p.crystals >= cost, 'Недостаточно кристаллов.');
        p.crystals -= cost; p.upgradeCompletesAt = now;
        Object.assign(p, advanceProgression(p, now));
      }
    });
  }

  async updateCustomization(accountId, { color, customLink, customLinkTitle } = {}) {
    const result = await this.action(accountId, (p, tx, now) => {
      const awardLink = () => {
        p.achievements ??= [];
        if (!p.achievements.includes('promotion_link')) p.achievements.push('promotion_link');
        p.promotionLinkedAt ??= now;
      };
      if (promotionUrl(p.customLink)) awardLink();
      if (typeof color === 'string') {
        const trimmed = color.trim();
        fail(/^#[0-9a-fA-F]{6}$/.test(trimmed), 'Некорректный цвет (формат #RRGGBB).');
        p.color = trimmed;
      }
      if (customLink !== undefined) {
        if (customLink === null || customLink === '') {
          p.customLink = null;
          p.customLinkTitle = null;
        } else {
          fail(typeof customLink === 'string', 'Некорректная ссылка.');
          const trimmed = customLink.trim();
          fail(trimmed.length <= 256, 'Ссылка слишком длинная (до 256 символов).');
          const normalized = promotionUrl(trimmed);
          fail(normalized, 'Укажите одну ссылку http:// или https:// без логина и пароля в адресе.');
          {
            p.customLink = normalized;
            awardLink();
            if (typeof customLinkTitle === 'string') {
              p.customLinkTitle = customLinkTitle.trim().slice(0, 64) || null;
            }
          }
        }
      }
    });
    this.mapEntriesCache = null;
    return result;
  }

  async claimReferralEnergy(accountId) {
    return this.action(accountId, (p, tx, now) => {
      const available = p.reserveEnergy ?? 0;
      fail(available > 0, 'У вас нет накопленной запасной энергии от приглашённых друзей.');
      const storage = storageCapacity(p.level, p.terrainAverage ?? 1, p.faction);
      const room = Math.max(0, storage * 3 - p.energy);
      fail(room > 0, 'Хранилище энергии заполнено. Вложите энергию в улучшение базы.');
      const claimAmount = Math.min(available, room);
      p.reserveEnergy -= claimAmount;
      p.claimedReserveEnergy = (p.claimedReserveEnergy ?? 0) + claimAmount;
      p.energy += claimAmount;
    });
  }

  async tiles({ parents = [], versions = {} } = {}, accountId = null) {
    fail(Array.isArray(parents) && parents.length <= 48 && parents.every(p => typeof p === 'string' && isValidCell(p) && getResolution(p) === 5), 'Запросите до 48 H3-тайлов resolution 5.');
    return this.transaction(async (tx, now) => {
      let conflicts = [];
      if (accountId) conflicts = await this.settleFully(tx, accountId, now);
      const centers = parents.map(parent => latLngToCell(...cellToLatLng(parent), 8));
      const players = await this.loadPlayers(tx, centers.map(cell => ({ cell, radiusRings: 20 })));
      for (const p of players) {
        if (centers.some(center => distance(center, p.baseCell) <= projectedRadius(p) + 20))
          conflicts.push(...await this.settleFully(tx, p.id, now));
      }
      const tiles = [];
      for (const parent of [...new Set(parents)]) {
        const tile = await this.tile(tx, parent), known = Number(versions[parent] ?? -1);
        tx.flushTile(tile);
        if (known === tile.revision) { tiles.push({ parent, version: tile.revision, unchanged: true }); continue; }
        const earliest = tile.history[0]?.version ?? tile.revision;
        const canDiff = known >= earliest - 1 && known >= 0;
        const changes = canDiff ? tile.history.filter(e => e.version > known) : [];
        tiles.push({ parent, version: tile.revision, full: !canDiff, owners: !canDiff ? tile.owners : undefined,
          changes: canDiff ? changes : undefined, diffBitmask: encodeTile(parent, changes.map(e => e.cell)).bitmask,
          locks: Object.fromEntries(Object.entries(tile.locks).filter(([, until]) => until > now)) });
      }
      const requestedParents=new Set(parents),inView=cell=>cell&&requestedParents.has(tileForCell(cell));
      const ownerIds=new Set(players.filter(p=>inView(p.baseCell)||(p.army?.units||[]).some(u=>inView(u.cell)||inView(u.move?.to))).map(p=>p.id));
      // Unchanged ownership masks still need fresh visible army metadata.
      for(const parent of requestedParents)for(const id of (await this.tile(tx,parent))._cells.values())ownerIds.add(id);
      const profiles = [];
      for (const id of ownerIds) {
        const player = await tx.get(`player:${id}`);
        if (player) profiles.push({
          ...playerProfile(player),
          shieldUntil: player.shieldUntil ?? 0,
          troops: troopDeployment(player, now),
          frontier: (player.borderCells ?? [player.baseCell]).slice(0, 8),
          army: player.army?publicArmy({...player.army,units:player.army.units.filter(u=>inView(u.cell)||inView(u.move?.from)||inView(u.move?.to))},now):null,
        });
      }
      return { serverTime: now, seasonId: this.config.seasonId, tiles, conflicts:conflicts.filter(c=>(c.fronts||[]).some(f=>inView(f.aCell)||inView(f.bCell))), players: profiles };
    });
  }

  async mapEntries() {
    const now=this.clock();
    if(this.mapEntriesCache && now-this.mapEntriesCache.at<10000)return this.mapEntriesCache.entries;
    if(this.mapEntriesPending)return this.mapEntriesPending;
    this.mapEntriesPending=(async()=>{
      // The compact spatial index has no paths, skeletons, receipts or full NPC records.
      const rows=await this.store.list(`spatial:${this.config.seasonId}:`),entries=[];
      let budget=32;
      for(const row of rows){
        const missing=Object.values(row.value.entries||{}).filter(e=>!e.faction).slice(0,budget);budget-=missing.length;
        if(missing.length){
          const updated={...row.value,entries:{...row.value.entries}};
          const players=await Promise.all(missing.map(e=>this.store.get(`player:${e.id}`)));
          for(const record of players)if(record?.value){const p=record.value;updated.entries[p.id]={...updated.entries[p.id],...mapEntry(p)};}
          // Lazy, bounded migration of old metadata; never advances the world.
          if(await this.store.atomic({checks:[{key:row.key,version:row.version}],puts:[{key:row.key,value:updated}]}))row.value=updated;
        }
        entries.push(...Object.values(row.value.entries||{}));
      }
      this.mapEntriesCache={at:now,entries};return entries;
    })().finally(()=>{this.mapEntriesPending=null;});
    return this.mapEntriesPending;
  }

  async overview(input) {
    try{aggregateOverview([],input);return {serverTime:this.clock(),seasonId:this.config.seasonId,...aggregateOverview(await this.mapEntries(),input)};}
    catch(error){if(error instanceof RangeError)throw new GameError('Некорректная область карты.',400,'INVALID_VIEWPORT');throw error;}
  }

  async leaderboard() {
    const entries=await this.mapEntries();
    return {serverTime:this.clock(),seasonId:this.config.seasonId,players:entries.map(playerProfile).sort((a,b)=>b.level-a.level||b.pixels-a.pixels||a.id.localeCompare(b.id)).slice(0,100)};
  }

  shop() { return { items: CATALOG, energyDailyCapHours: PAID_ENERGY_HOURS_PER_DAY, transfers: false, secondBaseEnabled: false }; }

  /** Must only be called with a payment-provider verified receipt by the server route. */
  async applyPurchase({ eventId, accountId, sku, periodEnd, stripeCustomerId, stripeSubscriptionId }) {
    fail(typeof eventId === 'string' && eventId.length > 0 && eventId.length <= 200, 'Некорректный ID платежа.');
    const product = CATALOG.find(p => p.id === sku);
    fail(product, 'Неизвестный товар.');
    return this.transaction(async (tx, now) => {
      const key = `payment:${eventId}`;
      const previous = await tx.get(key);
      if (previous) {
        fail(previous.accountId === accountId && previous.sku === sku, 'ID платежа уже использован.', 409);
        return { credited: false, duplicate: true, receipt: previous };
      }
      const p = await tx.get(`player:${accountId}`);
      fail(p, 'Аккаунт должен иметь базу перед покупкой.');
      if (product.crystals) p.crystals += product.crystals;
      if (product.vipDays) p.vipUntil = Number.isFinite(periodEnd) ? Math.max(p.vipUntil ?? 0, periodEnd) : Math.max(now, p.vipUntil ?? 0) + product.vipDays * DAY;
      if (product.vipDays && typeof stripeCustomerId === 'string' && /^cus_[A-Za-z0-9_]+$/.test(stripeCustomerId)) p.stripeCustomerId = stripeCustomerId;
      if (product.vipDays && typeof stripeSubscriptionId === 'string' && /^sub_[A-Za-z0-9_]+$/.test(stripeSubscriptionId)) p.stripeSubscriptionId = stripeSubscriptionId;
      if (product.seasonPass) p.seasonPass = this.config.seasonId;
      const receipt = { eventId, accountId, sku, creditedAt: now };
      await tx.put(`player:${accountId}`, p); await tx.put(key, receipt);
      return { credited: true, receipt };
    });
  }
}
