import * as fs from "node:fs/promises";
import * as path from "node:path";
import selfsigned from "selfsigned";
import { getExtensionContext } from "../context.js";
import { getLanAddresses } from "../util/helpers.js";

export let useHttps = false;
export let httpsOptions: { key: Buffer; cert: Buffer } | null = null;

// selfsigned's SubjectAltNameEntry has type: 1|2|6|7, value?: string,
// ip?: string. We re-export it so callers can typecheck without depending
// on selfsigned's surface.
export type SubjectAltNameEntry = {
  type: 1 | 2 | 6 | 7;
  value?: string;
  ip?: string;
};

/**
 * Build the subjectAltName entries for the HTTPS self-signed cert. Always
 * covers localhost + 127.0.0.1 + the unique LAN IPs provided. Bad inputs
 * are silently dropped so the cert never breaks on a malformed IP.
 *
 * Shape matches selfsigned's altNames API:
 *   { type: 2, value: string }  → DNS name
 *   { type: 7, ip:   string }  → IPv4 address
 */
export function buildSubjectAltNames(lanIps: string[]): SubjectAltNameEntry[] {
  const out: SubjectAltNameEntry[] = [
    { type: 2, value: "localhost" },
    { type: 7, ip: "127.0.0.1" },
  ];
  const seen = new Set<string>(["127.0.0.1"]);
  for (const raw of lanIps) {
    if (typeof raw !== "string") continue;
    const ip = raw.trim();
    if (!isLikelyIpv4(ip) || seen.has(ip)) continue;
    seen.add(ip);
    out.push({ type: 7, ip });
  }
  return out;
}

function isLikelyIpv4(s: string): boolean {
  const parts = s.split(".");
  if (parts.length !== 4) return false;
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0 || n > 255) return false;
    if (p.length > 1 && p.startsWith("0")) return false;
  }
  return true;
}

/**
 * Returns true if every required LAN IP appears as an iPAddress SAN inside
 * the given cert PEM. Decodes just enough of the X.509 DER to locate the
 * subjectAltName extension (OID 2.5.29.17) and scans its OCTET STRING for
 * IPv4 GeneralName entries (tag 0x87, length 4, 4 raw IP bytes). It is a
 * targeted, dependency-free check: no full ASN.1 parse. False positives for
 * unrelated 0x87 0x04 byte sequences outside the SAN value are unlikely
 * because the scanner is bounded to the SAN extension's value bytes.
 */
export function certCoversRequiredAltNames(certPem: Buffer | string, lanIps: string[]): boolean {
  const der = pemToDer(certPem);
  if (!der) return false;
  const presentIps = extractIpv4Sans(der);
  for (const raw of lanIps) {
    if (typeof raw !== "string") continue;
    const ip = raw.trim();
    if (!isLikelyIpv4(ip)) continue;
    if (!presentIps.includes(ip)) return false;
  }
  return true;
}

function pemToDer(pem: Buffer | string): Uint8Array | null {
  const text = typeof pem === "string" ? pem : pem.toString("utf8");
  const b64 = text
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  if (!b64) return null;
  try {
    return new Uint8Array(Buffer.from(b64, "base64"));
  } catch {
    return null;
  }
}

