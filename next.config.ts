import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // discord.js (and its native deps like zlib-sync, bufferutil, utf-8-validate)
  // ship C++ .node addons that Turbopack cannot place in ESM chunks. Marking
  // them as server-external packages tells Next.js to require() them at runtime
  // instead of bundling them — which is the only way discord.js works anyway.
  serverExternalPackages: [
    'discord.js',
    '@discordjs/ws',
    '@discordjs/collection',
    'zlib-sync',
    'bufferutil',
    'utf-8-validate',
    '@prisma/client',
    '@node-rs/argon2',
    'bcryptjs',
  ],
};

export default nextConfig;
