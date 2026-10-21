import { greatCircleDistance, cellToLatLng, gridDisk, isValidCell } from 'h3-js';
import { CONTINENTS, PRIMARY_CONTINENT } from '../shared/continents.js';

/**
 * Fog of War & Reconnaissance Engine.
 * Shrouds unexplored world lands in atmospheric fog of war and reveals
 * territory as players expand their base, deploy troops, and explore.
 */
export class FogOfWar {
  constructor(options = {}) {
    this.accountId = options.accountId || 'anonymous';
    this.exploredSet = new Set();
    this.activeVisionSources = [];
    this.storageKey = `pd_fog_v1_${this.accountId}`;
    this.loadExplored();
  }

  setAccount(accountId) {
    if (this.accountId === accountId) return;
    this.accountId = accountId || 'anonymous';
    this.storageKey = `pd_fog_v1_${this.accountId}`;
    this.exploredSet.clear();
    this.loadExplored();
  }

  loadExplored() {
    try {
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
      if (this.exploredSet.size > 0 && this.accountId !== 'anonymous') {
        const array = Array.from(this.exploredSet).slice(0, 5000);
        localStorage.setItem(this.storageKey, JSON.stringify(array));
      }
    } catch {
      // ignore storage quota issues
    }
  }

  /**
   * Updates vision sources from player state and army units.
   */
  update(player, armyUnits = [], selectedContinent = null) {
    this.activeVisionSources = [];

    // 1. Player base vision (radius ~18-20 hexes / 20 km)
    if (player?.baseCell && isValidCell(player.baseCell)) {
      const [lat, lng] = cellToLatLng(player.baseCell);
      this.activeVisionSources.push({
        lat,
        lng,
        radiusKm: 22,
        kind: 'base'
      });
      // Permanently mark base surroundings as explored
      try {
        const disk = gridDisk(player.baseCell, 8);
        for (const c of disk) this.exploredSet.add(c);
      } catch {}
    }

    // 2. Player's owned border and territory cells
    if (player?.borderCells) {
      for (let i = 0; i < Math.min(24, player.borderCells.length); i += 2) {
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

    // 3. Living army units (infantry, heavy, air, ultimate)
    // As soldiers march and patrol, their vision circle moves with them in real-time!
    if (Array.isArray(armyUnits)) {
      for (const unit of armyUnits) {
        if (!unit || unit.hp <= 0 || !unit.cell) continue;
        const [lat, lng] = cellToLatLng(unit.cell);
        // Air units have slightly greater reconnaissance radius
        const sightRadiusKm = unit.type === 'air' ? 14 : 9;
        this.activeVisionSources.push({
          lat,
          lng,
          radiusKm: sightRadiusKm,
          kind: 'unit'
        });

        // Add unit's footprint to explored memory
        try {
          const disk = gridDisk(unit.cell, unit.type === 'air' ? 4 : 3);
          for (const c of disk) this.exploredSet.add(c);
        } catch {}
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

  /**
   * Renders the Fog of War shroud layer over the canvas.
   */
  draw(ctx, { width, height, project, zoom, detailed, now = performance.now() }) {
    if (this.activeVisionSources.length === 0) return;

    ctx.save();

    if (detailed) {
      // Tactical mode: draw dark atmospheric fog shroud with feathered cutouts
      // Create temporary offscreen layer to composite fog cutouts cleanly
      const offCanvas = document.createElement('canvas');
      offCanvas.width = width;
      offCanvas.height = height;
      const offCtx = offCanvas.getContext('2d');
      if (!offCtx) {
        ctx.restore();
        return;
      }

      // 1. Fill entire screen with deep atmospheric fog of war
      offCtx.fillStyle = 'rgba(7, 13, 24, 0.93)';
      offCtx.fillRect(0, 0, width, height);

      // Subtle atmospheric grid mesh in deep fog
      offCtx.strokeStyle = 'rgba(30, 41, 59, 0.2)';
      offCtx.lineWidth = 1;
      const gridSize = Math.max(30, Math.min(80, zoom / 15));
      for (let x = 0; x < width; x += gridSize) {
        offCtx.beginPath();
        offCtx.moveTo(x, 0);
        offCtx.lineTo(x, height);
        offCtx.stroke();
      }
      for (let y = 0; y < height; y += gridSize) {
        offCtx.beginPath();
        offCtx.moveTo(0, y);
        offCtx.lineTo(width, y);
        offCtx.stroke();
      }

      // 2. Carve out active vision holes with feathered radial gradients
      offCtx.globalCompositeOperation = 'destination-out';

      for (const src of this.activeVisionSources) {
        const p = project(src.lat, src.lng);
        if (p.x < -300 || p.x > width + 300 || p.y < -300 || p.y > height + 300) continue;

        // Convert km radius to screen pixels based on zoom
        const pixelRadius = Math.max(40, (src.radiusKm / 40000) * width * (zoom / 4) * 2.8);
        const innerRadius = Math.max(10, pixelRadius * 0.65);

        const grad = offCtx.createRadialGradient(p.x, p.y, innerRadius, p.x, p.y, pixelRadius);
        grad.addColorStop(0, 'rgba(0, 0, 0, 1.0)');
        grad.addColorStop(0.7, 'rgba(0, 0, 0, 0.85)');
        grad.addColorStop(1, 'rgba(0, 0, 0, 0)');

        offCtx.fillStyle = grad;
        offCtx.beginPath();
        offCtx.arc(p.x, p.y, pixelRadius, 0, Math.PI * 2);
        offCtx.fill();
      }

      // Draw the composited fog mask over the main canvas
      ctx.drawImage(offCanvas, 0, 0);

      // 3. Draw subtle glowing frontier radar perimeter around vision sources
      ctx.save();
      for (const src of this.activeVisionSources) {
        if (src.kind !== 'base' && src.kind !== 'landing') continue;
        const p = project(src.lat, src.lng);
        if (p.x < -150 || p.x > width + 150 || p.y < -150 || p.y > height + 150) continue;

        const pixelRadius = Math.max(40, (src.radiusKm / 40000) * width * (zoom / 4) * 2.8);
        const pulse = 1 + Math.sin(now / 800) * 0.02;

        ctx.strokeStyle = src.kind === 'base' ? 'rgba(56, 189, 248, 0.28)' : 'rgba(245, 158, 11, 0.22)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 6]);
        ctx.beginPath();
        ctx.arc(p.x, p.y, pixelRadius * pulse, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.restore();

    } else {
      // Overview mode: soft cloud/fog shroud covering distant continents
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
