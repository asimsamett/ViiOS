import { randomUUID } from 'node:crypto';

export const timezone = 'Europe/Istanbul';
export const localDay = (date = new Date()) => new Intl.DateTimeFormat('en-CA', {timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
export function nextAudit(date=new Date()) {
  const [year,month,day]=localDay(date).split('-').map(Number);
  return new Date(Date.UTC(year,month-1,day+1)-3*60*60*1000).toISOString();
}
export function dailyDue(lastDay, lastAttempt, date=new Date()) { return !!lastDay && lastDay!==localDay(date) && (!lastAttempt || date.getTime()-new Date(lastAttempt).getTime()>=5*60*1000); }
export const healthOf = app => app.active===false ? 'closed' : app.networkState==='unknown' ? 'unreachable' : app.httpApplicable===false ? 'listening' : !app.status ? 'unreachable' : app.status>=500 ? 'degraded' : 'up';
export function event(type,message,app=null,at=new Date().toISOString(),notify=false) {
  return {id:randomUUID(),type,message,port:app?.port ?? null,name:app?.name ?? null,at,notify,read:false};
}
export function reconcile(previous, observed, {at=new Date().toISOString(),initial=false}={}) {
  const old=new Map(previous.map(a=>[a.port,a])); const seen=new Set(); const events=[];
  const apps=observed.map(raw=>{
    const prior=old.get(raw.port);
    const app=prior?.httpApplicable && raw.httpProbeError ? {...raw,httpApplicable:true,protocol:prior.protocol,kind:prior.kind,title:prior.title,error:'Port açık; HTTP/HTTPS yanıtı alınamıyor.'} : raw;
    seen.add(app.port); const prev=old.get(app.port); const same=prev && prev.pid===app.pid && prev.directory===app.directory && prev.kind===app.kind;
    const next={...app,active:true,health:healthOf({...app,active:true}),firstSeen:prev?.firstSeen || at,lastSeen:at,closedAt:null,previewAt:same ? prev.previewAt : undefined};
    if(!prev)events.push(event(initial?'discovered':'opened',initial ? 'İlk taramada açık port bulundu.' : 'Yeni port açıldı.',next,at,!initial));
    else if(prev.active===false)events.push(event('reopened','Kapanan port yeniden açıldı.',next,at,true));
    else if(healthOf(prev)!==next.health)events.push(event(['up','listening'].includes(next.health)?'recovered':next.health==='degraded'?'degraded':'unreachable',next.health==='listening'?'Servis portu dinliyor.':next.health==='up'?'Servis yeniden yanıt veriyor.':next.health==='degraded'?'Servis hata yanıtı veriyor.':'Port açık; HTTP/HTTPS yanıtı alınamıyor.',next,at,true));
    else if(prev.status!==next.status)events.push(event('http_changed',`HTTP yanıtı değişti: ${prev.status || '—'} → ${next.status || '—'}.`,next,at,false));
    else if(JSON.stringify(prev.transports?.slice().sort())!==JSON.stringify(next.transports?.slice().sort()))events.push(event('bindings_changed','Portun TCP/UDP dinleme türü değişti.',next,at,true));
    return next;
  });
  for(const prev of previous)if(!seen.has(prev.port)){
    if(prev.active!==false)events.push(event('closed','Port kapandı; artık dinlemiyor.',prev,at,true));
    apps.push({...prev,active:false,health:'closed',closedAt:prev.closedAt || at});
  }
  return {apps:apps.sort((a,b)=>a.port-b.port),events};
}
