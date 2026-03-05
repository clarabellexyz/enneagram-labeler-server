import { LabelerServer } from "@skyware/labeler";
import { AtpAgent } from "@atproto/api";
import http from "http";
import net from "net";

// ─── Config ──────────────────────────────────────────────────────────────────
const LABELER_DID = process.env.LABELER_DID;
const SIGNING_KEY = process.env.SIGNING_KEY;
const LABELER_PASSWORD = process.env.LABELER_PASSWORD;
const SETUP_KEY = process.env.SETUP_KEY || "change-me";
const PORT = parseInt(process.env.PORT || "3000");
const LABELER_PORT = 14831;

if (!LABELER_DID || !SIGNING_KEY) {
  console.error("Missing required environment variables: LABELER_DID, SIGNING_KEY");
  process.exit(1);
}

// ─── Valid label identifiers ──────────────────────────────────────────────────
const WINGS = ["e1w9","e1w2","e2w1","e2w3","e3w2","e3w4","e4w3","e4w5",
               "e5w4","e5w6","e6w5","e6w7","e7w6","e7w8","e8w7","e8w9","e9w8","e9w1"];

const VALID_LABELS = new Set([
  "e1","e2","e3","e4","e5","e6","e7","e8","e9",
  ...WINGS,
  ...WINGS.flatMap(w => [`${w}-sp`,`${w}-so`,`${w}-sx`])
]);

// ─── Label definitions ────────────────────────────────────────────────────────
const WING_NAMES = {
  "e1w9":"1w9 · The Idealist","e1w2":"1w2 · The Advocate",
  "e2w1":"2w1 · The Servant","e2w3":"2w3 · The Host",
  "e3w2":"3w2 · The Charmer","e3w4":"3w4 · The Professional",
  "e4w3":"4w3 · The Aristocrat","e4w5":"4w5 · The Bohemian",
  "e5w4":"5w4 · The Iconoclast","e5w6":"5w6 · The Problem Solver",
  "e6w5":"6w5 · The Defender","e6w7":"6w7 · The Buddy",
  "e7w6":"7w6 · The Entertainer","e7w8":"7w8 · The Realist",
  "e8w7":"8w7 · The Maverick","e8w9":"8w9 · The Bear",
  "e9w8":"9w8 · The Referee","e9w1":"9w1 · The Dreamer",
};
const TYPE_LABELS = [
  { identifier:"e1", name:"Type 1 · The Reformer",      description:"Principled, purposeful, self-controlled, and perfectionistic." },
  { identifier:"e2", name:"Type 2 · The Helper",        description:"Caring, interpersonal, demonstrative, and generous." },
  { identifier:"e3", name:"Type 3 · The Achiever",      description:"Adaptable, excelling, driven, and image-conscious." },
  { identifier:"e4", name:"Type 4 · The Individualist", description:"Expressive, dramatic, self-absorbed, and temperamental." },
  { identifier:"e5", name:"Type 5 · The Investigator",  description:"Perceptive, innovative, secretive, and isolated." },
  { identifier:"e6", name:"Type 6 · The Loyalist",      description:"Engaging, responsible, anxious, and suspicious." },
  { identifier:"e7", name:"Type 7 · The Enthusiast",    description:"Spontaneous, versatile, scattered, and acquisitive." },
  { identifier:"e8", name:"Type 8 · The Challenger",    description:"Self-confident, decisive, willful, and confrontational." },
  { identifier:"e9", name:"Type 9 · The Peacemaker",    description:"Receptive, reassuring, agreeable, and complacent." },
];
const WING_LABELS = WINGS.map(w => ({
  identifier: w, name: WING_NAMES[w],
  description: `Enneagram ${w.replace("e","").replace("w"," with wing ")}.`,
}));
const SUBTYPE_LABELS = WINGS.flatMap(w => [
  { identifier:`${w}-sp`, name:`${w.replace("e","")} SP`, description:`${w.replace("e","").replace("w"," w")} · Self-Preservation subtype.` },
  { identifier:`${w}-so`, name:`${w.replace("e","")} SO`, description:`${w.replace("e","").replace("w"," w")} · Social subtype.` },
  { identifier:`${w}-sx`, name:`${w.replace("e","")} SX`, description:`${w.replace("e","").replace("w"," w")} · Sexual subtype.` },
]);
const ALL_LABELS = [...TYPE_LABELS, ...WING_LABELS, ...SUBTYPE_LABELS];

// ─── Skyware Labeler Server ───────────────────────────────────────────────────
const server = new LabelerServer({
  did: LABELER_DID,
  signingKey: SIGNING_KEY,
  dbPath: "/data/labels.db",
});

server.start(LABELER_PORT, (error, address) => {
  if (error) {
    console.error("Failed to start labeler server:", error);
    process.exit(1);
  }
  console.log(`Labeler server listening on ${address}`);
});

