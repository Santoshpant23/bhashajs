// FILE: packages/sdk/src/cli.ts
//
// The `bhasha` CLI. Built as its own bundle (dist/cli.js) with a Node shebang.
//
//   bhasha init   — scaffold bhasha.config.json + a locales/ folder
//   bhasha pull   — read your keys (local JSON or the hosted API) and generate
//                   a typed declaration file so t()/<Trans> autocomplete and
//                   error on a typo'd or missing key
//   bhasha scan   — find t('...') / <Trans id="..."> keys in your source and
//                   report which are missing from / unused in your locales
//
// Zero runtime dependencies — only Node built-ins + global fetch (Node 18+).

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, extname, basename } from "node:path";

const CONFIG_FILE = "bhasha.config.json";
const DEFAULTS = {
  projectKey: "",
  apiUrl: "https://api.bhashajs.com/api",
  sourceLang: "en",
  localesDir: "locales",
  out: "bhasha-keys.d.ts",
  src: "src",
};

type Config = typeof DEFAULTS;
type FlatBundle = {
  flat: Record<string, string>;
  skipped: string[];
};

// ─── tiny output helpers (no color deps) ───────────────────────────
const log = (m: string) => process.stdout.write(m + "\n");
const err = (m: string) => process.stderr.write(m + "\n");
function die(m: string): never {
  err("✗ " + m);
  process.exit(1);
}

// ─── arg parsing ───────────────────────────────────────────────────
function parseFlags(args: string[]): Record<string, string | boolean> {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return flags;
}

function loadConfig(flags: Record<string, string | boolean>): Config {
  let fileCfg: Partial<Config> = {};
  if (existsSync(CONFIG_FILE)) {
    try {
      fileCfg = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
    } catch {
      die(`${CONFIG_FILE} is not valid JSON.`);
    }
  }
  return {
    ...DEFAULTS,
    ...fileCfg,
    // CLI flags win over the config file. Only string-valued flags override a
    // path/value — a bare boolean flag (e.g. `--out` with no argument) must not
    // coerce to the literal string "true" and silently write a file named true.
    ...(typeof flags["project-key"] === "string" ? { projectKey: flags["project-key"] } : {}),
    ...(typeof flags["api-url"] === "string" ? { apiUrl: flags["api-url"] } : {}),
    ...(typeof flags["source-lang"] === "string" ? { sourceLang: flags["source-lang"] } : {}),
    ...(typeof flags["locales-dir"] === "string" ? { localesDir: flags["locales-dir"] } : {}),
    ...(typeof flags["out"] === "string" ? { out: flags["out"] } : {}),
    ...(typeof flags["src"] === "string" ? { src: flags["src"] } : {}),
  };
}

// ─── key extraction from JSON bundles ──────────────────────────────
const REGISTER_NAMES = new Set(["default", "formal", "casual"]);
const MAX_FLATTEN_DEPTH = 8;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function flattenBundle(obj: unknown): FlatBundle {
  const flat: Record<string, string> = Object.create(null);
  const skipped: string[] = [];

  function walk(value: unknown, path: string[]) {
    if (!isPlainObject(value)) {
      if (path.length > 0) skipped.push(path.join("."));
      return;
    }
    for (const [segment, child] of Object.entries(value)) {
      const nextPath = [...path, segment];
      const dotted = nextPath.join(".");
      if (nextPath.length > MAX_FLATTEN_DEPTH) {
        skipped.push(dotted);
      } else if (typeof child === "string") {
        flat[dotted] = child;
      } else if (isPlainObject(child)) {
        walk(child, nextPath);
      } else {
        skipped.push(dotted);
      }
    }
  }

  walk(obj, []);
  return { flat, skipped };
}

// A locale file is either flat ({ "hero.title": "..." }) or register-nested
// ({ "hero.title": { "default": "..." } }). In both, the translation KEY is
// the top-level property, so Object.keys is what we want — UNLESS the bundle is
// itself a bare register map ({ "default": {...}, "casual": {...} }), which
// would yield bogus keys like ["default","casual"]. Guard against that shape.
export function keysFromBundle(obj: unknown): string[] {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return [];
  const names = Object.keys(obj as Record<string, unknown>);
  if (names.length > 0 && names.every((k) => REGISTER_NAMES.has(k))) {
    err(
      `! locale bundle looks like a bare register map (${names.join(", ")}) — ` +
        `expected translation keys at the top level; skipping.`
    );
    return [];
  }
  return Object.keys(flattenBundle(obj).flat);
}

