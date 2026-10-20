const RAD = Math.PI / 180, DEG = 180 / Math.PI;
export const wrapLongitude = value => ((value + 180) % 360 + 360) % 360 - 180;
export function geographicPosition(lat, lng) {
  lat = wrapLongitude(lat);
  if (lat > 90) return { lat: 180 - lat, lng: wrapLongitude(lng + 180) };
  if (lat < -90) return { lat: -180 - lat, lng: wrapLongitude(lng + 180) };
  return { lat, lng: wrapLongitude(lng) };
}
const odd = n => Math.abs(n % 2) === 1;

// Raw latitude continues through the poles. A reflected world sheet is the
// same geographic planet, not another game world or another set of tile IDs.
export function createWorldCamera({ width, height, zoom, lat = 41.31, lng = 69.28, mode = 'auto' }) {
  lat = wrapLongitude(lat); lng = wrapLongitude(lng);
  const size = Math.max(Math.min(width / 360, height / 180), width / 720, height / 360) * zoom;
  const globe = mode !== 'flat' && zoom < 4;
  const radius = Math.min(width, height) * .41 * zoom;
  const sinLat = Math.sin(lat * RAD), cosLat = Math.cos(lat * RAD), sinLng = Math.sin(lng * RAD), cosLng = Math.cos(lng * RAD);
  const raw = { west: lng - width / (2 * size), east: lng + width / (2 * size), south: lat - height / (2 * size), north: lat + height / (2 * size) };
  const center = geographicPosition(lat, lng);

  function points(a, b, margin = 80) {
    if (globe) {
      const p = project(a, b);
      return p.visible && p.x >= -margin && p.x <= width + margin && p.y >= -margin && p.y <= height + margin ? [p] : [];
    }
    const result = [];
    for (let sheet = Math.floor((raw.south + 90) / 180); sheet <= Math.floor((raw.north + 90) / 180); sheet++) {
      const y = height / 2 - (sheet * 180 + (odd(sheet) ? -a : a) - lat) * size;
      const base = b - (odd(sheet) ? 180 : 0);
      for (let turn = Math.floor((raw.west - base) / 360); turn <= Math.ceil((raw.east - base) / 360); turn++) {
        const x = width / 2 + (base + turn * 360 - lng) * size;
        if (x >= -margin && x <= width + margin && y >= -margin && y <= height + margin) result.push({ x, y, visible: true, sheet, turn });
      }
    }
    return result;
  }
  function project(a, b) {
    if (globe) {
      const phi = a * RAD, delta = (b - lng) * RAD;
      const east = Math.cos(phi) * Math.sin(delta), north = cosLat * Math.sin(phi) - sinLat * Math.cos(phi) * Math.cos(delta);
      const depth = sinLat * Math.sin(phi) + cosLat * Math.cos(phi) * Math.cos(delta);
      if (depth < -1e-9) return { x: -1e9, y: -1e9, visible: false };
      return { x: width / 2 + east * radius, y: height / 2 - north * radius, visible: true };
    }
    let best, distance = Infinity;
    const middle = Math.round(lat / 180);
    for (let sheet = middle - 1; sheet <= middle + 1; sheet++) {
      const aRaw = sheet * 180 + (odd(sheet) ? -a : a), bRaw = lng + wrapLongitude(b - (odd(sheet) ? 180 : 0) - lng);
      const x = width / 2 + (bRaw - lng) * size, y = height / 2 - (aRaw - lat) * size, d = Math.hypot(x - width / 2, y - height / 2);
      if (d < distance) { distance = d; best = { x, y, visible: true }; }
    }
    return best;
  }
  function atPoint(x, y) {
    if (!globe) {
      const rawLat = lat - (y - height / 2) / size, rawLng = lng + (x - width / 2) / size;
      return { ...geographicPosition(rawLat, rawLng), rawLat, rawLng, valid: true };
    }
    const east = (x - width / 2) / radius, north = -(y - height / 2) / radius, r2 = east * east + north * north;
    if (r2 > 1) return { ...center, valid: false };
    const front = Math.sqrt(Math.max(0, 1 - r2));
    const a = Math.asin(Math.max(-1, Math.min(1, north * cosLat + front * sinLat))) * DEG;
    const b = lng + Math.atan2(east, front * cosLat - north * sinLat) * DEG;
    return { lat: a, lng: wrapLongitude(b), valid: true };
  }
  function rasterPatches(bounds = { west: -180, east: 180, south: -90, north: 90 }) {
    const patches = [];
    for (let sheet = Math.floor((raw.south + 90) / 180); sheet <= Math.floor((raw.north + 90) / 180); sheet++) {
      const flipY = odd(sheet), top = sheet * 180 + (flipY ? -bounds.south : bounds.north), bottom = sheet * 180 + (flipY ? -bounds.north : bounds.south);
      const start = bounds.west - (flipY ? 180 : 0);
      for (let turn = Math.floor((raw.west - start - (bounds.east - bounds.west)) / 360) + 1; turn <= Math.floor((raw.east - start) / 360); turn++) {
        const left = start + turn * 360;
        if (top < raw.south || bottom > raw.north) continue;
        patches.push({ x: width / 2 + (left - lng) * size, y: height / 2 - (top - lat) * size, width: (bounds.east - bounds.west) * size, height: (top - bottom) * size, flipY, sheet, turn });
      }
    }
    return patches;
  }
  function requestView() {
    // A globe reuses one bounded compact world summary during rotation. Never
    // request exact ownership masks or model assets for its hidden hemisphere.
    if (globe) return { bounds: { west: -180, east: 180, south: -90, north: 90 }, windows: [] };
    const windows = [];
    for (const p of rasterPatches()) {
      const a = atPoint(Math.max(0, p.x), Math.max(0, p.y)), b = atPoint(Math.min(width, p.x + p.width), Math.min(height, p.y + p.height));
      const westRaw = Math.max(raw.west, -180 - (odd(p.sheet) ? 180 : 0) + p.turn * 360);
      const eastRaw = Math.min(raw.east, 180 - (odd(p.sheet) ? 180 : 0) + p.turn * 360);
      const offset = (odd(p.sheet) ? 180 : 0) - p.turn * 360;
      const south = Math.min(a.lat, b.lat), north = Math.max(a.lat, b.lat);
      const west = Math.max(-180, westRaw + offset), east = Math.min(180, eastRaw + offset);
      if (west < east && south < north) windows.push({ west, east, south, north });
    }
    // Preserve the smaller antimeridian interval; reflected polar sheets may
    // require all longitudes for the overview, while exact requests use windows.
    const south = Math.min(...windows.map(w => w.south)), north = Math.max(...windows.map(w => w.north));
    const sheet = Math.floor((lat + 90) / 180), span = raw.east - raw.west;
    let west = wrapLongitude(raw.west + (odd(sheet) ? 180 : 0)), east = wrapLongitude(raw.east + (odd(sheet) ? 180 : 0));
    if (span >= 360 || Math.floor((raw.south + 90) / 180) !== Math.floor((raw.north + 90) / 180)) { west = -180; east = 180; }
    return { bounds: { west, east, south, north }, windows };
  }
  project.points = points;
  project.rasterPatches = rasterPatches;
  project.requestView = requestView;
  project.shape = shape => {
    const projected = shape.map(([a, b]) => project(a, b));
    if (!globe && projected.length) for (const p of projected) p.x = projected[0].x + wrapLongitude((p.x - projected[0].x) / size) * size;
    return projected;
  };
  return { width, height, zoom, lat, lng, center, globe, size, radius, project, atPoint, requestView, rasterPatches,
    basis: { sinLat, cosLat, sinLng, cosLng } };
}

