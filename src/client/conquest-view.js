import { captureProgress } from '../shared/conquest.js';

// Shared Canvas overlay for WebGL, sprite fallback, web and Mini App.
export function drawConquestSites(ctx, units, view, now) {
  const sites = new Map();
  for (const unit of units) {
    const progress = captureProgress(unit, now);
    if (progress === null || sites.has(unit.cell)) continue;
    sites.set(unit.cell, true);
    const p = view.projectCell(unit.cell), shape = view.shapeCell(unit.cell);
    if (!p || !shape || !shape.length || p.x < -120 || p.y < -120 || p.x > view.width + 120 || p.y > view.height + 120) continue;
    const radius = Math.max(12, Math.min(60, Math.max(...shape.map(q => Math.hypot(q.x-p.x,q.y-p.y))) * .55));
    ctx.save();
    ctx.beginPath();shape.forEach((q,i) => i ? ctx.lineTo(q.x,q.y) : ctx.moveTo(q.x,q.y));ctx.closePath();
    ctx.fillStyle = unit.color + '30';ctx.strokeStyle = unit.color;ctx.lineWidth = 2;ctx.fill();ctx.stroke();
    // A control mast unfolds while the server's occupation timer runs.
    const mast = radius * (.4 + progress * .8), x = p.x + radius * .65, y = p.y;
    ctx.strokeStyle = '#f2f8e7';ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x,y-mast);ctx.stroke();
    ctx.fillStyle = unit.color;ctx.beginPath();ctx.moveTo(x,y-mast);ctx.lineTo(x+radius*.65*progress,y-mast+radius*.17);ctx.lineTo(x,y-mast+radius*.35);ctx.closePath();ctx.fill();
    ctx.strokeStyle = unit.color;ctx.lineWidth=3;ctx.beginPath();ctx.arc(p.x,p.y,radius,-Math.PI/2,-Math.PI/2+progress*Math.PI*2);ctx.stroke();
    const label = `Развёртывание ${Math.min(99,Math.floor(progress*100))}%`;
    ctx.font='600 11px sans-serif';ctx.textAlign='center';const width=ctx.measureText(label).width+16;
    ctx.fillStyle='#081c20ed';ctx.fillRect(p.x-width/2,p.y+radius+5,width,21);ctx.fillStyle='#ecf3db';ctx.fillText(label,p.x,p.y+radius+19);
    ctx.restore();
  }
}

export function drawDamageIndicators(ctx, units, view, now) {
  for (const unit of units) {
    const damage = unit.lastDamage, age = now - (damage?.at || 0);
    if (!damage || age < 0 || age > 4000) continue;
    const p = view.projectCell(unit.cell);
    if (!p || p.x < 0 || p.y < 0 || p.x > view.width || p.y > view.height) continue;
    ctx.save();ctx.font='700 11px sans-serif';ctx.textAlign='center';
    const label=`−${damage.amount} HP · ${damage.sourceName}`,width=ctx.measureText(label).width+12;
    ctx.fillStyle='#271116ed';ctx.fillRect(p.x-width/2,p.y-47,width,20);ctx.fillStyle='#ffb4a4';ctx.fillText(label,p.x,p.y-33);ctx.restore();
  }
}
