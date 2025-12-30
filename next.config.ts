import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // ESLint and TypeScript errors are now enforced during builds
  // Run `npm run lint` and `npx tsc --noEmit` locally before pushing
  allowedDevOrigins: ['localhost'],
  output: 'standalone',
  images: {
    domains: ['localhost'],
    // Add production domains as needed
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '*.amazonaws.com',
      },
      {
        protocol: 'https',
        hostname: '*.cloudfront.net',
      },
    ],
  },
  experimental: {
    serverActions: {
      // Large body size needed for drone image uploads
      // Rate limiting and auth protect against abuse
      bodySizeLimit: '100mb',
    },
  },
};

export default nextConfig;
