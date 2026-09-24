import type { NextConfig } from 'next';

const meituRuntime = [
  './node_modules/meitu-cli/**', './node_modules/@aws-sdk/**', './node_modules/@smithy/**',
  './node_modules/@aws/lambda-invoke-store/**', './node_modules/bowser/**', './node_modules/commander/**',
  './node_modules/mime-db/**', './node_modules/mime-types/**', './node_modules/tslib/**', './node_modules/yaml/**',
];

const nextConfig: NextConfig = {
  distDir: process.env.CATALOG_NEXT_DIST_DIR || '.next',
  serverExternalPackages: ['ali-oss', 'meitu-cli', '@napi-rs/canvas'],
  // The Meitu CLI loads obfuscated runtime dependencies through computed require paths.
  outputFileTracingIncludes: {
    '/api/batch/*': ['./lib/artwork-preview-tone.mjs', './batch-mockup/experiments/workbench/**', './batch-mockup/application/repair-pixels.mjs', './public/brand/ant-shirt/**'],
    '/api/wps-production/*': meituRuntime,
    // The garment cutout falls back to the same Meitu SDK.
    '/api/garment-mockup/*': meituRuntime,
  },
  agentRules: false,
  turbopack: {
    resolveAlias: {
      fs: { browser: './lib/browser-empty-module.ts' },
      path: { browser: './lib/browser-empty-module.ts' },
      'ort.bundle.min.mjs': {
        browser: './node_modules/onnxruntime-web/dist/ort.bundle.min.mjs',
      },
    },
  },
  images: {
    unoptimized: true,
  },
  async headers() {
    return [{
      source: '/ocr-models/:path*',
      headers: [{
        key: 'Cache-Control',
        value: 'public, max-age=31536000, immutable',
      }],
    }];
  },
};

export default nextConfig;
