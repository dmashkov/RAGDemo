/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: { /* ... */ },
  webpack: (config) => {
    config.resolve = config.resolve || {};
    config.resolve.alias = {
      ...(config.resolve.alias || {}),
      canvas: false, // чтобы pdfjs не тянул node-canvas
    };
    return config;
  },
};
export default nextConfig;
