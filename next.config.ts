import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  distDir: process.env.CATALOG_NEXT_DIST_DIR || '.next',
  serverExternalPackages: ['ali-oss', 'meitu-cli', '@napi-rs/canvas'],
  // Files the batch route reads from disk at runtime; tracing cannot see them.
  outputFileTracingIncludes: {
    '/api/batch/*': ['./lib/artwork-preview-tone.mjs', './batch-mockup/experiments/workbench/**', './batch-mockup/application/repair-pixels.mjs', './public/brand/ant-shirt/**'],
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
  poweredByHeader: false,
  async headers() {
    return [{
      // Framing stays same-origin only: /artwork-studio embeds /api/batch/saas-editors. A full CSP
      // waits until the OCR CDN and signed OSS/R2 image hosts are listed.
      source: '/:path*',
      headers: [
        { key: 'Strict-Transport-Security', value: 'max-age=31536000' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
        { key: 'Content-Security-Policy', value: "frame-ancestors 'self'" },
      ],
    }, {
      source: '/ocr-models/:path*',
      headers: [{
        key: 'Cache-Control',
        value: 'public, max-age=31536000, immutable',
      }],
    }];
  },
};

export default nextConfig;
