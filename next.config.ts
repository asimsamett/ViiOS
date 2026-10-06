import type { NextConfig } from 'next';

const demo = process.env.NEXT_PUBLIC_VIIOS_DEMO === 'true';
const nextConfig: NextConfig = {
  output: 'export',
  ...(demo ? { basePath: process.env.NEXT_PUBLIC_VIIOS_BASE_PATH || '', trailingSlash: true } : {}),
};

export default nextConfig;
