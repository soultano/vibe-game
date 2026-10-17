/* TERRAFRONT — deterministic local simulation. No server, accounts or real payments. */
const SAVE_KEY = 'terrafront.save.v1';
const COLORS = ['#8dfc80', '#f8756d', '#73b1ff', '#d08cff', '#ffce6b', '#5ce0cf', '#fa8fc9', '#a5a5ff', '#e1aa7c', '#9bce6c', '#ff9f64', '#61c9f5', '#b5c1d1'];
const NAMES = ['Алый союз', 'Северный протокол', 'Орден эфира', 'Золотой горизонт', 'Нефритовый рой', 'Розовый сектор', 'Сингулярность', 'Песчаный легион', 'Лесной синдикат', 'Солнечный фронт', 'Голубая армада', 'Стальной круг'];
const POLICIES = new Set(['expand', 'balanced', 'defend']);
const clamp = (x, min, max) => Math.max(min, Math.min(max, x));

export class GameEngine {
  constructor({ width, height, land, seed = 42 }) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 3 || height < 3 || !land || land.length !== width * height) throw new Error('Некорректный размер карты');
    this.width = width; this.height = height;
    this.land = Array.from(land, x => x ? 1 : 0);
    this.seed = seed >>> 0 || 42;
    this._rng = this.seed;
    this._saveTimer = 0; this._effectId = 0; this._logId = 0;
    this._frontiers = new Map(); this._budgets = new Map();
    this._freshState();
  }

  _freshState() {
    this._rng = this.seed;
    this.state = {
      width: this.width, height: this.height, totalLand: this.land.reduce((a, b) => a + b, 0),
      owners: this.land.map(x => x ? 0 : -1),
      players: [this._makePlayer(1, 'Командир', true)],
      started: false, elapsed: 0, speed: 1, paused: false, policy: 'balanced',
      victory: false, boostUntil: 0, target: null, effects: [], contactedRivals: [],
      stats: { captured: 0, battlesWon: 0, upgrades: 0 },
      quests: [
        { id: 'territory25', title: 'Первая экспансия', description: 'Захватите 25 клеток территории', progress: 0, target: 25, reward: 20, claimed: false },
        { id: 'level2', title: 'Новый уровень', description: 'Улучшите базу до уровня 2', progress: 0, target: 2, reward: 30, claimed: false },
        { id: 'territory100', title: 'Маленькая империя', description: 'Удерживайте 100 клеток территории', progress: 0, target: 100, reward: 40, claimed: false },
        { id: 'battle', title: 'Первый прорыв', description: 'Победите в 3 сражениях на границе', progress: 0, target: 3, reward: 50, claimed: false },
        { id: 'territory500', title: 'Региональная держава', description: 'Удерживайте 500 клеток территории', progress: 0, target: 500, reward: 80, claimed: false },
      ],
      log: [],
    };
    this._frontiers.clear(); this._budgets.clear(); this._saveTimer = 0;
  }

  _makePlayer(id, name, isHuman = false) {
    return { id, name, color: COLORS[(id - 1) % COLORS.length], level: 1, territory: 0, energy: isHuman ? 55 : 35, credits: isHuman ? 20 : 0, isHuman, alive: false, base: null, faction: 'tech', defeated: false };
  }

  _random() {
    let t = this._rng += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  }

  _neighbors(i) {
    const x = i % this.width, result = [];
    if (x) result.push(i - 1);
    if (x < this.width - 1) result.push(i + 1);
    if (i >= this.width) result.push(i - this.width);
    if (i < this.width * (this.height - 1)) result.push(i + this.width);
    return result;
  }

  getPlayer(id) { return this.state.players.find(p => p.id === id) || null; }
  getCell(x, y) {
    x = Math.floor(x); y = Math.floor(y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= this.width || y >= this.height) return null;
    const owner = this.state.owners[y * this.width + x], player = this.getPlayer(owner);
    return { x, y, owner, land: owner !== -1, player, isBase: Boolean(player?.base && player.base.x === x && player.base.y === y) };
  }
  canBuild(x, y) {
    const cell = this.getCell(x, y);
    return Boolean(cell && cell.owner === 0 && !this.getPlayer(1).alive);
  }

  _log(text, type = 'info') {
    this.state.log.unshift({ id: ++this._logId, text, time: this.state.elapsed, type });
    if (this.state.log.length > 40) this.state.log.length = 40;
  }

  buildBase(x, y, name = 'Командир', faction = 'tech') {
    x = Math.floor(x); y = Math.floor(y);
    if (this.getPlayer(1).alive) return { ok: false, message: 'У вас уже есть действующая база.' };
    if (!this.canBuild(x, y)) return { ok: false, message: 'Выберите свободную клетку суши.' };
    const human = this.getPlayer(1);
    human.name = String(name || 'Командир').trim().slice(0, 24) || 'Командир';
    human.faction = ['tech', 'magic', 'arcane', 'bio', 'nature', 'synth'].includes(faction) ? faction : 'tech';
    human.level = 1; human.energy = 55; human.alive = true; human.defeated = false;
    human.spawnedAt = this.state.elapsed;
    this._placeBase(human, x, y);
    if (!this.state.started) {
      this.state.started = true;
      this._spawnAI();
      this._log('База основана. Щит новичка действует 60 секунд.', 'success');
    } else this._log('Новая база развёрнута. Ваша империя возродилась.', 'success');
    this._refreshQuests(); this.save();
    return { ok: true, message: 'База основана. Экспансия началась!' };
  }

  _placeBase(player, x, y) {
    player.base = { x, y };
    const center = y * this.width + x;
    this._capture(center, player, false);
    // A compact landing zone; every starter cell connects to the base by land.
    const allowed = new Set();
    for (let yy = y - 1; yy <= y + 1; yy++) for (let xx = x - 1; xx <= x + 1; xx++) {
      if (xx >= 0 && yy >= 0 && xx < this.width && yy < this.height) allowed.add(yy * this.width + xx);
    }
    const queue = [center], seen = new Set(queue);
    for (let n = 0; n < queue.length; n++) for (const next of this._neighbors(queue[n])) {
      if (allowed.has(next) && !seen.has(next) && this.state.owners[next] === 0) {
        seen.add(next); queue.push(next); this._capture(next, player, false);
      }
    }
  }

  _spawnAI() {
    const centers = [this.getPlayer(1).base];
    const candidates = [];
    for (let i = 0; i < this.land.length; i++) if (this.state.owners[i] === 0) candidates.push(i);
    const desired = Math.min(12, Math.floor(this.state.totalLand / 50));
    const minimum = Math.max(5, Math.min(24, Math.sqrt(this.state.totalLand / Math.max(1, desired)) * 0.55));
    // Put two rivals within a short march, connected by actual land routes.
    const distances = new Int32Array(this.land.length).fill(-1);
    const origin = centers[0].y * this.width + centers[0].x;
    const queue = [origin]; distances[origin] = 0;
    for (let i = 0; i < queue.length; i++) for (const next of this._neighbors(queue[i])) {
      if (distances[next] < 0 && this.land[next] && distances[queue[i]] < 24) {
        distances[next] = distances[queue[i]] + 1; queue.push(next);
      }
    }
    for (let n = 0; n < desired; n++) {
      let best = -1, bestDistance = -1;
      const nearby = n < 2 ? queue.filter(i => distances[i] >= 11 && distances[i] <= 18 && this.state.owners[i] === 0) : [];
      const pool = nearby.length > 8 ? nearby : candidates;
      for (let attempt = 0; attempt < Math.min(600, pool.length); attempt++) {
        const index = pool[Math.floor(this._random() * pool.length)];
        if (this.state.owners[index] !== 0) continue;
        const x = index % this.width, y = Math.floor(index / this.width);
        const distance = Math.min(...centers.map(c => Math.hypot(c.x - x, c.y - y)));
        if (distance > bestDistance) { best = index; bestDistance = distance; }
      }
      if (best < 0 || bestDistance < (pool === nearby ? 7 : minimum)) continue;
      const player = this._makePlayer(n + 2, NAMES[n]);
      player.alive = true; player.spawnedAt = 0;
      this.state.players.push(player);
      const x = best % this.width, y = Math.floor(best / this.width);
      this._placeBase(player, x, y); centers.push({ x, y });
    }
    this._log(`${this.state.players.length - 1} автономных соперников развёрнулись на карте.`, 'info');
  }

  _isFrontier(i, id) {
    return this.state.owners[i] === id && this._neighbors(i).some(n => this.state.owners[n] >= 0 && this.state.owners[n] !== id);
  }
  _updateFrontier(i) {
    const owner = this.state.owners[i];
    if (owner <= 0) return;
    if (!this._frontiers.has(owner)) this._frontiers.set(owner, new Set());
    const frontier = this._frontiers.get(owner);
    if (this._isFrontier(i, owner)) frontier.add(i); else frontier.delete(i);
  }
  _capture(i, player, animate = true) {
    const previous = this.state.owners[i];
    if (previous < 0 || previous === player.id) return false;
    const defender = this.getPlayer(previous);
    if (defender) { defender.territory--; this._frontiers.get(previous)?.delete(i); }
    this.state.owners[i] = player.id; player.territory++;
    this._updateFrontier(i);
    for (const next of this._neighbors(i)) this._updateFrontier(next);
    if (player.isHuman && animate) this.state.stats.captured++;
    if (animate) {
      this.state.effects.push({ id: ++this._effectId, x: i % this.width, y: Math.floor(i / this.width), owner: player.id, type: previous > 0 ? 'battle' : 'capture', time: this.state.elapsed });
      if (this.state.effects.length > 120) this.state.effects.shift();
    }
    if (defender) {
      const baseIndex = defender.base ? defender.base.y * this.width + defender.base.x : -1;
      if (defender.territory <= 0 || i === baseIndex) this._eliminate(defender, player);
    }
    return true;
  }

  _eliminate(player, attacker) {
    player.alive = false; player.defeated = true;
    this._frontiers.delete(player.id); this._budgets.delete(player.id);
    // Remaining territory becomes neutral: victory does not grant a runaway windfall.
    for (let i = 0; i < this.state.owners.length; i++) if (this.state.owners[i] === player.id) {
      this.state.owners[i] = 0;
      for (const next of this._neighbors(i)) this._updateFrontier(next);
    }
    player.territory = 0;
    if (player.isHuman) this._log('Ваша база потеряна. Выберите новую свободную точку, чтобы вернуться.', 'danger');
    else this._log(`${attacker.name} захватил базу «${player.name}».`, attacker.isHuman ? 'success' : 'war');
  }

  getUpgradeCost(player = this.getPlayer(1)) { return Math.round(75 * Math.pow(1.78, Math.max(0, player.level - 1))); }
  getEnergyRate(player = this.getPlayer(1)) {
    if (!player?.alive) return 0;
    const income = 3.6 + Math.sqrt(player.territory) * 0.62 + (player.level - 1) * 0.55;
    return income * (player.isHuman && this.state.policy === 'defend' ? 1.12 : 1);
  }
  getExpansionRate(player = this.getPlayer(1)) {
    if (!player?.alive) return 0;
    let rate = (player.isHuman ? 1.7 : 0.66 + (player.id % 4) * 0.06) * (1 + 0.39 * (player.level - 1));
    if (player.isHuman) {
      rate *= this.state.policy === 'expand' ? 1.35 : this.state.policy === 'defend' ? 0.6 : 1;
      if (this.state.boostUntil > this.state.elapsed) rate *= 1.65;
    }
    return Math.min(35, rate);
  }
  upgrade() {
    const player = this.getPlayer(1), cost = this.getUpgradeCost(player);
    if (!player.alive) return { ok: false, message: 'Сначала разместите базу.' };
    if (player.level >= 12) return { ok: false, message: 'База достигла максимального уровня.' };
    if (player.energy < cost) return { ok: false, message: `Нужно ${cost} энергии.` };
    player.energy -= cost; player.level++; this.state.stats.upgrades++;
    this._log(`База улучшена до уровня ${player.level}. Скорость и сила выросли.`, 'success');
    this._refreshQuests(); this.save();
    return { ok: true, message: `База уровня ${player.level}!` };
  }
  setPolicy(policy) {
    if (!POLICIES.has(policy)) return { ok: false, message: 'Неизвестная стратегия.' };
    this.state.policy = policy; this.save();
    return { ok: true, message: ({ expand: 'Приоритет: экспансия', balanced: 'Приоритет: баланс', defend: 'Приоритет: оборона' })[policy] };
  }
  setTarget(x, y) {
    const cell = this.getCell(x, y);
    if (!cell?.land || !this.getPlayer(1).alive) return { ok: false, message: 'Выберите точку на суше.' };
    this.state.target = { x: cell.x, y: cell.y };
    return { ok: true, message: 'Направление экспансии задано.' };
  }
  activateBoost() {
    const player = this.getPlayer(1);
    if (!player.alive) return { ok: false, message: 'Сначала разместите базу.' };
    if (this.state.boostUntil > this.state.elapsed) return { ok: false, message: 'Ускорение уже действует.' };
    if (player.credits < 20) return { ok: false, message: 'Нужно 20 кредитов. Выполняйте задания.' };
    player.credits -= 20; this.state.boostUntil = this.state.elapsed + 30;
    this._log('Импульс экспансии: скорость +65% на 30 секунд.', 'success'); this.save();
    return { ok: true, message: 'Импульс активирован на 30 секунд.' };
  }
  claimQuest(id) {
    this._refreshQuests();
    const quest = this.state.quests.find(q => q.id === id);
    if (!quest || quest.claimed || quest.progress < quest.target) return { ok: false, message: 'Задание ещё не выполнено или награда получена.' };
    quest.claimed = true; this.getPlayer(1).credits += quest.reward;
    this._log(`«${quest.title}»: получено ${quest.reward} кредитов.`, 'success'); this.save();
    return { ok: true, message: `+${quest.reward} кредитов` };
  }
  _refreshQuests() {
    const human = this.getPlayer(1);
    for (const quest of this.state.quests) {
      const current = quest.id === 'level2' ? human.level : quest.id === 'battle' ? this.state.stats.battlesWon : human.territory;
      quest.progress = Math.min(quest.target, Math.max(quest.progress, current));
    }
  }

  _expand(player) {
    const frontier = this._frontiers.get(player.id);
    if (!frontier?.size) { this._navalExpand(player); return; }
    if (player.energy < 0.65) return;
    const list = [...frontier];
    let candidate = -1, score = -Infinity, enemyCandidate = -1, enemyScore = -Infinity;
    // Sampling keeps very large borders inexpensive while allowing directed expansion.
    for (let sample = 0; sample < Math.min(14, list.length); sample++) {
      const source = list[Math.floor(this._random() * list.length)];
      if (this.state.owners[source] !== player.id) { frontier.delete(source); continue; }
      for (const next of this._neighbors(source)) {
        const owner = this.state.owners[next];
        if (owner < 0 || owner === player.id) continue;
        const defender = this.getPlayer(owner);
        if (defender?.isHuman && this.state.elapsed - (defender.spawnedAt || 0) < 60) continue;
        const neutral = owner === 0;
        let value = this._random() * 3;
        if (player.isHuman && this.state.target) value -= Math.hypot(next % this.width - this.state.target.x, Math.floor(next / this.width) - this.state.target.y) * 0.1;
        if (neutral && value > score) { score = value; candidate = next; }
        if (!neutral && value > enemyScore) { enemyScore = value; enemyCandidate = next; }
        if (player.isHuman && defender && !this.state.contactedRivals.includes(defender.id)) {
          this.state.contactedRivals.push(defender.id);
          this._log(`Первый контакт: граница с «${defender.name}». Начинаются столкновения.`, 'war');
        }
      }
    }
    const aggression = player.isHuman ? ({ expand: 0.35, balanced: 0.2, defend: 0.08 })[this.state.policy] : 0.2;
    if (enemyCandidate >= 0 && (candidate < 0 || this._random() < aggression)) candidate = enemyCandidate;
    if (candidate < 0) { this._navalExpand(player); return; }
    const defender = this.getPlayer(this.state.owners[candidate]);
    if (!defender) { player.energy -= 0.65; this._capture(candidate, player); return; }
    const cost = 3.2 + defender.level * 0.3;
    if (player.energy < cost) return;
    player.energy -= cost;
    const attackPolicy = player.isHuman && this.state.policy === 'expand' ? 1.12 : 1;
    const defensePolicy = defender.isHuman ? (this.state.policy === 'defend' ? 1.5 : this.state.policy === 'expand' ? 0.95 : 1.14) : 1.14;
    const attackPower = (1 + player.level * 0.3 + Math.sqrt(player.territory) * 0.065) * attackPolicy;
    let defensePower = (1 + defender.level * 0.3 + Math.sqrt(defender.territory) * 0.065) * defensePolicy;
    if (defender.base && candidate === defender.base.y * this.width + defender.base.x) defensePower *= 1.65;
    const chance = clamp(attackPower / (attackPower + defensePower), 0.16, 0.78);
    if (this._random() < chance) {
      this._capture(candidate, player);
      if (player.isHuman) {
        this.state.stats.battlesWon++;
        if (this.state.stats.battlesWon === 1 || this.state.stats.battlesWon % 25 === 0) this._log(`Прорыв границы: захвачена территория «${defender.name}».`, 'war');
      }
    }
  }

  _navalExpand(player) {
    if (player.level < 2 || player.energy < 18 || this.state.elapsed < (player.nextExpeditionAt || 0)) return;
    player.nextExpeditionAt = this.state.elapsed + 8;
    // Follow a sea route from the coast to the nearest free shore. Enemy land
    // remains a physical barrier; sea expeditions never steal inland cells.
    const visited = new Uint8Array(this.land.length), queue = [];
    for (let i = 0; i < this.state.owners.length; i++) if (this.state.owners[i] === player.id) {
      for (const next of this._neighbors(i)) if (this.state.owners[next] === -1 && !visited[next]) {
        visited[next] = 1; queue.push(next);
      }
    }
    for (let i = 0; i < queue.length; i++) for (const next of this._neighbors(queue[i])) {
      if (visited[next]) continue;
      visited[next] = 1;
      if (this.state.owners[next] === 0) {
        player.energy -= 18;
        this._capture(next, player);
        const effect = this.state.effects[this.state.effects.length - 1];
        if (effect) effect.type = 'expedition';
        if (player.isHuman) this._log('Морская экспедиция основала плацдарм на новом берегу.', 'success');
        return;
      }
      if (this.state.owners[next] === -1) queue.push(next);
    }
  }

  tick(dtSeconds) {
    if (!this.state.started || this.state.paused || !Number.isFinite(dtSeconds) || dtSeconds <= 0) return;
    let remaining = Math.min(dtSeconds, 2) * this.state.speed;
    while (remaining > 1e-8) {
      const dt = Math.min(0.25, remaining); remaining -= dt;
      this.state.elapsed += dt;
      for (const player of this.state.players) {
        if (!player.alive) continue;
        player.energy = Math.min(1000000, player.energy + this.getEnergyRate(player) * dt);
        if (!player.isHuman && this.state.elapsed > 14 && player.level < 10 && player.energy > this.getUpgradeCost(player) * 1.45) {
          player.energy -= this.getUpgradeCost(player); player.level++;
        }
        if (!player.isHuman && this.state.elapsed < 8) continue;
        const budget = (this._budgets.get(player.id) || 0) + this.getExpansionRate(player) * dt;
        const actions = Math.min(12, Math.floor(budget));
        this._budgets.set(player.id, budget - actions);
        for (let i = 0; i < actions && player.alive; i++) this._expand(player);
      }
    }
    this.state.effects = this.state.effects.filter(e => this.state.elapsed - e.time < 2.5);
    this._refreshQuests();
    const human = this.getPlayer(1), ai = this.state.players.filter(p => !p.isHuman && p.alive);
    if (!this.state.victory && human.alive && (human.territory >= Math.ceil(this.state.totalLand * 0.35) || this.state.players.length > 1 && !ai.length)) {
      this.state.victory = true;
      human.credits += 150;
      this._log('Победа! Вы стали мировой державой. +150 кредитов. Можно продолжать.', 'victory');
    }
    this._saveTimer += Math.min(dtSeconds, 2);
    if (this._saveTimer > 8) { this._saveTimer = 0; this.save(); }
  }

  setSpeed(n) { this.state.speed = [1, 2, 3, 4, 5, 8, 10].includes(Number(n)) ? Number(n) : 1; }
  togglePause() { this.state.paused = !this.state.paused; return this.state.paused; }
  save() {
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(SAVE_KEY, JSON.stringify({ version: 1, width: this.width, height: this.height, seed: this.seed, rng: this._rng, savedAt: Date.now(), state: this.state }));
    } catch { /* Browsers may deny storage or exceed quota. Game remains playable. */ }
  }
  load() {
    try {
      if (typeof localStorage === 'undefined') return false;
      const save = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null');
      if (!save || save.version !== 1 || save.width !== this.width || save.height !== this.height || save.seed !== this.seed) return false;
      const state = save.state;
      if (!state || !Array.isArray(state.owners) || state.owners.length !== this.land.length || !Array.isArray(state.players) || state.players.length > 30 || !state.players.some(p => p.id === 1 && p.isHuman)) return false;
      const ids = new Set(state.players.map(p => p.id));
      if (ids.size !== state.players.length || state.players.some(p => !Number.isInteger(p.id) || p.id < 1 || !Number.isFinite(p.energy) || p.energy < 0 || !Number.isFinite(p.credits) || p.credits < 0 || !Number.isInteger(p.level) || p.level < 1 || p.level > 12 || typeof p.name !== 'string')) return false;
      if (!Number.isFinite(state.elapsed) || state.elapsed < 0 || typeof state.started !== 'boolean' || typeof state.paused !== 'boolean' || !Array.isArray(state.quests) || state.quests.length !== 5 || !state.stats || ['captured', 'battlesWon', 'upgrades'].some(key => !Number.isFinite(state.stats[key]) || state.stats[key] < 0)) return false;
      const questIds = ['territory25', 'level2', 'territory100', 'battle', 'territory500'];
      if (state.quests.some((q, i) => !q || q.id !== questIds[i] || typeof q.title !== 'string' || typeof q.description !== 'string' || !Number.isFinite(q.progress) || q.progress < 0 || !Number.isFinite(q.target) || q.target <= 0 || !Number.isFinite(q.reward) || q.reward < 0 || typeof q.claimed !== 'boolean')) return false;
      for (let i = 0; i < state.owners.length; i++) {
        const owner = state.owners[i];
        if (!Number.isInteger(owner) || (this.land[i] ? owner < 0 || owner > 0 && !ids.has(owner) : owner !== -1)) return false;
      }
      for (const player of state.players) {
        player.territory = state.owners.reduce((count, owner) => count + (owner === player.id ? 1 : 0), 0);
        player.alive = player.territory > 0;
        if (player.alive && (!player.base || !Number.isInteger(player.base.x) || !Number.isInteger(player.base.y) || player.base.x < 0 || player.base.y < 0 || player.base.x >= this.width || player.base.y >= this.height || state.owners[player.base.y * this.width + player.base.x] !== player.id)) return false;
      }
      state.policy = POLICIES.has(state.policy) ? state.policy : 'balanced';
      state.speed = [1, 2, 3, 4, 5, 8, 10].includes(state.speed) ? state.speed : 1;
      state.width = this.width; state.height = this.height;
      state.totalLand = this.land.reduce((a, b) => a + b, 0);
      state.effects = []; state.log = Array.isArray(state.log) ? state.log.filter(entry => entry && typeof entry.text === 'string' && Number.isFinite(entry.time)).slice(0, 40) : [];
      state.boostUntil = Number.isFinite(state.boostUntil) ? state.boostUntil : 0;
      state.contactedRivals = Array.isArray(state.contactedRivals) ? state.contactedRivals.filter(id => Number.isInteger(id) && ids.has(id)) : [];
      if (state.target && (!Number.isInteger(state.target.x) || !Number.isInteger(state.target.y) || state.target.x < 0 || state.target.y < 0 || state.target.x >= this.width || state.target.y >= this.height)) state.target = null;
      this.state = state; this._rng = save.rng >>> 0 || this.seed;
      this._frontiers.clear(); this._budgets.clear();
      for (let i = 0; i < state.owners.length; i++) this._updateFrontier(i);
      this._logId = Math.max(0, ...state.log.map(x => Number(x.id) || 0));
      this._refreshQuests();
      return true;
    } catch { return false; }
  }
  reset() {
    try { if (typeof localStorage !== 'undefined') localStorage.removeItem(SAVE_KEY); } catch { /* Optional storage. */ }
    this._freshState();
  }
}

export default GameEngine;