function collectLocalKeys(cfg: Config): string[] {
  if (!existsSync(cfg.localesDir)) {
    die(
      `No locales directory "${cfg.localesDir}". Run \`bhasha init\` first, ` +
        `or pass --remote to pull keys from the hosted API.`
    );
  }
  const files = readdirSync(cfg.localesDir).filter((f) => f.endsWith(".json"));
  if (files.length === 0) {
    die(`No .json locale files in "${cfg.localesDir}".`);
  }
  const keys = new Set<string>();
  for (const f of files) {
    try {
      const data = JSON.parse(readFileSync(join(cfg.localesDir, f), "utf8"));
      keysFromBundle(data).forEach((k) => keys.add(k));
    } catch {
      err(`! skipping ${f} (not valid JSON)`);
    }
  }
  return [...keys];
}

async function collectRemoteKeys(cfg: Config): Promise<string[]> {
  if (typeof fetch === "undefined") {
    die("Remote pull needs Node 18+ (global fetch is missing).");
  }
  if (!cfg.projectKey) {
    die("Remote pull needs a projectKey (set it in bhasha.config.json or pass --project-key).");
  }
  const url = `${cfg.apiUrl}/sdk/translations?lang=${encodeURIComponent(
    cfg.sourceLang
  )}&register=default`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { "x-api-key": cfg.projectKey } });
  } catch (e: any) {
    return die(`Could not reach ${cfg.apiUrl}: ${e?.message || e}`);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return die(`API returned HTTP ${res.status}${detail ? ": " + detail : ""}`);
  }
  const json: any = await res.json();
  return keysFromBundle(json?.data ?? json);
}

// ─── codegen ───────────────────────────────────────────────────────
function generateDts(keys: string[]): string {
  const sorted = [...new Set(keys)].sort();
  const lines = sorted.map((k) => `    ${JSON.stringify(k)}: string;`).join("\n");
  return `// AUTO-GENERATED by \`bhasha pull\` — do not edit by hand.
// Re-run \`npx bhasha pull\` whenever your keys change. (${sorted.length} keys)
import "bhasha-js";

declare module "bhasha-js" {
  interface BhashaKeyRegistry {
${lines}
  }
}
`;
}

// ─── source scanning ───────────────────────────────────────────────
const SCAN_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".astro"]);
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git", ".next", "coverage"]);

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) walk(full, out);
    else if (SCAN_EXTS.has(extname(name))) out.push(full);
  }
  return out;
}

