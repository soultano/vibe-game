import { BufferGeometry, BufferAttribute } from 'three';
import { computeMikkTSpaceTangents, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import * as MikkTSpace from 'three/addons/libs/mikktspace.module.js';
import sharp from 'sharp';

export async function prepareGeometry(doc) {
  await MikkTSpace.ready;
  let repairedNormals = 0;
  for (const mesh of doc.getRoot().listMeshes()) for (const primitive of mesh.listPrimitives()) {
    const semantics = { POSITION: 'position', NORMAL: 'normal', TEXCOORD_0: 'uv', TANGENT: 'tangent' };
    const geometry = new BufferGeometry(), buffer = primitive.getAttribute('POSITION').getBuffer();
    const attributes = primitive.listSemantics().map(semantic => [semantic, semantics[semantic] || semantic]);
    for (const [semantic, name] of attributes) {
      const accessor = primitive.getAttribute(semantic);
      geometry.setAttribute(name, new BufferAttribute(accessor.getArray().slice(), accessor.getElementSize(), accessor.getNormalized()));
    }
    geometry.setIndex(new BufferAttribute(primitive.getIndices().getArray().slice(), 1));
    const originalNormals = geometry.getAttribute('normal');
    geometry.computeVertexNormals();
    const computed = geometry.getAttribute('normal');
    // Meshy occasionally emits zero normals. Keep authored normals elsewhere.
    for (let i = 0; i < originalNormals.count; i++) {
      let x = primitive.getAttribute('NORMAL').getArray()[i * 3], y = primitive.getAttribute('NORMAL').getArray()[i * 3 + 1], z = primitive.getAttribute('NORMAL').getArray()[i * 3 + 2];
      let length = Math.hypot(x, y, z);
      if (length < 1e-6) { x = computed.getX(i); y = computed.getY(i); z = computed.getZ(i); length = Math.hypot(x, y, z); repairedNormals++; }
      if (length < 1e-6) { x = 0; y = 1; z = 0; length = 1; }
      originalNormals.setXYZ(i, x / length, y / length, z / length);
    }
    geometry.setAttribute('normal', originalNormals);
    computeMikkTSpaceTangents(geometry, MikkTSpace);
    const tangents = geometry.getAttribute('tangent'), normals = geometry.getAttribute('normal');
    for (let i = 0; i < tangents.count; i++) {
      let x = tangents.getX(i), y = tangents.getY(i), z = tangents.getZ(i), length = Math.hypot(x, y, z);
      // Collapsed UVs have no unique tangent. Choose a stable perpendicular.
      if (length < 1e-6) {
        const nx = normals.getX(i), ny = normals.getY(i), nz = normals.getZ(i);
        [x, y, z] = Math.abs(ny) < .9 ? [nz, 0, -nx] : [0, -nz, ny];
        length = Math.hypot(x, y, z);
      }
      tangents.setXYZW(i, x / length, y / length, z / length, tangents.getW(i) < 0 ? -1 : 1);
    }
    // Re-index all attributes including tangents, preserving UV/tangent seams.
    const indexed = mergeVertices(geometry, 1e-7);
    const names = new Map([...attributes, ['TANGENT', 'tangent']]);
    for (const [semantic, name] of names) {
      const attribute = indexed.getAttribute(name), accessor = doc.createAccessor().setType(['', 'SCALAR', 'VEC2', 'VEC3', 'VEC4'][attribute.itemSize])
        .setArray(attribute.array).setNormalized(attribute.normalized).setBuffer(buffer);
      primitive.setAttribute(semantic, accessor);
    }
    primitive.setIndices(doc.createAccessor().setType('SCALAR').setArray(indexed.index.array).setBuffer(buffer));
    geometry.dispose(); indexed.dispose();
  }
  for (const accessor of doc.getRoot().listAccessors()) if (accessor.listParents().every(parent => parent.propertyType === 'Root')) accessor.dispose();
  return repairedNormals;
}

export async function optimizeTextures(doc, maxSize = 512) {
  for (const texture of doc.getRoot().listTextures()) {
    texture.setImage(await sharp(texture.getImage()).resize(maxSize, maxSize, {fit: "inside", withoutEnlargement:true}).jpeg({quality:88,mozjpeg:true}).toBuffer()).setMimeType("image/jpeg");
  }
}
