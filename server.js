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

// ─── Post rkeys → labels (fill these in after making posts on enneagram.blue) ─
// Format: { rkey: 'post-rkey-here', label: 'e1' }
// Leave rkey as empty string until you've made the posts
const TYPE_POSTS = [
  { rkey: process.env.RKEY_E1 || '', label: 'e1' },
  { rkey: process.env.RKEY_E2 || '', label: 'e2' },
  { rkey: process.env.RKEY_E3 || '', label: 'e3' },
  { rkey: process.env.RKEY_E4 || '', label: 'e4' },
  { rkey: process.env.RKEY_E5 || '', label: 'e5' },
  { rkey: process.env.RKEY_E6 || '', label: 'e6' },
  { rkey: process.env.RKEY_E7 || '', label: 'e7' },
  { rkey: process.env.RKEY_E8 || '', label: 'e8' },
  { rkey: process.env.RKEY_E9 || '', label: 'e9' },
];

const DELETE_RKEY = process.env.RKEY_DELETE || '';

// ─── Label data ───────────────────────────────────────────────────────────────
const WINGS = ['e1w9','e1w2','e2w1','e2w3','e3w2','e3w4','e4w3','e4w5',
               'e5w4','e5w6','e6w5','e6w7','e7w6','e7w8','e8w7','e8w9','e9w8','e9w1'];

const VALID_LABELS = new Set([
  'e1','e2','e3','e4','e5','e6','e7','e8','e9',
  ...WINGS,
  ...WINGS.flatMap(w => [`${w}-sp`,`${w}-so`,`${w}-sx`])
]);

const WING_NAMES = {
  'e1w9':'1w9 · The Idealist','e1w2':'1w2 · The Advocate',
  'e2w1':'2w1 · The Servant','e2w3':'2w3 · The Host',
  'e3w2':'3w2 · The Charmer','e3w4':'3w4 · The Professional',
  'e4w3':'4w3 · The Aristocrat','e4w5':'4w5 · The Bohemian',
  'e5w4':'5w4 · The Iconoclast','e5w6':'5w6 · The Problem Solver',
  'e6w5':'6w5 · The Defender','e6w7':'6w7 · The Buddy',
  'e7w6':'7w6 · The Entertainer','e7w8':'7w8 · The Realist',
  'e8w7':'8w7 · The Maverick','e8w9':'8w9 · The Bear',
  'e9w8':'9w8 · The Referee','e9w1':'9w1 · The Dreamer',
};

const WING_DESCRIPTIONS = {
  'e1w9': "More detached and philosophical. The 9-wing softens the One's rigidity with acceptance and a longing for inner peace.",
  'e1w2': "More warm and people-oriented. The 2-wing channels the One's principles into direct service and concern for others.",
  'e2w1': "More principled and self-controlled. The 1-wing gives the Two a strong sense of duty and refinement in their giving.",
  'e2w3': "More ambitious and image-conscious. The 3-wing adds charm and drive, making this subtype highly engaging and sociable.",
  'e3w2': "More people-pleasing and interpersonal. The 2-wing makes the Three warmer, more relational, and attuned to others' feelings.",
  'e3w4': "More introspective and image-refined. The 4-wing gives the Three depth, artistic sensibility, and a desire for authenticity.",
  'e4w3': "More extroverted and achievement-oriented. The 3-wing energizes the Four toward expression, performance, and external recognition.",
  'e4w5': "More withdrawn and intellectual. The 5-wing deepens the Four's introspection, adding a reclusive, cerebral quality.",
  'e5w4': "More individualistic and emotionally expressive. The 4-wing gives the Five creativity, aesthetic sensitivity, and deeper self-awareness.",
  'e5w6': "More loyal and socially engaged. The 6-wing anchors the Five in practical thinking, collaboration, and concern for systems.",
  'e6w5': "More private and independent. The 5-wing gives the Six greater self-reliance and analytical depth to manage anxiety.",
  'e6w7': "More outgoing and optimistic. The 7-wing lightens the Six's anxiety, adding humor, enthusiasm, and a love of adventure.",
  'e7w6': "More responsible and relationship-focused. The 6-wing grounds the Seven's enthusiasm with loyalty and a need for security.",
  'e7w8': "More assertive and pragmatic. The 8-wing gives the Seven a bold, driven edge and a willingness to go after what they want.",
  'e8w7': "More expansive and pleasure-seeking. The 7-wing makes the Eight more visionary, charismatic, and energetically restless.",
  'e8w9': "More calm and receptive. The 9-wing softens the Eight's intensity with patience and a more measured approach to power.",
  'e9w8': "More assertive and energetic. The 8-wing gives the Nine greater confidence, decisiveness, and a stronger sense of presence.",
  'e9w1': "More principled and orderly. The 1-wing channels the Nine's acceptance into quiet idealism and a gentle moral compass.",
};

