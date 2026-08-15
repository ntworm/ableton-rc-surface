// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// This file is part of Ableton RC Surface, distributed under the
// PolyForm Noncommercial License 1.0.0. You may obtain a copy of
// the License at https://polyformproject.org/licenses/noncommercial/1.0.0
import * as http from "node:http";
import * as crypto from "node:crypto";
import { parseOrigin, getQueryParam } from "../util/url.js";

export type SessionRole = "viewer" | "controller" | "admin";

export interface Session {
  role: SessionRole;
  clientId?: string;
  token?: string;
}

let controllerToken = crypto.randomBytes(16).toString("hex");
let adminToken = crypto.randomBytes(16).toString("hex");

export function getControllerToken(): string {
  return controllerToken;
}

export function getAdminToken(): string {
  return adminToken;
}

export function regenerateTokens(): { controllerToken: string; adminToken: string } {
  controllerToken = crypto.randomBytes(16).toString("hex");
  adminToken = crypto.randomBytes(16).toString("hex");
  return { controllerToken, adminToken };
}

/**
 * Timing-safe string comparison to prevent timing attacks on tokens.
 */
export function timingSafeCompare(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Verifies Same-Origin for browser requests.
 * Returns true if no Origin header is present (non-browser client)
 */
export function sanitizeRequestUrl(urlStr: string | undefined): string {
  if (!urlStr) return "/";
  return urlStr.replace(/(?:token|secret|password|key|admin_token|controller_token|adminToken|controllerToken)=([^&]+)/gi, (match) => {
    const eqIdx = match.indexOf("=");
    return `${match.slice(0, eqIdx + 1)}[REDACTED]`;
  });
}

export type OriginCheckReason =
  | "no-origin-header"
  | "null-origin"
  | "no-host-header"
  | "origin-unparseable"
  | "non-http-origin-scheme"
  | "exact-host-match"
  | "loopback-match"
  | "hostname-match"
  | "port-mismatch"
  | "hostname-mismatch";

export interface OriginCheck {
  ok: boolean;
  reason: OriginCheckReason;
  originValue: string | null;
  hostValue: string | null;
  originPort: string | null;
  hostPort: string | null;
}

/**
 * Same-Origin check that reports WHY it decided what it decided.
 *
 * A bare boolean made a field failure undiagnosable: the phone page loaded
 * fine (top-level GETs carry no Origin) while POST /log answered 403 and every
 * WebSocket upgrade was destroyed — both of which DO carry an Origin — with no
 * way to see which branch rejected them or what headers the server actually
 * received.
 */
export function checkSameOrigin(req: http.IncomingMessage): OriginCheck {
  const origin = req.headers["origin"];
  const host = req.headers["host"];
  const base: Omit<OriginCheck, "ok" | "reason"> = {
    originValue: typeof origin === "string" ? origin : null,
    hostValue: typeof host === "string" ? host : null,
    originPort: null,
    hostPort: null,
  };

  // No Origin header — non-browser client (e.g. curl, CLI, native code) or a
  // top-level navigation.
  if (!origin || typeof origin !== "string") {
    return { ...base, ok: true, reason: "no-origin-header" };
  }

  // Live's embedded CEF/WebView sends "null" as the Origin for locally-served pages.
  if (origin === "null") return { ...base, ok: true, reason: "null-origin" };

  if (!host || typeof host !== "string") {
    return { ...base, ok: false, reason: "no-host-header" };
  }

  // parseOrigin, not `new URL`: Live's extension host has no URL global, and
  // the old try/catch turned that into "unparseable" for every request that
  // carries an Origin — silently 403'ing /log and destroying every WS upgrade.
  const originUrl = parseOrigin(origin);
  if (!originUrl) {
    return { ...base, ok: false, reason: "origin-unparseable" };
  }

  // A browser extension, a file:// page or a custom-scheme WebView reaches
  // here with a scheme that has no meaningful port. Naming that explicitly
  // beats reporting a bogus "port-mismatch" against the scheme default.
  if (originUrl.protocol !== "http:" && originUrl.protocol !== "https:") {
    return { ...base, ok: false, reason: "non-http-origin-scheme" };
  }

  const hostParts = host.toLowerCase().split(":");
  const hostNameOnly = hostParts[0];
  // Compare effective ports, resolving the scheme default when a port is
  // omitted. Treating an absent port as "matches anything" would let any
  // other daemon on the same address (router UI, dev server, sibling
  // extension) drive Live purely because it shares the hostname.
  const hostPort = hostParts[1] || ((req.socket as { encrypted?: boolean } | undefined)?.encrypted ? "443" : "80");
  const originPort = originUrl.port || (originUrl.protocol === "https:" ? "443" : "80");
  const detail = { ...base, originPort, hostPort };

  if (originUrl.host === host.toLowerCase()) {
    return { ...detail, ok: true, reason: "exact-host-match" };
  }
  if (originPort !== hostPort) {
    return { ...detail, ok: false, reason: "port-mismatch" };
  }

  const isLocalOrigin = originUrl.hostname === "127.0.0.1" || originUrl.hostname === "localhost";
  const isLocalHost = hostNameOnly === "127.0.0.1" || hostNameOnly === "localhost";
  if (isLocalOrigin && isLocalHost) {
    return { ...detail, ok: true, reason: "loopback-match" };
  }
  if (originUrl.hostname === hostNameOnly) {
    return { ...detail, ok: true, reason: "hostname-match" };
  }
  return { ...detail, ok: false, reason: "hostname-mismatch" };
}

/**
 * Validates Same-Origin header for browser connections.
 * Requests without an Origin header (non-browser clients like curl or CLI) pass validation.
 * Host and port MUST match.
 */
export function validateSameOrigin(req: http.IncomingMessage): boolean {
  return checkSameOrigin(req).ok;
}

type AuthLikeRequest = http.IncomingMessage | { url?: string; headers: http.IncomingHttpHeaders };

export interface TokenClassification {
  role: SessionRole;
  /** The request carried a token (query string, Bearer or X-Token). */
  tokenPresent: boolean;
  /** That token matched a currently-issued token. */
  tokenValid: boolean;
}

/** Name of the cookie the phone entry point sets in place of a URL token. */
export const SESSION_COOKIE_NAME = "rc_surface_token";

/**
 * Read one cookie without a parser dependency. Live's extension host is a bare
 * Node runtime, so this stays deliberately small: split on ';', take the first
 * '=' of each pair, ignore malformed entries.
 */
export function readCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    if (!value) return null;
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return null;
}