function findPattern(haystack: Uint8Array, needle: readonly number[]): number {
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function readDerLength(der: Uint8Array, pos: number): { length: number; headerSize: number } | null {
  if (pos >= der.length) return null;
  const first = der[pos]!;
  if (first < 0x80) return { length: first, headerSize: 1 };
  const n = first & 0x7f;
  if (n === 0 || n > 4 || pos + 1 + n > der.length) return null;
  let length = 0;
  for (let i = 0; i < n; i++) length = (length << 8) | der[pos + 1 + i]!;
  return { length, headerSize: 1 + n };
}

function extractIpv4Sans(der: Uint8Array): string[] {
  // OID 2.5.29.17 (subjectAltName) DER-encoded prefix: 06 03 55 1d 11
  const oidPos = findPattern(der, [0x06, 0x03, 0x55, 0x1d, 0x11]);
  if (oidPos === -1) return [];

  let pos = oidPos + 5; // past OID header

  // Optional BOOLEAN critical: 01 01 FF
  if (
    pos + 3 <= der.length &&
    der[pos] === 0x01 &&
    der[pos + 1] === 0x01 &&
    (der[pos + 2] === 0xff || der[pos + 2] === 0x00)
  ) {
    pos += 3;
  }

  // OCTET STRING tag (04 LL <value>)
  if (pos >= der.length || der[pos] !== 0x04) return [];
  pos++;
  const lenInfo = readDerLength(der, pos);
  if (!lenInfo) return [];
  pos += lenInfo.headerSize;
  const valueEnd = pos + lenInfo.length;
  if (valueEnd > der.length) return [];

  // Scan for iPAddress GeneralName entries: context-specific 7 (tag 0x87),
  // length 0x04, then 4 raw IPv4 bytes. Bounds are guaranteed by i+6<=valueEnd.
  const ips: string[] = [];
  for (let i = pos; i + 6 <= valueEnd; i++) {
    if (der[i] === 0x87 && der[i + 1] === 0x04) {
      const b1 = der[i + 2]!;
      const b2 = der[i + 3]!;
      const b3 = der[i + 4]!;
      const b4 = der[i + 5]!;
      ips.push(`${b1}.${b2}.${b3}.${b4}`);
    }
  }
  return ips;
}

/**
 * Persist or regenerate HTTPS certs. If persisted certs are missing the
 * current LAN SAN entries (e.g. the host's IP changed), regenerate and
 * overwrite so the phone keeps trusting the cert on its new IP.
 */
export async function loadCerts(): Promise<void> {
  const extensionContext = getExtensionContext();
  const storageDir = extensionContext?.environment?.storageDirectory;
  const lanIps = getLanAddresses();
  const altNames = buildSubjectAltNames(lanIps);

  if (!storageDir) {
    console.warn("[ableton-rc-surface] storageDirectory unavailable, generating ephemeral HTTPS certs (will not persist)");
    await generateAndApplyEphemeral(altNames);
    return;
  }

  const cleanStorageDir = storageDir.replace(/^\/([a-zA-Z]):/, "$1:");
  const certDir = path.join(cleanStorageDir, "certs");
  const keyPath = path.join(certDir, "ableton-rc-server.key");
  const certPath = path.join(certDir, "ableton-rc-server.crt");

  try {
    const [key, cert] = await Promise.all([
      fs.readFile(keyPath),
      fs.readFile(certPath),
    ]);
    if (!certCoversRequiredAltNames(cert, lanIps)) {
      console.log(
        `[ableton-rc-surface] persisted HTTPS cert missing LAN SAN (${lanIps.join(", ") || "none"}); regenerating`,
      );
      throw new Error("cert_san_stale");
    }
    httpsOptions = { key, cert };
    useHttps = true;
    console.log(`[ableton-rc-surface] loaded HTTPS certs from ${certDir}`);
    return;
  } catch {
    // Files don't exist or SAN is stale -- generate and persist.
  }

  try {
    await fs.mkdir(certDir, { recursive: true });
    const pems = await selfsigned.generate(
      [{ name: "commonName", value: "ableton-rc-surface.local" }],
      {
        algorithm: "sha256",
        keySize: 2048,
        extensions: [
          { name: "basicConstraints", cA: false },
          { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
          { name: "subjectAltName", altNames },
        ],
      },
    );
    await Promise.all([
      fs.writeFile(keyPath, pems.private, { mode: 0o600 }),
      fs.writeFile(certPath, pems.cert, { mode: 0o600 }),
    ]);
    httpsOptions = {
      key: Buffer.from(pems.private, "utf8"),
      cert: Buffer.from(pems.cert, "utf8"),
    };
    useHttps = true;
    console.log(
      `[ableton-rc-surface] generated and saved new HTTPS certs to ${certDir} (LAN SAN: ${lanIps.join(", ") || "none"})`,
    );
  } catch (err) {
    console.error(`[ableton-rc-surface] could not generate/persist HTTPS certs: ${err instanceof Error ? err.message : String(err)}; falling back to HTTP (camera/mic will not work on phone)`);
    useHttps = false;
    httpsOptions = null;
  }
}

async function generateAndApplyEphemeral(
  altNames: SubjectAltNameEntry[],
): Promise<void> {
  try {
    const pems = await selfsigned.generate(
      [{ name: "commonName", value: "ableton-rc-surface.local" }],
      {
        algorithm: "sha256",
        keySize: 2048,
        extensions: [
          { name: "basicConstraints", cA: false },
          { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
          { name: "subjectAltName", altNames },
        ],
      },
    );
    httpsOptions = {
      key: Buffer.from(pems.private, "utf8"),
      cert: Buffer.from(pems.cert, "utf8"),
    };
    useHttps = true;
  } catch (err) {
    console.error(`[ableton-rc-surface] ephemeral selfsigned generation failed: ${err instanceof Error ? err.message : String(err)}; falling back to HTTP`);
    useHttps = false;
    httpsOptions = null;
  }
}
