// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// This file is part of Ableton RC Surface, distributed under the
// PolyForm Noncommercial License 1.0.0. You may obtain a copy of
// the License at https://polyformproject.org/licenses/noncommercial/1.0.0
//
// URL parsing that does not depend on the WHATWG `URL` constructor.
//
// Ableton Live's extension host does not expose `URL` as a global. Every
// request-path parser used to call `new URL(...)` inside a try/catch, so in
// Live the calls threw and the catch swallowed it:
//   - the same-origin check reported "unparseable" and 403'd every request
//     that carries an Origin header (POST /log, the wss:// upgrade), while
//     plain navigations — which send no Origin — kept working, so the page
//     loaded and only the connection died;
//   - token parsing returned null, so every client silently became a viewer;
//   - client_id parsing returned null, so sessions never resumed.
//
// Node has a global URL, which is why none of this reproduced in tests.
// These helpers are total and dependency-free, so they behave identically in
// both runtimes.

export interface ParsedOrigin {
  /** Lower-cased scheme including the colon, e.g. "https:". */
  protocol: string;
  /** Lower-cased host without the port. IPv6 keeps its brackets. */
  hostname: string;
  /** Explicit port, or "" when the origin omitted it. */
  port: string;
  /** hostname plus ":port" when a port was present. */
  host: string;
}

// scheme://host[:port] with an optional trailing slash. Host is either a
// bracketed IPv6 literal or a run of characters that cannot contain / ? # :
const ORIGIN_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(\[[^\]]+\]|[^/?#:]+)(?::(\d+))?\/?$/;

/** Parse an Origin header value. Returns null when it is not a valid origin. */
export function parseOrigin(raw: string): ParsedOrigin | null {
  if (typeof raw !== "string") return null;
  const match = ORIGIN_RE.exec(raw.trim());
  if (!match) return null;
  const protocol = `${match[1]!.toLowerCase()}:`;
  const hostname = match[2]!.toLowerCase();
  const port = match[3] ?? "";
  return { protocol, hostname, port, host: port ? `${hostname}:${port}` : hostname };
}

function decodeSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // A malformed percent-escape must not take down request handling.
    return value;
  }
}

/**
 * Read a single query parameter from a request URL or path.
 * Returns "" for a present-but-empty value and null when absent.
 */
export function getQueryParam(url: string | undefined, name: string): string | null {
  if (typeof url !== "string") return null;
  const start = url.indexOf("?");
  if (start === -1) return null;
  let query = url.slice(start + 1);
  const hash = query.indexOf("#");
  if (hash !== -1) query = query.slice(0, hash);

  for (const pair of query.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const rawKey = eq === -1 ? pair : pair.slice(0, eq);
    if (decodeSafe(rawKey.replace(/\+/g, " ")) !== name) continue;
    if (eq === -1) return "";
    return decodeSafe(pair.slice(eq + 1).replace(/\+/g, " "));
  }
  return null;
}
