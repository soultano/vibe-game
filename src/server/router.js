import { CONFIG, FACTIONS } from '../shared/config.js';
import { GameService } from './game-service.js';
import { handleAuth, requireAuth, getAuthContext } from './auth.js';
import { paymentStatus, createCheckout, verifyWebhook, createPortal, cancelSubscription } from './payments.js';
import { handleTelegramWebhook } from './telegram-webhook.js';
import { HttpError, json, readJSON } from './http.js';

export function createApp({store,env={},clock=()=>Date.now(),serveAsset}) {
  if(!store) throw new Error('Persistent store required');
  const service=new GameService({store,clock});
  const mutationRoutes = new Map([
    ['/api/base',(id,body)=>service.placeBase(id,body)],
    ['/api/upgrades/fund',(id,body)=>service.fundUpgrade(id,body)],
    ['/api/azimuth',(id,body)=>service.rotate(id,body)],
    ['/api/abandon',(id,body)=>service.abandon(id,body)],
    ['/api/daily/claim',id=>service.claimDaily(id)],
    ['/api/crystals/spend',(id,body)=>service.spendCrystals(id,body)],
    ['/api/abilities/use',(id,body)=>service.useAbility(id,body)],
    ['/api/army/order',(id,body)=>service.commandArmy(id,body)],
    ['/api/army/unit-order',(id,body)=>service.commandUnit(id,body)],
    ['/api/army/unit-orders',(id,body)=>service.commandUnits(id,body)],
    ['/api/player/customization',(id,body)=>service.updateCustomization(id,body)],
    ['/api/referrals/claim',id=>service.claimReferralEnergy(id)],
  ]);
  return {
    service,
    async fetch(request) {
      let path='';
      try {
        const url=new URL(request.url);path=url.pathname;
        if(path.startsWith('/api/auth/')) return await handleAuth(request,env,store) || json({error:'Неизвестный маршрут входа.'},404);
        if(path==='/api/health') {
          if(request.method!=='GET')throw new HttpError(405,'Метод не поддерживается.');
          await store.get('health:readiness');
          return json({ok:true,version:2,worldVersion:CONFIG.WORLD_VERSION,storage:'persistent',timeAuthority:'server',gameplay:'npc-v1',landscape:'fantasy-v1',webGuest:true,mapLod:'v1',terrainLod:'pyramid-v2',worldView:'globe-flat-v1',climate:'zones-v1',actors:'living-v2',unitOrders:'v1',groupOrders:'v1',serverTime:clock()});
        }
        if(path==='/api/config'&&request.method==='GET')return json({worldVersion:CONFIG.WORLD_VERSION,region:CONFIG.REGION,factions:FACTIONS,tileResolution:5,cellResolution:8,pollMs:CONFIG.TILE_POLL_INTERVAL_MS,rotation:{crystals:CONFIG.ROTATE_CRYSTAL_COST,cooldownHours:CONFIG.ROTATE_COOLDOWN_HOURS},terrain:{approximate:true,source:CONFIG.TERRAIN_SOURCE}});
        if(path==='/api/state'&&request.method==='GET') {const {account}=await requireAuth(request,env,store);return json(await service.state(account.id));}
        if(path==='/api/map/overview'&&request.method==='GET') {
          const input=Object.fromEntries(['west','east','south','north','resolution'].map(k=>[k,url.searchParams.get(k)]));
          return json(await service.overview(input),200,{'Cache-Control':'public, max-age=10, s-maxage=10, stale-while-revalidate=10'});
        }
        if(path==='/api/leaderboard'&&request.method==='GET')return json(await service.leaderboard());
        if(path==='/api/tiles'&&request.method==='GET') {
          const parents=(url.searchParams.get('parents')||'').split(',').filter(Boolean);
          let versions={};
          try { versions=JSON.parse(url.searchParams.get('versions')||'{}'); }
          catch { throw new HttpError(400,'Некорректные версии тайлов.'); }
          if(!versions||typeof versions!=='object'||Array.isArray(versions))throw new HttpError(400,'Некорректные версии тайлов.');
          // Public world geometry only: no account-specific state in the CDN key.
          const result=await service.tiles({parents,versions});
          // Armies move and lose HP even when a tile's ownership revision stays
          // unchanged. A territory-only ETag would freeze public spectator NPCs.
          return json(result,200,{'Cache-Control':'no-store'});
        }
        if(path==='/api/tiles'&&request.method==='POST') {
          const {account}=await requireAuth(request,env,store,{write:true});
          const body=await readJSON(request);const result=await service.tiles(body,account.id);
          return json(result);
        }
        if(path==='/api/shop'&&request.method==='GET')return json({...service.shop(),payments:paymentStatus(env)});
        if(path==='/api/checkout'&&request.method==='POST') {
          const {account}=await requireAuth(request,env,store,{write:true});
          const body=await readJSON(request);
          const current=await service.state(account.id);if(!current.player)throw new HttpError(409,'Перед покупкой необходимо основать базу.');
          return json(await createCheckout(request,env,account,body,service.shop().items,{store}));
        }
        if((path==='/api/billing/portal'||path==='/api/billing/cancel')&&request.method==='POST') {
          const {account}=await requireAuth(request,env,store,{write:true});
          const player=(await store.get(`player:${account.id}`))?.value;
          return json(path==='/api/billing/portal'
            ?await createPortal(request,env,account,player)
            :await cancelSubscription(request,env,account,player));
        }
        if(path==='/api/webhooks/stripe'&&request.method==='POST') {
          const receipt=await verifyWebhook(request,env,store);
          return json(receipt?await service.applyPurchase(receipt):{received:true,ignored:true});
        }
        if(path==='/api/telegram/webhook') {
          return await handleTelegramWebhook(request,env);
        }
        if(mutationRoutes.has(path)) {
          if(request.method!=='POST')throw new HttpError(405,'Изменение мира требует POST.');
          const {account}=await requireAuth(request,env,store,{write:true});
          return json(await mutationRoutes.get(path)(account.id,await readJSON(request)));
        }
        if(path.startsWith('/api/'))return json({error:'Маршрут не найден.',code:'NOT_FOUND'},404);
        if(!['GET','HEAD'].includes(request.method))return json({error:'Метод не поддерживается.'},405,{Allow:'GET, HEAD'});
        return await serveAsset(request);
      } catch(error) {
        const status=Number.isInteger(error.status)&&error.status>=400&&error.status<=599?error.status:500;
        if(status===500)console.error('request_failed',path,error.name||'Error');
        return json({error:status===500?'Внутренняя ошибка сервера.':error.message,code:error.code||'REQUEST_FAILED'},status);
      }
    }
  };
}
