// One interactive sheet at a time, including native dialogs and the tutorial.
export function createSurfaces({document,closeUnits=()=>{},closeTutorial=()=>{},onChange=()=>{}}){
 const node=id=>document.getElementById(id);
 function sync(){onChange();}
 function closeAll(keep){
  for(const p of document.querySelectorAll('[data-panel]'))if(p.id!==keep)p.hidden=true;
  if(keep!=='accountPanel'&&node('accountPanel'))node('accountPanel').hidden=true;
  if(keep!=='unitPanel')closeUnits();
  if(keep!=='tutorialOverlay')closeTutorial();
  for(const dialog of document.querySelectorAll('dialog'))if(dialog.open&&dialog.id!==keep)dialog.close();
  if(node('langDropdown'))node('langDropdown').hidden=true;
  sync();
 }
 function showDialog(id){closeAll(id);const dialog=node(id);if(dialog&&!dialog.open)dialog.showModal();sync();}
 function covered(){return !!document.querySelector('dialog[open]')||node('tutorialOverlay')?.hidden===false||node('accountPanel')?.hidden===false||[...document.querySelectorAll('[data-panel]')].some(p=>!p.hidden);}
 function back(){
  const dialogs=[...document.querySelectorAll('dialog')].filter(d=>d.open);
  if(dialogs.length){dialogs.at(-1).close();sync();return true;}
  const any=covered()||node('unitPanel')?.hidden===false;if(any)closeAll();return any;
 }
 for(const dialog of document.querySelectorAll('dialog'))dialog.addEventListener('close',sync);
 return{closeAll,showDialog,sync,covered,back};
}
