// Run once against downloaded Meshy GLBs. Normal builds consume the committed
// assets and need no Meshy credentials or network access.
import { readFile, writeFile, mkdir, stat, copyFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import sharp from 'sharp';
import { BufferGeometry, BufferAttribute } from 'three';
import { computeMikkTSpaceTangents, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import * as MikkTSpace from 'three/addons/libs/mikktspace.module.js';

const input = process.argv[2];
if (!input) throw new Error('Usage: node scripts/prepare-headquarters.mjs <downloaded-model-directory>');
const root = resolve(import.meta.dirname, '..'), source = resolve(input);
const destination = join(root, 'src/client/assets/models');
await mkdir(destination, { recursive: true });
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS), models = {};
await MikkTSpace.ready;
const jobs = JSON.parse(await readFile(join(source, 'jobs.json'), 'utf8'));
for (const id of ['protocol', 'vanguard', 'bloom', 'swarm', 'pack']) {
  const original = join(source, id + '.glb'), doc = await io.read(original);
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
  const materials = doc.getRoot().listMaterials();
  const normals = new Set(materials.map(material => material.getNormalTexture()).filter(Boolean));
  const colors = new Set(materials.flatMap(material => [material.getBaseColorTexture(), material.getEmissiveTexture()]).filter(Boolean));
  for (const texture of doc.getRoot().listTextures()) {
    const size = normals.has(texture) || colors.has(texture) ? 1024 : 512;
    const bytes = await sharp(texture.getImage()).resize(size, size, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: normals.has(texture) ? 92 : 86, mozjpeg: true }).toBuffer();
    texture.setImage(bytes).setMimeType('image/jpeg');
  }
  const target = join(destination, id + '.glb');
  await io.write(target, doc);
  const preview = join(source, id + '-preview.png');
  await sharp(preview).resize(512, 512, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 88 }).toFile(join(destination, id + '-poster.webp'));
  // The fallback on the map depicts the same generated model, with its alpha.
  await copyFile(preview, join(root, 'src/client/assets/headquarters', id + '.png'));
  let triangles = 0;
  for (const mesh of doc.getRoot().listMeshes()) for (const primitive of mesh.listPrimitives()) {
    triangles += (primitive.getIndices()?.getCount() || primitive.getAttribute('POSITION')?.getCount() || 0) / 3;
  }
  const finished = JSON.parse(await readFile(join(source, id + '-finished.json'), 'utf8'));
  const bytes = await readFile(target);
  models[id] = { file: `/assets/models/${id}.glb`, poster: `/assets/models/${id}-poster.webp`, taskId: jobs[id].taskId, resource: jobs[id].resource, consumedCredits: finished.result.task.consumed_credits, triangles, repairedNormals, tangents: 'MikkTSpace', bytes: bytes.length, originalBytes: (await stat(original)).size, textureMaxSize: 1024, sha256: createHash('sha256').update(bytes).digest('hex') };
  console.log(JSON.stringify({ id, triangles, originalBytes: models[id].originalBytes, gameBytes: bytes.length }));
}
await writeFile(join(destination, 'manifest.json'), JSON.stringify({ generator: 'Meshy', pipeline: 'image-to-3d / smart-topology / textured / 2k', models }, null, 2) + '\n');
