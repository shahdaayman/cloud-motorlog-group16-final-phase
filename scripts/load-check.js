/** Bounded, read-only concurrency check. Does not simulate a million users. */
const base=process.env.LOAD_URL||'http://localhost:3000/api/health';
const total=Math.min(500,Math.max(1,Number(process.env.REQUESTS||100)));
const concurrency=Math.min(20,Math.max(1,Number(process.env.CONCURRENCY||10)));
(async()=>{let cursor=0,success=0,fail=0;const latencies=[];
 async function worker(){while(true){const id=cursor++;if(id>=total)break;const start=performance.now();try{const r=await fetch(base,{signal:AbortSignal.timeout(6000)});if(!r.ok)fail++;else success++;}catch{fail++;}latencies.push(performance.now()-start);}}
 await Promise.all(Array.from({length:concurrency},worker));latencies.sort((a,b)=>a-b);console.log(JSON.stringify({requests:total,concurrency,success,failures:fail,p50Ms:Math.round(latencies[Math.floor(latencies.length*.5)]||0),p95Ms:Math.round(latencies[Math.floor(latencies.length*.95)]||0)},null,2));if(fail)process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1});
