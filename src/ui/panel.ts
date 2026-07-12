// Copyright © 2026 Gabriel Worm
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Source: https://github.com/ntworm/ableton-rc-surface
//
// This file is part of Ableton RC Surface, distributed under the
// PolyForm Noncommercial License 1.0.0. You may obtain a copy of
// the License at https://polyformproject.org/licenses/noncommercial/1.0.0
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { initialize, type ActivationContext } from "@ableton-extensions/sdk";
import { actualPort, serverInstance } from "../server/state.js";
import { startServer, stopServer } from "../server/state.js";
import { showInfoDialog } from "../util/helpers.js";

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
