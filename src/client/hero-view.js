import { cellToLatLng, gridDisk, gridDistance } from 'h3-js';
import { HERO_CONFIG, HERO_STATES, calculateStepMpCost, getDeterministicPoi, getWildMountAt, calculateTamingChance, getMaxMovementPoints } from '../shared/hero-engine.js';
import { getFaction } from '../shared/config.js';

export class HeroView {
  constructor({ $, api, toast, paint, showDialog, getPlayer, surfaces }) {
    this.$ = $;
    this.api = api;
    this.toast = toast;
    this.paint = paint;
    this.showDialog = showDialog;
    this.getPlayer = getPlayer;
    this.surfaces = surfaces;

    this.isHeroMoveMode = false;
    this.hoverCell = null;
    this.selectedTargetMount = null;
    this.moving = false;

    this.initUI();
  }

  initUI() {
    const heroBtn = this.$('heroHudBtn');
    if (heroBtn) {
      heroBtn.onclick = () => this.openHeroPanel();
    }

    const heroMoveBtn = this.$('heroMoveBtn');
    if (heroMoveBtn) {
      heroMoveBtn.onclick = () => this.toggleMoveMode();
    }

    const perkBtn = this.$('heroPerkBtn');
    if (perkBtn) {
      perkBtn.onclick = () => this.openLevelUpDialog();
    }

    const tamingBtn = this.$('confirmTameBtn');
    if (tamingBtn) {
      tamingBtn.onclick = () => this.executeTaming();
    }

    const cancelTameBtn = this.$('cancelTameBtn');
    if (cancelTameBtn) {
      cancelTameBtn.onclick = () => this.$('heroTamingDialog')?.close();
    }

    const mountToggleBtn = this.$('heroMountToggleBtn');
    if (mountToggleBtn) {
      mountToggleBtn.onclick = () => this.toggleEquippedMount();
    }

    // Perk selection buttons in Level Up dialog
    for (const perkId of ['attack', 'defense', 'speed', 'intellect']) {
      const btn = this.$(`perk_${perkId}`);
      if (btn) {
        btn.onclick = () => this.selectPerk(perkId);
      }
    }
  }

  updateHUD(player) {
    const hero = player?.hero;
    const hud = this.$('heroHudBtn');
    if (!hud) return;

    if (!hero) {
      hud.hidden = true;
      return;
    }

    hud.hidden = false;
    const mount = hero.currentMount ? HERO_CONFIG.mounts[hero.currentMount] : null;
    const iconSpan = this.$('heroHudIcon');
    if (iconSpan) iconSpan.textContent = mount ? mount.icon : '⚔️';

    const lvlSpan = this.$('heroHudLvl');
    if (lvlSpan) lvlSpan.textContent = `Ур.${hero.level}`;

    const mpText = this.$('heroHudMp');
    if (mpText) mpText.textContent = `${hero.mp} MP`;

    const mpBar = this.$('heroHudMpBar');
    if (mpBar) {
      const maxMp = hero.maxMp || getMaxMovementPoints(hero);
      const pct = Math.max(0, Math.min(100, Math.round((hero.mp / maxMp) * 100)));
      mpBar.style.width = `${pct}%`;
    }

    const perkDot = this.$('heroPerkDot');
    if (perkDot) {
      perkDot.hidden = !(hero.pendingPerks > 0);
    }
  }

