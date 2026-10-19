import assets from '../../build/assets.json';
import { createApp } from './router.js';
import { D1Store } from './store.js';
import { json } from './http.js';
const decoded=new Map();
async function serveAsset(request) {
 const url=new URL(request.url),path=url.pathname==='/'?'/index.html':url.pathname;
 const asset=assets[path];if(!asset)return new Response('Не найдено',{status:404});
 if(asset.redirect)return new Response(null,{status:302,headers:{Location:asset.redirect,'Cache-Control':'public, max-age=300'}});
 if(request.headers.get('if-none-match')===asset.etag)return new Response(null,{status:304,headers:{ETag:asset.etag}});
 let bytes=decoded.get(path);if(!bytes){bytes=Uint8Array.from(atob(asset.body),c=>c.charCodeAt(0));decoded.set(path,bytes);}
 const headers={'Content-Type':asset.type,'X-Content-Type-Options':'nosniff','Referrer-Policy':'strict-origin-when-cross-origin','ETag':asset.etag,'Cache-Control':/\.(png|webp|glb)$/.test(path)?'public, max-age=86400':'no-cache'};
 return new Response(request.method==='HEAD'?null:bytes,{headers});
}
export default {
 async fetch(request,env) {
   if(!env.DB)return json({error:'Хранилище мира не подключено.',code:'STORAGE_UNAVAILABLE'},503);
   const settings={...env,LOCAL_DEV:false,APP_ORIGIN:env.APP_ORIGIN||'https://pixel-dominion-world.info525398.chatgpt.site'};
   return createApp({store:new D1Store(env.DB),env:settings,serveAsset}).fetch(request);
 }
};
