export const BIOMES=Object.freeze({
 grass:{name:'Луг',color:'#52713b',rgb:[86,119,64]},forest:{name:'Лес',color:'#2d5141',rgb:[43,81,62]},
 rock:{name:'Скалы',color:'#7b8169',rgb:[123,128,103]},mountain:{name:'Горы',color:'#737b71',rgb:[151,160,143]},
 sand:{name:'Песчаный берег',color:'#ad9658',rgb:[180,157,94]},water:{name:'Вода',color:'#1c6579',rgb:[27,83,106]},
 snow:{name:'Снежные поля',color:'#e0eaf0',rgb:[224,234,240]},ice:{name:'Ледник',color:'#a8d1e0',rgb:[168,209,224]},
 tundra:{name:'Тундра',color:'#969b79',rgb:[150,155,121]},desert:{name:'Пустыня',color:'#d2b16b',rgb:[210,177,107]},
 redDesert:{name:'Красная пустыня',color:'#b97345',rgb:[185,115,69]},coldDesert:{name:'Каменистая пустыня',color:'#b5ac89',rgb:[181,172,137]},
 jungle:{name:'Джунгли',color:'#21533a',rgb:[33,83,58]},savanna:{name:'Саванна',color:'#aca05b',rgb:[172,160,91]},
});
export const CLIMATES=Object.freeze({
 polar:{name:'Полярный холод',base:[215,232,238]},tundra:{name:'Субарктика',base:[146,155,126]},
 desert:{name:'Жаркий и сухой',base:[205,171,102]},rainforest:{name:'Влажные тропики',base:[38,91,61]},
 savanna:{name:'Сухие тропики',base:[164,155,83]},alpine:{name:'Высокогорье',base:[156,164,151]},
 temperate:{name:'Умеренный',base:[83,112,65]},
});
function zone(lat,lng,a,b,ry,rx){const d=((lat-a)/ry)**2+((lng-b)/rx)**2;if(d<.72)return true;if(d>1.3)return false;return d<1+Math.sin(lng*.5+lat*.4)*.18+Math.sin(lng*.19-lat*.57)*.1;}
export function desertBiomeAt(lat,lng){return lat< -10&&(lng>110||lng>10&&lng<30)?'redDesert':lat>33&&lng>75?'coldDesert':'desert';}
export function climateAt(lat,lng){
 lng=((lng+180)%360+360)%360-180;
 if(lat< -60||lat>74||zone(lat,lng,74,-42,17,23))return 'polar';
 if(lat>62)return 'tundra';
 if(zone(lat,lng,24,12,12,35)||zone(lat,lng,24,47,11,16)||zone(lat,lng,-25,132,12,21)||zone(lat,lng,-24,17,10,12)||zone(lat,lng,-23,-70,12,4)||zone(lat,lng,42,103,8,21)||zone(lat,lng,41,56,6,9))return 'desert';
 if(zone(lat,lng,30,85,5,23)||zone(lat,lng,-17,-70,39,7)||zone(lat,lng,43,-113,18,9)||zone(lat,lng,46.5,10,3,9))return 'alpine';
 if(zone(lat,lng,-4,-62,12,20)||zone(lat,lng,-1,22,9,15)||zone(lat,lng,4,117,17,28)||zone(lat,lng,12,-85,9,15))return 'rainforest';
 if(zone(lat,lng,3,32,18,21)||zone(lat,lng,-17,-48,13,17)||zone(lat,lng,-14,136,9,18))return 'savanna';
 return 'temperate';
}
