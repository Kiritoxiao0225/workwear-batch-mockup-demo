import type { NextConfig } from 'next';
const config: NextConfig = { serverExternalPackages: ['@napi-rs/canvas', 'sharp', 'postgres'], agentRules: false };
export default config;
