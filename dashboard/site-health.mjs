const main=document.querySelector('main');
if(main){
 const strip=document.createElement('div');strip.className='health-strip';strip.setAttribute('role','status');strip.innerHTML='<span>Scheduled paper scans · refreshes every minute</span><a href="readiness.html">Platform access & funding readiness</a>';main.prepend(strip);
 let release=null;
 async function check(){try{const response=await fetch('./build-info.json?t='+Date.now(),{cache:'no-store',signal:AbortSignal.timeout(8000)});if(!response.ok)return;const next=await response.json();if(!next.version)return;if(release&&release!==next.version){strip.innerHTML='<span>A new dashboard version is ready.</span>';const button=document.createElement('button');button.textContent='Load update';button.onclick=()=>location.reload();strip.append(button);}release=next.version;}catch{/* Existing interface and dated snapshots remain usable during an outage. */}}
 check();setInterval(()=>{if(document.visibilityState==='visible')check();},60000);
}
