import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Mark pdf-parse + pdfjs-dist as external in server builds so Next /
  // Turbopack doesn't bundle them. They contain dynamic import paths
  // for their Web Worker that the bundler rewrites incorrectly,
  // breaking server-side PDF text extraction in /api/webhooks/inbound-bill.
  // Letting Node resolve them at runtime fixes the worker lookup.
  serverExternalPackages: ['pdf-parse', 'pdfjs-dist'],
};

export default nextConfig;
