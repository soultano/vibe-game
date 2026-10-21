import { greatCircleDistance, cellToLatLng, isValidCell, getResolution } from 'h3-js';
import { cellIsLand } from './geography.js';
import { isClanHallCell } from './clan-hall.js';

/**
 * Global Continents and Primary Landing Dropzones.
 * Each continent features an expedition landing beacon from which colonies expand.
 */
export const CONTINENTS = Object.freeze([
  {
    id: 'asia',
    name: 'Евразия (Центральная Азия)',
    shortName: 'Евразия',
    flag: '🌍',
    center: Object.freeze({ lat: 41.3111, lng: 69.2797 }), // Ташкент (Основная историческая высадка)
    isPrimary: true,
    baseRadiusKm: 120,      // Базовый радиус начального плацдарма
    growthPerPlayerKm: 8,   // Расширение радиуса за каждого высадившегося командира
    maxRadiusKm: 1200
  },
  {
    id: 'europe',
    name: 'Европа',
    shortName: 'Европа',
    flag: '🏰',
    center: Object.freeze({ lat: 50.05, lng: 14.45 }), // Прага (возле Великого Кланхолла)
    isPrimary: false,
    baseRadiusKm: 90,
    growthPerPlayerKm: 8,
    maxRadiusKm: 1000
  },
  {
    id: 'north_america',
    name: 'Северная Америка',
    shortName: 'Сев. Америка',
    flag: '🗽',
    center: Object.freeze({ lat: 40.7128, lng: -74.0060 }), // Нью-Йорк / Атлантическое побережье
    isPrimary: false,
    baseRadiusKm: 90,
    growthPerPlayerKm: 8,
    maxRadiusKm: 1000
  },
  {
    id: 'south_america',
    name: 'Южная Америка',
    shortName: 'Юж. Америка',
    flag: '🌴',
    center: Object.freeze({ lat: -23.5505, lng: -46.6333 }), // Сан-Паулу
    isPrimary: false,
    baseRadiusKm: 80,
    growthPerPlayerKm: 8,
    maxRadiusKm: 900
  },
  {
    id: 'africa',
    name: 'Африка',
    shortName: 'Африка',
    flag: '🏜',
    center: Object.freeze({ lat: 30.0444, lng: 31.2357 }), // Дельта Нила / Каир
    isPrimary: false,
    baseRadiusKm: 80,
    growthPerPlayerKm: 8,
    maxRadiusKm: 900
  },
  {
    id: 'east_asia',
    name: 'Восточная Азия',
    shortName: 'Вост. Азия',
    flag: '⛩',
    center: Object.freeze({ lat: 35.6762, lng: 139.6503 }), // Токио / Тихоокеанский плацдарм
    isPrimary: false,
    baseRadiusKm: 80,
    growthPerPlayerKm: 8,
    maxRadiusKm: 900
  },
  {
    id: 'australia',
    name: 'Австралия',
    shortName: 'Австралия',
    flag: '🦘',
    center: Object.freeze({ lat: -33.8688, lng: 151.2093 }), // Сидней
    isPrimary: false,
    baseRadiusKm: 70,
    growthPerPlayerKm: 8,
    maxRadiusKm: 800
  }
]);

export const PRIMARY_CONTINENT = CONTINENTS[0];

export const CONTINENTS_BY_ID = Object.freeze(
  new Map(CONTINENTS.map(c => [c.id, c]))
);

export function getContinent(id) {
  return CONTINENTS_BY_ID.get(id) || PRIMARY_CONTINENT;
}

/**
 * Maximum distance from an established player base to build a new colony (chain settlement).
 */
export const SETTLEMENT_CHAIN_MAX_KM = 35;

/**
 * Calculates current dynamic landing radius for a continent based on its player population.
 */
