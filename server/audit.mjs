// Pure reporting and annotation rules shared by the HTTP API and tests.
const invalid=message=>Object.assign(new Error(message),{status:400});
const hasControl=text=>{for(let i=0;i<text.length;i++)if(text.charCodeAt(i)<32)return true;return false;};
export const defaultAnnotation=()=>({displayName:'',note:'',favorite:false,expectedUp:false,tags:[],revision:0});
export function patchAnnotation(previous,patch) {
  const base={...defaultAnnotation(),...previous};
  if(!patch || typeof patch!=='object' || Array.isArray(patch) || !Object.keys(patch).length || Object.keys(patch).some(k=>!['displayName','note','favorite','expectedUp','tags','revision'].includes(k)))throw invalid('Geçersiz uygulama bilgisi.');
  if(patch.revision!==undefined && patch.revision!==base.revision)throw Object.assign(new Error('Bu portun notu başka bir oturumda güncellendi. Pencereyi yeniden açıp değişiklikleri kontrol edin.'),{status:409});
  for(const key of ['favorite','expectedUp'])if(patch[key]!==undefined && typeof patch[key]!=='boolean')throw invalid('Takip seçenekleri doğru/yanlış olmalı.');
  for(const [key,max] of [['displayName',100],['note',2000]])if(patch[key]!==undefined && (typeof patch[key]!=='string' || patch[key].length>max || patch[key].includes('\0')))throw invalid(`${key==='note'?'Not':'Görünen ad'} en fazla ${max} karakter olmalı.`);
  if(patch.tags!==undefined && (!Array.isArray(patch.tags) || patch.tags.length>5 || patch.tags.some(t=>typeof t!=='string' || !t.trim() || t.length>24 || hasControl(t))))throw invalid('En fazla 5 etiket ekleyin; her biri 1–24 karakter olmalı.');
  const next={...base,...patch,revision:base.revision+1};
  next.displayName=next.displayName.trim();next.note=next.note.trim();next.tags=[...new Set(next.tags.map(t=>t.trim()))];
  next.updatedAt=new Date().toISOString();return next;
}
export const annotate=(app,annotations)=>{const annotation={...defaultAnnotation(),...annotations[String(app.port)]};return {...app,originalName:app.name,name:annotation.displayName || app.name,annotation};};
export const needsAttention=app=>app.active===false ? !!app.annotation?.expectedUp : app.networkState==='unknown' || app.httpApplicable!==false && (!app.status || app.status>=500);
export function insights(apps,events,now=Date.now()) {
  const recent=events.filter(e=>new Date(e.at).getTime()>=now-86400000);
  return {issues:apps.filter(needsAttention).length,expectedDown:apps.filter(a=>a.active===false && a.annotation?.expectedUp).length,
    favorites:apps.filter(a=>a.annotation?.favorite).length,opened24h:recent.filter(e=>['opened','reopened'].includes(e.type)).length,
    closed24h:recent.filter(e=>e.type==='closed').length,failed24h:recent.filter(e=>e.type==='control_failed').length};
}
function number(value,fallback,min,max) {
  if(value===undefined)return fallback;
  if(typeof value!=='string' || !/^\d+$/.test(value))throw invalid('Port aralığı ve sayfa değerleri tam sayı olmalı.');
  const n=Number(value);if(n<min || n>max)throw invalid('Port aralığı veya sayfalama sınır dışında.');return n;
}
export function freePortQuery(query={},scope={start:1,end:65535}) {
  const start=number(query.start,scope.start,scope.start,scope.end),end=number(query.end,scope.end,scope.start,scope.end);
  if(start>end)throw invalid('Başlangıç portu bitiş portundan büyük olamaz.');
  const protocol=query.protocol || 'both';if(!['tcp','udp','both'].includes(protocol))throw invalid('TCP, UDP veya ikisini seçin.');
  if(query.excludeKnown!==undefined && !['true','false'].includes(query.excludeKnown))throw invalid('Geçersiz geçmiş filtresi.');
  return {start,end,protocol,excludeKnown:query.excludeKnown!=='false',offset:number(query.offset,0,0,65535),limit:number(query.limit,100,1,500)};
}
export function freePorts(snapshot,query={},allPages=false) {
  if(snapshot.networkOnly)throw Object.assign(new Error('Ağ taraması boş portları kesin olarak belirleyemez. UDP ve sunucu içindeki dinleyiciler için SSH erişimi gerekir.'),{status:409});
  if(!snapshot.scannedAt)throw Object.assign(new Error('Boş portlar için önce başarılı bir sunucu taraması gerekiyor.'),{status:503});
  const filters=freePortQuery(query,snapshot);
  const known=new Map(snapshot.apps.map(a=>[a.port,a]));
  const occupied=new Set();
  for(const app of snapshot.apps.filter(a=>a.active!==false)) {
    const transports=app.transports || (app.protocol==='udp'?['udp']:['tcp']);
    if(filters.protocol==='both' || transports.includes(filters.protocol))occupied.add(app.port);
  }
  const all=[];let occupiedCount=0,excludedKnown=0;
  for(let port=filters.start;port<=filters.end;port++) {
    if(occupied.has(port)){occupiedCount++;continue;}
    const app=known.get(port),previouslyUsed=!!app && app.active===false;
    if(filters.excludeKnown && previouslyUsed){excludedKnown++;continue;}
    all.push({port,previouslyUsed,previousName:previouslyUsed?app.name:null,restartable:previouslyUsed && !!app.control?.canStart,
      otherProtocol:app?.active!==false && app ? app.transports?.join(' / ').toUpperCase() || app.protocol.toUpperCase():null});
  }
  return {scannedAt:snapshot.scannedAt,host:snapshot.host,stale:!!snapshot.error || !!snapshot.pendingControlScan || !!snapshot.controlling || Date.now()-new Date(snapshot.scannedAt).getTime()>180000,
    connectionError:snapshot.error || (snapshot.pendingControlScan || snapshot.controlling?'Servis işlemi sonrasında güncel port taraması bekleniyor.':null),filters,total:all.length,occupied:occupiedCount,excludedKnown,rangeSize:filters.end-filters.start+1,
    ports:allPages?all:all.slice(filters.offset,filters.offset+filters.limit)};
}
export function csv(rows) {
  const cell=value=>{let text=value==null?'':String(value);if(/^[\s]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text))text="'"+text;return '"'+text.replaceAll('"','""')+'"';};
  return '\uFEFF'+rows.map(row=>row.map(cell).join(',')).join('\r\n')+'\r\n';
}
export function inventoryReport(snapshot) {
  return {exportedAt:new Date().toISOString(),scannedAt:snapshot.scannedAt,host:snapshot.host,hostname:snapshot.hostname,networkOnly:!!snapshot.networkOnly,coverage:snapshot.networkCoverage || null,range:{start:snapshot.start,end:snapshot.end},connectionError:snapshot.error,
    apps:snapshot.apps.map(a=>({port:a.port,name:a.name,originalName:a.originalName,active:a.active,health:a.health,status:a.status,
      transports:a.transports,addresses:a.addresses,directory:a.directory,process:a.process,pid:a.pid,firstSeen:a.firstSeen,lastSeen:a.lastSeen,closedAt:a.closedAt,
      favorite:a.annotation?.favorite || false,expectedUp:a.annotation?.expectedUp || false,tags:a.annotation?.tags || [],note:a.annotation?.note || ''}))};
}
export function inventoryCsv(report) {
  return csv([['Sunucu','Son tarama','Port','Uygulama','Durum','HTTP','Protokol','Adresler','Dizin','PID','Favori','Sürekli çalışmalı','Etiketler','Port notu'],
    ...report.apps.map(a=>[report.host,report.scannedAt,a.port,a.name,a.health,a.status,a.transports?.join(' / '),a.addresses?.join(' / '),a.directory,a.pid,a.favorite?'Evet':'Hayır',a.expectedUp?'Evet':'Hayır',a.tags.join(' / '),a.note])]);
}
