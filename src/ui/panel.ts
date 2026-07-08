import * as fs from "node:fs/promises";
import * as path from "node:path";
import { initialize, type ActivationContext } from "@ableton-extensions/sdk";
import { actualPort, serverInstance } from "../server/state.js";
import { startServer, stopServer } from "../server/state.js";

/**
 * Panel wiring extracted from src/extension.ts so the activation entry
 * point can stay slim. Behaviour is preserved 1:1 — the modal served when
 * the server is up is fetched over HTTP (avoids the WebKit cross-origin
 * WebSocket problem that a `data:` URI hits), and a `data:` URI is built
 * inline when the server is down so the user can still click Start.
 */

type ModalContext = ReturnType<typeof initialize>;

/**
 * Open the unified RC Surface panel modal and dispatch the action the user
 * pressed inside it. Loops up to 24 turns so the same panel can keep
 * returning actions (start, stop, restart, mappings, close) without
 * needing re-open from the menu.
 */
export async function showPanelDialog(
  context: ModalContext,
  callbacks: {
    startServer: () => Promise<void>;
    stopServer: () => Promise<void>;
    showMappingDialog: (context: ModalContext) => Promise<void>;
    showInfoDialog: (context: ModalContext, message: string) => Promise<void>;
  },
): Promise<void> {
  for (let turn = 0; turn < 24; turn++) {
    let action: string;
    try {
      action = await renderPanelDialog(context);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`[ableton-rc-surface] panel dialog error: ${detail}`);
      return;
    }
    if (action === "close" || !action) return;
    try {
      if (action === "start" && serverInstance === null) {
        await callbacks.startServer();
      } else if (action === "stop" && serverInstance !== null) {
        await callbacks.stopServer();
      } else if (action === "restart") {
        await callbacks.stopServer();
        await callbacks.startServer();
      } else if (action === "mappings") {
        await callbacks.showMappingDialog(context);
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`[ableton-rc-surface] panel action "${action}" failed: ${detail}`);
      await callbacks.showInfoDialog(context, `Action failed: ${detail}`);
      return;
    }
  }
}

/**
 * Render one panel modal. Reads the bundled HTML/CSS/JS from disk and
 * falls back to a `data:` URI when the server is down (so the Start
 * button is still reachable from the menu).
 */
async function renderPanelDialog(context: ModalContext): Promise<string> {
  const isRunning = serverInstance !== null;
  const port = actualPort;

  if (isRunning && port !== null) {
    const url = `http://127.0.0.1:${port}/static/panel/index.html`;
    return await context.ui.showModalDialog(url, 900, 820);
  }

  const panelDir = path.join(__dirname, "static/panel");
  let html = "";
  try {
    html = await fs.readFile(path.join(panelDir, "index.html"), "utf8");
    const css = await fs.readFile(path.join(panelDir, "style.css"), "utf8");
    const js = await fs.readFile(path.join(panelDir, "app.js"), "utf8");
    const qrJs = await fs.readFile(path.join(panelDir, "qrcode.js"), "utf8");

    html = html.replace('<link rel="stylesheet" href="style.css">', `<style>${css}</style>`);
    html = html.replace('<script src="qrcode.js"></script>', `<script>${qrJs}</script>`);
    html = html.replace('<script src="app.js"></script>', `<script>${js}</script>`);

    const injection = `
      <script>
        window.INITIAL_PORT = null;
        window.INITIAL_IS_RUNNING = false;
        window.INITIAL_CLIENTS = [];
      </script>
    `;
    html = html.replace('<body>', `<body>${injection}`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    html = `<!DOCTYPE html><html><body style="background:#1c1c1e;color:#fff;padding:20px;font-family:sans-serif"><h3>Failed to load panel files: ${detail}</h3></body></html>`;
  }

  return await context.ui.showModalDialog(`data:text/html,${encodeURIComponent(html)}`, 900, 820);
}

/**
 * Open the mappings admin modal. Requires the server to be running (the
 * admin UI is served from it). Logs and returns silently otherwise.
 */
export async function showMappingDialog(context: ModalContext): Promise<void> {
  const port = actualPort ?? 0;
  if (!port) {
    console.error("[ableton-rc-surface] showMappingDialog: server not running, cannot open dialog");
    return;
  }
  const url = `http://127.0.0.1:${port}/static/admin/mappings.html`;
  try {
    await context.ui.showModalDialog(url, 920, 640);
  } catch (err) {
    console.error(`[ableton-rc-surface] showMappingDialog error: ${err}`);
  }
}

/**
 * Small HTML popup used by the panel action error path. Renders an `OK`
 * button that posts `close_and_send` back through the Live webkit bridge.
 */
export async function showInfoDialog(
  context: ModalContext,
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

/**
 * Register the panel command with the Live UI and hook the Scene +
 * track/clip context-menu entries to open the same modal. Takes the
 * already-initialised extension context so the bootstrap can keep a
 * single `initialize()` call at the top of activate().
 */
export function registerPanelCommand(context: ReturnType<typeof initialize>): void {
  void context.commands.registerCommand("abletonRcSurface.panel", async () => {
    await showPanelDialog(context, {
      startServer,
      stopServer,
      showMappingDialog,
      showInfoDialog,
    });
  });
  const SCOPES = [
    "MidiTrack",
    "AudioTrack",
    "MidiClip",
    "AudioClip",
    "ClipSlot",
    "Scene",
  ] as const;
  for (const scope of SCOPES) {
    void context.ui.registerContextMenuAction(scope, "RC Surface: Panel", "abletonRcSurface.panel");
  }
}
