/** @type {import('next').NextConfig} */
const nextConfig = {
  // React <Activity> route caching — the production amplifier. The crash does NOT
  // require it (the GC strip is the root cause; see store-repro.cjs), but in the
  // real app cacheComponents keeps the consuming subtree mounted while its owner
  // query's retention is released, which is how the strip lands on a *live*
  // fragment and turns a transient navigation into a permanent, restart-only crash.
  cacheComponents: true,
  compiler: {
    relay: {
      src: "./",
      language: "typescript",
      eagerEsModules: true,
      artifactDirectory: "./__generated__",
    },
  },
};

export default nextConfig;
