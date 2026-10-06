export type Control = {canStop:boolean;canStart:boolean;canRestart?:boolean;active?:boolean;kind?:string;label?:string;unit?:string;reason?:string;affectedPorts?:number[];token?:string};

export type App = { modelConnections?: ModelConnection[]; modelDiscovery?: ModelDiscovery; project?:ProjectInfo;serviceName?:string;filesPath?:string|null;entry?:string; networkState?:"open"|"unknown"|"closed"; originalName?:string; annotation?:Annotation; control?: Control; port: number; name: string; title: string; directory: string; process: string; pid: number | null; addresses: string[]; internal: boolean; protocol: string; path: string; status: number | null; latency: number; kind: 'web' | 'api' | 'service'; httpApplicable?: boolean; transports?: string[]; listeners?: {transport:string;address:string;pid:number;process:string}[]; active?: boolean; health?: string; firstSeen?: string; lastSeen?: string; closedAt?: string; error?: string; previewAt?: string; previewError?: string; openUrl?: string; tlsUnverified?: boolean };
export type Inventory = { serverId?:string;stale?:boolean;networkOnly?:boolean;networkAutoFull?:boolean;networkProgress?:{checked:number;total:number}|null;networkCoverage?:{fullScannedAt?:string}|null; pendingControlScan?:boolean; insights?:{issues:number;expectedDown:number;favorites:number;opened24h:number;closed24h:number;failed24h:number}; controlling?: {port:number;action:string} | null; controlError?:string; apps: App[]; scannedAt: string | null; scanning: boolean; capturing: boolean; error: string | null; previewError: string | null; host: string; hostname: string; mode: string; start: number; end: number; unread: number; nextAuditAt: string; lastDailyAuditDay: string };

export type Annotation={displayName:string;note:string;favorite:boolean;expectedUp:boolean;tags:string[];revision:number;updatedAt?:string};

export type ControlAction='start'|'stop'|'restart';

export type ProjectRelationship={kind:'configured'|'directory';label:string;description:string};
export type ProjectInfo={id:string;name:string;directory:string|null;primaryPort?:number;system:boolean;parent?:ProjectInfo;relationship?:ProjectRelationship};

export type ModelEvidence = {kind:'process'|'config'|'source';key:string;file?:string;line?:number};
export type ModelConnection = {endpoint:string;model:string|null;role:string;scope:'process'|'project';evidence:ModelEvidence[]};
export type ModelDiscovery = {checkedAt?:string;status:'found'|'not-found'|'partial'|'unavailable'};
