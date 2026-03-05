import { LabelerServer } from '@skyware/labeler';
import { AtpAgent } from '@atproto/api';
import { Jetstream } from '@skyware/jetstream';
import http from 'http';
import net from 'net';
import fs from 'fs';

// ─── Config ──────────────────────────────────────────────────────────────────
const DID = process.env.LABELER_DID;
const SIGNING_KEY = process.env.SIGNING_KEY;
const LABELER_PASSWORD = process.env.LABELER_PASSWORD;
const SETUP_KEY = process.env.SETUP_KEY || 'change-me';
const PORT = parseInt(process.env.PORT || '3000');
const LABELER_PORT = 14831;
const FIREHOSE_URL = process.env.FIREHOSE_URL || 'wss://jetstream2.us-east.bsky.network/subscribe';
const WANTED_COLLECTION = 'app.bsky.feed.like';

if (!DID || !SIGNING_KEY) {
  console.error('Missing required environment variables: LABELER_DID, SIGNING_KEY');
  process.exit(1);
}

// ─── Type/wing number to word mapping ────────────────────────────────────────
const NUM_TO_WORD = { '1':'one','2':'two','3':'three','4':'four','5':'five','6':'six','7':'seven','8':'eight','9':'nine' };
const WINGS_MAP = { one:['nine','two'], two:['one','three'], three:['two','four'], four:['three','five'], five:['four','six'], six:['five','seven'], seven:['six','eight'], eight:['seven','nine'], nine:['eight','one'] };

// ─── Post rkeys → labels (fill in after making posts on enneagram.blue) ──────
const TYPE_POSTS = [
  { rkey: process.env.RKEY_E1 || '', label: 'type-one' },
  { rkey: process.env.RKEY_E2 || '', label: 'type-two' },
  { rkey: process.env.RKEY_E3 || '', label: 'type-three' },
  { rkey: process.env.RKEY_E4 || '', label: 'type-four' },
  { rkey: process.env.RKEY_E5 || '', label: 'type-five' },
  { rkey: process.env.RKEY_E6 || '', label: 'type-six' },
  { rkey: process.env.RKEY_E7 || '', label: 'type-seven' },
  { rkey: process.env.RKEY_E8 || '', label: 'type-eight' },
  { rkey: process.env.RKEY_E9 || '', label: 'type-nine' },
];
const DELETE_RKEY = process.env.RKEY_DELETE || '';

// ─── Generate all label identifiers ──────────────────────────────────────────
const TYPES = ['one','two','three','four','five','six','seven','eight','nine'];
const SUBTYPES = ['sp','so','sx'];

const ALL_WING_IDS = TYPES.flatMap(t => WINGS_MAP[t].map(w => `type-${t}-wing-${w}`));
const ALL_SUBTYPE_IDS = ALL_WING_IDS.flatMap(w => SUBTYPES.map(s => `${w}-${s}`));
const ALL_LABEL_IDS = new Set([
  ...TYPES.map(t => `type-${t}`),
  ...ALL_WING_IDS,
  ...ALL_SUBTYPE_IDS,
]);

// ─── Label display data ───────────────────────────────────────────────────────
const TYPE_DISPLAY = {
  'type-one':   { name: 'Type 1 · The Reformer',      desc: 'Principled, purposeful, self-controlled, and perfectionistic.' },
  'type-two':   { name: 'Type 2 · The Helper',        desc: 'Caring, interpersonal, demonstrative, and generous.' },
  'type-three': { name: 'Type 3 · The Achiever',      desc: 'Adaptable, excelling, driven, and image-conscious.' },
  'type-four':  { name: 'Type 4 · The Individualist', desc: 'Expressive, dramatic, self-absorbed, and temperamental.' },
  'type-five':  { name: 'Type 5 · The Investigator',  desc: 'Perceptive, innovative, secretive, and isolated.' },
  'type-six':   { name: 'Type 6 · The Loyalist',      desc: 'Engaging, responsible, anxious, and suspicious.' },
  'type-seven': { name: 'Type 7 · The Enthusiast',    desc: 'Spontaneous, versatile, scattered, and acquisitive.' },
  'type-eight': { name: 'Type 8 · The Challenger',    desc: 'Self-confident, decisive, willful, and confrontational.' },
  'type-nine':  { name: 'Type 9 · The Peacemaker',    desc: 'Receptive, reassuring, agreeable, and complacent.' },
};

