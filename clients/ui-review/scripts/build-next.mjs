import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const clientDir = resolve(scriptDir, "..");
const sourceDir = resolve(clientDir, "src/next");
const staticDir = resolve(clientDir, "../../static");
const mode = process.argv[2] ?? "--write";
if (!new Set(["--write", "--check"]).has(mode)) throw new Error("usage: build-next.mjs [--write|--check]");

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.sort((a, b) => a.name.localeCompare(b.name)).map((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  }));
  return nested.flat();
}

const modules = await files(sourceDir);
// The sources deliberately use browser-native ES modules. This tiny bundler preserves one
// immutable asset without inventing a framework or pulling a build dependency into the service.
const moduleSource = new Map();
for (const path of modules) {
  if (!path.endsWith(".ts")) continue;
  const key = relative(sourceDir, path).replace(/\\/g, "/").replace(/\.ts$/, "");
  const source = await readFile(path, "utf8");
  moduleSource.set(key, ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    fileName: path,
    reportDiagnostics: true,
  }).outputText);
}
function transform(path, body) {
  let transformed = body.replace(/^import \{([^}]+)\} from ["'](.+?)["'];?$/gm, (_, names, specifier) => {
    const resolved = resolve(dirname(resolve(sourceDir, `${path}.ts`)), specifier.endsWith(".ts") ? specifier : specifier.endsWith(".js") ? specifier.replace(/\.js$/, ".ts") : `${specifier}.ts`);
    const key = relative(sourceDir, resolved).replace(/\\/g, "/").replace(/\.ts$/, "");
    return `const {${names}} = require(${JSON.stringify(key)});`;
  });
  const exported = [];
  transformed = transformed.replace(/export function (\w+)/g, (_, name) => { exported.push(name); return `function ${name}`; });
  transformed = transformed.replace(/export class (\w+)/g, (_, name) => { exported.push(name); return `class ${name}`; });
  transformed = transformed.replace(/export const (\w+)/g, (_, name) => { exported.push(name); return `const ${name}`; });
  if (exported.length) transformed += `\nObject.assign(exports, { ${exported.join(", ")} });`;
  return transformed;
}
const wrapped = [...moduleSource.entries()].map(([key, body]) =>
  `${JSON.stringify(key)}: function(require, exports) {\n${transform(key, body)}\n}`
).join(",\n");
const bundle = `/* UI Review Next — generated; source is clients/ui-review/src/next */\n(() => {\nconst modules = {${wrapped}}; const cache = {}; const require = (id) => { if (cache[id]) return cache[id]; const out = {}; cache[id] = out; modules[id](require, out); return out; };\nconst next = require("index"); window.UIReviewNext = { mount: next.mount }; if (window.UI_REVIEW_NEXT?.sessionId) next.mount(window.UI_REVIEW_NEXT);\n})();\n`;
const sha256 = createHash("sha256").update(bundle).digest("hex");
const asset = `ui-review-next.${sha256.slice(0, 16)}.js`;

async function manifestText() {
  const existing = await readdir(staticDir).catch(() => []);
  const names = existing.filter((name) => /^ui-review-next\.[a-f0-9]{16}\.js$/.test(name));
  if (!names.includes(asset)) names.push(asset);
  const ordered = [asset, ...names.filter((name) => name !== asset).sort()];
  const assets = [];
  for (const name of ordered) {
    const content = name === asset ? bundle : await readFile(resolve(staticDir, name));
    const digest = createHash("sha256").update(content).digest("hex");
    if (name !== `ui-review-next.${digest.slice(0, 16)}.js`) throw new Error(`Next client asset hash mismatch: ${name}`);
    assets.push({ asset: name, sha256: digest });
  }
  return JSON.stringify({ version: 1, asset, sha256, assets }, null, 2) + "\n";
}
if (mode === "--write") {
  await mkdir(staticDir, { recursive: true });
  await writeFile(resolve(staticDir, asset), bundle);
  const manifest = await manifestText();
  await writeFile(resolve(staticDir, "ui-review-next.manifest.json"), manifest);
} else {
  const manifest = await manifestText();
  const current = await readFile(resolve(staticDir, "ui-review-next.manifest.json"), "utf8").catch(() => "");
  if (current !== manifest) throw new Error("Next client build is stale; run npm run build:next");
  await readFile(resolve(staticDir, asset));
}
process.stdout.write(`ui-review-next asset=${asset}\n`);
