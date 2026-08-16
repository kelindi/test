import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@internal/core', '@internal/ui'],
};

export default nextConfig;
