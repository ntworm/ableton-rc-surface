import { networkInterfaces } from "node:os";
import { type ExtensionContext } from "../context.js";

export function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v;
}

export function clampN11(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v <= -1) return -1;
  if (v >= 1) return 1;
  return v;
}

export function isArrayLike(o: unknown): o is { length: number; [n: number]: unknown } {
  if (!o || typeof o !== "object") return false;
  const l = (o as { length?: unknown }).length;
  return typeof l === "number" && Number.isFinite(l) && l >= 0;
}

export async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${label}`)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

export function getLanAddresses(): string[] {
  const interfaces = networkInterfaces();
  const out: string[] = [];
  for (const addrs of Object.values(interfaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === "IPv4" && !addr.internal) {
        out.push(addr.address);
      }
    }
  }
  return out;
}

export function isRfc1918(ip: string): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export function pickLanIps(ips: string[]): { primary: string; others: string[] } {
  const rfc = ips.filter(isRfc1918);
  if (rfc.length === 0) {
    return { primary: ips[0] ?? "127.0.0.1", others: [] };
  }
  const rank = (ip: string): number => {
    if (ip.startsWith("192.168.")) return 0;
    if (ip.startsWith("10.")) return 1;
    return 2; // 172.16-31
  };
  const sorted = [...rfc].sort((a, b) => rank(a) - rank(b));
  const primary = sorted[0];
  if (!primary) return { primary: "127.0.0.1", others: [] };
  return { primary, others: sorted.slice(1) };
}

export async function showInfoDialog(
  context: ExtensionContext,
  message: string,
): Promise<void> {
  const safe = message
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const html = `<!DOCTYPE html>
<html><head><style>
*,*::before,*::after{box-sizing:border-box}*{margin:0}
:root{--bg:hsl(0,0%,21%);--text:hsl(0,0%,71%);--ctrl:hsl(0,0%,16%);--border:hsl(0,0%,7%);--accent:hsl(31,100%,67%)}
html{background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:12px;height:100%}
body{padding:1.5em;height:100%;display:flex;flex-direction:column;justify-content:center;align-items:center;gap:1em}
p{text-align:center;line-height:1.5}
.actions{display:flex;justify-content:flex-end;width:100%}
.btn{font-size:1rem;background:var(--ctrl);color:var(--text);border:1px solid var(--border);height:24px;padding:0 1.5em;border-radius:1em;cursor:pointer}
.btn:active{background:var(--accent);color:hsl(0,0%,7%)}
</style></head>
<body>
<p>${safe}</p>
<div class="actions">
  <button class="btn" onclick="send('ok')">OK</button>
</div>
<script>function send(v){const m={method:"close_and_send",params:[v]};if(window.webkit?.messageHandlers?.live)window.webkit.messageHandlers.live.postMessage(m);else if(window.chrome?.webview)window.chrome.webview.postMessage(m);}</script>
</body></html>`;
  await context.ui.showModalDialog(`data:text/html,${encodeURIComponent(html)}`, 380, 180);
}
