export const CAPTURE_DEPLOY_MS = 3000;

export function captureProgress(unit, now) {
  return unit?.state === 'capture' && unit.hp > 0
    ? Math.max(0, Math.min(1, (now - (Number.isFinite(unit.stateAt) ? unit.stateAt : now)) / CAPTURE_DEPLOY_MS)) : null;
}

export function troopPurpose(type) {
  return type === 'air'
    ? 'Авиация прикрывает наземные отряды и атакует противника. Землю занимает пехота или тяжёлый отряд.'
    : 'Занимает гексы: выберите «Захватить» и гекс у своей границы. Отряд дойдёт и развернёт точку контроля.';
}

export function healthExplanation(unit, now) {
  const damage = unit?.lastDamage;
  if (damage && now - damage.at < 30000) return `−${damage.amount} HP: ${damage.sourceName || 'противник'}. HP теряется только в бою; у штаба отряд восстанавливается.`;
  return 'HP теряется только от атак противника. Движение и захват не расходуют HP. У штаба отряд восстанавливается.';
}
