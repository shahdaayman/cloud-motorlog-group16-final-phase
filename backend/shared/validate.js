const { bad } = require('./errors');
const EMAIL=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function str(v, name, min=1, max=200) {if(typeof v!=='string'||v.trim().length<min||v.trim().length>max) throw bad(`${name} must contain ${min}-${max} characters`); return v.trim();}
function optionalStr(v,name,max=500){if(v==null||v==='')return '';return str(v,name,1,max);}
function number(v,name,min=0,max=1e10){if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max)throw bad(`${name} must be a number between ${min} and ${max}`);return v;}
function integer(v,name,min=0,max=1e10){number(v,name,min,max);if(!Number.isInteger(v))throw bad(`${name} must be a whole number`);return v;}
function date(v,name='date'){ if(typeof v!=='string'||!/^(\d{4})-(\d{2})-(\d{2})$/.test(v))throw bad(`${name} must use YYYY-MM-DD`);const d=new Date(`${v}T12:00:00Z`);if(Number.isNaN(d.valueOf())||d.toISOString().slice(0,10)!==v)throw bad(`${name} is not a valid date`);return v;}
function boolean(v,name){if(typeof v!=='boolean')throw bad(`${name} must be true or false`);return v;}
function enumValue(v,name,values){if(!values.includes(v))throw bad(`${name} must be one of: ${values.join(', ')}`);return v;}
function email(v){const s=str(v,'email',3,254).toLowerCase();if(!EMAIL.test(s))throw bad('Invalid email address');return s;}
function vin(v){const s=str(v,'VIN',17,17).toUpperCase();if(!/^[A-HJ-NPR-Z0-9]{17}$/.test(s))throw bad('VIN must have 17 characters and exclude I, O, Q');return s;}
function boundedQuery(req){const limit=Math.min(100,Math.max(1,Number.parseInt(req.query.limit||'40',10)||40));return limit;}
function assertFields(body,allowed){if(!body||typeof body!=='object'||Array.isArray(body))throw bad('JSON object required');const unknown=Object.keys(body).filter(k=>!allowed.includes(k));if(unknown.length)throw bad(`Unknown fields: ${unknown.join(', ')}`);}
function dateRange(q){const from=q.from?date(q.from,'from'):null;const to=q.to?date(q.to,'to'):null;if(from&&to&&from>to)throw bad('from must not be after to');return {from,to};}
function money(n){return Math.round((n+Number.EPSILON)*100)/100;}
function pageToken(key){return key?Buffer.from(JSON.stringify(key)).toString('base64url'):null;}
function parsePageToken(value){if(!value)return undefined;try{const key=JSON.parse(Buffer.from(String(value),'base64url').toString('utf8'));if(!key||typeof key!=='object'||Array.isArray(key))throw new Error();return key;}catch{throw bad('Invalid page token');}}
module.exports={str,optionalStr,number,integer,date,boolean,enumValue,email,vin,boundedQuery,assertFields,dateRange,money,pageToken,parsePageToken};
