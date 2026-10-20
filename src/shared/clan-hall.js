import { latLngToCell, gridDisk, gridRing, cellToLatLng } from 'h3-js';

export const CLAN_HALL_CENTER_COORDS = Object.freeze({
  lat: 50.0772,
  lng: 14.4254,
  name: 'Великий Кланхолл',
  subtitle: 'Цитадель Европы',
  season: 'Сезон 2',
  status: 'closed',
  eventMessage: 'Ивент закрыт: Захват и управление Кланхоллом станут доступны в следующем сезоне!',
  eventShortMessage: 'Ивент недоступен (появится в следующем сезоне)'
});

export const CLAN_HALL_CENTER_CELL = latLngToCell(CLAN_HALL_CENTER_COORDS.lat, CLAN_HALL_CENTER_COORDS.lng, 8);

// 37 hexes from radius 3 disk + 3 strategic bastion gatehouses from ring 4 = exactly 40 hexes
const diskCells = gridDisk(CLAN_HALL_CENTER_CELL, 3);
const ring4 = gridRing(CLAN_HALL_CENTER_CELL, 4);
const bastions = [ring4[0], ring4[8], ring4[16]];

export const CLAN_HALL_CELLS = Object.freeze([...diskCells, ...bastions]);
export const CLAN_HALL_CELLS_SET = Object.freeze(new Set(CLAN_HALL_CELLS));

export function isClanHallCell(cell) {
  return CLAN_HALL_CELLS_SET.has(cell);
}

export function isClanHallCenter(cell) {
  return cell === CLAN_HALL_CENTER_CELL;
}
