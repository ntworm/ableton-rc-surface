import * as esbuild from "esbuild";
import * as fs from "node:fs";
import * as path from "node:path";

const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const production = process.argv.includes("--production");

await esbuild.build({
  entryPoints: ["src/extension.ts"],
  outfile: manifest.entry,
  bundle: true,
  format: "cjs",
  platform: "node",
  sourcesContent: false,
  logLevel: "info",
  minify: production,
  sourcemap: !production,
});

// Copy static/ into dist/ so the .ablx bundles the bundled PWA alongside
// the compiled extension.js. The Extension serves these at /static/...
// at runtime (matching the original FastAPI path, so the PWA's
// window.location.host-derived WebSocket URL points straight at us).
const staticDst = path.join(path.dirname(manifest.entry), "static");
function copyDir(src: string, dst: string): void {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDir(s, d);
    } else if (entry.name.endsWith(".test.mjs")) {
      continue;
    } else {
      fs.copyFileSync(s, d);
    }
  }
}
fs.rmSync(staticDst, { recursive: true, force: true });
copyDir("static", staticDst);
console.log(`copied static/* → ${staticDst}`);
