import {Worker} from 'node:worker_threads';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
import {renderTerrainRaster} from '../src/client/terrain-raster.js';
const url=pathToFileURL(resolve('dist/client/terrain-worker.js')).href;
const source=`const {parentPort}=require('node:worker_threads');globalThis.self={postMessage:(data,transfer)=>parentPort.postMessage(data,transfer)};(async()=>{await import(${JSON.stringify(url)});parentPort.on('message',data=>self.onmessage({data}));parentPort.postMessage({ready:true});})().catch(error=>{throw error});`;
const worker=new Worker(source,{eval:true});
try{
 await new Promise((resolve,reject)=>{worker.once('message',value=>{assert.equal(value.ready,true);resolve();});worker.once('error',reject);});
 const tile={west:68,east:72,south:39,north:43,pixels:64,level:8},reply=new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);});
 worker.postMessage({id:42,tile});const result=await reply;assert.equal(result.id,42);assert.deepEqual(result.data,renderTerrainRaster(tile).data);
 console.log('Built terrain Worker OK: real ESM shared chunks load, pixels match the shared field, buffer transferred; no browser.');
}finally{await worker.terminate();}
