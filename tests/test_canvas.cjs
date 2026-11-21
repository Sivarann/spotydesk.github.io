// Browser-logic tests with synthetic DOM/network, no Spotify account or npm install required.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function main() {
  const listeners = new Map();
  const root = {dataset:{currentView:'player'}};
  const background = {querySelector:()=>({before: v => {v.parentNode=background}}),prepend: v=>{v.parentNode=background}};
  const settings = {children:[],append(c){this.children.push(c);}};
  const input = {checked:true, addEventListener(type, callback){this.change=callback}};
  const status = {textContent:''};
  const document = {
    readyState:'complete', hidden:false,
    getElementById:id=>id==='remote'?root:null,
    querySelector:sel=>sel.includes('player-background')?background:sel.includes('settings')?settings:null,
    createElement(tag){ if(tag==='video')return video; return {
      className:'',innerHTML:'',querySelector:s=>s==='input'?input:status
    }; },
    addEventListener:(name,cb)=>listeners.set(name,cb)
  };
  const storage = new Map();
  const localStorage = {getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)};
  const video = {
    src:'',listeners:{},muted:false,playing:false,
    setAttribute(){},removeAttribute(k){if(k==='src')this.src='';},
    addEventListener(name,cb){this.listeners[name]=cb},
    load(){},pause(){this.playing=false},
    play(){this.playing=true;this.listeners.playing?.();return Promise.resolve();},remove(){},
  };
  const urls=[];
  const fetch = async (input)=>{
    const url=String(input);urls.push(url);
    if(url.endsWith('/canvas-config.json')) return {ok:true,json:async()=>({endpoint:'https://canvas.example/api/canvas'})};
    if(url.endsWith('/video-loops.json')) return {ok:true,json:async()=>({'spotify:track:local123':'./videos/local.mp4'})};
    if(url.includes('trackId=canvas123')) return {ok:true,json:async()=>({data:{canvasesList:[{
      trackUri:'spotify:track:canvas123',canvasUrl:'https://canvaz.scdn.co/playlist.cnvs.mp4'
    }]}})};
    if(url.includes('trackId=missing456')) return {ok:true,json:async()=>({data:{canvasesList:[]}})};
    if(url.includes('trackId=error999')) throw Error('network error');
    return {ok:false};
  };
  const context={
    document,window:{addEventListener(){ }},localStorage,
    URL,location:{origin:'https://spotydesk.github.io',href:'https://spotydesk.github.io/'},
    MutationObserver:class{observe(){}},fetch,AbortController,setTimeout,clearTimeout,
  };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'../overlay/canvas-background.js'),'utf8'),context);
  const controller=context.window.turntableCanvasBackground;
  assert.ok(controller);
  const settle=()=>new Promise(resolve=>setTimeout(resolve,20));
  await controller.syncTrack({uri:'spotify:track:canvas123'},true);
  await settle();
  assert.equal(video.src,'https://canvaz.scdn.co/playlist.cnvs.mp4');
  assert.equal(root.dataset.spotydeskCanvas,'active');
  assert.equal(video.muted,true);
  assert.equal(urls.filter(u=>u.includes('trackId=canvas123')).length,1);
  await controller.syncTrack({uri:'spotify:track:canvas123'},false);
  assert.equal(video.playing,false);
  await controller.syncTrack({uri:'spotify:track:canvas123'},true);
  assert.equal(video.playing,true);
  await controller.syncTrack({uri:'spotify:track:local123'},true);
  await settle();
  assert.equal(video.src,'https://spotydesk.github.io/videos/local.mp4');
  assert.equal(urls.filter(u=>u.includes('trackId=local123')).length,0);
  await controller.syncTrack({uri:'spotify:track:missing456'},true);
  await settle();
  assert.equal(root.dataset.spotydeskCanvas,'off');
  assert.equal(video.src,'');
  await controller.syncTrack({uri:'spotify:track:error999'},true);
  await settle();
  assert.equal(root.dataset.spotydeskCanvas,'off');
  await controller.syncTrack({uri:'spotify:track:canvas123'},true);
  await settle();
  assert.equal(root.dataset.spotydeskCanvas,'active');
  video.listeners.error();
  assert.equal(root.dataset.spotydeskCanvas,'off');
  assert.equal(video.playing,false);
  input.change({target:{checked:false}});
  assert.equal(storage.get('spotydesk.canvas.enabled.v1'),'false');
  assert.equal(root.dataset.spotydeskCanvas,'off');
  controller.dispose();
  console.log('PASS: Canvas lookup, local priority, no video fallback, media errors, pause/resume, preference, cleanup');
}
main().catch(e=>{console.error(e);process.exitCode=1});
