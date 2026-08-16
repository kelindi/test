import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@internal/core'],
};

export default nextConfig;
