import { greatCircleDistance, cellToLatLng, gridDisk, isValidCell } from 'h3-js';
import { CONTINENTS, PRIMARY_CONTINENT } from '../shared/continents.js';

/**
 * Fog of War & Reconnaissance Engine.
 * Shrouds unexplored world lands in atmospheric fog of war and reveals
 * territory as players expand their base, deploy troops, and explore.
 *
 * Performance-optimized:
 * - Persistent half-resolution offscreen canvas (4x fewer pixels, zero GC churn).
 * - Debounced/cached vision updates.
 * - Eliminated per-frame grid lines and DOM canvas allocations.
 */
export class FogOfWar {
  constructor(options = {}) {
    this.accountId = options.accountId || 'anonymous';
    this.exploredSet = new Set();
    this.activeVisionSources = [];
    this.storageKey = `pd_fog_v1_${this.accountId}`;
    this._offCanvas = null;
    this._offCtx = null;
    this._lastBaseCell = null;
    this._lastUnitHash = '';
    this.loadExplored();
  }

  setAccount(accountId) {
    if (this.accountId === accountId) return;
    this.accountId = accountId || 'anonymous';
    this.storageKey = `pd_fog_v1_${this.accountId}`;
    this.exploredSet.clear();
    this._lastBaseCell = null;
    this._lastUnitHash = '';
    this.loadExplored();
  }

  loadExplored() {
    try {
      if (typeof localStorage === 'undefined') return;
      const saved = localStorage.getItem(this.storageKey);
      if (saved) {
        const list = JSON.parse(saved);
        if (Array.isArray(list)) {
          for (const cell of list) this.exploredSet.add(cell);
        }
      }
    } catch {
      // localStorage may fail in private mode; fallback to in-memory set
    }
  }

  saveExplored() {
    try {
      if (typeof localStorage === 'undefined') return;
      if (this.exploredSet.size > 0 && this.accountId !== 'anonymous') {
        const array = Array.from(this.exploredSet).slice(0, 3000);
        localStorage.setItem(this.storageKey, JSON.stringify(array));
      }
    } catch {
      // ignore storage quota issues
    }
  }

  /**
   * Updates vision sources from player state and army units.
   * Call when world/player state changes, NOT on every 60fps render tick.
   */
  update(player, armyUnits = [], selectedContinent = null) {
    this.activeVisionSources = [];

    // 1. Player base vision (radius ~22 km)
    if (player?.baseCell && isValidCell(player.baseCell)) {
      const [lat, lng] = cellToLatLng(player.baseCell);
      this.activeVisionSources.push({
        lat,
        lng,
        radiusKm: 22,
        kind: 'base'
      });
      // Permanently mark base surroundings as explored once
      if (this._lastBaseCell !== player.baseCell) {
        this._lastBaseCell = player.baseCell;
        try {
          const disk = gridDisk(player.baseCell, 8);
          for (const c of disk) this.exploredSet.add(c);
        } catch {}
      }
    }

    // 2. Player's owned border and territory cells
    if (player?.borderCells) {
      const step = Math.max(1, Math.floor(player.borderCells.length / 16));
      for (let i = 0; i < player.borderCells.length && i < 24; i += step) {
        const cell = player.borderCells[i];
        if (isValidCell(cell)) {
          const [lat, lng] = cellToLatLng(cell);
          this.activeVisionSources.push({
            lat,
            lng,
            radiusKm: 6,
            kind: 'territory'
          });
          this.exploredSet.add(cell);
        }
      }
    }

    // 3. Living army units
    const unitHash = (armyUnits || []).map(u => `${u?.key}:${u?.cell}:${u?.hp}`).join('|');
    const unitsChanged = unitHash !== this._lastUnitHash;
    this._lastUnitHash = unitHash;

    if (Array.isArray(armyUnits)) {
      for (const unit of armyUnits) {
        if (!unit || unit.hp <= 0 || !unit.cell) continue;
        const [lat, lng] = cellToLatLng(unit.cell);
        const sightRadiusKm = unit.type === 'air' ? 14 : 9;
        this.activeVisionSources.push({
          lat,
          lng,
          radiusKm: sightRadiusKm,
          kind: 'unit'
        });

        if (unitsChanged) {
          try {
            const disk = gridDisk(unit.cell, unit.type === 'air' ? 4 : 3);
            for (const c of disk) this.exploredSet.add(c);
          } catch {}
        }
      }
    }

    // 4. Continent landing dropzone scout perimeter
    const cont = selectedContinent || PRIMARY_CONTINENT;
    if (cont?.center) {
      this.activeVisionSources.push({
        lat: cont.center.lat,
        lng: cont.center.lng,
        radiusKm: cont.baseRadiusKm * 0.45,
        kind: 'landing'
      });
    }

    // Debounced persist
    if (this._saveTimeout) clearTimeout(this._saveTimeout);
    this._saveTimeout = setTimeout(() => this.saveExplored(), 5000);
  }

