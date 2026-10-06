export type ServerService = {name:string;displayName:string;description:string;state:string;subState:string;startup:string;pid:number|null;token:string|null;actions:string[];reason:string;dependencies:string[];dependents:string[];canLogs:boolean;lab:boolean};
export type ServiceSort = 'name'|'displayName'|'state'|'startup'|'pid';
export const serviceLabels:Record<string,string> = {start:'Başlat',stop:'Durdur',restart:'Yeniden başlat',enable:'Otomatik başlatmayı aç',disable:'Otomatik başlatmayı kapat',automatic:'Otomatik',manual:'Elle',disabled:'Devre dışı'};
export function serviceStatus(value:string) {return ({running:'Çalışıyor',active:'Çalışıyor',stopped:'Durmuş',inactive:'Durmuş',failed:'Hata',paused:'Duraklatılmış',unknown:'Bilinmiyor'} as Record<string,string>)[value.toLowerCase()]||value;}
export function filterServices(rows:ServerService[],query:string,status:string,sort:ServiceSort,descending:boolean) {
  const terms=query.toLocaleLowerCase('tr-TR').trim().split(/\s+/).filter(Boolean);
  return rows.filter(row=>terms.every(term=>`${row.name} ${row.displayName} ${row.state} ${serviceStatus(row.state)}`.toLocaleLowerCase('tr-TR').includes(term))&&(status==='all'||status==='readonly'&&!row.actions.length||status==='running'&&['active','running'].includes(row.state.toLowerCase())||status==='stopped'&&['inactive','stopped'].includes(row.state.toLowerCase())||status==='failed'&&row.state==='failed')).sort((a,b)=>{
    const left=a[sort],right=b[sort];if(left===null)return right===null?a.name.localeCompare(b.name):1;if(right===null)return -1;
    const order=typeof left==='number'&&typeof right==='number'?left-right:String(left).localeCompare(String(right),'tr');return (descending?-order:order)||a.name.localeCompare(b.name);
  });
}
