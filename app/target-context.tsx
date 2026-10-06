'use client';
import { createContext, useContext, useMemo } from 'react';
import { api as globalApi, downloadReport as download } from './api';
import { DEMO_MODE } from '@/lib/public-mode';
import { demoPreviewUrl } from '../demo/fixtures.mjs';

export function targetClient(id:string) {
  const prefix=`/servers/${encodeURIComponent(id)}`;
  return {id,url:(path:string)=>DEMO_MODE && /^\/previews\/\d+/.test(path) ? demoPreviewUrl(id, Number(/^\/previews\/(\d+)/.exec(path)![1])) : `/api${prefix}${path}`,
    api:<T=Record<string,unknown>,>(path:string,options?:RequestInit)=>globalApi<T>(['/session','/login','/logout','/servers','/servers/discover'].includes(path)?path:prefix+path,options),
    downloadReport:(path:string)=>download(path,`/api${prefix}/reports/`)};
}
const defaultClient=targetClient('none');
const TargetContext=createContext(defaultClient);
export function TargetProvider({id,children}:{id:string;children:React.ReactNode}) {
  const client=useMemo(()=>targetClient(id),[id]);
  return <TargetContext.Provider value={client}>{children}</TargetContext.Provider>;
}
export const useTarget=()=>useContext(TargetContext);
