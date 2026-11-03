const encoder=new TextEncoder();
const hash=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(value)))].map(v=>v.toString(16).padStart(2,'0')).join('');
export const telegramWebhookSecret=token=>hash('pixel-dominion:telegram-webhook:'+token.trim());
const equal=(a,b)=>{if(typeof a!=='string'||a.length!==b.length)return false;let d=0;for(let i=0;i<a.length;i++)d|=a.charCodeAt(i)^b.charCodeAt(i);return d===0;};
export async function validTelegramWebhook(request,env){const value=request.headers.get('x-telegram-bot-api-secret-token');return equal(value,await telegramWebhookSecret(env.TELEGRAM_BOT_TOKEN))||!!env.TELEGRAM_WEBHOOK_SECRET&&equal(value,env.TELEGRAM_WEBHOOK_SECRET);}

export async function startBotLogin(store,{fingerprint,origin,botUsername}){
 const id=crypto.randomUUID().replaceAll('-',''),pollToken=crypto.randomUUID()+crypto.randomUUID(),expiresAt=Date.now()+300000,code=String(crypto.getRandomValues(new Uint32Array(1))[0]%1000000).padStart(6,'0');
 await store.atomic({puts:[{key:'bot-login:'+id,value:{pollHash:await hash(pollToken),fingerprint,origin,expiresAt,code,status:'waiting'}}]});
 return{attemptId:id,pollToken,expiresAt,code,url:`https://t.me/${botUsername}?start=login_${id}`};
}
export async function readBotLogin(store,id,pollToken,fingerprint){
 if(typeof id!=='string'||!/^[a-f0-9]{32}$/.test(id)||typeof pollToken!=='string'||pollToken.length>128)throw Object.assign(Error('Запрос входа недействителен. Начните заново.'),{status:401});
 const row=await store.get('bot-login:'+id);
 if(!row||!equal(row.value.pollHash,await hash(pollToken))||!equal(row.value.fingerprint,fingerprint))throw Object.assign(Error('Запрос входа недействителен. Начните заново.'),{status:401});
 if(row.value.expiresAt<=Date.now())throw Object.assign(Error('Время подтверждения истекло. Начните вход заново.'),{status:410});
 return row;
}
export async function handleBotLoginUpdate(update,env,store,send){
 const message=update.message,callback=update.callback_query,id=message?.text?.match(/^\/start(?:@[A-Za-z0-9_]+)? login_([a-f0-9]{32})$/)?.[1]||callback?.data?.match(/^login:([a-f0-9]{32})$/)?.[1];
 if(!id)return false;
 const chat=message?.chat||callback?.message?.chat,user=message?.from||callback?.from;
 if(chat?.type!=='private'||!Number.isSafeInteger(user?.id)||user.is_bot||chat.id!==user.id)return true;
 const key='bot-login:'+id,row=await store.get(key);
 if(!row||row.value.expiresAt<=Date.now()||row.value.status==='used'){
  if(callback)await send('answerCallbackQuery',{callback_query_id:callback.id,text:'Запрос истёк. Начните вход на сайте заново.'});
  else await send('sendMessage',{chat_id:chat.id,text:'Запрос входа истёк. Вернитесь на сайт и начните заново.'});return true;
 }
 if(message){
  const hostname=new URL(row.value.origin).hostname;
  await send('sendMessage',{chat_id:chat.id,text:`Подтвердите вход в Pixel Dominion на ${hostname}. Код: ${row.value.code}.\n\nНажимайте кнопку, только если вы сами начали этот вход и код совпадает с кодом на сайте.`,reply_markup:{inline_keyboard:[[{text:`Подтвердить вход · ${row.value.code}`,callback_data:'login:'+id}]]}});return true;
 }
 const identity={id:user.id,first_name:String(user.first_name||'Игрок Telegram').slice(0,256),...(user.last_name?{last_name:String(user.last_name).slice(0,256)}:{})};
 if(row.value.status==='approved'&&row.value.user?.id!==user.id)return true;
 const saved=row.value.status==='approved'||await store.atomic({checks:[{key,version:row.version}],puts:[{key,value:{...row.value,status:'approved',user:identity}}]});
 await send('answerCallbackQuery',{callback_query_id:callback.id,text:saved?'Вход подтверждён. Вернитесь на сайт.':'Запрос изменился. Повторите вход.'});
 if(saved)await send('editMessageText',{chat_id:chat.id,message_id:callback.message.message_id,text:'Вход подтверждён. Вернитесь в окно игры.',reply_markup:{inline_keyboard:[]}});
 return true;
}
