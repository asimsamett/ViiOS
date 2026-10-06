/** Build-time flags. Normal controller builds always use the authenticated API. */
export const DEMO_MODE = process.env.NEXT_PUBLIC_VIIOS_DEMO === 'true';
export const PUBLIC_BASE_PATH = DEMO_MODE ? (process.env.NEXT_PUBLIC_VIIOS_BASE_PATH || '') : '';
export const publicAsset = (path: string) => `${PUBLIC_BASE_PATH}${path}`;
