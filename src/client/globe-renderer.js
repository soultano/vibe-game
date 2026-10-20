// Software texture projection keeps the world view independent of WebGL/Three.
// Only dirty frames are rendered, at a bounded resolution; dragging uses fewer
// samples and releasing the pointer restores the still-image quality.
export function createGlobeRenderer({ canvasFactory = () => document.createElement('canvas') } = {}) {
  const surface = canvasFactory(), sourceSurface = canvasFactory();
  const output = surface.getContext('2d'), sourceContext = sourceSurface.getContext('2d', { willReadFrequently: true });
  let source, pixels, sw = 0, sh = 0, buffer;
  function readSource(image) {
    if (!image || source === image) return;
    try {
      sw = image.naturalWidth || image.width; sh = image.naturalHeight || image.height;
      sourceSurface.width = sw; sourceSurface.height = sh;
      sourceContext.clearRect(0, 0, sw, sh); sourceContext.drawImage(image, 0, 0);
      pixels = sourceContext.getImageData(0, 0, sw, sh).data; source = image;
    } catch { pixels = null; }
  }
  function draw(ctx, camera, { image, fallback, moving = false } = {}) {
    readSource(image?.complete && image.naturalWidth ? image : fallback);
    const { width, height, radius, basis: { sinLat, cosLat, sinLng, cosLng } } = camera;
    const left = Math.max(0, width / 2 - radius), top = Math.max(0, height / 2 - radius);
    const w = Math.min(width, width / 2 + radius) - left, h = Math.min(height, height / 2 + radius) - top;
    const scale = Math.min(1, Math.sqrt((moving ? 90000 : 240000) / Math.max(1, w * h)));
    const rw = Math.max(1, Math.ceil(w * scale)), rh = Math.max(1, Math.ceil(h * scale));
    if (surface.width !== rw || surface.height !== rh || !buffer) {
      surface.width = rw; surface.height = rh; buffer = output.createImageData(rw, rh);
    }
    const data = buffer.data;
    let index = 0;
    for (let row = 0; row < rh; row++) {
      const north = -(top + (row + .5) / rh * h - height / 2) / radius;
      for (let col = 0; col < rw; col++, index += 4) {
        const east = (left + (col + .5) / rw * w - width / 2) / radius, r2 = east * east + north * north;
        if (r2 > 1) { data[index + 3] = 0; continue; }
        const front = Math.sqrt(1 - r2);
        const z = Math.max(-1, Math.min(1, north * cosLat + front * sinLat));
        const x = -east * sinLng - north * sinLat * cosLng + front * cosLat * cosLng;
        const y = east * cosLng - north * sinLat * sinLng + front * cosLat * sinLng;
        const u = (Math.atan2(y, x) / (2 * Math.PI) + .5) * sw;
        const v = (.5 - Math.asin(z) / Math.PI) * sh;
        const offset = (Math.min(sh - 1, Math.max(0, Math.floor(v))) * sw + (Math.floor(u) % sw + sw) % sw) * 4;
        const shade = .62 + .38 * Math.max(0, -.3 * east + .4 * north + .86 * front);
        const hasPixel = pixels && pixels[offset + 3];
        const rim = Math.pow(1 - front, 5) * 35;
        data[index] = (hasPixel ? pixels[offset] : 20) * shade + rim * .2;
        data[index + 1] = (hasPixel ? pixels[offset + 1] : 65) * shade + rim * .8;
        data[index + 2] = (hasPixel ? pixels[offset + 2] : 83) * shade + rim;
        data[index + 3] = 255;
      }
    }
    output.putImageData(buffer, 0, 0);
    ctx.save();
    if (radius < Math.hypot(width, height)) {
      const glow = ctx.createRadialGradient(width / 2, height / 2, radius * .98, width / 2, height / 2, radius * 1.07);
      glow.addColorStop(0, '#65cadb36'); glow.addColorStop(1, '#65cadb00');
      ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(width / 2, height / 2, radius * 1.07, 0, Math.PI * 2); ctx.fill();
    }
    ctx.imageSmoothingEnabled = true; ctx.drawImage(surface, left, top, w, h);
    ctx.strokeStyle = '#8fd5d95c'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(width / 2, height / 2, radius, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
    return { pixels: rw * rh, moving };
  }
  return { draw };
}