/**
 * Build the Set-Cookie header that replaces a URL token.
 *
 * SameSite=Lax rather than Strict on purpose: the phone is reached by scanning
 * a QR code or following a shared link, and Strict would withhold the cookie
 * on exactly that top-level navigation while still not buying anything here —
 * Lax already blocks cross-site subresource and POST use.
 */
export function buildSessionCookie(token: string, secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=2592000", // 30 days; a token that outlives its server reads as stale
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function extractToken(req: AuthLikeRequest): string | null {
  // getQueryParam, not `new URL`: see parseOrigin above. When this threw in
  // Live, every client silently authenticated as a viewer and all transport,
  // pad and knob writes were rejected with no visible cause.
  const fromQuery = getQueryParam(req.url, "token");
  if (fromQuery) return fromQuery;

  if (req.headers) {
    const authHeader = req.headers["authorization"];
    if (authHeader && authHeader.startsWith("Bearer ")) {
      return authHeader.slice(7).trim() || null;
    }
    if (typeof req.headers["x-token"] === "string" && req.headers["x-token"]) {
      return req.headers["x-token"];
    }
    // Last, because an explicit token on the request should always win over
    // whatever the browser happens to be carrying.
    const cookieHeader = req.headers["cookie"];
    const fromCookie = readCookie(
      typeof cookieHeader === "string" ? cookieHeader : undefined,
      SESSION_COOKIE_NAME,
    );
    if (fromCookie) return fromCookie;
  }

  return null;
}

/**
 * Resolves the role AND distinguishes "no token" from "token that no longer
 * matches". Tokens are regenerated on every extension start, so a phone
 * reconnecting from a still-open page or a bookmark presents a stale token.
 * Collapsing that into a plain "viewer" leaves the user with a session that
 * looks connected while every live-write is silently rejected.
 */
export function classifyRequestToken(req: AuthLikeRequest): TokenClassification {
  const token = extractToken(req);
  if (!token) return { role: "viewer", tokenPresent: false, tokenValid: false };
  if (timingSafeCompare(token, adminToken)) {
    return { role: "admin", tokenPresent: true, tokenValid: true };
  }
  if (timingSafeCompare(token, controllerToken)) {
    return { role: "controller", tokenPresent: true, tokenValid: true };
  }
  return { role: "viewer", tokenPresent: true, tokenValid: false };
}

/**
 * Resolves the role for an incoming HTTP request or WS connection request.
 */
export function authenticateRequest(req: AuthLikeRequest): SessionRole {
  return classifyRequestToken(req).role;
}
