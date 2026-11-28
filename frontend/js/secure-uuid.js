(function(root,factory){
  'use strict';
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.MotorlogSecureUUID=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  function v4(cryptoApi=typeof globalThis!=='undefined'?globalThis.crypto:undefined){
    if(cryptoApi&&typeof cryptoApi.randomUUID==='function'){
      try{return cryptoApi.randomUUID();}catch(error){if(typeof cryptoApi.getRandomValues!=='function')throw error;}
    }
    if(!cryptoApi||typeof cryptoApi.getRandomValues!=='function')throw new Error('Secure random identifier generation is unavailable in this browser.');
    const bytes=new Uint8Array(16);cryptoApi.getRandomValues(bytes);bytes[6]=(bytes[6]&0x0f)|0x40;bytes[8]=(bytes[8]&0x3f)|0x80;
    const hex=Array.from(bytes,value=>value.toString(16).padStart(2,'0')).join('');
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  }
  return {v4};
});
