export const DEMO_SERVER_IDS: readonly ['demo-linux', 'demo-windows'];
export const DEMO_NOTICE: string;
export function demoPreviewUrl(serverId: string, port: string | number): string;
export function demoPreviewSvg(serverId: string, port: string | number): string;
