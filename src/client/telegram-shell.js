// Shell gestures are independent of authentication and optional SDK loading.
// API contract: https://core.telegram.org/bots/webapps#initializing-mini-apps
export function createTelegramShell({getApp,launchData,style,onViewport=()=>{},onBack=()=>{},onActivity=()=>{}}){
 let bound=null;
 const supported=(app,version)=>!app.isVersionAtLeast||app.isVersionAtLeast(version);
 function viewport(event){
  const app=getApp();if(!app||event?.isStateStable===false)return;
  const height=app.viewportStableHeight||app.viewportHeight;
  if(Number.isFinite(height)&&height>0)style.setProperty('--viewport-height',height+'px');
  onViewport();
 }
 function setup(){
  const app=getApp();if(!app||!(launchData||app.initData))return;
  if(bound===app)return;bound=app;
  try{app.ready?.();app.expand?.();}catch{}
  try{if(supported(app,'7.7'))app.disableVerticalSwipes?.();}catch{}
  try{app.setHeaderColor?.('#080f19');app.setBackgroundColor?.('#080f19');}catch{}
  app.BackButton?.onClick?.(onBack);
  app.onEvent?.('viewportChanged',viewport);
  app.onEvent?.('safeAreaChanged',viewport);app.onEvent?.('contentSafeAreaChanged',viewport);
  app.onEvent?.('activated',()=>{onActivity(true);viewport();});
  app.onEvent?.('deactivated',()=>onActivity(false));
  viewport();
 }
 return{setup,backVisible(show){const back=getApp()?.BackButton;try{show?back?.show?.():back?.hide?.();}catch{}}};
}