  openHeroPanel() {
    const player = this.getPlayer();
    const hero = player?.hero;
    if (!hero) return;

    const faction = getFaction(player.faction);
    const mount = hero.currentMount ? HERO_CONFIG.mounts[hero.currentMount] : null;
    const maxMp = hero.maxMp || getMaxMovementPoints(hero);

    // Text & stats
    this.$('heroPanelTitle').textContent = `${hero.name || 'Командир'}`;
    this.$('heroPanelSubtitle').textContent = `Герой ${faction.name} · Уровень ${hero.level}`;
    this.$('heroPanelAvatar').textContent = mount ? mount.icon : '🧙‍♂️';

    // XP & Level
    const nextXp = hero.xpNext || 100;
    this.$('heroXpText').textContent = `${hero.xp} / ${nextXp} XP`;
    const xpPct = Math.min(100, Math.round((hero.xp / nextXp) * 100));
    this.$('heroXpBar').style.width = `${xpPct}%`;

    // Movement status
    this.$('heroMpText').textContent = `${hero.mp} / ${maxMp} MP`;
    this.$('heroMpBar').style.width = `${Math.min(100, Math.round((hero.mp / maxMp) * 100))}%`;

    const stateDesc = mount
      ? `🐎 Верховой режим (${mount.name}) · Скорость x${mount.speed_multiplier}`
      : `🚶 Пеший режим · Базовая скорость (1.0x)`;
    this.$('heroModeBadge').textContent = stateDesc;

    // Attributes
    const atkVal = 5 + (hero.stats?.attack || 0) * 5;
    const defVal = (hero.stats?.defense || 0) * 5;
    const intVal = (hero.stats?.intellect || 0) * 10;
    this.$('heroStatAttack').textContent = `+${atkVal}%`;
    this.$('heroStatDefense').textContent = `+${defVal}%`;
    this.$('heroStatIntellect').textContent = `+${intVal}%`;
    this.$('heroStatVision').textContent = `${hero.visionRadius || 3} гекса`;
    this.$('heroStatLeadership').textContent = `${hero.leadership || 1} / 4 слота`;

    // Mount management card
    const mountSlotCard = this.$('heroMountSlot');
    const mountBtn = this.$('heroMountToggleBtn');
    if (mount) {
      mountSlotCard.innerHTML = `<span class="mount-icon">${mount.icon}</span><div><strong>${mount.name} (Ранг ${mount.tier})</strong><p>${mount.description}</p></div>`;
      if (mountBtn) {
        mountBtn.hidden = false;
        mountBtn.textContent = 'Спешиться (Пешком)';
      }
    } else if (hero.equippedMount && HERO_CONFIG.mounts[hero.equippedMount]) {
      const eq = HERO_CONFIG.mounts[hero.equippedMount];
      mountSlotCard.innerHTML = `<span class="mount-icon">${eq.icon}</span><div><strong>${eq.name} (В стойле)</strong><p>${eq.description}</p></div>`;
      if (mountBtn) {
        mountBtn.hidden = false;
        mountBtn.textContent = `Оседлать (${eq.name})`;
      }
    } else {
      mountSlotCard.innerHTML = `<span class="mount-icon">🪑</span><div><strong>Маунт не оседлан</strong><p>Укротите зверя на 10+ уровне с помощью лассо.</p></div>`;
      if (mountBtn) mountBtn.hidden = true;
    }

    // Perks button
    const perkAlert = this.$('heroPerkAlert');
    if (perkAlert) {
      perkAlert.hidden = !(hero.pendingPerks > 0);
      this.$('heroPendingPerksCount').textContent = String(hero.pendingPerks || 0);
    }

    this.showDialog('heroPanel');
  }

  openLevelUpDialog() {
    this.showDialog('heroLevelUpDialog');
  }

  async selectPerk(perkId) {
    try {
      await this.api('/api/hero/perk', { perkId });
      this.toast(`Перк «${HERO_CONFIG.perks[perkId].name}» успешно изучен!`);
      this.$('heroLevelUpDialog')?.close();
      this.openHeroPanel();
      this.paint();
    } catch (e) {
      this.toast(e.message || 'Ошибка выбора перка', true);
    }
  }

  async toggleEquippedMount() {
    const player = this.getPlayer();
    const hero = player?.hero;
    if (!hero) return;

    const targetMount = hero.currentMount ? null : (hero.equippedMount || hero.mountsOwned?.[0]);
    try {
      await this.api('/api/hero/mount', { mountId: targetMount });
      this.toast(targetMount ? 'Герой оседлал маунта! Скорость удвоена.' : 'Герой спешился.');
      this.openHeroPanel();
      this.paint();
    } catch (e) {
      this.toast(e.message || 'Ошибка смены маунта', true);
    }
  }

