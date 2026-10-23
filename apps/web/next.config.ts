import type { NextConfig } from 'next';
const config: NextConfig = { devIndicators: false, serverExternalPackages: ['pg','pdf-parse','tesseract.js','@tesseract.js-data/kor','@tesseract.js-data/eng'], poweredByHeader: false, experimental: { serverActions: { bodySizeLimit: '22mb' } }, async headers() { return [{ source: '/(.*)', headers: [{key:'X-Content-Type-Options',value:'nosniff'},{key:'Referrer-Policy',value:'same-origin'},{key:'X-Frame-Options',value:'DENY'}] }, { source: '/api/(.*)', headers: [{key:'Cache-Control',value:'private, no-store'}] }]; } };
export default async function nextConfig() {
  const { loadProjectEnv } = await import('../../scripts/load-env.mjs');
  loadProjectEnv();
  return config;
}
