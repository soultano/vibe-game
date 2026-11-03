import test from 'node:test';import assert from 'node:assert/strict';import {createHmac} from 'node:crypto';
import {createClientHarness} from './helpers/client-harness.mjs';import {telegramWebhookSecret} from '../src/server/telegram-bot-login.js';
const token='123456:synthetic-bot-login-token',user={id:88776655,first_name:'Командир'},origin='https://game.example';
async function fixture(options={}){const calls=[],env={LOCAL_DEV:false,TELEGRAM_BOT_TOKEN:token,TELEGRAM_BOT_USERNAME:'DominionTestBot',AUTH_FETCH:async(url,options)=>{calls.push({method:url.split('/').at(-1),body:JSON.parse(options.body)});return new Response(JSON.stringify({ok:true,result:{message_id:10}}));}},h=await createClientHarness({env,origin,cookieBlocked:true,...options});h.calls=calls;const webhookSecret=await telegramWebhookSecret(token);h.webhook=async(update,secret=webhookSecret)=>h.app.fetch(new Request(origin+'/api/telegram/webhook',{method:'POST',headers:{'content-type':'application/json','x-telegram-bot-api-secret-token':secret},body:JSON.stringify(update)}));return h;}
const attempt=h=>JSON.parse(h.session.get('pd-bot-login'));
async function poll(h){const item=[...h.timers].find(([,t])=>[100,2000].includes(t.ms)&&/^poll\d*$/.test(t.callback.name));assert.ok(item,'a private login poll must be scheduled');h.timers.delete(item[0]);await item[1].callback();}
async function approve(h,id,who=user){const chat={id:who.id,type:'private'};const start=await h.webhook({message:{text:'/start login_'+id,chat,from:who,message_id:10}});assert.equal(start.status,200);return h.webhook({callback_query:{id:'confirm',data:'login:'+id,from:who,message:{message_id:10,chat}}});}
test('website → bot explicit confirmation → website signs into the same account as Mini App without a widget domain',async()=>{
 const h=await fixture();await h.click('openAuthModalBtn');await h.click('modalTelegramBtn');const a=attempt(h);assert.match(h.$('telegramBotLink').href,/\?start=login_/);assert.match(h.$('modalAuthNotice').textContent,new RegExp(a.code));assert.equal(h.$('modalTelegramWidget').children.length,0);
 await poll(h);assert.equal(h.client.state().account,null);const secret=await telegramWebhookSecret(token);assert.equal((await h.webhook({callback_query:{id:'forged',data:'login:'+a.attemptId,from:user,message:{chat:{id:user.id,type:'private'}}}},'wrong')).status,403);assert.equal(h.calls.length,0);
 assert.equal((await approve(h,a.attemptId)).status,200);await poll(h);assert.equal(h.client.state().account.provider,'telegram');assert.equal(h.$('authModal').open,false);assert.equal(h.session.has('pd-bot-login'),false);
 const fields={auth_date:String(Math.floor(Date.now()/1000)),query_id:crypto.randomUUID(),user:JSON.stringify(user)},check=Object.keys(fields).sort().map(k=>k+'='+fields[k]).join('\n'),key=createHmac('sha256','WebAppData').update(token).digest(),launchData=new URLSearchParams({...fields,hash:createHmac('sha256',key).update(check).digest('hex')}).toString();
 const mini=await createClientHarness({env:{LOCAL_DEV:false,TELEGRAM_BOT_TOKEN:token,TELEGRAM_BOT_USERNAME:'DominionTestBot'},origin,store:h.store,launchData});assert.equal(mini.client.state().account.id,h.client.state().account.id);
});
test('reload resumes the private attempt; closing cancels polling; a network failure retries without losing the challenge',async()=>{
 const h=await fixture();await h.click('openAuthModalBtn');await h.click('modalTelegramBtn');const a=attempt(h);h.$('authModal').close();assert.ok(![...h.timers.values()].some(t=>/^poll\d*$/.test(t.callback.name)));
 const next=await fixture({store:h.store,session:h.session});await next.click('openAuthModalBtn');await new Promise(setImmediate);assert.match(next.$('modalAuthNotice').textContent,new RegExp(a.code));next.network.failures.set('/api/auth/telegram/bot/poll',1);await poll(next);assert.equal(next.client.state().account,null);await approve(next,a.attemptId);await poll(next);assert.equal(next.client.state().account.provider,'telegram');
});
test('expired attempts and mismatched private poll secrets fail; bot opening alone never authorizes login',async()=>{
 const h=await fixture();await h.click('openAuthModalBtn');await h.click('modalTelegramBtn');const a=attempt(h);await h.webhook({message:{text:'/start login_'+a.attemptId,chat:{id:user.id,type:'private'},from:user}});assert.match(h.calls[0].body.text,/только если/);await poll(h);assert.equal(h.client.state().account,null);
 const me=await(await h.app.fetch(new Request(origin+'/api/auth/me'))).json();
 const wrong=await h.app.fetch(new Request(origin+'/api/auth/telegram/bot/poll',{method:'POST',headers:{origin,'content-type':'application/json','x-login-token':me.loginToken,'x-csrf-token':me.csrfToken},body:JSON.stringify({attemptId:a.attemptId,pollToken:'wrong',fingerprint:a.fingerprint})}));assert.equal(wrong.status,401);
 const row=await h.store.get('bot-login:'+a.attemptId);row.value.expiresAt=Date.now()-1;await h.store.atomic({puts:[{key:'bot-login:'+a.attemptId,value:row.value}]});await poll(h);assert.match(h.$('modalAuthNotice').textContent,/истекло/);assert.equal(h.session.has('pd-bot-login'),false);assert.equal(h.client.state().account,null);
 await h.click('modalTelegramBtn');assert.notEqual(attempt(h).attemptId,a.attemptId);
});
test('closing the login dialog aborts an outstanding poll and cannot attach its late session to the browser',async()=>{
 const h=await fixture();await h.click('openAuthModalBtn');await h.click('modalTelegramBtn');const a=attempt(h);await approve(h,a.attemptId);
 let release;h.network.beforeRequest=async path=>{if(path==='/api/auth/telegram/bot/poll')await new Promise(resolve=>release=resolve);};
 const pending=poll(h);for(let i=0;i<20&&!release;i++)await new Promise(setImmediate);assert.ok(release);h.$('authModal').close();release();await pending;assert.equal(h.client.state().account,null);assert.equal(h.session.has('pd-session'),false);
});