  openTamingDialog(wildMount) {
    this.selectedTargetMount = wildMount;
    const player = this.getPlayer();
    const hero = player?.hero;
    if (!hero) return;

    this.$('tameBeastIcon').textContent = wildMount.icon;
    this.$('tameBeastName').textContent = wildMount.name;
    this.$('tameBeastTier').textContent = `Ранг ${wildMount.tier}`;

    const chance = Math.round(calculateTamingChance(hero.level) * 100);
    this.$('tameChanceVal').textContent = `${chance}%`;

    const hasItem = (hero.inventory || []).includes(HERO_CONFIG.taming.required_item);
    const reqItemSpan = this.$('tameItemStatus');
    if (reqItemSpan) {
      reqItemSpan.textContent = hasItem ? '✓ В наличии' : '✗ Отсутствует (найдите в руинах)';
      reqItemSpan.className = hasItem ? 'item-has' : 'item-missing';
    }

    this.showDialog('heroTamingDialog');
  }

  async executeTaming() {
    if (!this.selectedTargetMount || this.moving) return;
    this.moving = true;
    try {
      const res = await this.api('/api/hero/tame', { targetCell: this.selectedTargetMount.cell });
      this.$('heroTamingDialog')?.close();
      if (res?.tamingResult?.success) {
        this.toast(`🎉 Победа! Вы успешно приручили ${res.tamingResult.mount}! Скорость увеличена в 2 раза!`);
      } else {
        this.toast(`Зверь вырвался! Шанс был ${res?.tamingResult?.chance || 40}%. Попробуйте снова!`, true);
      }
      this.paint();
    } catch (e) {
      this.toast(e.message || 'Ошибка приручения', true);
    } finally {
      this.moving = false;
    }
  }

  toggleMoveMode() {
    this.isHeroMoveMode = !this.isHeroMoveMode;
    const banner = this.$('targetingBanner');
    if (banner) {
      banner.hidden = !this.isHeroMoveMode;
      const s = banner.querySelector('span');
      if (s) s.textContent = '🧙‍♂️ Поход Героя: выберите гекс на карте для перемещения';
    }
    this.paint();
  }

  setHoverCell(cell) {
    if (this.hoverCell !== cell) {
      this.hoverCell = cell;
      if (this.isHeroMoveMode) this.paint();
    }
  }

  async handleCellClick(cell) {
    const player = this.getPlayer();
    const hero = player?.hero;
    if (!hero || this.moving) return false;

    // Only handle map clicks when Hero mode is active
    if (!this.isHeroMoveMode) return false;

    // Check if clicked cell is adjacent wild mount
    const wild = getWildMountAt(cell);
    if (wild && gridDistance(hero.cell, cell) <= 1) {
      this.openTamingDialog(wild);
      return true;
    }

    await this.executeHeroMove(cell);
    return true;
  }

  async executeHeroMove(destination) {
    const player = this.getPlayer();
    const hero = player?.hero;
    if (!hero || this.moving) return;

    if (destination === hero.cell) {
      this.isHeroMoveMode = false;
      this.$('targetingBanner').hidden = true;
      this.paint();
      return;
    }

    const dist = gridDistance(hero.cell, destination);
    if (dist > 8) {
      this.toast('Слишком далеко для одного перехода (до 8 гексов за раз).', true);
      return;
    }

    this.moving = true;
    try {
      await this.api('/api/hero/move', { destination, cell: destination });
      this.isHeroMoveMode = false;
      this.$('targetingBanner').hidden = true;
      this.toast('Герой прибыл на новую позицию! Область исследована.');
      this.paint();
    } catch (e) {
      this.toast(e.message || 'Невозможно переместиться', true);
    } finally {
      this.moving = false;
    }
  }

