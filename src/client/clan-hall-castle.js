import { CLAN_HALL_CENTER_COORDS } from '../shared/clan-hall.js';

export function drawClanHallCastle(ctx, { project, zoom, cw, ch, detailed, now = performance.now() }) {
  const p = project(CLAN_HALL_CENTER_COORDS.lat, CLAN_HALL_CENTER_COORDS.lng);
  if (p.x < -180 || p.x > cw + 180 || p.y < -180 || p.y > ch + 180) return;

  ctx.save();

  if (detailed) {
    // Detailed Tactical View: Draw the massive medieval fantasy castle
    const scale = Math.min(2.2, Math.max(0.7, zoom / 1000));
    const cx = p.x;
    const cy = p.y - 10 * scale;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(scale, scale);

    // 1. Castle Shadow
    ctx.beginPath();
    ctx.ellipse(0, 48, 85, 24, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.fill();

    // 2. Outer Curtain Wall & Courtyard
    ctx.fillStyle = '#1e293b';
    ctx.strokeStyle = '#475569';
    ctx.lineWidth = 2;
    ctx.fillRect(-70, 10, 140, 36);
    ctx.strokeRect(-70, 10, 140, 36);

    // Wall Crenellations (outer battlements)
    ctx.fillStyle = '#334155';
    for (let bx = -70; bx <= 60; bx += 14) {
      ctx.fillRect(bx, 2, 8, 10);
      ctx.strokeRect(bx, 2, 8, 10);
    }

    // 3. Left & Right Bastion Towers
    const towers = [-58, 58];
    for (const tx of towers) {
      // Tower Body
      const tGrad = ctx.createLinearGradient(tx - 16, -30, tx + 16, 40);
      tGrad.addColorStop(0, '#334155');
      tGrad.addColorStop(0.5, '#1e293b');
      tGrad.addColorStop(1, '#0f172a');
      ctx.fillStyle = tGrad;
      ctx.fillRect(tx - 15, -28, 30, 72);
      ctx.strokeStyle = '#f59e0b88';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(tx - 15, -28, 30, 72);

      // Tower Crenellations
      ctx.fillStyle = '#475569';
      ctx.fillRect(tx - 17, -34, 34, 8);
      ctx.strokeRect(tx - 17, -34, 34, 8);

      // Tower Conical Roof
      ctx.beginPath();
      ctx.moveTo(tx - 18, -34);
      ctx.lineTo(tx, -65);
      ctx.lineTo(tx + 18, -34);
      ctx.closePath();
      ctx.fillStyle = '#b91c1c'; // Royal Crimson Roof
      ctx.fill();
      ctx.strokeStyle = '#f59e0b';
      ctx.stroke();

      // Tower Flying Pennant Flag
      const flagWave = Math.sin(now / 200 + tx) * 4;
      ctx.beginPath();
      ctx.moveTo(tx, -65);
      ctx.lineTo(tx, -78);
      ctx.lineTo(tx + 14, -72 + flagWave);
      ctx.lineTo(tx, -66);
      ctx.fillStyle = '#fbbf24'; // Gold banner
      ctx.fill();

      // Slit Windows
      ctx.fillStyle = '#fef08a';
      ctx.fillRect(tx - 3, -12, 6, 12);
      ctx.fillRect(tx - 3, 10, 6, 12);
    }

    // 4. Central Great Keep (Grand High Citadel)
    const keepGrad = ctx.createLinearGradient(-35, -70, 35, 45);
    keepGrad.addColorStop(0, '#475569');
    keepGrad.addColorStop(0.4, '#1e293b');
    keepGrad.addColorStop(1, '#090d16');
    ctx.fillStyle = keepGrad;
    ctx.fillRect(-35, -55, 70, 100);
    ctx.strokeStyle = '#fbbf24';
    ctx.lineWidth = 2;
    ctx.strokeRect(-35, -55, 70, 100);

    // Keep Middle Crenellated Ring
    ctx.fillStyle = '#334155';
    ctx.fillRect(-38, -62, 76, 9);
    ctx.strokeRect(-38, -62, 76, 9);

    // 5. Central High Spire & Crown
    ctx.beginPath();
    ctx.moveTo(-24, -62);
    ctx.lineTo(0, -102);
    ctx.lineTo(24, -62);
    ctx.closePath();
    ctx.fillStyle = '#7f1d1d'; // Deep imperial roof
    ctx.fill();
    ctx.strokeStyle = '#f59e0b';
    ctx.stroke();

    // Grand Spire Flag
    const centralWave = Math.sin(now / 180) * 6;
    ctx.beginPath();
    ctx.moveTo(0, -102);
    ctx.lineTo(0, -120);
    ctx.lineTo(24, -112 + centralWave);
    ctx.lineTo(0, -104);
    ctx.fillStyle = '#f59e0b';
    ctx.fill();

    // 6. Arched Gatehouse & Portcullis
    ctx.fillStyle = '#05070a';
    ctx.beginPath();
    ctx.arc(0, 24, 16, Math.PI, 0);
    ctx.lineTo(16, 46);
    ctx.lineTo(-16, 46);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Portcullis Grate
    ctx.strokeStyle = '#94a3b8';
    ctx.lineWidth = 1;
    for (let gx = -10; gx <= 10; gx += 5) {
      ctx.beginPath();
      ctx.moveTo(gx, 20);
      ctx.lineTo(gx, 46);
      ctx.stroke();
    }

    // Glowing Stained Glass / Magic Energy Windows
    ctx.fillStyle = '#38bdf8';
    ctx.shadowColor = '#38bdf8';
    ctx.shadowBlur = 8;
    ctx.fillRect(-12, -35, 8, 16);
    ctx.fillRect(4, -35, 8, 16);
    ctx.fillRect(-5, -15, 10, 18);
    ctx.shadowBlur = 0;

    // Gate Torches Warm Glow
    ctx.fillStyle = '#f59e0b';
    ctx.beginPath();
    ctx.arc(-22, 26, 4, 0, Math.PI * 2);
    ctx.arc(22, 26, 4, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();

    // 7. Floating Title & Event Status Badge
    const title = '🏰 ВЕЛИКИЙ КЛАНХОЛЛ';
    const subtitle = '🔒 ИВЕНТ ЗАКРЫТ · СЕЗОН 2';

    ctx.font = '700 12px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif';
    const tw = Math.max(ctx.measureText(title).width, ctx.measureText(subtitle).width) + 24;
    const badgeY = cy + 54 * scale;

    ctx.fillStyle = 'rgba(15, 23, 42, 0.94)';
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(cx - tw / 2, badgeY, tw, 36, 8);
    ctx.fill();
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.fillStyle = '#fbbf24';
    ctx.fillText(title, cx, badgeY + 15);

    ctx.font = '600 10px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif';
    ctx.fillStyle = '#f87171'; // Red lock alert
    ctx.fillText(subtitle, cx, badgeY + 29);
    ctx.textAlign = 'left';

  } else {
    // Strategic Overview Mode: Prominent fortress pin with glowing radial aura
    const pulse = 1 + Math.sin(now / 500) * 0.08;
    const r = 18 * pulse;

    // Glowing fortress aura
    const aura = ctx.createRadialGradient(p.x, p.y, 4, p.x, p.y, r * 2.2);
    aura.addColorStop(0, 'rgba(245, 158, 11, 0.45)');
    aura.addColorStop(0.6, 'rgba(217, 119, 6, 0.15)');
    aura.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = aura;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r * 2.2, 0, Math.PI * 2);
    ctx.fill();

    // Fortress Hex Shield
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = '#1e1b4b';
    ctx.fill();
    ctx.strokeStyle = '#fbbf24';
    ctx.lineWidth = 2.5;
    ctx.stroke();

    // Center Castle Icon
    ctx.font = `${Math.round(r * 1.1)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('🏰', p.x, p.y);
    ctx.textBaseline = 'alphabetic';

    // Overview Badge Label
    const label = 'ВЕЛИКИЙ КЛАНХОЛЛ [Сезон 2]';
    ctx.font = '700 11px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif';
    const lw = ctx.measureText(label).width + 16;
    ctx.fillStyle = 'rgba(10, 15, 29, 0.9)';
    ctx.strokeStyle = '#d97706';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(p.x - lw / 2, p.y + r + 5, lw, 18, 4);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#fef08a';
    ctx.fillText(label, p.x, p.y + r + 18);
    ctx.textAlign = 'left';
  }

  ctx.restore();
}

