export function createTelegramBotLogin({$,api,fingerprint,refreshAuth,getAccount,setBusy}){
 let attempt=null,timer=null,epoch=0,inFlight=null;
 const notice=text=>$('modalAuthNotice').textContent=text;
 function stop(){epoch++;if(timer!==null)clearTimeout(timer);timer=null;inFlight?.abort();inFlight=null;setBusy(false);}
 function clear(){stop();attempt=null;try{sessionStorage.removeItem('pd-bot-login');}catch{}}
 function show(){
  const link=$('telegramBotLink');link.hidden=false;link.href=attempt.url;link.textContent='Продолжить вход в Telegram';
  notice(`Код ${attempt.code}. Подтвердите вход у бота и вернитесь в это окно.`);
 }
 async function poll(){
  if(!attempt||getAccount()||!$('authModal').open)return;
  const generation=epoch;
  const request=new AbortController();inFlight=request;
  try{
   const result=await api('/api/auth/telegram/bot/poll',{attemptId:attempt.attemptId,pollToken:attempt.pollToken,fingerprint:attempt.fingerprint||await fingerprint()},{signal:request.signal,acceptSession:()=>generation===epoch&&$('authModal').open});
   if(generation!==epoch)return;
   if(result.account||result.status==='used'){await refreshAuth();if(getAccount()){clear();$('authModal').close();return;}}
   if(result.status==='used'){clear();notice('Начните вход заново: подтверждение уже использовано.');return;}
  }catch(error){if(generation!==epoch)return;if([401,403,410].includes(error.status)){clear();notice(error.message);return;}notice('Связь прервалась. Проверяем подтверждение повторно…');}
  if(generation===epoch)timer=setTimeout(poll,2000);
 }
 async function start(popup=null){
  if(getAccount()){popup?.close();return;}stop();const generation=epoch;setBusy(true);
  if(popup)popup.opener=null;
  try{
   await refreshAuth();if(getAccount()||generation!==epoch){popup?.close();return;}
   const device=await fingerprint();attempt={...await api('/api/auth/telegram/bot/start',{fingerprint:device}),fingerprint:device};
   if(generation!==epoch){popup?.close();return;}
   try{sessionStorage.setItem('pd-bot-login',JSON.stringify(attempt));}catch{}
   show();if(popup)popup.location.replace(attempt.url);timer=setTimeout(poll,2000);
  }catch(error){popup?.close();notice(['TypeError','AbortError','TimeoutError'].includes(error.name)?'Нет связи с сервером. Повторите вход.':error.message||'Не удалось начать вход. Повторите попытку.');}
  finally{if(generation===epoch)setBusy(false);}
 }
 function resume(){
  if(getAccount()){clear();return;}
  if(!attempt){try{attempt=JSON.parse(sessionStorage.getItem('pd-bot-login'));}catch{}}
  if(attempt?.expiresAt>Date.now()){stop();show();timer=setTimeout(poll,100);}
  else clear();
 }
 $('authModal').addEventListener('close',stop);
 return{start,resume,stop};
}
