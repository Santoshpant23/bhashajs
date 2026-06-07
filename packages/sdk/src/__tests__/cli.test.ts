import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

// Behavioral tests for the built CLI (dist/cli.js). Requires `npm run build`
// first (CI builds the SDK before testing); skipped if the artifact is absent.
const CLI = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
const built = existsSync(CLI);

function run(cwd: string, args: string[]) {
  return execFileSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
}

function tmp() {
  return mkdtempSync(join(tmpdir(), "bhasha-cli-"));
}

describe.skipIf(!built)("bhasha CLI (dist/cli.js)", () => {
  it("init + pull --local generates type-safe keys AND wires tsconfig", () => {
    const dir = tmp();
    try {
      writeFileSync(
        join(dir, "tsconfig.json"),
        JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] })
      );
      run(dir, ["init"]); // scaffolds bhasha.config.json + locales/en.json
      writeFileSync(
        join(dir, "locales", "en.json"),
        JSON.stringify({ "cart.checkout": "Checkout", greeting: "Hi {name}" })
      );

      const out = run(dir, ["pull", "--local"]);
      expect(out).toContain("type-safe keys");

      const dts = readFileSync(join(dir, "bhasha-keys.d.ts"), "utf8");
      expect(dts).toContain('"cart.checkout": string');
      expect(dts).toContain('"greeting": string');

      // The generated .d.ts must be wired into tsconfig "include" or it's a no-op.
      const tsconfig = JSON.parse(readFileSync(join(dir, "tsconfig.json"), "utf8"));
      expect(tsconfig.include).toContain("bhasha-keys.d.ts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("scan --strict exits non-zero when a used key is missing from locales", () => {
    const dir = tmp();
    try {
      run(dir, ["init"]); // locales/en.json gets the stub keys (hero.title, greeting)
      mkdirSync(join(dir, "src"));
      writeFileSync(join(dir, "src", "App.tsx"), "export const X = () => t('definitely.missing');\n");

      let code = 0;
      try {
        run(dir, ["scan", "--strict"]);
      } catch (e: any) {
        code = e.status ?? 1;
      }
      expect(code).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