export function panWorld(camera, dx, dy) {
  const scale = camera.globe ? camera.radius * RAD : camera.size;
  return { lat: wrapLongitude(camera.lat + dy / scale), lng: wrapLongitude(camera.lng - dx / scale) };
}

// A small Newton solve keeps the same geographic point under mouse/touch when
// zoom changes projection. It never changes the identity of the focused cell.
export function anchorWorld(options, world, x, y) {
  let { lat, lng } = options;
  if (world.valid === false) return { lat, lng };
  for (let i = 0; i < 8; i++) {
    const camera = createWorldCamera({ ...options, lat, lng }), p = camera.project(world.lat, world.lng);
    if (!p.visible) break;
    const dx = x - p.x, dy = y - p.y;
    if (Math.hypot(dx, dy) < .02) break;
    const e = .00001, a = createWorldCamera({ ...options, lat: lat + e, lng }).project(world.lat, world.lng), b = createWorldCamera({ ...options, lat, lng: lng + e }).project(world.lat, world.lng);
    const ax = (a.x - p.x) / e, ay = (a.y - p.y) / e, bx = (b.x - p.x) / e, by = (b.y - p.y) / e, determinant = ax * by - ay * bx;
    if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-6) break;
    lat += Math.max(-25, Math.min(25, (dx * by - dy * bx) / determinant));
    lng += Math.max(-25, Math.min(25, (dy * ax - dx * ay) / determinant));
  }
  return { lat: wrapLongitude(lat), lng: wrapLongitude(lng) };
}
