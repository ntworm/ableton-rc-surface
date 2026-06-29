import * as http from "node:http";
import * as https from "node:https";
import { type AddressInfo } from "node:net";
import { loadCerts, useHttps, httpsOptions } from "./cert.js";
import { handleHttp } from "./http.js";
import { handleUpgrade, wssInit, stopAllWsClients } from "./ws.js";
import { getLanAddresses } from "../util/helpers.js";
import { stopMixSnapshotLoop } from "../live/snapshots.js";

export { useHttps } from "./cert.js";
export let actualPort: number | null = null;
export let actualHttpsPort: number | null = null;
export let serverInstance: http.Server | null = null;
export let httpsServerInstance: https.Server | null = null;

export function setActualPort(p: number | null) { actualPort = p; }
export function setActualHttpsPort(p: number | null) { actualHttpsPort = p; }

export async function startServer(): Promise<void> {
  if (serverInstance !== null) {
    console.log("[ableton-rc-bridge] startServer: already running");
    return;
  }
  await loadCerts();
  await new Promise<void>((resolve, reject) => {
    const srv = http.createServer(async (req, res) => {
      try {
        await handleHttp(req, res);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        console.error(`[ableton-rc-bridge] http error: ${detail}`);
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
          console.error(`[ableton-rc-bridge] https error: ${detail}`);
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
      console.error(`[ableton-rc-bridge] server error: ${err.message}`);
      serverInstance = null;
      httpsServerInstance = null;
      actualPort = null;
      actualHttpsPort = null;
      reject(err);
    };

    srv.on("error", handleError);
    if (httpsSrv) {
      httpsSrv.on("error", handleError);
    }

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
        httpsSrv.listen(targetHttpsPort, "0.0.0.0", () => {
          const httpsAddr = httpsSrv!.address() as AddressInfo | null;
          if (httpsAddr) {
            actualHttpsPort = httpsAddr.port;
            httpsServerInstance = httpsSrv;
            printListenInfo();
            resolve();
          } else {
            reject(new Error("httpsServer.address() returned null"));
          }
        });
        
        httpsSrv.on("error", (err: any) => {
          if ((err as any).code === "EADDRINUSE") {
            httpsSrv!.listen(0, "0.0.0.0", () => {
              const httpsAddr = httpsSrv!.address() as AddressInfo | null;
              if (httpsAddr) {
                actualHttpsPort = httpsAddr.port;
                httpsServerInstance = httpsSrv;
                printListenInfo();
                resolve();
              }
            });
          } else {
            handleError(err);
          }
        });
      } else {
        printListenInfo();
        resolve();
      }
    });

    function printListenInfo(): void {
      const ips = getLanAddresses();
      console.log(`[ableton-rc-bridge] HTTP listening on http://0.0.0.0:${actualPort}`);
      if (actualHttpsPort) {
        console.log(`[ableton-rc-bridge] HTTPS listening on https://0.0.0.0:${actualHttpsPort}`);
      }
      for (const ip of ips) {
        console.log(`[ableton-rc-bridge]   Local Mappings URL: http://${ip}:${actualPort}/static/admin/mappings.html`);
        if (actualHttpsPort) {
          console.log(`[ableton-rc-bridge]   LAN phone URL: https://${ip}:${actualHttpsPort}/`);
        } else {
          console.log(`[ableton-rc-bridge]   LAN phone URL: http://${ip}:${actualPort}/`);
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

  stopMixSnapshotLoop();
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
  console.log("[ableton-rc-bridge] server stopped");
}
