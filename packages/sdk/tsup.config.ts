// FILE: packages/sdk/tsup.config.ts
//
// tsup is the bundler that turns our TypeScript source into
// distributable JavaScript. It creates three outputs:
//   1. dist/index.js    — ES Modules (for modern bundlers like Vite/webpack)
//   2. dist/index.cjs   — CommonJS (for older Node.js require() usage)
//   3. dist/index.d.ts  — TypeScript type declarations

import { defineConfig } from "tsup";

export default defineConfig({
  // Entry point — tsup starts here and follows all imports
  entry: ["src/index.ts"],

  // Output both ESM and CJS formats so the package works everywhere
  format: ["esm", "cjs"],

  // Generate .d.ts type declaration files
  dts: true,

  // Split code into chunks for better tree-shaking
  splitting: true,

  // Generate sourcemaps for debugging
  sourcemap: true,

  // Clean the dist folder before each build
  clean: true,

  // React is a peer dependency — don't bundle it into our package
  // The user's app already has React, so we just reference it
  external: ["react", "react-dom"],
});
