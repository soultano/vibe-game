// Touch holds add a selection gesture without taking away pan or pinch.
// Desktop Shift-drag draws a marquee; ordinary dragging still pans the map.
export function createUnitGestures({getView,getPlayer,ownUnits,hitUnit,layoutTroops,beginSelection,select,selectMany,open,invalidate,isBusy}){
 let start=null,timer=null,rosterClickUntil=0,lastTouch=-Infinity;
 function clearTimer(){if(timer!==null)clearTimeout(timer);timer=null;}
 function cancel(){clearTimer();if(start?.roster)rosterClickUntil=Date.now()+800;const box=start?.box;start=null;if(box)invalidate();}
 function down(event,point,rosterId){
  cancel();if(isBusy()||event.button>0)return false;
  const touch=event.pointerType==='touch';if(touch)lastTouch=Date.now();
  if(!rosterId&&!touch&&event.shiftKey){start={id:event.pointerId,a:point,b:point,box:true};open();invalidate();return true;}
  const view=getView(),unit=rosterId?ownUnits().find(u=>u.key===rosterId):touch?hitUnit(layoutTroops(view.units,view),point.x,point.y,getPlayer()?.id):null;
  if(!unit)return false;
  start={id:event.pointerId,a:point,b:point,unit:unit.key,roster:!!rosterId,touch,shift:!!event.shiftKey,held:false,cancelled:false};
  if(touch&&unit.hp>0)timer=setTimeout(()=>{timer=null;if(!start||start.cancelled)return;start.held=true;beginSelection(start.unit);invalidate();},480);
  return false;
 }
 function move(event,point){
  if(!start||start.id!==event.pointerId)return false;start.b=point;
  if(start.box){invalidate();return true;}
  if(Math.hypot(point.x-start.a.x,point.y-start.a.y)>5){clearTimer();start.cancelled=true;}
  return false;
 }
 function up(event,point){
  if(!start||start.id!==event.pointerId)return false;
  const gesture=start;clearTimer();start=null;
  if(gesture.box){
   invalidate();if(Math.hypot(point.x-gesture.a.x,point.y-gesture.a.y)<=5)return false;
   const view=getView(),left=Math.min(gesture.a.x,point.x),right=Math.max(gesture.a.x,point.x),top=Math.min(gesture.a.y,point.y),bottom=Math.max(gesture.a.y,point.y);
   const ids=layoutTroops(view.units,view).filter(p=>p.unit.owner===getPlayer()?.id&&!p.unit.neutral&&p.unit.hp>0&&p.x>=left&&p.x<=right&&p.y-p.elevation*.8-p.span*.36>=top&&p.y-p.elevation*.8-p.span*.36<=bottom).map(p=>p.unit.key);
   selectMany(ids,{add:true});return true;
  }
  if(gesture.touch)lastTouch=Date.now();
  if(gesture.roster){rosterClickUntil=Date.now()+800;if(!gesture.cancelled&&!gesture.held)select(gesture.unit,{additive:gesture.shift||undefined});return true;}
  return gesture.held;
 }
 function draw(ctx){
  if(!start?.box)return;const x=Math.min(start.a.x,start.b.x),y=Math.min(start.a.y,start.b.y),w=Math.abs(start.a.x-start.b.x),h=Math.abs(start.a.y-start.b.y);
  ctx.save();ctx.fillStyle='#b5ff8b1b';ctx.fillRect(x,y,w,h);ctx.strokeStyle='#c0ff9b';ctx.lineWidth=1.5;ctx.setLineDash([6,4]);ctx.strokeRect(x,y,w,h);ctx.restore();
 }
 return{down,move,up,cancel,draw,consumeRosterClick(event){if(event.detail===0)return false;const consume=Date.now()<rosterClickUntil;rosterClickUntil=0;return consume;},ignoreContextMenu(event){return event.pointerType==='touch'||event.sourceCapabilities?.firesTouchEvents||!event.pointerType&&Date.now()-lastTouch<800;}};
}