function keysUsedInSource(srcDir: string): Set<string> {
  const used = new Set<string>();
  // t('key') / t("key") / t(`key`)  and  <Trans id="key">
  // The negative lookbehind keeps a standalone `t(` while skipping method calls
  // like `obj.t(` and identifiers ending in t (`format(`), reducing false hits.
  const tCall = /(?<![\w.])t\(\s*['"`]([^'"`]+)['"`]/g;
  const transId = /<Trans\b[^>]*\bid=\s*['"]([^'"]+)['"]/g;
  for (const file of walk(srcDir)) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    let m: RegExpExecArray | null;
    while ((m = tCall.exec(text))) used.add(m[1]);
    while ((m = transId.exec(text))) used.add(m[1]);
  }
  return used;
}

// ─── commands ──────────────────────────────────────────────────────
function cmdInit(cfg: Config) {
  if (existsSync(CONFIG_FILE)) {
    err(`! ${CONFIG_FILE} already exists — leaving it untouched.`);
  } else {
    const seed = {
      projectKey: "",
      apiUrl: DEFAULTS.apiUrl,
      sourceLang: DEFAULTS.sourceLang,
      localesDir: DEFAULTS.localesDir,
      out: DEFAULTS.out,
      src: DEFAULTS.src,
    };
    writeFileSync(CONFIG_FILE, JSON.stringify(seed, null, 2) + "\n");
    log(`✓ wrote ${CONFIG_FILE}`);
  }

  if (!existsSync(cfg.localesDir)) mkdirSync(cfg.localesDir, { recursive: true });
  const sample = join(cfg.localesDir, `${cfg.sourceLang}.json`);
  if (!existsSync(sample)) {
    writeFileSync(
      sample,
      JSON.stringify(
        { "hero.title": "Welcome", "greeting": "Hello {name}" },
        null,
        2
      ) + "\n"
    );
    log(`✓ wrote ${sample}`);
  }

  log("");
  log("Next:");
  log("  1. Add your keys to the locale file(s) — or set projectKey to pull from the hosted API.");
  log("  2. Run `npx bhasha pull` to generate type-safe keys.");
  log("     (pull wires the generated .d.ts into your tsconfig automatically.)");
}

async function cmdPull(cfg: Config, flags: Record<string, string | boolean>) {
  // Decide the key source. `--remote`/`--local` win explicitly. Otherwise,
  // default to the hosted API whenever a projectKey is configured — the local
  // locales/ that `init` scaffolds is just a starter stub, NOT the source of
  // truth, so the old `!existsSync(localesDir)` heuristic (which init always
  // makes false) silently pulled the 2-key stub for every hosted user.
  const wantsLocal = flags["local"] === true;
  const wantsRemote = flags["remote"] === true;
  const remote = wantsRemote || (!wantsLocal && !!cfg.projectKey);
  if (!remote && cfg.projectKey && !wantsLocal) {
    err("! a projectKey is set but pulling from local files — pass --remote to pull from the hosted API.");
  }

  const keys = remote ? await collectRemoteKeys(cfg) : collectLocalKeys(cfg);
  if (keys.length === 0) die("No keys found.");
  writeFileSync(cfg.out, generateDts(keys));
  log(`✓ ${cfg.out} — ${keys.length} type-safe keys (${remote ? "remote" : "local"} source)`);
  log(`  t() and <Trans> now autocomplete and error on a typo'd key.`);

  // The generated declaration only takes effect if TypeScript actually compiles
  // it — wire it into tsconfig (or tell the user exactly how to).
  wireTsconfig(cfg.out);
}

function localeFilesForPush(cfg: Config, flags: Record<string, string | boolean>): string[] {
  if (!existsSync(cfg.localesDir)) {
    die(`No locales directory "${cfg.localesDir}". Run \`bhasha init\` first.`);
  }
  const lang = flags["lang"];
  if (typeof lang === "string") {
    const file = join(cfg.localesDir, `${lang}.json`);
    if (!existsSync(file)) die(`Missing locale file: ${file}`);
    return [file];
  }
  const files = readdirSync(cfg.localesDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => join(cfg.localesDir, f));
  if (files.length === 0) die(`No .json locale files in "${cfg.localesDir}".`);
  return files;
}

function readFlatLocale(file: string): FlatBundle {
  try {
    return flattenBundle(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    die(`${file} is not valid JSON.`);
  }
}

async function cmdPush(cfg: Config, flags: Record<string, string | boolean>) {
  if (typeof fetch === "undefined") {
    die("Push needs Node 18+ (global fetch is missing).");
  }
  if (!cfg.projectKey) {
    die("Push needs a projectKey. Set it in bhasha.config.json or pass --project-key.");
  }

  const register = typeof flags["register"] === "string" ? flags["register"] : "default";
  const dryRun = flags["dry-run"] === true;
  const files = localeFilesForPush(cfg, flags);

  for (const file of files) {
    const lang = basename(file, ".json");
    const { flat, skipped } = readFlatLocale(file);
    const keys = Object.keys(flat);

    if (dryRun) {
      log(`${lang}: would push ${keys.length} key(s) to register "${register}"${skipped.length ? `, ${skipped.length} skipped locally` : ""}`);
      if (skipped.length) log(`  skipped locally: ${skipped.slice(0, 10).join(", ")}`);
      continue;
    }

    const url = `${cfg.apiUrl}/sdk/push`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": cfg.projectKey,
        },
        body: JSON.stringify({ lang, register, translations: flat }),
      });
    } catch (e: any) {
      return die(`Could not reach ${cfg.apiUrl}: ${e?.message || e}`);
    }

    const bodyText = await res.text();
    let json: any = null;
    try {
      json = bodyText ? JSON.parse(bodyText) : null;
    } catch {
      // Keep bodyText for the generic error below.
    }

    if (res.status === 403) {
      die(
        "Push was rejected. Create a scoped API key with read-only OFF and no origin allowlist in Project Settings -> API Key."
      );
    }
    if (!res.ok) {
      die(`API returned HTTP ${res.status}${bodyText ? ": " + bodyText : ""}`);
    }

    const data = json?.data ?? json ?? {};
    const totalSkipped = Number(data.skipped || 0) + skipped.length;
    log(`${lang}: ${data.created || 0} created, ${data.updated || 0} updated, ${totalSkipped} skipped`);
    if (Array.isArray(data.skippedRegulated) && data.skippedRegulated.length > 0) {
      log(
        `  regulated keys skipped: ${data.skippedRegulated.join(", ")} ` +
          "(regulated keys can only be edited by a human in the dashboard)"
      );
    }
    if (skipped.length) {
      log(`  skipped locally: ${skipped.slice(0, 10).join(", ")}`);
    }
  }
}

