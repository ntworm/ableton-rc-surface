import * as fs from "node:fs/promises";
import * as path from "node:path";
import selfsigned from "selfsigned";
import { getExtensionContext } from "../context.js";

export let useHttps = false;
export let httpsOptions: { key: Buffer; cert: Buffer } | null = null;

export async function loadCerts(): Promise<void> {
  const extensionContext = getExtensionContext();
  const storageDir = extensionContext?.environment?.storageDirectory;
  if (!storageDir) {
    console.warn("[ableton-rc-bridge] storageDirectory unavailable, generating ephemeral HTTPS certs (will not persist)");
    try {
      const pems = await selfsigned.generate(
        [{ name: "commonName", value: "ableton-rc-bridge.local" }],
        {
          algorithm: "sha256",
          keySize: 2048,
          extensions: [
            { name: "basicConstraints", cA: false },
            {
              name: "keyUsage",
              digitalSignature: true,
              keyEncipherment: true,
            },
            {
              name: "subjectAltName",
              altNames: [
                { type: 2, value: "localhost" },
                { type: 7, ip: "127.0.0.1" },
              ],
            },
          ],
        },
      );
      httpsOptions = {
        key: Buffer.from(pems.private, "utf8"),
        cert: Buffer.from(pems.cert, "utf8"),
      };
      useHttps = true;
    } catch (err) {
      console.error(`[ableton-rc-bridge] ephemeral selfsigned generation failed: ${err instanceof Error ? err.message : String(err)}; falling back to HTTP`);
      useHttps = false;
      httpsOptions = null;
    }
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
    httpsOptions = { key, cert };
    useHttps = true;
    console.log(`[ableton-rc-bridge] loaded HTTPS certs from ${certDir}`);
    return;
  } catch {
    // Files don't exist -- generate and persist.
  }

  try {
    await fs.mkdir(certDir, { recursive: true });
    const pems = await selfsigned.generate(
      [{ name: "commonName", value: "ableton-rc-bridge.local" }],
      {
        algorithm: "sha256",
        keySize: 2048,
        extensions: [
          { name: "basicConstraints", cA: false },
          {
            name: "keyUsage",
            digitalSignature: true,
            keyEncipherment: true,
          },
          {
            name: "subjectAltName",
            altNames: [
              { type: 2, value: "localhost" },
              { type: 7, ip: "127.0.0.1" },
            ],
          },
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
    console.log(`[ableton-rc-bridge] generated and saved new HTTPS certs to ${certDir}`);
  } catch (err) {
    console.error(`[ableton-rc-bridge] could not generate/persist HTTPS certs: ${err instanceof Error ? err.message : String(err)}; falling back to HTTP (camera/mic will not work on phone)`);
    useHttps = false;
    httpsOptions = null;
  }
}
