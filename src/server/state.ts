import * as http from "node:http";
import * as https from "node:https";
import { type AddressInfo } from "node:net";
import { loadCerts, useHttps, httpsOptions } from "./cert.js";
import { handleHttp } from "./http.js";
import { handleUpgrade, wssInit, stopAllWsClients } from "./ws.js";
import { getLanAddresses } from "../util/helpers.js";

export { useHttps } from "./cert.js";
export let actualPort: number | null = null;
export let actualHttpsPort: number | null = null;
export let serverInstance: http.Server | null = null;
export let httpsServerInstance: https.Server | null = null;

export function setActualPort(p: number | null) { actualPort = p; }
export function setActualHttpsPort(p: number | null) { actualHttpsPort = p; }

interface ListenableServer {
  listen(port: number, hostname: string): unknown;
  once(event: "error", listener: (err: NodeJS.ErrnoException) => void): unknown;
  once(event: "listening", listener: () => void): unknown;
  off(event: "error", listener: (err: NodeJS.ErrnoException) => void): unknown;
  off(event: "listening", listener: () => void): unknown;
  address(): AddressInfo | string | null;
}

/**
 * Auxiliary helper to bind a server to a preferred port or fallback to a random port
 * if the address is already in use (EADDRINUSE).
 * 
 * NOTE (HTTPS Fallback Bug Fix - P1.2): 
 * In previous versions, the global error listener `srv.on("error", handleError)` was
 * registered before calling srv.listen(). When a port collision (EADDRINUSE) occurred,
 * both the global handler and the local fallback listener would execute. This caused
 * the startup promise to be prematurely rejected before the fallback port could bind.
 * 
 * This helper isolates the initial error listener and only registers the global 
 * `handleError` listener after the port binding succeeds, preventing conflicts.
 */
export function listenOnPreferredOrRandom(
  srv: ListenableServer,
  preferredPort: number,
  host: string,
  fallbackOnAddrInUse = false,
): Promise<number> {
  return new Promise((resolve, reject) => {
    let fallbackTried = false;

    const cleanup = () => {
      srv.off("error", onError);
      srv.off("listening", onListening);
    };

    const onListening = () => {
      cleanup();
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("server.address() returned null"));
        return;
      }
      resolve(addr.port);
    };

    const onError = (err: NodeJS.ErrnoException) => {
      if (fallbackOnAddrInUse && err.code === "EADDRINUSE" && !fallbackTried) {
        fallbackTried = true;
        srv.listen(0, host);
        return;
      }
      cleanup();
      reject(err);
    };

    srv.once("error", onError);
    srv.once("listening", onListening);
    srv.listen(preferredPort, host);
  });
}

export async function startServer(): Promise<void> {
  if (serverInstance !== null) {
    console.log("[ableton-rc-surface] startServer: already running");
    return;
  }
  await loadCerts();
  await new Promise<void>((resolve, reject) => {
    const srv = http.createServer(async (req, res) => {
      try {
        await handleHttp(req, res);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        console.error(`[ableton-rc-surface] http error: ${detail}`);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end(`server error: ${detail}\n`);
        }
      }
    });

    let httpsSrv: https.Server | null = null;
    if (useHttps && httpsOptions) {
      httpsSrv = https.createServer(httpsOptions, async (req, res) => {
        try {
          await handleHttp(req, res);
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          console.error(`[ableton-rc-surface] https error: ${detail}`);
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "text/plain" });
            res.end(`server error: ${detail}\n`);
          }
        }
      });
    }

    wssInit();

    srv.on("upgrade", (req, socket, head) => handleUpgrade(req, socket, head));
    if (httpsSrv) {
      httpsSrv.on("upgrade", (req, socket, head) => handleUpgrade(req, socket, head));
    }

    const handleError = (err: any) => {
      console.error(`[ableton-rc-surface] server error: ${err.message}`);
      serverInstance = null;
      httpsServerInstance = null;
      actualPort = null;
      actualHttpsPort = null;
      reject(err);
    };

    srv.on("error", handleError);

    srv.listen(0, "0.0.0.0", () => {
      const addr = srv.address() as AddressInfo | null;
      if (!addr) {
        reject(new Error("server.address() returned null"));
        return;
      }
      actualPort = addr.port;
      serverInstance = srv;

      if (httpsSrv) {
        const targetHttpsPort = actualPort + 1;
        listenOnPreferredOrRandom(httpsSrv, targetHttpsPort, "0.0.0.0", true)
          .then((port) => {
            actualHttpsPort = port;
            httpsServerInstance = httpsSrv;
            httpsSrv!.on("error", handleError);
            printListenInfo();
            resolve();
          })
          .catch((err) => {
            handleError(err);
          });
      } else {
        printListenInfo();
        resolve();
      }
    });

    function printListenInfo(): void {
      const ips = getLanAddresses();
      console.log(`[ableton-rc-surface] HTTP listening on http://0.0.0.0:${actualPort}`);
      if (actualHttpsPort) {
        console.log(`[ableton-rc-surface] HTTPS listening on https://0.0.0.0:${actualHttpsPort}`);
      }
      for (const ip of ips) {
        console.log(`[ableton-rc-surface]   Local Mappings URL: http://${ip}:${actualPort}/static/admin/mappings.html`);
        if (actualHttpsPort) {
          console.log(`[ableton-rc-surface]   LAN phone URL: https://${ip}:${actualHttpsPort}/`);
        } else {
          console.log(`[ableton-rc-surface]   LAN phone URL: http://${ip}:${actualPort}/`);
        }
      }
    }
  });
}

export async function stopServer(): Promise<void> {
  const srv = serverInstance;
  const httpsSrv = httpsServerInstance;
  if (!srv && !httpsSrv) return;
  serverInstance = null;
  httpsServerInstance = null;
  actualPort = null;
  actualHttpsPort = null;

  stopAllWsClients();

  const promises: Promise<void>[] = [];
  if (srv) {
    promises.push(new Promise<void>((resolve) => {
      srv.close(() => resolve());
    }));
  }
  if (httpsSrv) {
    promises.push(new Promise<void>((resolve) => {
      httpsSrv.close(() => resolve());
    }));
  }
  await Promise.all(promises);
  console.log("[ableton-rc-surface] server stopped");
}
