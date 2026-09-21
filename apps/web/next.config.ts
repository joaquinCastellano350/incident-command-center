import type { NextConfig } from 'next';
import { z } from 'zod';

const environment = z
  .object({
    API_INTERNAL_BASE_URL: z.url().default('http://localhost:3001'),
    PUBLIC_API_BASE_URL: z.url().default('http://localhost:3001'),
  })
  .parse(process.env);

process.env.API_INTERNAL_BASE_URL = environment.API_INTERNAL_BASE_URL;
process.env.PUBLIC_API_BASE_URL = environment.PUBLIC_API_BASE_URL;

const nextConfig: NextConfig = {
  output: 'standalone',
};

export default nextConfig;
