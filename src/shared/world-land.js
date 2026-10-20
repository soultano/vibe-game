// Authored approximate Antarctic coastline supplements the project's old mask,
// which omitted the entire continent below 60°S. It is game cartography.
const antarctica=[[-180,-78],[-160,-77],[-140,-74],[-120,-73],[-100,-73],[-80,-73],[-72,-68],[-64,-63],[-57,-66],[-48,-76],[-20,-75],[0,-70],[20,-69],[40,-68],[60,-67],[80,-66],[100,-65],[120,-66],[140,-67],[155,-70],[170,-77],[180,-78]];
export function antarcticLand(lat,lng){
 if(lat> -60)return false;
 lng=((lng+180)%360+360)%360-180;
 for(let i=1;i<antarctica.length;i++){const[a,b]=antarctica[i-1],[c,d]=antarctica[i];if(lng<=c)return lat<=b+(d-b)*(lng-a)/(c-a);}
 return false;
}
export function worldLandAt(lat,lng,mask){
 if(lat< -60)return antarcticLand(lat,lng);
 const x=Math.floor((((lng+180)%360+360)%360)),y=Math.max(0,Math.min(179,Math.floor(90-lat)));
 return !!mask[y*360+x];
}
