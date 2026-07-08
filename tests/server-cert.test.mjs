import test from "node:test";
import assert from "node:assert/strict";
import selfsigned from "selfsigned";

function certOptions(altNames) {
  return {
    algorithm: "sha256",
    keySize: 2048,
    extensions: [
      { name: "basicConstraints", cA: false },
      { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
      { name: "subjectAltName", altNames },
    ],
  };
}

test("cert.ts builds SAN entries for localhost, loopback, and unique LAN IPs", async () => {
  const { buildSubjectAltNames } = await import("../src/server/cert.ts");

  assert.deepEqual(
    buildSubjectAltNames(["192.168.100.2", "not-an-ip", "127.0.0.1", "192.168.100.2"]),
    [
      { type: 2, value: "localhost" },
      { type: 7, ip: "127.0.0.1" },
      { type: 7, ip: "192.168.100.2" },
    ],
  );
});

test("cert.ts detects persisted certs that are missing the current LAN IP SAN", async () => {
  const { buildSubjectAltNames, certCoversRequiredAltNames } = await import("../src/server/cert.ts");
  const attrs = [{ name: "commonName", value: "ableton-rc-surface.local" }];

  const oldPems = await selfsigned.generate(
    attrs,
    certOptions(buildSubjectAltNames([])),
  );
  assert.equal(
    certCoversRequiredAltNames(Buffer.from(oldPems.cert, "utf8"), ["192.168.100.2"]),
    false,
  );

  const newPems = await selfsigned.generate(
    attrs,
    certOptions(buildSubjectAltNames(["192.168.100.2"])),
  );
  assert.equal(
    certCoversRequiredAltNames(Buffer.from(newPems.cert, "utf8"), ["192.168.100.2"]),
    true,
  );
});
