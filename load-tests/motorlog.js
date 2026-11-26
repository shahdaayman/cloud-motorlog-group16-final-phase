import http from 'k6/http';
import {check,sleep} from 'k6';
const steadyVus=Number(__ENV.STEADY_VUS||20);
export const options={stages:[{duration:'15s',target:5},{duration:'30s',target:steadyVus},{duration:'15s',target:0}],thresholds:{http_req_duration:['p(95)<500'],http_req_failed:['rate<0.05']}};
const base=__ENV.BASE_URL||'http://localhost:3101';
export default function(){const r=http.get(`${base}/api/health`);check(r,{'health 200':x=>x.status===200,'instance header':x=>Boolean(x.headers['X-Motorlog-Instance'])});sleep(0.2);}