const WING_DISPLAY = {
  'type-one-wing-nine':   { name: '1w9 · The Idealist',      desc: "More detached and philosophical. The 9-wing softens the One's rigidity with acceptance and a longing for inner peace." },
  'type-one-wing-two':    { name: '1w2 · The Advocate',      desc: "More warm and people-oriented. The 2-wing channels the One's principles into direct service and concern for others." },
  'type-two-wing-one':    { name: '2w1 · The Servant',       desc: "More principled and self-controlled. The 1-wing gives the Two a strong sense of duty and refinement in their giving." },
  'type-two-wing-three':  { name: '2w3 · The Host',          desc: "More ambitious and image-conscious. The 3-wing adds charm and drive, making this subtype highly engaging and sociable." },
  'type-three-wing-two':  { name: '3w2 · The Charmer',       desc: "More people-pleasing and interpersonal. The 2-wing makes the Three warmer, more relational, and attuned to others' feelings." },
  'type-three-wing-four': { name: '3w4 · The Professional',  desc: "More introspective and image-refined. The 4-wing gives the Three depth, artistic sensibility, and a desire for authenticity." },
  'type-four-wing-three': { name: '4w3 · The Aristocrat',    desc: "More extroverted and achievement-oriented. The 3-wing energizes the Four toward expression, performance, and external recognition." },
  'type-four-wing-five':  { name: '4w5 · The Bohemian',      desc: "More withdrawn and intellectual. The 5-wing deepens the Four's introspection, adding a reclusive, cerebral quality." },
  'type-five-wing-four':  { name: '5w4 · The Iconoclast',    desc: "More individualistic and emotionally expressive. The 4-wing gives the Five creativity, aesthetic sensitivity, and deeper self-awareness." },
  'type-five-wing-six':   { name: '5w6 · The Problem Solver',desc: "More loyal and socially engaged. The 6-wing anchors the Five in practical thinking, collaboration, and concern for systems." },
  'type-six-wing-five':   { name: '6w5 · The Defender',      desc: "More private and independent. The 5-wing gives the Six greater self-reliance and analytical depth to manage anxiety." },
  'type-six-wing-seven':  { name: '6w7 · The Buddy',         desc: "More outgoing and optimistic. The 7-wing lightens the Six's anxiety, adding humor, enthusiasm, and a love of adventure." },
  'type-seven-wing-six':  { name: '7w6 · The Entertainer',   desc: "More responsible and relationship-focused. The 6-wing grounds the Seven's enthusiasm with loyalty and a need for security." },
  'type-seven-wing-eight':{ name: '7w8 · The Realist',       desc: "More assertive and pragmatic. The 8-wing gives the Seven a bold, driven edge and a willingness to go after what they want." },
  'type-eight-wing-seven':{ name: '8w7 · The Maverick',      desc: "More expansive and pleasure-seeking. The 7-wing makes the Eight more visionary, charismatic, and energetically restless." },
  'type-eight-wing-nine': { name: '8w9 · The Bear',          desc: "More calm and receptive. The 9-wing softens the Eight's intensity with patience and a more measured approach to power." },
  'type-nine-wing-eight': { name: '9w8 · The Referee',       desc: "More assertive and energetic. The 8-wing gives the Nine greater confidence, decisiveness, and a stronger sense of presence." },
  'type-nine-wing-one':   { name: '9w1 · The Dreamer',       desc: "More principled and orderly. The 1-wing channels the Nine's acceptance into quiet idealism and a gentle moral compass." },
};

const SUBTYPE_NAMES = { sp: 'SP · Self-Preservation', so: 'SO · Social', sx: 'SX · Sexual' };

