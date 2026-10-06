import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
const source=stripTypeScriptTypes(readFileSync(new URL('../app/desktop-dock-layout.ts',import.meta.url),'utf8'));
const {dockLayout}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
test('all shortcuts remain reachable and each page fits including magnification',()=>{
 for(const width of [280,320,390,458,760,761,1024,1366,1920,2560])for(const count of [2,5,12,25,34,50]){
  const result=dockLayout(width,count),compact=width<=760;
  assert.ok(result.pages>=1&&result.pageSize>=1);
  const visible=result.pages===1?count:Math.min(count,result.pageSize+2);
  const actual=visible*(result.size+result.gap)-result.gap+(compact?22:30)+(result.pages>1?64:0)+(compact?0:result.size*2.6);
  assert.ok(actual<=width-(compact?16:32),`${width}px, ${count} items: ${actual}`);
  if(result.pages>1)assert.ok(result.pages*result.pageSize>=count-2);
 }
});
test('wide desktops retain the original complete Dock while narrow screens page',()=>{
 assert.equal(dockLayout(1920,25).pages,1);
 assert.ok(dockLayout(458,25).pages>1);
 assert.equal(dockLayout(1920,25).size,54);
 assert.equal(dockLayout(458,25).size,36);
});
