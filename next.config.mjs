import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */

// GitHub Pages serves this repo at https://<user>.github.io/wired-future/
// so every asset URL needs the /wired-future prefix in production.
// Override with NEXT_PUBLIC_BASE_PATH="" when hosting at a domain root.
const rawBasePath =
  process.env.NEXT_PUBLIC_BASE_PATH ??
  (process.env.NODE_ENV === 'production' ? '/wired-future' : '');

const basePath = rawBasePath === '/' ? '' : rawBasePath;

const nextConfig = {
  // A stray pnpm-lock.yaml in the user profile makes Next infer C:\Users\<user>
  // as the workspace root, which drags the whole home directory into file
  // tracing. Pin it to this project.
  outputFileTracingRoot: projectRoot,

  // Builds run with NEXT_DIST_DIR=out; dev leaves it unset and keeps .next.
  // Two reasons: `npm run build` while `npm run dev` is live must not wipe the
  // dev server's chunks (it did, twice), and with output:'export' the static
  // export is written INTO distDir - so pointing it at out/ is also what puts
  // the deployable files where the GitHub Action expects them.
  distDir: process.env.NEXT_DIST_DIR || '.next',

  // Client code needs the same prefix to build /models/*.glb URLs. Without
  // this the var is undefined in the browser whenever the fallback above
  // supplied the basePath, and the car 404s on GitHub Pages.
  env: {
    NEXT_PUBLIC_BASE_PATH: basePath,
    NEXT_PUBLIC_ORIGIN_TRIAL_TOKEN:
      process.env.NEXT_PUBLIC_ORIGIN_TRIAL_TOKEN || '',
  },

  output: 'export',
  basePath,
  assetPrefix: basePath || undefined,
  trailingSlash: true,
  images: { unoptimized: true },
  reactStrictMode: true,

  webpack: (config) => {
    // transformers.js ships both onnxruntime-node and onnxruntime-web. This is
    // a browser-only static export, so stub the node build out - otherwise
    // webpack tries to bundle native .node bindings and the build fails.
    config.resolve.alias = {
      ...config.resolve.alias,
      'onnxruntime-node$': false,
      sharp$: false,
    };

    // MediaPipe's vision bundle resolves its WASM loader through a computed
    // require, which webpack cannot follow and reports as a critical
    // dependency. It is not one: the loader is fetched at runtime from the CDN
    // root passed to FilesetResolver.forVisionTasks, never bundled.
    config.ignoreWarnings = [
      ...(config.ignoreWarnings ?? []),
      {
        module: /@mediapipe[\/]tasks-vision/,
        message: /Critical dependency: the request of a dependency is an expression/,
      },
    ];
    return config;
  },
};

export default nextConfig;
