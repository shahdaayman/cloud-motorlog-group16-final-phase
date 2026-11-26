/** Produces independently deployable Lambda ZIP packages in dist/ using esbuild + archiver. */
const fs=require('node:fs');const path=require('node:path');
const esbuild=require('esbuild');const archiver=require('archiver');
const root=path.resolve(__dirname,'..');const dist=path.join(root,'dist');fs.mkdirSync(dist,{recursive:true});
function zipFile(entry,dest){return new Promise((resolve,reject)=>{const output=fs.createWriteStream(dest);const archive=archiver('zip',{zlib:{level:9}});output.on('close',resolve);output.on('error',reject);archive.on('error',reject);archive.pipe(output);archive.file(entry,{name:'index.js'});archive.finalize();});}
async function main(){for(const name of ['vehicles','fuel','reminders']){
 const out=path.join(dist,`${name}.js`);
 await esbuild.build({entryPoints:[path.join(root,'backend/services',name,'lambda.js')],outfile:out,bundle:true,platform:'node',target:'node22',format:'cjs',minify:false,logLevel:'warning',external:[]});
 await zipFile(out,path.join(dist,`${name}.zip`));console.log(`Packaged ${name} → dist/${name}.zip (handler index.handler)`);
}console.log('ZIP packages are ready for Lambda deployment.');}
main().catch(e=>{console.error(e);process.exitCode=1});
