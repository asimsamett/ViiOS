import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {stripTypeScriptTypes} from 'node:module';
import {createDesktopLayoutStore} from '../server/desktop-layout.mjs';
const moduleUrl=source=>'data:text/javascript;base64,'+Buffer.from(source).toString('base64');
const launcherUrl=moduleUrl(stripTypeScriptTypes(readFileSync(new URL('../app/launcher-data.ts',import.meta.url),'utf8')).replace(/^import .* from 'react';\r?\n/m,''));
const {launcherActions,cleanLaunchItem}=await import(launcherUrl);
const source=stripTypeScriptTypes(readFileSync(new URL('../app/feature-catalog.ts',import.meta.url),'utf8')).replace(/from '\.\/launcher-data'/,`from '${launcherUrl}'`);
const {featureChapters,filterFeatures}=await import(moduleUrl(source));
test('every built-in destination has a readable chapter and all related links resolve',()=>{
 const expected=launcherActions.filter(item=>!['action:apps','action:managed'].includes(item.id));
 for(const item of expected)assert.ok(featureChapters.some(chapter=>chapter.id===item.id),item.id);
 assert.equal(new Set(featureChapters.map(chapter=>chapter.id)).size,featureChapters.length);
 for(const chapter of featureChapters){
  assert.ok(cleanLaunchItem(chapter.item),chapter.id);
  assert.ok(chapter.summary&&chapter.when&&chapter.steps.length&&chapter.notes.length);
  for(const id of chapter.related)assert.ok(featureChapters.some(entry=>entry.id===id),id);
 }
});
test('Turkish and unaccented searches include chapter content and obey category filters',()=>{
 assert.ok(filterFeatures('sifre','Tümü').some(entry=>entry.id==='action:credentials'));
 assert.ok(filterFeatures('İŞLEM GEÇMİŞİ','Tümü').some(entry=>entry.id==='action:history'));
 assert.ok(filterFeatures('fiziksel disk','İzleme').some(entry=>entry.id==='action:storage'));
 assert.ok(filterFeatures('','Dosyalar').every(entry=>entry.category==='Dosyalar'));
 assert.equal(filterFeatures('zzzznonexistent','Tümü').length,0);
});
test('the new guide shortcut survives server persistence and browser normalization',async()=>{
 const dataDir=await mkdtemp(path.join(tmpdir(),'viios-guide-'));
 try{
  const store=createDesktopLayoutStore({dataDir}),guide=launcherActions.find(item=>item.view==='features');
  await store.save({revision:0,dock:[guide],desktop:null});
  const read=await store.read();assert.equal(cleanLaunchItem(read.dock[0]).view,'features');assert.equal(read.desktop,null);
 }finally{await rm(dataDir,{recursive:true,force:true});}
});
