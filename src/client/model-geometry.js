import { Box3, Group, Vector3 } from 'three';

// Preserve source geometry, UVs and materials; only normalize the display pivot.
export function normalizeHeadquarters(scene) {
  scene.updateMatrixWorld(true);
  const box = new Box3().setFromObject(scene), size = box.getSize(new Vector3());
  const longest = Math.max(size.x, size.y, size.z);
  if (box.isEmpty() || !Number.isFinite(longest) || longest <= 0) throw new Error('Empty headquarters model');
  const center = box.getCenter(new Vector3()), content = new Group(), pivot = new Group();
  content.add(scene);
  content.position.set(-center.x, -box.min.y, -center.z);
  pivot.add(content);
  pivot.scale.setScalar(2 / longest);
  pivot.updateMatrixWorld(true);
  return pivot;
}

export function disposeHeadquarters(root) {
  const geometries = new Set(), materials = new Set(), textures = new Set();
  root.traverse(node => {
    if (node.geometry) geometries.add(node.geometry);
    for (const material of Array.isArray(node.material) ? node.material : node.material ? [node.material] : []) {
      materials.add(material);
      for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
    }
  });
  for (const geometry of geometries) geometry.dispose();
  for (const texture of textures) { texture.source?.data?.close?.(); texture.dispose(); }
  for (const material of materials) material.dispose();
}
