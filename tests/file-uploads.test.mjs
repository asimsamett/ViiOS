import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable, PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { createUploadReceiver, uploadRequest } from '../server/file-uploads.mjs';

const helper = `let chunks=[];process.stdin.on('data',c=>chunks.push(c));process.stdin.on('end',()=>{
const all=Buffer.concat(chunks),line=all.indexOf(10);if(line<0)return;
const h=JSON.parse(all.subarray(0,line)),body=all.subarray(line+1),suffix=Buffer.from('\\nMANAGEMENT-UPLOAD-COMMIT\\n');
const ok=body.length===h.size+suffix.length&&body.subarray(h.size).equals(suffix);
process.stdout.write(JSON.stringify(ok?{ok:true,path:h.path,bytes:h.size}:{ok:false,status:400,error:'Incomplete'}));});`;
function fixture(code=helper) {
  const events=[];
  const receive=createUploadReceiver({openStream:async()=>spawn(process.execPath,['-e',code],{windowsHide:true,stdio:['pipe','pipe','pipe']}),log:async(type)=>events.push(type)});
  return { receive, events };
}
function request(chunks,size,headers={}) {
  const req=Readable.from(chunks);
  req.query={path:'/home/test/file.bin',size:String(size)};
  req.headers={'content-type':'application/octet-stream',...headers};
  req.complete=true;
  return req;
}
test('raw upload preserves binary bytes and accepts >16MB with backpressure',async()=>{
  const {receive,events}=fixture();
  const chunk=Buffer.alloc(65536,19);chunk[0]=0;chunk[1]=10;
  const result=await receive(request(Array(320).fill(chunk),chunk.length*320));
  assert.equal(result.bytes,20*1024*1024);assert.deepEqual(events,['file_upload']);
  assert.equal((await receive(request([],0))).bytes,0);
});
test('truncated and excess chunked bodies cannot forge a commit',async()=>{
  for (const req of [request([Buffer.from('short')],30),request([Buffer.from('abc\nMANAGEMENT-UPLOAD-COMMIT\n')],3)]) {
    const {receive,events}=fixture();await assert.rejects(receive(req));assert.deepEqual(events,['file_failed']);
  }
});
test('abort closes helper input cooperatively and reports failure',async()=>{
  const req=new PassThrough();req.query={path:'/home/test/file',size:'10000'};req.headers={'content-type':'application/octet-stream'};req.complete=false;
  const {receive,events}=fixture();const pending=receive(req);req.write('partial');
  setTimeout(()=>{req.emit('aborted');req.destroy();},100);
  await assert.rejects(pending,{status:499});assert.deepEqual(events,['file_failed']);
});
test('helper early rejection keeps conflict details without waiting for entire body',async()=>{
  const {receive}=fixture(`process.stdout.end(JSON.stringify({ok:false,status:409,error:'Already exists'}));`);
  const req=new PassThrough();req.query={path:'/home/test/file',size:'10000'};req.headers={'content-type':'application/octet-stream'};req.complete=false;
  const pending=receive(req);req.write('first');await assert.rejects(pending,{status:409});req.destroy();
});
test('upload protocol rejects JSON, invalid sizes and mismatched content length',async()=>{
  for(const query of [{path:'/home/file',size:'-1'},{path:'/home/file',size:'1.5'},{path:'/home/file',size:'9007199254740992'},{path:['/home/file'],size:'0'}])assert.throws(()=>uploadRequest(query));
  const {receive}=fixture();
  await assert.rejects(receive(request([],0,{'content-type':'application/json'})),{status:415});
  await assert.rejects(receive(request([],0,{'content-length':'1'})),{status:400});
});
