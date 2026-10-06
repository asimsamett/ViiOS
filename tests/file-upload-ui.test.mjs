import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const source=readFileSync(new URL('../app/file-upload.ts',import.meta.url),'utf8');
const compiled=ts.transpile(source,{module:ts.ModuleKind.ES2022,target:ts.ScriptTarget.ES2022});
const {filesToUpload,droppedUpload,sendUpload}=await import('data:text/javascript;base64,'+Buffer.from(compiled).toString('base64'));
function file(name,path,size=1){return {name,webkitRelativePath:path,size};}
test('folder selection has no 100 file or 200MB cap and retains duplicate basenames in separate folders',()=>{
  const files=Array.from({length:125},(_,i)=>file('same.bin',`root/dir-${i}/same.bin`,2*1024*1024));
  const items=filesToUpload(files);assert.equal(items.filter(i=>i.file).length,125);assert.equal(items.filter(i=>!i.file).length,126);
  assert.equal(items.filter(i=>i.file).reduce((sum,i)=>sum+i.file.size,0),250*1024*1024);
  assert.equal(items.at(-1).path,'root/dir-124/same.bin');
  assert.throws(()=>filesToUpload([file('bad','root/../escape')]));
});
function entry(name,children){return {name,isDirectory:!!children,isFile:!children,file:resolve=>resolve(file(name,'')),createReader:()=>{let offset=0;return{readEntries:resolve=>{const batch=children.slice(offset,offset+100);offset+=100;resolve(batch);}};}};}
test('folder drop walks all Chromium batches and preserves empty folders',async()=>{
  const root=entry('folder',[entry('empty',[]),...Array.from({length:205},(_,i)=>entry(`file-${i}`))]);
  const items=await droppedUpload({items:[{kind:'file',webkitGetAsEntry:()=>root}],files:[]});
  assert.equal(items.length,207);assert(items.some(i=>i.path==='folder/empty'&&!i.file));assert(items.some(i=>i.path==='folder/file-204'));
});

test('demo upload is rejected before creating a request or reading a file',async()=>{
  const previous=process.env.NEXT_PUBLIC_VIIOS_DEMO;
  process.env.NEXT_PUBLIC_VIIOS_DEMO='true';
  try { await assert.rejects(sendUpload('/api/files/upload',null,new AbortController().signal,()=>assert.fail('No upload progress in demo')),/Demo modunda/); }
  finally { if(previous===undefined)delete process.env.NEXT_PUBLIC_VIIOS_DEMO;else process.env.NEXT_PUBLIC_VIIOS_DEMO=previous; }
});
