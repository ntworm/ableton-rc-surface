#!/usr/bin/env node
// package-tester-kit.mjs
//
// Build a tester-ready .zip of the current Ableton RC Bridge release.
//
// Usage:
//   node scripts/package-tester-kit.mjs
//   npm run package:tester
//
// Behavior:
//   1. run `npm run package` to (re)generate the .ablx
//   2. stage the .ablx + canonical docs into release-kits/<name>-test/
//   3. write SHA256SUMS.txt
//   4. zip the staged folder using a Node-native zip writer (STORE, no deps)
//
// Output:
//   release-kits/<name>-test/   <- staged folder
//   release-kits/<name>-test.zip  <- final tester kit

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(here, "..");

// resolve name + version from package.json (single source of truth)
const pkg = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
const version = pkg.version;
const baseName = `Ableton-RC-Surface-${version}`;
const kitName = `${baseName}-test`;
const kitsRoot = join(repoRoot, "release-kits");
const stagedDir = join(kitsRoot, kitName);
const zipPath = join(kitsRoot, `${kitName}.zip`);

// files staged into the tester kit (relative to repo root)
// DECISION: We explicitly include all user-facing docs (like docs/USER-GUIDE.md, LICENSE, etc.)
// inside the test zip kit to ensure that the kit remains self-contained and free of broken links.
const stageDocs = [
  "README.md",
  "LICENSE",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "docs/README.md",
  "docs/INSTALL.md",
  "docs/USER-GUIDE.md",
  "docs/FAQ.md",
  "docs/PRIVACY.md",
  "docs/SECURITY.md",
  "docs/CUSTOMIZATION.md",
  "docs/TESTER-GUIDE.md",
  "docs/AGENT_GUIDE.md",
];

function log(msg) {
  process.stdout.write(`[tester-kit] ${msg}\n`);
}

function run(cmd, cwd = repoRoot) {
  log(`$ ${cmd}`);
  execSync(cmd, { cwd, stdio: "inherit" });
}

async function pathExists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function copyFile(src, dst) {
  await mkdir(resolve(dst, ".."), { recursive: true });
  await writeFile(dst, await readFile(src));
}

// minimal Node-native zip writer (STORE method, no compression, no extra fields)
// spec: PKWARE APPNOTE.TXT - File Up to version 4.5 (STORE)
// enough for a few MB of docs + a single .ablx; small + zero dependencies.
const SIG = {
  localFileHeader: 0x04034b50,
  centralDirHeader: 0x02014b50,
  endOfCentralDir: 0x06054b50,
};

function dosDateTime(d = new Date()) {
  const time =
    ((d.getHours() & 0x1f) << 11) |
    ((d.getMinutes() & 0x3f) << 5) |
    ((Math.floor(d.getSeconds() / 2)) & 0x1f);
  const date =
    (((d.getFullYear() - 1980) & 0x7f) << 9) |
    (((d.getMonth() + 1) & 0x0f) << 5) |
    (d.getDate() & 0x1f);
  return { time, date };
}

async function sha256File(p) {
  const h = createHash("sha256");
  h.update(await readFile(p));
  return h.digest("hex");
}

// CRC32 (PKZIP polynomial 0xEDB88320, reflected) — required by zip spec.
// Node's crypto module exposes only SHA/MD5 families, so we implement it.
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c = CRC32_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

async function buildZip(srcDir, outPath) {
  const base = resolve(srcDir);
  const { time, date } = dosDateTime();

  // walk files (skip directories; emit empty dirs as zero-byte entries)
  const entries = [];
  async function walk(dir, prefix) {
    for (const name of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, name.name);
      const rel = prefix ? `${prefix}/${name.name}` : name.name;
      if (name.isDirectory()) {
        entries.push({ path: full, relPath: `${rel}/`, data: Buffer.alloc(0) });
        await walk(full, rel);
      } else if (name.isFile()) {
        entries.push({ path: full, relPath: rel, data: await readFile(full) });
      }
    }
  }
  await walk(base, "");

  const centralRecords = [];
  const chunks = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.relPath, "utf8");
    const crcVal = crc32(e.data);
    const size = e.data.length;
    const isDir = e.relPath.endsWith("/");

    // Local file header
    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG.localFileHeader, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0x0800, 6);      // general purpose flag (utf8 name)
    local.writeUInt16LE(0, 8);           // method (STORE = 0)
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crcVal, 14);
    local.writeUInt32LE(size, 18);       // compressed size
    local.writeUInt32LE(size, 22);       // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);          // extra field length

    chunks.push(local, nameBuf, e.data);

    const headerSize = local.length + nameBuf.length;
    const dataOffset = offset;
    offset += headerSize + size;

    centralRecords.push({ nameBuf, crcVal, size, isDir, localHeaderOffset: dataOffset });
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const r of centralRecords) {
    const rec = Buffer.alloc(46);
    rec.writeUInt32LE(SIG.centralDirHeader, 0);
    rec.writeUInt16LE(20, 4);           // version made by
    rec.writeUInt16LE(20, 6);           // version needed
    rec.writeUInt16LE(0x0800, 8);       // flag
    rec.writeUInt16LE(0, 10);           // method
    rec.writeUInt16LE(time, 12);
    rec.writeUInt16LE(date, 14);
    rec.writeUInt32LE(r.crcVal, 16);
    rec.writeUInt32LE(r.size, 20);
    rec.writeUInt32LE(r.size, 24);
    rec.writeUInt16LE(r.nameBuf.length, 28);
    rec.writeUInt16LE(0, 30);           // extra
    rec.writeUInt16LE(0, 32);           // comment
    rec.writeUInt16LE(0, 34);           // disk number
    rec.writeUInt16LE(0, 36);           // internal attrs
    rec.writeUInt32LE(r.isDir ? 0x10 : 0, 38);  // external attrs
    rec.writeUInt32LE(r.localHeaderOffset, 42);
    chunks.push(rec, r.nameBuf);
    centralSize += rec.length + r.nameBuf.length;
  }

  // End of central directory
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG.endOfCentralDir, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(centralRecords.length, 8);
  eocd.writeUInt16LE(centralRecords.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20);
  chunks.push(eocd);

  const out = createWriteStream(outPath);
  for (const c of chunks) {
    if (c.length === 0) continue;
    if (!out.write(c)) {
      await new Promise((r) => out.once("drain", r));
    }
  }
  await new Promise((r, j) => out.end((err) => (err ? j(err) : r())));
}

