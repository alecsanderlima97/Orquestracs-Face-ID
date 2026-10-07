import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["pdf-parse", "pdfjs-dist", "@napi-rs/canvas"],
  outputFileTracingIncludes: {
    "/api/holerite/parse": ["node_modules/@napi-rs/canvas*/**/*"],
  },
};

export default nextConfig;
