import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { WebSocketServer } from "ws";

const PORT = 9878;
const staticDir = path.resolve(process.cwd(), "static/phone-v3");

const mimeTypes: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

const server = http.createServer((req, res) => {
  let reqPath = req.url?.split("?")[0] ?? "/";
  if (reqPath === "/") reqPath = "/index.html";
  const filePath = path.join(staticDir, reqPath);

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = mimeTypes[ext] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": contentType });
  fs.createReadStream(filePath).pipe(res);
});

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  ws.send(
    JSON.stringify({
      type: "state",
      tempo: 120,
      isPlaying: false,
      connected: true,
    })
  );

  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.cmd) {
        ws.send(JSON.stringify({ type: "ack", cmd: data.cmd }));
      }
    } catch {}
  });
});

server.listen(PORT, () => {
  console.log(`Surface Playwright Test Server running at http://localhost:${PORT}`);
});
