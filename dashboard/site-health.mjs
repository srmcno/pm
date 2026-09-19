const main=document.querySelector('main');
if(main){
 const strip=document.createElement('div');strip.className='health-strip';strip.setAttribute('role','status');strip.innerHTML='<span>Scheduled paper scans · refreshes every minute</span><a href="readiness.html">Platform access & funding readiness</a>';main.prepend(strip);
 let release=document.querySelector('meta[name="mm-release"]')?.content||null,busy=false;const loadedAt=Date.now();
 async function check(){
  if(busy||document.visibilityState!=='visible')return;busy=true;
  try{
   const response=await fetch('./build-info.json?t='+Date.now(),{cache:'no-store',signal:AbortSignal.timeout(8000)});if(!response.ok)return;
   const next=await response.json(),revision=next.interfaceRevision;if(!/^[a-f0-9]{20}$/.test(revision||''))return;
   if(!release){release=revision;return;}
   if(release===revision)return;
   // Never interrupt typing. Readiness retains its nonsensitive calculator
   // values in session storage; live data continues updating in the meantime.
   if(document.body.dataset.updateBlocked==='true'||document.activeElement?.matches('input,select,textarea,[contenteditable="true"]')){
    strip.replaceChildren();const label=document.createElement('span');label.textContent=document.body.dataset.updateBlocked==='true'?'Dashboard update ready. This browser cannot retain your edits; reload after you finish.':'Dashboard update ready. It will load after you finish editing.';strip.append(label);
    return;
   }
   // Query-version the document as well as its imports. A stale CDN document
   // must not cause a reload loop while the new release propagates.
   const url=new URL(location.href);
   if(url.searchParams.get('_ui')===revision){if(Date.now()-loadedAt<60000)return;url.searchParams.set('_retry',String(Date.now()));}
   url.searchParams.set('_ui',revision);location.replace(url);
  }catch{/* Existing interface and dated snapshots remain usable during an outage. */}finally{busy=false;}
 }
 check();setInterval(check,60000);
 document.addEventListener('visibilitychange',check);
 addEventListener('pageshow',check);
 document.addEventListener('focusout',()=>setTimeout(check,0));
}
