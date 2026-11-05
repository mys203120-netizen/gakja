import type { NextConfig } from 'next';
import path from 'node:path';

const port = Number(process.env.REALTIME_PORT || 3001);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('REALTIME_PORT must be between 1024 and 65535');
const nextConfig: NextConfig = {
  outputFileTracingRoot: process.cwd(),
  poweredByHeader: false,
  devIndicators: false,
  webpack(config) {
    // vad-web is CommonJS; select ORT's browser ESM WASM entry explicitly so
    // webpack does not include its Node-only dynamic require branches.
    const browserOrt = path.join(process.cwd(), 'node_modules/onnxruntime-web/dist/ort.wasm.min.mjs');
    config.resolve.alias = { ...config.resolve.alias, 'onnxruntime-web/wasm$': browserOrt, 'onnxruntime-web$': browserOrt };
    return config;
  },
  async rewrites() {
    return [{ source: '/api/:path*', destination: `http://127.0.0.1:${port}/api/:path*` }];
  },
  async headers() {
    return [{ source: '/:path*', headers: [
      { key: 'Referrer-Policy', value: 'no-referrer' },
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Permissions-Policy', value: 'camera=(self), microphone=(self), fullscreen=(self)' }
    ] }];
  }
};
export default nextConfig;
