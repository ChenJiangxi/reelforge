import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained build output: rsync .next/standalone + .next/static to the
  // server and run `node server.js` — zero install/build on the 1.6G box.
  output: "standalone",
};

export default nextConfig;
