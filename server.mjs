import http from 'node:http';
import { readFile,stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve,extname,sep } from 'node:path';
import { createApp } from './src/server/router.js';
import { createLocalStore } from './src/server/local-store.js';
if(existsSync('.env.local'))process.loadEnvFile('.env.local');
const port=Number(process.env.PORT||4173);
const origin=process.env.APP_ORIGIN||`http://127.0.0.1:${port}`;
const store=await createLocalStore(process.env.DATABASE_PATH||'.data/world.sqlite');
const root=resolve('dist/client');
const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.webp':'image/webp','.svg':'image/svg+xml','.glb':'model/gltf-binary'};
const app=createApp({store,env:{...process.env,APP_ORIGIN:origin,LOCAL_DEV:process.env.LOCAL_DEV??'true'},serveAsset:async request=>{
  try{const path=decodeURIComponent(new URL(request.url).pathname),file=resolve(root,'.'+(path==='/'?'/index.html':path));if(!file.startsWith(root+sep)||!(await stat(file)).isFile())return new Response('Не найдено',{status:404});return new Response(request.method==='HEAD'?null:await readFile(file),{headers:{'Content-Type':types[extname(file)]||'application/octet-stream','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'}});}catch{return new Response('Не найдено',{status:404});}
}});
const server=http.createServer(async(req,res)=>{
 try{
  const host=req.headers.host||`127.0.0.1:${port}`;
  if(![`127.0.0.1:${port}`,`localhost:${port}`].includes(host)){res.writeHead(400);res.end('Invalid Host');return;}
  const chunks=[];let length=0;for await(const chunk of req){length+=chunk.length;if(length>140000){res.writeHead(413);res.end('Request too large');return;}chunks.push(chunk);}
  const request=new Request(`http://${host}${req.url}`,{method:req.method,headers:req.headers,...(!['GET','HEAD'].includes(req.method)&&chunks.length?{body:Buffer.concat(chunks)}:{})});
  const response=await app.fetch(request),body=Buffer.from(await response.arrayBuffer());
  const headers=Object.fromEntries([...response.headers].filter(([k])=>k!=='set-cookie'));
  const cookies=response.headers.getSetCookie();if(cookies.length)headers['set-cookie']=cookies;
  res.writeHead(response.status,headers);res.end(body);
 }catch{if(!res.headersSent)res.writeHead(500);res.end('Server error');}
});
server.listen(port,'127.0.0.1',()=>console.log(`Pixel Dominion server: http://127.0.0.1:${port} (persistent SQLite, loopback only)`));
function shutdown(){server.close(()=>{store.close();process.exit(0);});}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