const TYPE_LABELS = [
  { identifier:'e1', name:'Type 1 · The Reformer',      description:'Principled, purposeful, self-controlled, and perfectionistic.' },
  { identifier:'e2', name:'Type 2 · The Helper',        description:'Caring, interpersonal, demonstrative, and generous.' },
  { identifier:'e3', name:'Type 3 · The Achiever',      description:'Adaptable, excelling, driven, and image-conscious.' },
  { identifier:'e4', name:'Type 4 · The Individualist', description:'Expressive, dramatic, self-absorbed, and temperamental.' },
  { identifier:'e5', name:'Type 5 · The Investigator',  description:'Perceptive, innovative, secretive, and isolated.' },
  { identifier:'e6', name:'Type 6 · The Loyalist',      description:'Engaging, responsible, anxious, and suspicious.' },
  { identifier:'e7', name:'Type 7 · The Enthusiast',    description:'Spontaneous, versatile, scattered, and acquisitive.' },
  { identifier:'e8', name:'Type 8 · The Challenger',    description:'Self-confident, decisive, willful, and confrontational.' },
  { identifier:'e9', name:'Type 9 · The Peacemaker',    description:'Receptive, reassuring, agreeable, and complacent.' },
];
const WING_LABELS = WINGS.map(w => ({
  identifier: w, name: WING_NAMES[w], description: WING_DESCRIPTIONS[w],
}));
const SUBTYPE_LABELS = WINGS.flatMap(w => [
  { identifier:`${w}-sp`, name:`${w.replace('e','')} SP`, description:`${w.replace('e','').replace('w',' w')} · Self-Preservation subtype.` },
  { identifier:`${w}-so`, name:`${w.replace('e','')} SO`, description:`${w.replace('e','').replace('w',' w')} · Social subtype.` },
  { identifier:`${w}-sx`, name:`${w.replace('e','')} SX`, description:`${w.replace('e','').replace('w',' w')} · Sexual subtype.` },
]);
const ALL_LABELS = [...TYPE_LABELS, ...WING_LABELS, ...SUBTYPE_LABELS];

// ─── Labeler server ───────────────────────────────────────────────────────────
const labelerServer = new LabelerServer({ did: DID, signingKey: SIGNING_KEY, dbPath: '/data/labels.db' });

// ─── DB helpers ──────────────────────────────────────────────────────────────
function fetchCurrentLabels(did) {
  const result = labelerServer.db.execute(
    `SELECT val, neg FROM labels WHERE uri = ? ORDER BY cts DESC`,
    [did]
  );
  const rows = Array.isArray(result) ? result : (result?.rows ?? []);
  const labels = rows.reduce((set, row) => {
    if (!row.neg) set.add(row.val);
    else set.delete(row.val);
    return set;
  }, new Set());
  return labels;
}

async function removeExistingEnneagramLabels(did) {
  const current = fetchCurrentLabels(did);
  const toRemove = [...current].filter(v => VALID_LABELS.has(v));
  if (toRemove.length > 0) {
    await labelerServer.createLabels({ uri: did }, { negate: toRemove });
    console.log(`Negated labels for ${did}: ${toRemove.join(', ')}`);
  }
}

// ─── Firehose label application (like-based) ──────────────────────────────────
async function applyLabelFromLike(did, rkey) {
  console.log(`Like received: rkey=${rkey} from ${did}`);

  // Handle delete post like
  if (DELETE_RKEY && rkey === DELETE_RKEY) {
    await removeExistingEnneagramLabels(did);
    console.log(`Deleted all labels for ${did}`);
    return;
  }

  // Find matching type post
  const match = TYPE_POSTS.find(p => p.rkey && p.rkey === rkey);
  if (!match) {
    console.log(`No matching label for rkey: ${rkey}`);
    return;
  }

  // Remove existing type labels (keep wing/subtype labels from website)
  const current = fetchCurrentLabels(did);
  const typeLabelsToRemove = [...current].filter(v => /^e[1-9]$/.test(v));
  if (typeLabelsToRemove.length > 0) {
    await labelerServer.createLabels({ uri: did }, { negate: typeLabelsToRemove });
  }

  await labelerServer.createLabel({ uri: did, val: match.label });
  console.log(`Applied label ${match.label} to ${did}`);
}