async function checkMarkdownLinks(stagedDir) {
  log("verifying relative markdown links...");
  const mdFiles = ["README.md", ...stageDocs.filter((d) => d.endsWith(".md"))];
  let warnings = 0;
  for (const rel of mdFiles) {
    const fullPath = join(stagedDir, rel);
    if (!(await pathExists(fullPath))) continue;
    const content = await readFile(fullPath, "utf8");
    const dirOfFile = resolve(fullPath, "..");
    const linkRegex = /\[[^\]]*\]\(([^)]+)\)/g;
    let match;
    while ((match = linkRegex.exec(content)) !== null) {
      const link = match[1];
      if (
        link.startsWith("http://") ||
        link.startsWith("https://") ||
        link.startsWith("mailto:") ||
        link.startsWith("#")
      ) {
        continue;
      }
      const targetWithoutAnchor = link.split("#")[0];
      if (!targetWithoutAnchor) continue;
      const resolvedTarget = resolve(dirOfFile, targetWithoutAnchor);
      if (!(await pathExists(resolvedTarget))) {
        log(`[WARNING] Broken relative link in ${rel}: "${link}" (resolved to ${relative(stagedDir, resolvedTarget)})`);
        warnings++;
      }
    }
  }
  log(`link check done with ${warnings} warning(s)`);
}

async function main() {
  log(`version: ${version}`);
  log(`staging into: ${stagedDir}`);

  // 1. (re)build + package via npm (delegated so we honor existing CI flags)
  run("npm run package");

  // 2. fresh staged dir
  if (await pathExists(stagedDir)) {
    await rm(stagedDir, { recursive: true, force: true });
  }
  await mkdir(stagedDir, { recursive: true });

  // 3. copy the .ablx
  const ablxSrc = join(repoRoot, `${baseName}.ablx`);
  if (!(await pathExists(ablxSrc))) {
    throw new Error(`missing ${baseName}.ablx after npm run package`);
  }
  await copyFile(ablxSrc, join(stagedDir, `${baseName}.ablx`));

  // 3.5 copy the MIDI receiver device
  const receiverSrc = join(repoRoot, "static", "RC-Midi-Receiver.amxd");
  if (!(await pathExists(receiverSrc))) {
    throw new Error("missing static/RC-Midi-Receiver.amxd");
  }
  await copyFile(receiverSrc, join(stagedDir, "RC-Midi-Receiver.amxd"));

  // 4. copy docs
  for (const rel of stageDocs) {
    const src = join(repoRoot, rel);
    if (!(await pathExists(src))) {
      log(`skip missing doc: ${rel}`);
      continue;
    }
    await copyFile(src, join(stagedDir, rel));
  }

  // 5. write SHA256SUMS.txt
  const sums = [];
  for (const rel of [`${baseName}.ablx`, "RC-Midi-Receiver.amxd", ...stageDocs]) {
    const full = join(stagedDir, rel);
    if (!(await pathExists(full))) continue;
    sums.push(`${await sha256File(full)}  ${rel.split(sep).join("/")}`);
  }
  await writeFile(join(stagedDir, "SHA256SUMS.txt"), sums.join("\n") + "\n");

  // 5.5 Check for broken relative links
  await checkMarkdownLinks(stagedDir);

  // 6. zip
  if (await pathExists(zipPath)) {
    await rm(zipPath);
  }
  await buildZip(stagedDir, zipPath);

  log(`kit ready:`);
  log(`  ${stagedDir}`);
  log(`  ${zipPath}`);
  log(`  ${sums.length} entries hashed`);
}

export { buildZip, crc32, sha256File, stageDocs };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
}
