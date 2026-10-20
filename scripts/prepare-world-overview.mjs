// Anti-aliased generalization of the same terrain; never magnify raw biome noise.
import sharp from 'sharp';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {renderTerrainRaster} from '../src/client/terrain-raster.js';
const raster=renderTerrainRaster({west:-180,east:180,north:90,south:-90,pixels:1024,height:512,columns:512,level:1});
const bytes=await sharp(Buffer.from(raster.data),{raw:{width:raster.width,height:raster.height,channels:4}}).blur(1).webp({quality:75}).toBuffer();
await writeFile('src/client/assets/terrain/world-overview.webp',bytes);
const path='src/client/assets/terrain/manifest.json',manifest=JSON.parse(await readFile(path));
manifest.overview={file:'world-overview.webp',width:1024,height:512,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
delete manifest.regionalOverview;manifest.pyramid={pixels:384,maxVisible:24,maxCached:40,concurrency:2,levels:[2,12],source:'Filtered shared deterministic terrain field; viewport-only Web Workers; no model downloads'};
await writeFile(path,JSON.stringify(manifest,null,2));console.log(JSON.stringify({worldBytes:bytes.length}));
