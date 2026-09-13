import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained build output: rsync .next/standalone + .next/static to the
  // server and run `node server.js` — zero install/build on the 1.6G box.
  output: "standalone",
  // worker 上传成片/webm 动辄 15-40MB,默认 10MB 会被截断成坏 multipart
  experimental: { proxyClientMaxBodySize: "512mb" },
};

export default nextConfig;
