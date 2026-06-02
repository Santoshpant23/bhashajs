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
import { join, extname } from "node:path";

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
// A locale file is either flat ({ "hero.title": "..." }) or register-nested
// ({ "hero.title": { "default": "..." } }). In both, the translation KEY is
// the top-level property, so Object.keys is what we want.
function keysFromBundle(obj: unknown): string[] {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return [];
  return Object.keys(obj as Record<string, unknown>);
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
  log("  1. Add your keys to the locale file(s).");
  log("  2. Run `npx bhasha pull` to generate type-safe keys.");
  log("  3. Make sure the generated .d.ts is picked up by your tsconfig.");
}

async function cmdPull(cfg: Config, flags: Record<string, string | boolean>) {
  const remote = flags["remote"] === true || (!!cfg.projectKey && !existsSync(cfg.localesDir));
  const keys = remote ? await collectRemoteKeys(cfg) : collectLocalKeys(cfg);
  if (keys.length === 0) die("No keys found.");
  writeFileSync(cfg.out, generateDts(keys));
  log(`✓ ${cfg.out} — ${keys.length} type-safe keys (${remote ? "remote" : "local"} source)`);
  log(`  t() and <Trans> now autocomplete and error on a typo'd key.`);
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
  bhasha pull [--remote]          generate type-safe keys from locales or the API
  bhasha scan [--strict]          find t()/<Trans> keys; report missing/unused

Flags (override bhasha.config.json):
  --project-key <key>   --api-url <url>     --source-lang <code>
  --locales-dir <dir>   --out <file>        --src <dir>

Examples:
  npx bhasha init
  npx bhasha pull                 # from ./locales/*.json
  npx bhasha pull --remote --project-key bjs_xxx
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

main().catch((e) => die(e?.message || String(e)));
