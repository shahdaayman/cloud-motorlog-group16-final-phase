const fs=require('node:fs');
const path=require('node:path');
const esbuild=require('esbuild');
const archiver=require('archiver');
const root=path.resolve(__dirname,'..');
const dist=path.join(root,'dist');
const bundled=path.join(dist,'motorlog-audit-logger.js');
const archivePath=path.join(dist,'motorlog-audit-logger.zip');
function zip(){return new Promise((resolve,reject)=>{const output=fs.createWriteStream(archivePath);const archive=archiver('zip',{zlib:{level:9}});output.on('close',resolve);output.on('error',reject);archive.on('error',reject);archive.pipe(output);archive.file(bundled,{name:'index.js'});archive.finalize();});}
async function main(){fs.mkdirSync(dist,{recursive:true});await esbuild.build({entryPoints:[path.join(root,'backend/services/audit-logger/lambda.js')],outfile:bundled,bundle:true,platform:'node',target:'node22',format:'cjs',minify:false,logLevel:'warning',external:[]});await zip();console.log('Packaged motorlog-audit-logger with CloudWatch Logs SDK dependency.');}
main().catch(error=>{console.error(error);process.exitCode=1;});