function buildAllLabels() {
  const labels = [];
  for (const t of TYPES) {
    const id = `type-${t}`;
    labels.push({ identifier: id, severity: 'inform', blurs: 'none', defaultSetting: 'warn', adultOnly: false,
      locales: [{ lang: 'en', name: TYPE_DISPLAY[id].name, description: TYPE_DISPLAY[id].desc }] });
  }
  for (const wingId of ALL_WING_IDS) {
    const d = WING_DISPLAY[wingId];
    labels.push({ identifier: wingId, severity: 'inform', blurs: 'none', defaultSetting: 'warn', adultOnly: false,
      locales: [{ lang: 'en', name: d.name, description: d.desc }] });
  }
  for (const wingId of ALL_WING_IDS) {
    for (const s of SUBTYPES) {
      const id = `${wingId}-${s}`;
      const wingName = WING_DISPLAY[wingId].name;
      labels.push({ identifier: id, severity: 'inform', blurs: 'none', defaultSetting: 'warn', adultOnly: false,
        locales: [{ lang: 'en', name: `${wingName} · ${SUBTYPE_NAMES[s]}`, description: `${wingName} with ${SUBTYPE_NAMES[s]} instinct.` }] });
    }
  }
  return labels;
}

// ─── Labeler server ───────────────────────────────────────────────────────────
const labelerServer = new LabelerServer({ did: DID, signingKey: SIGNING_KEY, dbPath: '/data/labels.db' });

// ─── Label helpers ────────────────────────────────────────────────────────────
// Legacy label identifiers from before the rename (e1, e1w2, e1w2-sp, etc.)
const LEGACY_LABEL_IDS = [];
const LEGACY_WINGS = { 1:[9,2],2:[1,3],3:[2,4],4:[3,5],5:[4,6],6:[5,7],7:[6,8],8:[7,9],9:[8,1] };
for (let t = 1; t <= 9; t++) {
  LEGACY_LABEL_IDS.push(`e${t}`);
  for (const w of LEGACY_WINGS[t]) {
    LEGACY_LABEL_IDS.push(`e${t}w${w}`);
    for (const s of ['sp','so','sx']) LEGACY_LABEL_IDS.push(`e${t}w${w}-${s}`);
  }
}

async function removeExistingEnneagramLabels(did) {
  const toNegate = [...ALL_LABEL_IDS, ...LEGACY_LABEL_IDS];
  await labelerServer.createLabels({ uri: did }, { negate: toNegate });
  console.log(`Negated all enneagram labels for ${did}`);
}

async function applyLabel(did, label) {
  await removeExistingEnneagramLabels(did);
  await labelerServer.createLabel({ uri: did, val: label });
  console.log(`Applied label ${label} to ${did}`);
}

// ─── Token verification ───────────────────────────────────────────────────────
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

// ─── Jetstream firehose ───────────────────────────────────────────────────────
let cursor = 0;
try {
  cursor = Number(fs.readFileSync('/data/cursor.txt', 'utf8'));
  console.log(`Cursor loaded: ${cursor}`);
} catch {
  cursor = Math.floor(Date.now() * 1000);
  console.log(`No cursor found, starting from now: ${cursor}`);
}

const jetstream = new Jetstream({
  wantedCollections: [WANTED_COLLECTION],
  endpoint: FIREHOSE_URL,
  cursor,
});

jetstream.on('open', () => {
  console.log(`Connected to Jetstream at ${FIREHOSE_URL}`);
  setInterval(() => {
    if (jetstream.cursor) {
      fs.writeFile('/data/cursor.txt', jetstream.cursor.toString(), err => {
        if (err) console.error('Error saving cursor:', err);
      });
    }
  }, 10000);
});
jetstream.on('error', err => console.error('Jetstream error:', err));
jetstream.onCreate(WANTED_COLLECTION, event => {
  if (event.commit?.record?.subject?.uri?.includes(DID)) {
    const rkey = event.commit.record.subject.uri.split('/').pop();
    if (DELETE_RKEY && rkey === DELETE_RKEY) {
      removeExistingEnneagramLabels(event.did).catch(console.error);
      return;
    }
    const match = TYPE_POSTS.find(p => p.rkey && p.rkey === rkey);
    if (match) {
      applyLabel(event.did, match.label).catch(console.error);
    }
  }
});
jetstream.start();