// ─── Helper: verify token ─────────────────────────────────────────────────────
async function verifyToken(accessJwt) {
  const payload = JSON.parse(Buffer.from(accessJwt.split('.')[1], 'base64').toString());
  const did = payload.sub;
  if (!did || !did.startsWith('did:')) throw new Error('Invalid token');
  const res = await fetch('https://bsky.social/xrpc/com.atproto.server.getSession', {
    headers: { 'Authorization': `Bearer ${accessJwt}` }
  });
  if (!res.ok) throw new Error('Invalid or expired token');
  const data = await res.json();
  if (data.did !== did) throw new Error('Token DID mismatch');
  return did;
}

// ─── Helper: remove existing enneagram labels ─────────────────────────────────
async function removeExistingLabels(did) {
  try {
    const labels = await server.queryLabels({ subjects: [did] });
    for (const label of labels) {
      if (VALID_LABELS.has(label.val) && !label.neg) {
        await server.createLabel({ uri: did, val: label.val, neg: true });
      }
    }
  } catch (err) {
    console.log("Could not query existing labels, proceeding:", err.message);
  }
}

// ─── HTTP + WebSocket proxy server ───────────────────────────────────────────
const healthServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost`);

  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check
  if (url.pathname === "/xrpc/_health" || url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ version: "1.0.0", status: "ok" }));
    return;
  }

  // Apply label endpoint
  if (url.pathname === "/apply-label" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const { accessJwt, label } = JSON.parse(body);
        if (!accessJwt || !label) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Missing accessJwt or label" }));
          return;
        }
        if (!VALID_LABELS.has(label)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid label identifier" }));
          return;
        }
        const userDid = await verifyToken(accessJwt);
        console.log(`Applying label "${label}" to ${userDid}`);
        await removeExistingLabels(userDid);
        await server.createLabel({ uri: userDid, val: label });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, did: userDid, label }));
      } catch (err) {
        console.error("Apply label error:", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Remove label endpoint
  if (url.pathname === "/remove-label" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const { accessJwt } = JSON.parse(body);
        if (!accessJwt) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Missing accessJwt" }));
          return;
        }
        const userDid = await verifyToken(accessJwt);
        console.log(`Removing labels for ${userDid}`);
        await removeExistingLabels(userDid);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, did: userDid }));
      } catch (err) {
        console.error("Remove label error:", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Setup labels endpoint
  if (url.pathname === "/setup-labels") {
    const key = url.searchParams.get("key");
    if (key !== SETUP_KEY) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Forbidden" }));
      return;
    }
    if (!LABELER_PASSWORD) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "LABELER_PASSWORD not set" }));
      return;
    }
    try {
      const agent = new AtpAgent({ service: "https://bsky.social" });
      await agent.login({ identifier: LABELER_DID, password: LABELER_PASSWORD });
      const existing = await agent.api.com.atproto.repo.getRecord({
        repo: LABELER_DID, collection: "app.bsky.labeler.service", rkey: "self",
      }).catch(() => null);
      const record = existing?.data?.value || {
        $type: "app.bsky.labeler.service",
        policies: { labelValues: [], labelValueDefinitions: [] },
        createdAt: new Date().toISOString(),
      };
      record.policies = {
        labelValues: ALL_LABELS.map(l => l.identifier),
        labelValueDefinitions: ALL_LABELS.map(l => ({
          identifier: l.identifier, severity: "inform", blurs: "none",
          defaultSetting: "warn", adultOnly: false,
          locales: [{ lang: "en", name: l.name, description: l.description }]
        }))
      };
      await agent.api.com.atproto.repo.putRecord({
        repo: LABELER_DID, collection: "app.bsky.labeler.service",
        rkey: "self", record,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, message: `Defined ${ALL_LABELS.length} labels.` }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Proxy all other HTTP requests to Skyware
  const options = {
    hostname: "127.0.0.1", port: LABELER_PORT,
    path: req.url, method: req.method, headers: req.headers,
  };
  const proxy = http.request(options, proxyRes => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });
  proxy.on("error", err => {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Bad Gateway" }));
  });
  req.pipe(proxy, { end: true });
});

// ─── WebSocket proxy — critical for subscribeLabels ───────────────────────────
healthServer.on("upgrade", (req, socket, head) => {
  console.log(`WebSocket upgrade: ${req.url}`);
  const target = net.connect(LABELER_PORT, "127.0.0.1", () => {
    target.write(
      `GET ${req.url} HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${LABELER_PORT}\r\n` +
      Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join("\r\n") +
      `\r\n\r\n`
    );
    target.write(head);
    socket.pipe(target);
    target.pipe(socket);
  });
  target.on("error", err => {
    console.error("WebSocket proxy error:", err);
    socket.destroy();
  });
  socket.on("error", () => target.destroy());
});

healthServer.listen(PORT, () => {
  console.log(`Proxy server listening on port ${PORT}`);
});

process.on("SIGTERM", () => {
  server.close();
  healthServer.close();
});
