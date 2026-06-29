# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.4.x   | ✅         |
| 0.3.x   | ⚠️ best-effort |
| < 0.3   | ❌         |

## Reporting a Vulnerability

If you discover a security vulnerability, **please do not open a public
GitHub issue**. Instead, email the maintainer directly at the address
listed in the repository's profile, or use the
[GitHub Security Advisory](https://docs.github.com/en/code-security/security-advisories)
flow for private disclosure.

We will acknowledge receipt within 48 hours and aim to release a patch
within 7 days for critical issues.

## Scope

The extension runs an HTTP/HTTPS + WebSocket server on a LAN-bound
random port. Attack surface includes:

- **Self-signed TLS certificates**: generated per-install, stored in
  Ableton's `storageDirectory/certs/`. Private keys are never bundled
  in the published `.ablx`.
- **WebSocket command handler**: all commands run inside the Ableton
  Extensions SDK sandbox. There is no shell exec, no file write outside
  `storageDirectory`, and no network egress from the extension process.
- **Static file server**: serves only files under `dist/static/` with
  path-traversal protection (normalise + prefix check).

## HTTPS and Certificates

- Phone/Mix browser clients connect via **HTTP** (port N) because
  mobile browsers reject self-signed certs without manual trust.
- The admin dashboard connects via **HTTPS** (port N+1) since it runs
  on localhost where the self-signed cert is trusted by the host.
- Camera and microphone APIs on phones require a Secure Context; if you
  need them, you must either trust the self-signed cert manually on the
  phone or tunnel through a reverse proxy with a real cert (see
  `docs/INSTALL.md`).