// ─── HTTP + WebSocket proxy ───────────────────────────────────────────────────
const healthServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost`);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (url.pathname === '/' || url.pathname === '/xrpc/_health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  if (url.pathname === '/apply-label' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { accessJwt, label } = JSON.parse(body);
        if (!accessJwt || !label) throw new Error('Missing accessJwt or label');
        if (!ALL_LABEL_IDS.has(label)) throw new Error(`Invalid label: ${label}`);
        const did = await verifyToken(accessJwt);
        await applyLabel(did, label);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, did, label }));
      } catch (err) {
        console.error('Apply label error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (url.pathname === '/remove-label' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { accessJwt } = JSON.parse(body);
        if (!accessJwt) throw new Error('Missing accessJwt');
        const did = await verifyToken(accessJwt);
        await removeExistingEnneagramLabels(did);
        // Clean up self-labels too
        const getRes = await fetch(`https://bsky.social/xrpc/com.atproto.repo.getRecord?repo=${did}&collection=app.bsky.actor.profile&rkey=self`, {
          headers: { 'Authorization': `Bearer ${accessJwt}` }
        });
        if (getRes.ok) {
          const existing = await getRes.json();
          const record = existing.value || {};
          record.$type = record.$type || 'app.bsky.actor.profile';
          const filtered = (record.labels?.values || []).filter(l => !l.val.match(/^(e[1-9]|type-)/));
          record.labels = { $type: 'com.atproto.label.defs#selfLabels', values: filtered };
          await fetch('https://bsky.social/xrpc/com.atproto.repo.putRecord', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${accessJwt}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ repo: did, collection: 'app.bsky.actor.profile', rkey: 'self', record })
          });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        console.error('Remove label error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (url.pathname === '/setup-labels') {
    if (url.searchParams.get('key') !== SETUP_KEY) {
      res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden' })); return;
    }
    try {
      const agent = new AtpAgent({ service: 'https://bsky.social' });
      await agent.login({ identifier: DID, password: LABELER_PASSWORD });
      const existing = await agent.api.com.atproto.repo.getRecord({
        repo: DID, collection: 'app.bsky.labeler.service', rkey: 'self',
      }).catch(() => null);
      const record = existing?.data?.value || {
        $type: 'app.bsky.labeler.service',
        policies: { labelValues: [], labelValueDefinitions: [] },
        createdAt: new Date().toISOString(),
      };
      const allLabels = buildAllLabels();
      record.policies = {
        labelValues: allLabels.map(l => l.identifier),
        labelValueDefinitions: allLabels,
      };
      record.subjectTypes = ['account'];
      record.subjectCollections = ['app.bsky.actor.profile'];
      await agent.api.com.atproto.repo.putRecord({
        repo: DID, collection: 'app.bsky.labeler.service', rkey: 'self', record,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: `Defined ${allLabels.length} labels.` }));
    } catch (err) {
      res.writeHead(500); res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Proxy to Skyware
  const options = { hostname: '127.0.0.1', port: LABELER_PORT, path: req.url, method: req.method, headers: req.headers };
  const proxy = http.request(options, proxyRes => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });
  proxy.on('error', () => { res.writeHead(502); res.end(JSON.stringify({ error: 'Bad Gateway' })); });
  req.pipe(proxy, { end: true });
});

healthServer.on('upgrade', (req, socket, head) => {
  console.log(`WebSocket upgrade: ${req.url}`);
  const target = net.connect(LABELER_PORT, '127.0.0.1', () => {
    target.write(
      `GET ${req.url} HTTP/1.1\r\nHost: 127.0.0.1:${LABELER_PORT}\r\n` +
      Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') +
      '\r\n\r\n'
    );
    target.write(head);
    socket.pipe(target);
    target.pipe(socket);
  });
  target.on('error', () => socket.destroy());
  socket.on('error', () => target.destroy());
});

labelerServer.start(LABELER_PORT, (error, address) => {
  if (error) { console.error('Failed to start labeler:', error); process.exit(1); }
  console.log(`Labeler server listening on ${address}`);
});

healthServer.listen(PORT, () => console.log(`Proxy server listening on port ${PORT}`));

process.on('SIGTERM', () => {
  if (jetstream.cursor) fs.writeFileSync('/data/cursor.txt', jetstream.cursor.toString());
  jetstream.close();
  labelerServer.stop();
  healthServer.close();
});
