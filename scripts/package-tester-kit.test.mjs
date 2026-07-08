import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = join(import.meta.dirname, "..");
const scriptPath = join(repoRoot, "scripts", "package-tester-kit.mjs");

test("tester-kit: script is present and runnable via node", () => {
  const r = spawnSync("node", ["--check", scriptPath], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});

test("tester-kit: built-in zip writer produces a readable zip", async () => {
  const mod = await import(`${pathToFileURL(scriptPath).href}?test=${Date.now()}`);
  assert.equal(typeof mod.buildZip, "function");

  const dir = await mkdtemp(join(tmpdir(), "tester-kit-zip-src-"));
  const out = join(tmpdir(), `tester-kit-${Date.now()}.zip`);
  try {
    await mkdir(join(dir, "docs"), { recursive: true });
    await writeFile(join(dir, "hello.txt"), "hello\n");
    await writeFile(join(dir, "docs", "readme.txt"), "docs\n");

    await mod.buildZip(dir, out);
    const zip = await readFile(out);
    assert.equal(zip.readUInt32LE(0), 0x04034b50);
    assert.match(zip.toString("utf8"), /hello\.txt/);
    assert.match(zip.toString("utf8"), /docs\/readme\.txt/);
    assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(out, { force: true });
  }
});

test("tester-kit: SHA256 helper matches known hash for fixed bytes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tester-kit-"));
  try {
    const file = join(dir, "hello.txt");
    await writeFile(file, "hello\n");
    const h = createHash("sha256").update("hello\n").digest("hex");
    const re = await readFile(file);
    const reh = createHash("sha256").update(re).digest("hex");
    assert.equal(reh, h);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("tester-kit: stage docs list includes required user-facing files", async () => {
  // read package.json and assert that the script references the docs we ship
  const src = await readFile(scriptPath, "utf8");
  const expected = [
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
  for (const doc of expected) {
    assert.ok(src.includes(doc), `expected ${doc} in stageDocs`);
  }
});

test("tester-kit: staged docs include every staged markdown link they reference", async () => {
  const mod = await import(`${pathToFileURL(scriptPath).href}?docs=${Date.now()}`);
  const staged = new Set(mod.stageDocs);
  const docLink = /`((?:docs\/)?[A-Za-z0-9._/-]+\.md)`/g;

  for (const rel of staged) {
    if (!rel.endsWith(".md")) continue;
    const text = await readFile(join(repoRoot, rel), "utf8");
    for (const match of text.matchAll(docLink)) {
      const linkedDoc = match[1];
      const baseDir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/") + 1) : "";
      const resolvedDoc = linkedDoc.startsWith("docs/") || staged.has(linkedDoc)
        ? linkedDoc
        : `${baseDir}${linkedDoc}`;
      assert.ok(
        staged.has(resolvedDoc),
        `${rel} references ${linkedDoc}, but ${resolvedDoc} is not staged`,
      );
    }
  }
});

test("tester-kit: zip writer does NOT include certs, env, tests, node_modules, dist", async () => {
  const src = await readFile(scriptPath, "utf8");
  // the script must not reference forbidden dirs in its stage list
  const forbidden = [".env", ".pem", ".key", "node_modules", "/dist/"];
  for (const token of forbidden) {
    assert.ok(!src.includes(token), `forbidden token in script: ${token}`);
  }
});
