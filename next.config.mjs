// next.config.mjs
/** @type {import('next').NextConfig} */
const nextConfig = {
  // experimental: { serverActions: undefined }, // можно удалить опцию совсем
  webpack: (config) => {
    config.resolve = config.resolve || {};
    config.resolve.alias = {
      ...(config.resolve.alias || {}),
      canvas: false, // важно для pdfjs-dist в Node/SSR
    };
    return config;
  },
};
export default nextConfig;