  draw(ctx, { width, height, project, zoom, detailed, now }) {
    if (!detailed) return;
    const player = this.getPlayer();
    const hero = player?.hero;
    if (!hero?.cell) return;

    ctx.save();

    // 1. Draw Hero Token
    const hp = project(...cellToLatLng(hero.cell));
    if (hp.x >= -60 && hp.x <= width + 60 && hp.y >= -60 && hp.y <= height + 60) {
      const isMounted = !!hero.currentMount;
      const pulse = 1 + Math.sin(now / 500) * 0.08;

      // Aura
      ctx.beginPath();
      ctx.arc(hp.x, hp.y, 22 * pulse, 0, Math.PI * 2);
      ctx.fillStyle = isMounted ? 'rgba(234, 179, 8, 0.25)' : 'rgba(56, 189, 248, 0.22)';
      ctx.fill();

      ctx.lineWidth = 2.5;
      ctx.strokeStyle = isMounted ? '#facc15' : '#38bdf8';
      ctx.stroke();

      // Hero icon / mount
      ctx.font = '20px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const mount = hero.currentMount ? HERO_CONFIG.mounts[hero.currentMount] : null;
      ctx.fillText(mount ? mount.icon : '🧙‍♂️', hp.x, hp.y - 1);

      // Name & level plate
      ctx.font = '700 10px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif';
      const badge = `★ Ур.${hero.level} (${hero.mp} MP)`;
      const bw = ctx.measureText(badge).width + 10;
      ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
      ctx.beginPath();
      ctx.roundRect(hp.x - bw / 2, hp.y + 14, bw, 15, 3);
      ctx.fill();
      ctx.strokeStyle = isMounted ? '#facc15' : '#38bdf8';
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.fillStyle = '#ffffff';
      ctx.fillText(badge, hp.x, hp.y + 22);
    }

    // 2. Draw nearby POIs and Wild Mounts around the hero
    try {
      const nearDisk = gridDisk(hero.cell, 7);
      for (const c of nearDisk) {
        const poi = getDeterministicPoi(c);
        if (poi) {
          const pp = project(...cellToLatLng(c));
          if (pp.x >= -30 && pp.x <= width + 30 && pp.y >= -30 && pp.y <= height + 30) {
            ctx.font = '16px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(poi.icon, pp.x, pp.y);

            ctx.font = '600 9px sans-serif';
            ctx.fillStyle = '#f8fafc';
            ctx.fillText(poi.name.split(' ')[0], pp.x, pp.y + 14);
          }
        }

        const wild = getWildMountAt(c);
        if (wild) {
          const wp = project(...cellToLatLng(c));
          if (wp.x >= -30 && wp.x <= width + 30 && wp.y >= -30 && wp.y <= height + 30) {
            ctx.font = '18px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(wild.icon, wp.x, wp.y);

            ctx.font = '700 9px sans-serif';
            ctx.fillStyle = '#f59e0b';
            ctx.fillText(`Дикий (Т${wild.tier})`, wp.x, wp.y + 14);
          }
        }
      }
    } catch {}

    // 3. Move Mode Path Planner
    if (this.isHeroMoveMode && this.hoverCell && this.hoverCell !== hero.cell) {
      try {
        const dist = gridDistance(hero.cell, this.hoverCell);
        if (dist <= 8) {
          const stepMp = calculateStepMpCost(this.hoverCell, hero);
          const canAfford = hero.mp >= stepMp;
          const hp2 = project(...cellToLatLng(this.hoverCell));

          ctx.beginPath();
          ctx.moveTo(hp.x, hp.y);
          ctx.lineTo(hp2.x, hp2.y);
          ctx.lineWidth = 3;
          ctx.strokeStyle = canAfford ? '#10b981' : '#ef4444';
          ctx.setLineDash([6, 4]);
          ctx.stroke();
          ctx.setLineDash([]);

          // Cost badge
          const costText = `${stepMp} MP`;
          ctx.font = '700 11px sans-serif';
          const cw = ctx.measureText(costText).width + 10;
          ctx.fillStyle = canAfford ? '#065f46' : '#7f1d1d';
          ctx.beginPath();
          ctx.roundRect(hp2.x - cw / 2, hp2.y - 18, cw, 16, 4);
          ctx.fill();
          ctx.fillStyle = '#ffffff';
          ctx.textAlign = 'center';
          ctx.fillText(costText, hp2.x, hp2.y - 6);
        }
      } catch {}
    }

    ctx.restore();
  }
}
