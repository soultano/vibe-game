import { getFaction } from './config.js';
export const TROOP_ASSET_VERSION='living-v2';
export const troopModelUrl=id=>`/assets/troops/${id}.glb?v=${TROOP_ASSET_VERSION}`;

// Existing ability IDs remain stable for stored cooldowns and payment receipts.
export const TROOP_CLASSES = Object.freeze([
  { id: 'infantry', label: 'Лёгкая пехота', abilityId: 'infantry', size: 22 },
  { id: 'armor', label: 'Тяжёлый отряд', abilityId: 'field', size: 35 },
  { id: 'air', label: 'Авиация', abilityId: 'heavy', size: 45 },
  { id: 'ultimate', label: 'Ультимативный юнит', abilityId: 'ultimate', size: 62 },
].map(Object.freeze));
const catalog = {
  protocol: [['Сентинел', 'Робот с импульсным карабином'], ['Бастион', 'Четырёхногий осадный мех'], ['Архонт', 'Воздушный боевой носитель'], ['Омега', 'Парящее ядро со щитом и импульсом']],
  vanguard: [['Рейнджер', 'Штурмовик в тактической броне'], ['Крепость', 'Гусеничный танк прорыва'], ['Громовержец', 'Бронированный конвертоплан'], ['Атлант', 'Пилотируемый осадный экзокостюм']],
  bloom: [['Спороносец', 'Грибной боец со споромётом'], ['Корнеглот', 'Тяжёлый корневой зверь'], ['Манта спор', 'Парящая грибная манта'], ['Праматерь', 'Шагающий организм с живым сердцем']],
  swarm: [['Жало', 'Быстрый богомол-разведчик'], ['Таран', 'Осадный жук с кислотными железами'], ['Жнец', 'Крылатый ядовитый бомбардировщик'], ['Левиафан улья', 'Подвижный бронированный выводок']],
  pack: [['Клык', 'Лёгкий киберволк'], ['Грохот', 'Тяжёлый кибермедведь'], ['Коршун', 'Киберптица с бронированными крыльями'], ['Первозверь', 'Гигантский саблезубый киберхищник']],
};
export const TROOP_ANIMATIONS = Object.freeze(['idle', 'walk', 'run', 'attack', 'capture', 'death']);
export function troopFor(faction, type = 'infantry') {
  const side = getFaction(faction), role = TROOP_CLASSES.find(value => value.id === type) || TROOP_CLASSES[0];
  const [name, description] = catalog[side.id][TROOP_CLASSES.indexOf(role)];
  const id = `${side.id}-${role.id}`;
  return { ...role, id, type: role.id, faction: side.id, color: side.color, name, description,
    model: troopModelUrl(id), poster: `/assets/troops/${id}.webp` };
}
export function troopForAbility(faction, abilityId) {
  return troopFor(faction, TROOP_CLASSES.find(value => value.abilityId === abilityId)?.id);
}
export function troopDeployment(player, now) {
  if (!player?.baseCell) return [];
  return TROOP_CLASSES.flatMap(role => {
    const ability = Array.isArray(player.abilities) ? player.abilities.find(value => value.id === role.abilityId) : player.abilities?.[role.abilityId];
    const active = Number.isFinite(ability?.activeUntil) && ability.activeUntil > now && (ability.activeFrom ?? 0) <= now;
    if (role.id !== 'infantry' && !active) return [];
    return [{ type: role.id, count: role.id === 'infantry' ? active ? 5 : 3 : 1,
      activeUntil: active ? ability.activeUntil : null }];
  });
}
