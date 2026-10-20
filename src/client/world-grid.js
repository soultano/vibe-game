export function drawWorldGrid(ctx, camera) {
  ctx.save();ctx.strokeStyle='#a6e3dd21';ctx.lineWidth=1;ctx.beginPath();
  function line(coordinates){
    let previous=new Map();
    for(const[a,b]of coordinates){
      const next=new Map();
      for(const p of camera.project.points(a,b)){
        const key=camera.globe?'sphere':`${p.sheet}:${p.turn}`,last=previous.get(key);
        if(last&&Math.hypot(p.x-last.x,p.y-last.y)<Math.max(camera.width,camera.height)/2){ctx.moveTo(last.x,last.y);ctx.lineTo(p.x,p.y);}
        next.set(key,p);
      }
      previous=next;
    }
  }
  for(let lng=-180;lng<180;lng+=30)line(Array.from({length:91},(_,i)=>[-90+i*2,lng]));
  for(let lat=-60;lat<=60;lat+=30)line(Array.from({length:181},(_,i)=>[lat,-180+i*2]));
  ctx.stroke();ctx.restore();
}
