const net=require('node:net');
const [upstreamHost='floci',upstreamPortText='80',listenPortText='4510']=process.argv.slice(2);
const upstreamPort=Number(upstreamPortText),listenPort=Number(listenPortText);
if(!Number.isInteger(upstreamPort)||!Number.isInteger(listenPort))throw new Error('Valid proxy ports are required');
const server=net.createServer(client=>{const upstream=net.connect(upstreamPort,upstreamHost);client.pipe(upstream);upstream.pipe(client);const close=()=>{client.destroy();upstream.destroy();};client.on('error',close);upstream.on('error',close);});
server.listen(listenPort,'0.0.0.0',()=>console.log(`Motorlog ALB loopback proxy listening on ${listenPort}`));
