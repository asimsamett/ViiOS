import http from 'node:http';
// Disposable service fixture. A ready signal is sent only after the real listener binds.
const server=http.createServer((_req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({service:'ViiOS Lab Service',status:'running'}));});
server.on('error',()=>process.exit(1));
const port=Number(process.argv[2]??3291);
if(!Number.isInteger(port)||port<0||port>65535)process.exit(1);
server.listen(port,'127.0.0.1',()=>process.send?.({ready:true,port:server.address().port}));
process.on('disconnect',()=>server.close(()=>process.exit(0)));