// ─── Website label application ────────────────────────────────────────────────
async function applyLabelFromWebsite(did, label) {
  await removeExistingEnneagramLabels(did);
  await labelerServer.createLabel({ uri: did, val: label });
  console.log(`Applied label ${label} to ${did} via website`);
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
    applyLabelFromLike(event.did, rkey).catch(err =>
      console.error(`Error labeling ${event.did}:`, err)
    );
  }
});

jetstream.start();

// ─── HTTP + WebSocket proxy server ───────────────────────────────────────────
const healthServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Debug execute return shape
  if (url.pathname === '/debug-execute') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const result = labelerServer.db.execute(`SELECT val, neg FROM labels LIMIT 3`, []);
    res.end(JSON.stringify({ resultType: typeof result, isArray: Array.isArray(result), result }, null, 2));
    return;
  }

  // Debug endpoint - remove after use
  if (url.pathname === '/debug-db') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const dbInfo = {
      dbType: typeof labelerServer.db,
      dbKeys: labelerServer.db ? Object.getOwnPropertyNames(Object.getPrototypeOf(labelerServer.db)) : [],
      serverKeys: Object.keys(labelerServer),
    };
    res.end(JSON.stringify(dbInfo, null, 2));
    return;
  }

  // Health
  if (url.pathname === '/' || url.pathname === '/xrpc/_health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', version: '1.0.0' }));
    return;
  }

  // Apply label (website)
  if (url.pathname === '/apply-label' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { accessJwt, label } = JSON.parse(body);
        if (!accessJwt || !label) throw new Error('Missing accessJwt or label');
        if (!VALID_LABELS.has(label)) throw new Error('Invalid label identifier');
        const did = await verifyToken(accessJwt);
        await applyLabelFromWebsite(did, label);
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

  // Remove label (website)
  if (url.pathname === '/remove-label' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { accessJwt } = JSON.parse(body);
        if (!accessJwt) throw new Error('Missing accessJwt');
        const did = await verifyToken(accessJwt);
        await removeExistingEnneagramLabels(did);
        // Also clean up self-labels
        const getRes = await fetch(`https://bsky.social/xrpc/com.atproto.repo.getRecord?repo=${did}&collection=app.bsky.actor.profile&rkey=self`, {
          headers: { 'Authorization': `Bearer ${accessJwt}` }
        });
        if (getRes.ok) {
          const existing = await getRes.json();
          const record = existing.value || {};
          record.$type = record.$type || 'app.bsky.actor.profile';
          const filtered = (record.labels?.values || []).filter(l =>
            !l.val.match(/^e[1-9](w[1-9](-(sp|so|sx))?)?$/)
          );
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

  // Setup labels
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
      record.policies = {
        labelValues: ALL_LABELS.map(l => l.identifier),
        labelValueDefinitions: ALL_LABELS.map(l => ({
          identifier: l.identifier, severity: 'inform', blurs: 'none',
          defaultSetting: 'warn', adultOnly: false,
          locales: [{ lang: 'en', name: l.name, description: l.description }]
        }))
      };
      record.subjectTypes = ['account'];
      record.subjectCollections = ['app.bsky.actor.profile'];
      await agent.api.com.atproto.repo.putRecord({
        repo: DID, collection: 'app.bsky.labeler.service', rkey: 'self', record,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: `Defined ${ALL_LABELS.length} labels.` }));
    } catch (err) {
      res.writeHead(500); res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Proxy to Skyware
  const options = {
    hostname: '127.0.0.1', port: LABELER_PORT,
    path: req.url, method: req.method, headers: req.headers,
  };
  const proxy = http.request(options, proxyRes => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });
  proxy.on('error', () => { res.writeHead(502); res.end(JSON.stringify({ error: 'Bad Gateway' })); });
  req.pipe(proxy, { end: true });
});

// WebSocket proxy for subscribeLabels
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
