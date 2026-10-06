'use client';
import { Play, RotateCw, ShieldCheck, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { App, ControlAction, Inventory } from './types';

export const canManage=(app:App)=>!!(app.control?.canStart || app.control?.canStop || app.control?.canRestart);
export const actionText:Record<ControlAction,string>={start:'Başlat',stop:'Durdur',restart:'Yeniden başlat'};
export const actionTitle:Record<ControlAction,string>={start:'Uygulamayı başlat',stop:'Uygulamayı durdur',restart:'Uygulamayı yeniden başlat'};
export const actionAllowed=(app:App,action:ControlAction)=>action==='start'?!!app.control?.canStart:action==='stop'?!!app.control?.canStop:!!app.control?.canRestart;

export default function ControlActions({app,inventory,busy,onAction}:{app:App;inventory:Inventory|null;busy:boolean;onAction:(app:App,action:ControlAction)=>void}) {
  const changing=inventory?.controlling?.port===app.port;
  const locked=busy || !!inventory?.controlling || !!inventory?.scanning;
  const reason=inventory?.controlling?'Bir servis işlemi sürüyor.':inventory?.scanning?'Port taraması sürüyor; işlem seçenekleri tarama bitince etkinleşir.':app.control?.reason;
  return <div className="app-controls lifecycle-actions"><div className="lifecycle-heading"><span>Uygulama işlemleri</span>{changing && <strong>İşlem sürüyor…</strong>}</div><div className="lifecycle-buttons">{([{action:'start',icon:Play},{action:'stop',icon:Square},{action:'restart',icon:RotateCw}] as const).map(({action,icon:Icon})=><Button key={action} variant="outline" className={`lifecycle-${action}`} disabled={locked || !actionAllowed(app,action)} title={reason || (!actionAllowed(app,action)?action==='start'?'Uygulama zaten çalışıyor.':'Bu işlem için uygulama çalışıyor olmalı.':`${app.name} · ${actionText[action]}`)} onClick={()=>onAction(app,action)} aria-label={`:${app.port} ${actionTitle[action].toLocaleLowerCase('tr-TR')}`}><Icon size={15} className={changing && inventory?.controlling?.action===action?'spin':''}/>{actionText[action]}</Button>)}</div>{reason && <span className="control-reason"><ShieldCheck size={13}/>{reason}</span>}</div>;
}
