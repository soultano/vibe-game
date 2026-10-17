import { cellToParent, gridDistance, cellToLatLng, greatCircleDistance, gridDisk, getHexagonEdgeLengthAvg } from 'h3-js';
import { deriveLevel } from '../shared/economy.js';
import { CONFIG } from '../shared/config.js';

function distance(a, b) {
  try { return gridDistance(a, b); }
  catch { return greatCircleDistance(cellToLatLng(a), cellToLatLng(b), 'km') / 0.75; }
}

export function projectedRadius(player) {
  const level = Math.max(player.level, player.upgradeTargetLevel ?? 1, player.queuedProject?.targetLevel ?? 1);
  return deriveLevel(level, player.faction).radiusRings * 4;
}

/** Compact res-3 metadata selects complete interacting components before player reads. */
export async function nearbyPlayerIds(store, tx, seasonId, centers) {
  tx.spatialMetadata ??= new Map();
  tx.spatialBuckets ??= new Map();
  const maxRadius = deriveLevel(CONFIG.MAX_LEVEL).radiusRings * 4;
  const bucketResolution = 1;
  const edgeRatio = getHexagonEdgeLengthAvg(CONFIG.H3_RESOLUTION, 'km') / getHexagonEdgeLengthAvg(bucketResolution, 'km');
  const entries = new Map();
  const selected = new Set();
  const frontier = [...centers];
  for (let index = 0; index < frontier.length; index++) {
    const center = frontier[index];
    // The maximum opposing radius guarantees a sleeping high-level base is found.
    // Neighbouring res-1 prefixes contain only occupied res-3 metadata. Empty
    // res-3 cells do not cause thousands of individual database requests.
    const rings = Math.ceil((center.radiusRings + maxRadius) * edgeRatio * 1.3) + 2;
    const keys = gridDisk(cellToParent(center.cell, bucketResolution), rings).map(parent => `spatial:${seasonId}:${parent}:`);
    const missing = keys.filter(key => !tx.spatialBuckets.has(key));
    for (let offset = 0; offset < missing.length; offset += 32) await Promise.all(missing.slice(offset, offset + 32).map(async key => {
      const rows = await store.list(key);
      tx.spatialBuckets.set(key, rows.map(row => row.key));
      for (const row of rows) if (!tx.spatialMetadata.has(row.key)) tx.spatialMetadata.set(row.key, row.value);
    }));
    for (const key of keys) for (const rowKey of tx.spatialBuckets.get(key))
      for (const entry of Object.values(tx.spatialMetadata.get(rowKey)?.entries ?? {})) entries.set(entry.id, entry);
    for (const entry of entries.values()) {
      if (selected.has(entry.id)) continue;
      if (distance(center.cell, entry.baseCell) > center.radiusRings + entry.radiusRings + 2) continue;
      selected.add(entry.id);
      frontier.push({ cell: entry.baseCell, radiusRings: entry.radiusRings });
    }
  }
  return [...selected].sort();
}

export async function indexPlayer(tx, player) {
  const parent = cellToParent(player.baseCell, CONFIG.SHARD_RESOLUTION);
  const bucket = cellToParent(player.baseCell, 1);
  const key = `spatial:${player.seasonId}:${bucket}:${parent}`;
  const row = await tx.get(key) ?? { parent, entries: {} };
  const entry = { id: player.id, baseCell: player.baseCell, radiusRings: projectedRadius(player) };
  const old = row.entries[player.id];
  if (old && old.baseCell === entry.baseCell && old.radiusRings === entry.radiusRings) return;
  row.entries[player.id] = entry;
  await tx.put(key, row);
  tx.spatialMetadata?.set(key, row);
  const epochKey = `world-index:${player.seasonId}`, epoch = await tx.get(epochKey);
  await tx.put(epochKey, { epoch: (epoch?.epoch ?? 0) + 1 });
}