  /**
   * Checks if coordinates are currently in active line of sight.
   */
  isInVision(lat, lng) {
    for (const src of this.activeVisionSources) {
      const d = greatCircleDistance([lat, lng], [src.lat, src.lng], 'km');
      if (d <= src.radiusKm) return true;
    }
    return false;
  }

  /**
   * Checks if an H3 cell is explored.
   */
  isCellExplored(cell) {
    if (!cell) return false;
    if (this.exploredSet.has(cell)) return true;
    const [lat, lng] = cellToLatLng(cell);
    return this.isInVision(lat, lng);
  }

  _getOffscreen(width, height) {
    const scale = 0.5; // Half resolution: 4x faster, buttery smooth, soft feathered fog
    const targetW = Math.max(16, Math.ceil(width * scale));
    const targetH = Math.max(16, Math.ceil(height * scale));

    if (!this._offCanvas) {
      if (typeof document !== 'undefined') {
        this._offCanvas = document.createElement('canvas');
        this._offCanvas.width = targetW;
        this._offCanvas.height = targetH;
        this._offCtx = this._offCanvas.getContext('2d');
      }
    } else if (this._offCanvas.width !== targetW || this._offCanvas.height !== targetH) {
      this._offCanvas.width = targetW;
      this._offCanvas.height = targetH;
    }
    return { canvas: this._offCanvas, ctx: this._offCtx, scale };
  }

  /**
   * Renders the Fog of War shroud layer over the canvas.
   */
  draw(ctx, { width, height, project, zoom, detailed, now = performance.now() }) {
    if (this.activeVisionSources.length === 0) return;

    ctx.save();

    if (detailed) {
      const off = this._getOffscreen(width, height);
      if (!off.canvas || !off.ctx) {
        ctx.restore();
        return;
      }

      const offCtx = off.ctx;
      const scale = off.scale;
      const offW = off.canvas.width;
      const offH = off.canvas.height;

      // 1. Fill offscreen fog shroud with dark tactical color
      offCtx.globalCompositeOperation = 'source-over';
      offCtx.fillStyle = 'rgba(7, 13, 24, 0.92)';
      offCtx.fillRect(0, 0, offW, offH);

      // 2. Carve out active vision holes with feathered radial gradients
      offCtx.globalCompositeOperation = 'destination-out';

      for (const src of this.activeVisionSources) {
        const p = project(src.lat, src.lng);
        const sx = p.x * scale;
        const sy = p.y * scale;

        // Convert km radius to screen pixels
        const pixelRadius = Math.max(35, (src.radiusKm / 40000) * width * (zoom / 4) * 2.8) * scale;
        if (sx < -pixelRadius || sx > offW + pixelRadius || sy < -pixelRadius || sy > offH + pixelRadius) continue;

        const innerRadius = Math.max(8 * scale, pixelRadius * 0.65);
        const grad = offCtx.createRadialGradient(sx, sy, innerRadius, sx, sy, pixelRadius);
        grad.addColorStop(0, 'rgba(0, 0, 0, 1.0)');
        grad.addColorStop(0.7, 'rgba(0, 0, 0, 0.85)');
        grad.addColorStop(1, 'rgba(0, 0, 0, 0)');

        offCtx.fillStyle = grad;
        offCtx.beginPath();
        offCtx.arc(sx, sy, pixelRadius, 0, Math.PI * 2);
        offCtx.fill();
      }

      // Draw the composited fog mask over the main canvas (upscaled with automatic bilinear filter)
      ctx.drawImage(off.canvas, 0, 0, width, height);

      // 3. Subtle pulsing perimeter ring around base & landing beacon
      ctx.save();
      for (const src of this.activeVisionSources) {
        if (src.kind !== 'base' && src.kind !== 'landing') continue;
        const p = project(src.lat, src.lng);
        if (p.x < -150 || p.x > width + 150 || p.y < -150 || p.y > height + 150) continue;

        const pixelRadius = Math.max(40, (src.radiusKm / 40000) * width * (zoom / 4) * 2.8);
        const pulse = 1 + Math.sin(now / 900) * 0.015;

        ctx.strokeStyle = src.kind === 'base' ? 'rgba(56, 189, 248, 0.3)' : 'rgba(245, 158, 11, 0.25)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 6]);
        ctx.beginPath();
        ctx.arc(p.x, p.y, pixelRadius * pulse, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.restore();

    } else {
      // Overview mode: soft atmospheric cloud shroud
      ctx.fillStyle = 'rgba(7, 13, 24, 0.35)';
      ctx.fillRect(0, 0, width, height);

      // Highlight active landing beacons through the cloud
      for (const src of this.activeVisionSources) {
        if (src.kind !== 'landing' && src.kind !== 'base') continue;
        const p = project(src.lat, src.lng);
        if (p.x < -50 || p.x > width + 50 || p.y < -50 || p.y > height + 50) continue;

        const grad = ctx.createRadialGradient(p.x, p.y, 4, p.x, p.y, 45);
        grad.addColorStop(0, src.kind === 'base' ? 'rgba(56, 189, 248, 0.45)' : 'rgba(245, 158, 11, 0.35)');
        grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 45, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.restore();
  }
}
