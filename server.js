import { LabelerServer } from "@skyware/labeler";
import http from "http";

// ─── Config ──────────────────────────────────────────────────────────────────
const LABELER_DID = process.env.LABELER_DID;
const SIGNING_KEY = process.env.SIGNING_KEY;
const PORT = parseInt(process.env.PORT || "3000");
const LABELER_PORT = 14831;

if (!LABELER_DID || !SIGNING_KEY) {
  console.error("Missing required environment variables: LABELER_DID, SIGNING_KEY");
  process.exit(1);
}

// ─── Skyware Labeler Server ───────────────────────────────────────────────────
const server = new LabelerServer({
  did: LABELER_DID,
  signingKey: SIGNING_KEY,
});

server.start(LABELER_PORT, (error, address) => {
  if (error) {
    console.error("Failed to start labeler server:", error);
    process.exit(1);
  }
  console.log(`Labeler server listening on ${address}`);
});

// ─── HTTP health check server for Railway ────────────────────────────────────
// Railway needs a standard HTTP server to confirm the service is alive.
// This proxies /xrpc/* requests to the Skyware labeler and handles health checks.
const healthServer = http.createServer((req, res) => {
  if (req.url === "/xrpc/_health" || req.url === "/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ version: "1.0.0", status: "ok" }));
    return;
  }

  // Proxy all other requests to the Skyware labeler port
  const options = {
    hostname: "127.0.0.1",
    port: LABELER_PORT,
    path: req.url,
    method: req.method,
    headers: req.headers,
  };

  const proxy = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });

  proxy.on("error", (err) => {
    console.error("Proxy error:", err);
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Bad Gateway" }));
  });

  req.pipe(proxy, { end: true });
});

healthServer.listen(PORT, () => {
  console.log(`Health/proxy server listening on port ${PORT}`);
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────
process.on("SIGTERM", () => {
  console.log("Shutting down...");
  server.close();
  healthServer.close();
});
