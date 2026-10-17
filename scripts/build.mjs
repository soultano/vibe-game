import { build } from 'esbuild';
import { readFile,writeFile,mkdir,readdir,stat,rm,cp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve,extname } from 'node:path';
const project=resolve(import.meta.dirname,'..');
process.chdir(project);
await rm('dist',{recursive:true,force:true});
await mkdir('dist/client',{recursive:true});await mkdir('dist/server',{recursive:true});await mkdir('dist/.openai',{recursive:true});await mkdir('build',{recursive:true});
await cp('src/client/index.html','dist/client/index.html');await cp('src/client/styles.css','dist/client/styles.css');await cp('src/client/assets','dist/client/assets',{recursive:true});await cp('data/world-mask.json','dist/client/world-mask.json');
await build({entryPoints:['src/client/main.js'],outfile:'dist/client/main.js',bundle:true,format:'esm',platform:'browser',target:'es2022',minify:true,legalComments:'none'});
const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.svg':'image/svg+xml'};
const assets={};
async function walk(dir,prefix=''){for(const name of await readdir(dir)){const p=dir+'/'+name,key=prefix+'/'+name;if((await stat(p)).isDirectory())await walk(p,key);else {const bytes=await readFile(p);assets[key]={type:types[extname(name)]||'application/octet-stream',body:bytes.toString('base64'),etag:'"'+createHash('sha256').update(bytes).digest('hex').slice(0,24)+'"'};}}}
await walk('dist/client');await writeFile('build/assets.json',JSON.stringify(assets));
await build({entryPoints:['src/server/worker.js'],outfile:'dist/server/index.js',bundle:true,format:'esm',platform:'browser',target:'es2022',minify:true,legalComments:'none'});
await cp('.openai/hosting.json','dist/.openai/hosting.json');await cp('drizzle','dist/.openai/drizzle',{recursive:true});
await writeFile('dist/server/wrangler.json',JSON.stringify({name:'pixel-dominion-world',main:'index.js',compatibility_date:'2026-10-17',compatibility_flags:[],d1_databases:[{binding:'DB',database_name:'pixel-dominion-world',database_id:'00000000-0000-4000-8000-000000000000'}]},null,2));
console.log('Built server + client +',Object.keys(assets).length,'embedded assets');
console.log('Worker size:',(await stat('dist/server/index.js')).size,'bytes');
