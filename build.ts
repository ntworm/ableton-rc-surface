// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// This file is part of Ableton RC Surface, distributed under the
// PolyForm Noncommercial License 1.0.0. You may obtain a copy of
// the License at https://polyformproject.org/licenses/noncommercial/1.0.0
import * as esbuild from "esbuild";
import * as fs from "node:fs";
import * as path from "node:path";

const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

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

function copyStatic() {
  try {
    fs.rmSync(staticDst, { recursive: true, force: true });
    copyDir("static", staticDst);
    console.log(`copied static/* → ${staticDst}`);
  } catch (err) {
    console.error("Error copying static:", err);
  }
}

const appDataPath = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, "Ableton", "Extensions", "worm.ableton-rc-surface")
  : null;

// AppData sync is opt-in for v0.5.0+ to avoid mutating the user's
// active Ableton extension folder during local validation. Production
// package builds (`npm run package`) and `npm run build:prod` should
// never touch AppData unless explicitly enabled.
//
// To opt-in during local development:
//   ABLETON_RC_DEV_SYNC=1 npm run build
//   ABLETON_RC_DEV_SYNC=1 npm run watch
const devSyncEnabled = process.env.ABLETON_RC_DEV_SYNC === "1";

function syncToAppData() {
  if (!appDataPath || !fs.existsSync(appDataPath)) return;
  if (!devSyncEnabled) {
    // silent skip — surface this once so devs know it's a known target
    console.log(`[dev-sync] Skipping AppData sync (${appDataPath}). Set ABLETON_RC_DEV_SYNC=1 to enable.`);
    return;
  }
  try {
    fs.copyFileSync("manifest.json", path.join(appDataPath, "manifest.json"));
    copyDir("dist", path.join(appDataPath, "dist"));
    console.log(`[dev-sync] Synced built files directly to Ableton Live Extensions folder.`);
  } catch (err) {
    console.error("[dev-sync] Failed to sync to AppData:", err);
  }
}

if (watch) {
  const ctx = await esbuild.context({
    entryPoints: ["src/extension.ts"],
    outfile: manifest.entry,
    bundle: true,
    format: "cjs",
    platform: "node",
    sourcesContent: false,
    logLevel: "info",
    minify: false,
    sourcemap: true,
    plugins: [{
      name: "copy-static-on-end",
      setup(build) {
        build.onEnd(() => {
          copyStatic();
          syncToAppData();
        });
      }
    }]
  });
  await ctx.watch();
  console.log("esbuild is watching src/ for changes...");

  // Watch static/ using native node fs.watch (debounced to avoid duplicate hot-reloads)
  let debounceTimeout: NodeJS.Timeout | null = null;
  fs.watch("static", { recursive: true }, (eventType, filename) => {
    if (filename && !filename.endsWith(".test.mjs")) {
      if (debounceTimeout) clearTimeout(debounceTimeout);
      debounceTimeout = setTimeout(() => {
        console.log(`static change detected: ${filename}, rebuilding...`);
        copyStatic();
        syncToAppData();
      }, 100);
    }
  });
  console.log("node-watcher is watching static/ for changes...");
} else {
  await esbuild.build({
    entryPoints: ["src/extension.ts"],
    outfile: manifest.entry,
    bundle: true,
    format: "cjs",
    platform: "node",
    sourcesContent: false,
    logLevel: production ? "silent" : "info",
    sourcemap: !production,
  });
  copyStatic();
  syncToAppData();
}
