import test from 'node:test';
import assert from 'node:assert/strict';
import { enrichClosedModels } from '../server/model-connections.mjs';

test('closed apps use current project settings, deepest root wins and runtime secrets never carry over',()=>{
  const runtime={endpoint:'http://old',model:'old'};
  const apps=[{active:false,directory:'/home/project/sub/app',modelConnections:[runtime]},{active:false,directory:'/home/project-other',modelConnections:[runtime]},{active:true,directory:'/home/project/sub/app',modelConnections:[runtime]}];
  const result=enrichClosedModels(apps,[{roots:['/home/project'],modelConnections:[{endpoint:'http://parent'}]},{roots:['/home/project/sub'],modelConnections:[{endpoint:'http://nested'}],modelDiscovery:{status:'found'}}]);
  assert.equal(result[0].modelConnections[0].endpoint,'http://nested');
  assert.deepEqual(result[1].modelConnections,[]);assert.equal(result[1].modelDiscovery.status,'unavailable');
  assert.equal(result[2],apps[2]);
});
