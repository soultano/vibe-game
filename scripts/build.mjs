import sharp from 'sharp';
import { build } from 'esbuild';
import { readFile,writeFile,mkdir,readdir,stat,rm,cp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve,extname } from 'node:path';
const project=resolve(import.meta.dirname,'..');
process.chdir(project);
await rm('dist',{recursive:true,force:true});
await mkdir('dist/client',{recursive:true});await mkdir('dist/server',{recursive:true});await mkdir('dist/.openai',{recursive:true});await mkdir('build',{recursive:true});
await cp('src/client/index.html','dist/client/index.html');await cp('src/client/styles.css','dist/client/styles.css');await optimizeArtwork();await cp('data/world-mask.json','dist/client/world-mask.json');
async function optimizeArtwork() {
  let originalBytes = 0, optimizedBytes = 0;
  for (const [group, size] of [['factions', 192], ['headquarters', 384]]) {
    const source = 'src/client/assets/' + group, destination = 'dist/client/assets/' + group;
    await mkdir(destination, { recursive: true });
    for (const name of await readdir(source)) {
      if (!name.endsWith('.png')) continue;
      originalBytes += (await stat(source + '/' + name)).size;
      const output = destination + '/' + name.replace(/\.png$/, '.webp');
      await sharp(source + '/' + name)
        .resize(size, size, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 85, effort: 6 }).toFile(output);
      optimizedBytes += (await stat(output)).size;
    }
  }
  console.log(`Artwork: ${originalBytes} → ${optimizedBytes} bytes (${(100 * (1 - optimizedBytes / originalBytes)).toFixed(1)}% smaller)`);
}
await cp('src/client/assets/models','dist/client/assets/models',{recursive:true});
await cp('src/client/assets/troops','dist/client/assets/troops',{recursive:true});
await cp('src/client/assets/terrain','dist/client/assets/terrain',{recursive:true});
await build({entryPoints:['src/client/main.js'],outdir:'dist/client',chunkNames:'chunks/[name]-[hash]',bundle:true,splitting:true,format:'esm',platform:'browser',target:'es2022',minify:true,legalComments:'none'});
const release=createHash('sha256').update(await readFile('dist/client/main.js')).update(await readFile('dist/client/styles.css')).digest('hex').slice(0,16);
const html=(await readFile('dist/client/index.html','utf8')).replace('/main.js',`/main.js?v=${release}`).replace('/styles.css',`/styles.css?v=${release}`);
await writeFile('dist/client/index.html',html);
await writeFile('dist/client/release.json',JSON.stringify({release,features:['web-play','server-npc','fantasy-landscape']}));
const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.webp':'image/webp','.svg':'image/svg+xml','.glb':'model/gltf-binary'};
const assets={};
async function walk(dir,prefix=''){for(const name of await readdir(dir)){const p=dir+'/'+name,key=prefix+'/'+name;if((await stat(p)).isDirectory())await walk(p,key);else {const bytes=await readFile(p);const etag='"'+createHash('sha256').update(bytes).digest('hex').slice(0,24)+'"';
assets[key]={type:types[extname(name)]||'application/octet-stream',body:bytes.toString('base64'),etag};}}}
await walk('dist/client');await writeFile('build/assets.json',JSON.stringify(assets));
await build({entryPoints:['src/server/worker.js'],outfile:'dist/server/index.js',bundle:true,format:'esm',platform:'browser',target:'es2022',minify:true,legalComments:'none'});
await cp('.openai/hosting.json','dist/.openai/hosting.json');await cp('drizzle','dist/.openai/drizzle',{recursive:true});
await writeFile('dist/server/wrangler.json',JSON.stringify({name:'pixel-dominion-world',main:'index.js',compatibility_date:'2026-10-17',compatibility_flags:[],d1_databases:[{binding:'DB',database_name:'pixel-dominion-world',database_id:'00000000-0000-4000-8000-000000000000'}]},null,2));
console.log('Built server + client +',Object.keys(assets).length,'embedded assets');
console.log('Worker size:',(await stat('dist/server/index.js')).size,'bytes');
