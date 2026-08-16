import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@internal/core'],
  eslint: {
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
