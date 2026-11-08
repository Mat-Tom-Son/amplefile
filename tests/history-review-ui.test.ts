import assert from 'node:assert/strict';
import {createRequire,registerHooks} from 'node:module';
import test from 'node:test';
import {createElement} from 'react';
import {createDomHarness} from './support/dom.js';
const iconNames = Object.keys(createRequire(import.meta.url)("@fluentui/react-icons")).filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
const assets = registerHooks({
  resolve(specifier, context, next) { return specifier === "@fluentui/react-icons" ? { url: "test:history-icons", shortCircuit: true } : next(specifier, context); },
  load(url, context, next) {
    if (url === "test:history-icons") return { format: "module", source: iconNames.map((name) => `export const ${name}=${name === "bundleIcon" ? "(filled)=>filled" : "()=>null"};`).join("\n"), shortCircuit: true };
    if (/\.(css|svg)(?:\?|$)/.test(url)) return { format: "module", source: "export default '';", shortCircuit: true };
    return next(url, context);
  },
});

const {HistoryFileComparison}=await import('../web-local/src/components/panes/HistoryFileComparison.js');
assets.deregister();

const busyError=()=>Response.json({error:'Wait for the current History or Connected Folder registration operation to finish.'},{status:409});

test('switching Compare to another file lets the first comparison finish before the next one starts', async t=>{
 const dom=await createDomHarness();const original=globalThis.fetch;
 let reading=false;let release=()=>{};const requested:string[]=[];const refused:string[]=[];
 t.after(async()=>{release();await dom.cleanup();globalThis.fetch=original;});
 globalThis.fetch=async(input,init)=>{
  const path=new URL(String(input),'http://localhost').searchParams.get('path')!;
  if(reading){refused.push(path);return busyError();}
  requested.push(path);reading=true;
  // The host keeps reading, and holding its History lock, after the app stops listening.
  return new Promise<Response>((resolve,reject)=>{
   release=()=>{reading=false;resolve(Response.json({error:'not needed'},{status:404}));};
   init?.signal?.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true});
  });
 };
 const comparison=(path:string)=>createElement(HistoryFileComparison,{connectedFolderId:'disposable',path,fromCheckpointId:'one'});
 await dom.render(comparison('first.txt'));
 await dom.waitFor(()=>reading);
 await dom.render(comparison('second.txt'));
 await dom.render(comparison('third.txt'));
 await dom.settle();
 assert.deepEqual(refused,[]);
 await dom.act(async()=>{release();});
 await dom.waitFor(()=>requested.length===2);
 assert.deepEqual(requested,['first.txt','third.txt'],'a comparison replaced while it waited is never sent');
 assert.deepEqual(refused,[]);
});
