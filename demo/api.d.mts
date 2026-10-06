export type DemoController = { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>; reset(): void };
export function createDemoController(options?: { origin?: string; now?: () => string }): DemoController;
export function demoFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
export function demoPreviewUrl(serverId: string, port: string | number): string;