/**
 * Make sure the generated .d.ts is picked up by TypeScript. If tsconfig.json is
 * strict JSON with an `include` array that doesn't list the file, add it; if
 * it's JSONC (comments) or unparseable, print the exact line to add by hand.
 * Never throws — type-gen must not be blocked by tsconfig surgery.
 */
function wireTsconfig(outFile: string): void {
  const TSCONFIG = "tsconfig.json";
  const manual = () => {
    log("");
    log(`  ⚠ Ensure TypeScript compiles ${outFile}. Add it to your ${TSCONFIG} "include":`);
    log(`      "include": ["src", ${JSON.stringify(outFile)}]`);
  };
  try {
    if (!existsSync(TSCONFIG)) return manual();
    const raw = readFileSync(TSCONFIG, "utf8");
    if (raw.includes(outFile)) return; // already referenced
    // Only auto-edit strict JSON; never risk corrupting a JSONC tsconfig.
    if (/\/\/|\/\*/.test(raw)) return manual();
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return manual();
    }
    if (!parsed || typeof parsed !== "object") return manual();
    // No `include` (and no `files`) → TS compiles every .ts/.d.ts in the tree,
    // so a root-level .d.ts is already picked up. Nothing to do.
    if (!Array.isArray(parsed.include)) {
      if (Array.isArray(parsed.files)) return manual();
      return;
    }
    parsed.include.push(outFile);
    writeFileSync(TSCONFIG, JSON.stringify(parsed, null, 2) + "\n");
    log(`  ✓ added ${outFile} to ${TSCONFIG} "include"`);
  } catch {
    manual();
  }
}

function cmdScan(cfg: Config, flags: Record<string, string | boolean>) {
  const used = keysUsedInSource(cfg.src);
  log(`Scanned ${cfg.src}/ — ${used.size} unique keys used in code.`);

  if (!existsSync(cfg.localesDir)) {
    log(`(no "${cfg.localesDir}" to compare against — run \`bhasha init\` / \`bhasha pull\`.)`);
    return;
  }
  const defined = new Set(collectLocalKeys(cfg));
  const missing = [...used].filter((k) => !defined.has(k)).sort();
  const unused = [...defined].filter((k) => !used.has(k)).sort();

  if (missing.length) {
    log("");
    log(`⚠ ${missing.length} key(s) used in code but missing from locales:`);
    missing.forEach((k) => log("    " + k));
  }
  if (unused.length) {
    log("");
    log(`· ${unused.length} key(s) defined in locales but not used in code:`);
    unused.slice(0, 50).forEach((k) => log("    " + k));
    if (unused.length > 50) log(`    …and ${unused.length - 50} more`);
  }
  if (!missing.length && !unused.length) log("✓ locales and source are in sync.");

  if (flags["strict"] === true && missing.length) process.exit(1);
}

function cmdHelp() {
  log(`bhasha — type-safe i18n keys for bhasha-js

Usage:
  bhasha init                     scaffold bhasha.config.json + locales/
  bhasha pull [--remote|--local]  generate type-safe keys from the API or local locales
                                  (defaults to the hosted API when a projectKey is set)
  bhasha push [--lang <code>]     push local locale JSON to BhashaJS
  bhasha scan [--strict]          find t()/<Trans> keys; report missing/unused

Flags (override bhasha.config.json):
  --project-key <key>   --api-url <url>     --source-lang <code>
  --locales-dir <dir>   --out <file>        --src <dir>
  --register <reg>      --dry-run

Examples:
  npx bhasha init
  npx bhasha pull                 # from ./locales/*.json
  npx bhasha pull --remote --project-key bjs_xxx
  npx bhasha push --lang hi --register formal
  npx bhasha scan --strict`);
}

// ─── entry ─────────────────────────────────────────────────────────
async function main() {
  const [, , cmd, ...rest] = process.argv;
  const flags = parseFlags(rest);
  const cfg = loadConfig(flags);

  switch (cmd) {
    case "init":
      cmdInit(cfg);
      break;
    case "pull":
      await cmdPull(cfg, flags);
      break;
    case "push":
      await cmdPush(cfg, flags);
      break;
    case "scan":
      cmdScan(cfg, flags);
      break;
    case "version":
    case "--version":
    case "-v":
      log("bhasha (bhasha-js CLI)");
      break;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      cmdHelp();
      break;
    default:
      err(`Unknown command: ${cmd}\n`);
      cmdHelp();
      process.exit(1);
  }
}

if (typeof require !== "undefined" && typeof module !== "undefined" && require.main === module) {
  main().catch((e) => die(e?.message || String(e)));
}
