((root,factory)=>{const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.MotorlogHashRouter=api;})(globalThis,()=>{
 'use strict';
 function create({valid,fallback,locationObject=globalThis.location,historyObject=globalThis.history}){
  const allowed=new Set(valid);
  if(!allowed.has(fallback))throw new Error('Hash router fallback must be an allowed route');
  function resolve(hash=locationObject.hash){let value='';try{value=decodeURIComponent(String(hash||'').replace(/^#\/?/,'')).trim().toLowerCase();}catch{}return allowed.has(value)?value:fallback;}
  function write(route,mode){const safe=allowed.has(route)?route:fallback,target=`#${safe}`;if(locationObject.hash!==target)historyObject[`${mode}State`](null,'',target);return safe;}
  return {resolve,normalize:()=>write(resolve(),'replace'),navigate:(route,{replace=false}={})=>write(route,replace?'replace':'push'),isAllowed:route=>allowed.has(route)};
 }
 return {create};
});
