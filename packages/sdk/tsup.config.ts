// FILE: packages/sdk/tsup.config.ts
//
// tsup bundles our TypeScript source into distributable JavaScript.
//
// We run TWO separate builds (an array config) so the `"use client"` directive
// lands ONLY on the React entry, not on the server-safe one — tsup's `banner`
// is per-build:
//   • build 1 → "bhasha-js"        (provider, hooks, components + utils) with
//                the "use client" directive, so it imports cleanly into a
//                Next.js App Router app (app/layout.tsx etc.).
//   • build 2 → "bhasha-js/server" (pure, React-free utilities) with NO
//                directive, safe to import inside React Server Components / Node.
//
// Each build emits ESM (.mjs), CJS (.js), and .d.ts declarations.

import { defineConfig } from "tsup";

const shared = {
  format: ["esm", "cjs"] as const,
  dts: true,
  sourcemap: true,
  splitting: false,
  // React is a peer dependency — never bundle it into our package.
  external: ["react", "react-dom"],
};

export default defineConfig([
  {
    ...shared,
    entry: { index: "src/index.ts" },
    clean: true,
    // Mark the whole client bundle as a Client Component boundary so a
    // Next.js Server Component can import the provider/hooks without the
    // "needs useState / only works in a Client Component" build error.
    banner: { js: '"use client";' },
  },
  {
    ...shared,
    // Server-safe utils + the framework-agnostic engine. No "use client"
    // banner — both are React-free and run anywhere (RSC, Node, Vue, Svelte…).
    entry: { server: "src/server.ts", vanilla: "src/vanilla.ts" },
    // Don't wipe the client build that ran first.
    clean: false,
  },
  {
    // The `bhasha` CLI — a Node program, not part of the library API. CJS with
    // a shebang so it runs directly; no type declarations needed for a bin.
    entry: { cli: "src/cli.ts" },
    format: ["cjs"],
    platform: "node",
    clean: false,
    dts: false,
    sourcemap: false,
    splitting: false,
    banner: { js: "#!/usr/bin/env node" },
    external: ["react", "react-dom"],
  },
]);