export function getContinentLandingRadiusKm(continent, playersCount = 0) {
  const c = typeof continent === 'string' ? getContinent(continent) : continent;
  if (!c) return 60;
  return Math.min(c.maxRadiusKm, c.baseRadiusKm + Math.max(0, playersCount) * c.growthPerPlayerKm);
}

/**
 * Finds the closest continent landing hub to a given coordinate.
 */
export function findNearestContinent(lat, lng) {
  let nearest = PRIMARY_CONTINENT;
  let minDistance = Infinity;
  for (const c of CONTINENTS) {
    const d = greatCircleDistance([lat, lng], [c.center.lat, c.center.lng], 'km');
    if (d < minDistance) {
      minDistance = d;
      nearest = c;
    }
  }
  return { continent: nearest, distanceKm: minDistance };
}

/**
 * Checks if a cell is allowed for placing a base/building according to settlement rules:
 * - Must be on land
 * - Not Clan Hall
 * - Either inside a continent's dynamic landing zone OR near an existing player base (up to 35 km).
 *
 * @param {string} cell - H3 resolution 8 cell
 * @param {object} options
 * @param {string[]} [options.existingBases] - array of existing player base cells
 * @param {string} [options.continentId] - preferred continent id
 * @param {number} [options.continentPlayersCount] - count of players on that continent
 */
export function validateSettlementPlacement(cell, options = {}) {
  if (!isValidCell(cell) || getResolution(cell) !== 8) {
    return { allowed: false, reason: 'Некорректная ячейка карты.' };
  }
  if (!cellIsLand(cell)) {
    return { allowed: false, reason: 'Штаб нельзя развернуть в воде. Выберите сушу.' };
  }
  if (isClanHallCell(cell)) {
    return { allowed: false, reason: 'Территория Великого Кланхолла защищена. Ивент откроется в следующем сезоне.', code: 'EVENT_LOCKED' };
  }

  const [lat, lng] = cellToLatLng(cell);
  const existingBases = options.existingBases || [];

  // 1. Check if near any existing player base (chain settlement / cluster expansion)
  let nearestBaseDistance = Infinity;
  for (const b of existingBases) {
    if (!b || !isValidCell(b)) continue;
    const [bLat, bLng] = cellToLatLng(b);
    const d = greatCircleDistance([lat, lng], [bLat, bLng], 'km');
    if (d < nearestBaseDistance) nearestBaseDistance = d;
    if (d <= SETTLEMENT_CHAIN_MAX_KM) {
      return {
        allowed: true,
        reason: null,
        type: 'cluster',
        distanceKm: d
      };
    }
  }

  // 2. Check if within active landing zone of preferred or any continent
  const targetContinent = options.continentId ? getContinent(options.continentId) : null;
  const continentsToCheck = targetContinent ? [targetContinent, ...CONTINENTS.filter(c => c.id !== targetContinent.id)] : CONTINENTS;

  for (const c of continentsToCheck) {
    const d = greatCircleDistance([lat, lng], [c.center.lat, c.center.lng], 'km');
    const radius = getContinentLandingRadiusKm(c, options.continentPlayersCount ?? 0);
    if (d <= radius) {
      return {
        allowed: true,
        reason: null,
        type: 'landing_zone',
        continent: c,
        distanceKm: d,
        radiusKm: radius
      };
    }
  }

  const nearest = findNearestContinent(lat, lng);
  return {
    allowed: false,
    reason: `В диких землях нет связи с экспедицией. Стройте рядом с зоной высадки (${nearest.continent.shortName}, до ${Math.round(getContinentLandingRadiusKm(nearest.continent, options.continentPlayersCount || 0))} км) или рядом с базами других командиров (до ${SETTLEMENT_CHAIN_MAX_KM} км), либо выберите другой материк.`,
    code: 'OUTSIDE_SETTLEMENT',
    nearestContinent: nearest.continent,
    distanceToNearestHubKm: nearest.distanceKm,
    distanceToNearestBaseKm: nearestBaseDistance
  };
}
