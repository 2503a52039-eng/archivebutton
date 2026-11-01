/**
 * Archive Button - local demo server (no npm packages needed).
 *
 * Simulates the whole flow from the proposal:
 *   button press -> archive job -> result -> buzzer pattern -> logged run
 * The simulated "bucket" is in memory; run history is saved to data.json.
 * The real AWS version of the archive job is in lambda/archive_handler.py.
 *
 * Run:  node server.js      then open http://localhost:3000
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const HEARTBEAT_TIMEOUT_MS = (Number(process.env.HEARTBEAT_TIMEOUT_SEC) || 180) * 1000;
const DAY = 24 * 60 * 60 * 1000;

// ---------- state ----------
function makeBucket() {
  // Deterministic pseudo-random files so every reset looks the same.
  let seed = 42;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const folders = ['logs', 'reports', 'backups', 'exports', 'media'];
  const files = [];
  for (let i = 1; i <= 80; i++) {
    const folder = folders[Math.floor(rnd() * folders.length)];
    files.push({
      key: `${folder}/file-${String(i).padStart(3, '0')}.dat`,
      sizeMB: Math.round(5 + rnd() * 115),
      ageDays: Math.round(5 + rnd() * 395),
      storageClass: 'STANDARD',
    });
  }
  return files;
}

function seedRuns() {
  // Matches the illustrative dashboard in the slides: 1,240 files, 38 GB, 5 runs, 1 failed.
  const now = Date.now();
  const at = (daysAgo, h, m) => {
    const d = new Date(now - daysAgo * DAY);
    d.setHours(h, m, 0, 0);
    return d.toISOString();
  };
  return [
    { time: at(6, 11, 30), status: 'success', filesMoved: 310, sizeMB: 9728, durationMs: 41000, message: 'Archived 310 files' },
    { time: at(5, 14, 5), status: 'success', filesMoved: 280, sizeMB: 8396, durationMs: 37000, message: 'Archived 280 files' },
    { time: at(3, 9, 5), status: 'failed', filesMoved: 0, sizeMB: 0, durationMs: 3000, message: 'AccessDenied: cannot read bucket', midRun: false, permission: true },
    { time: at(2, 16, 40), status: 'success', filesMoved: 350, sizeMB: 11571, durationMs: 52000, message: 'Archived 350 files' },
    { time: at(1, 10, 12), status: 'success', filesMoved: 300, sizeMB: 9216, durationMs: 39000, message: 'Archived 300 files' },
  ].map((r, i) => ({ id: i + 1, ...r }));
}

let state = load();

function load() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return fresh();
  }
}
function fresh() {
  return {
    ageLimitDays: 90,
    files: makeBucket(),
    runs: seedRuns(),
    device: { forceOffline: false, lastSeen: Date.now() },
    inject: 'none', // none | partial | failure  (for demos)
  };
}
function save() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2)); } catch (e) { console.error('save failed', e.message); }
}

// Simulated device heartbeat (a real device would POST /api/heartbeat).
setInterval(() => {
  if (!state.device.forceOffline) state.device.lastSeen = Date.now();
}, 10000);

// ---------- archive job ----------
function runArchive() {
  const started = Date.now();
  const eligible = state.files.filter(f => f.storageClass === 'STANDARD' && f.ageDays > state.ageLimitDays);
  const run = {
    id: (state.runs.at(-1)?.id || 0) + 1,
    time: new Date().toISOString(),
    status: 'success', filesMoved: 0, sizeMB: 0, durationMs: 0, message: '',
  };

  if (state.inject === 'failure') {
    run.status = 'failed';
    run.permission = true;
    run.message = 'AccessDenied: cannot move files in target bucket';
  } else if (state.inject === 'partial') {
    // Move ~70% then stop: "finishes with files left behind".
    const n = Math.floor(eligible.length * 0.7);
    eligible.slice(0, n).forEach(f => { f.storageClass = 'GLACIER'; run.filesMoved++; run.sizeMB += f.sizeMB; });
    run.status = 'partial';
    run.message = `${eligible.length - n} files left behind`;
  } else if (eligible.length === 0) {
    run.message = 'Nothing to archive - no files older than the age limit';
  } else {
    eligible.forEach(f => { f.storageClass = 'GLACIER'; run.filesMoved++; run.sizeMB += f.sizeMB; });
    run.message = `Archived ${run.filesMoved} files`;
  }
  run.durationMs = Date.now() - started + 800 + Math.round(Math.random() * 900);
  state.runs.push(run);
  state.inject = 'none'; // one-shot
  save();
  return run;
}

// ---------- derived data ----------
function severityFor(run, prev) {
  if (run.status === 'success') return null;
  if (run.midRun || (run.status === 'partial')) return { level: 'P1', label: 'Critical', response: 'Within 15 minutes', escalate: 'On-call engineer, then data owner' };
  if (run.permission || prev?.status !== 'success') return { level: 'P2', label: 'Major', response: 'Within 1 hour', escalate: 'Support team, then on-call engineer' };
  return { level: 'P3', label: 'Minor', response: 'Next business day', escalate: 'Support team queue' };
}

function deviceStatus() {
  const online = !state.device.forceOffline && Date.now() - state.device.lastSeen < HEARTBEAT_TIMEOUT_MS;
  return { online, lastSeen: state.device.lastSeen, forced: state.device.forceOffline };
}

function stats() {
  const now = Date.now();
  const weekRuns = state.runs.filter(r => now - new Date(r.time) < 7 * DAY);
  const daily = [];
  for (let i = 6; i >= 0; i--) {
    const day = new Date(now - i * DAY);
    const label = day.toLocaleDateString('en-GB', { weekday: 'short' });
    const files = state.runs
      .filter(r => new Date(r.time).toDateString() === day.toDateString())
      .reduce((a, r) => a + r.filesMoved, 0);
    daily.push({ label, files });
  }
  const runs = state.runs.slice(-10).reverse().map(r => {
    const idx = state.runs.findIndex(x => x.id === r.id);
    return { ...r, severity: severityFor(r, state.runs[idx - 1]) };
  });
  const incidents = runs.filter(r => r.severity).slice(0, 5).map(r => ({
    id: r.id, time: r.time, message: r.message, ...r.severity,
  }));
  const device = deviceStatus();
  if (!device.online) {
    incidents.unshift({ id: 'device', time: new Date(device.lastSeen).toISOString(), message: 'Button heartbeat has stopped', level: 'P2', label: 'Major', response: 'Within 1 hour', escalate: 'Support team, then on-call engineer' });
  }
  const eligible = state.files.filter(f => f.storageClass === 'STANDARD' && f.ageDays > state.ageLimitDays);
  return {
    kpis: {
      filesArchived: weekRuns.reduce((a, r) => a + r.filesMoved, 0),
      gbMoved: Math.round(weekRuns.reduce((a, r) => a + r.sizeMB, 0) / 1024),
      runsThisWeek: weekRuns.length,
      failed: weekRuns.filter(r => r.status === 'failed').length,
    },
    daily, runs, incidents, device,
    bucket: {
      ageLimitDays: state.ageLimitDays,
      total: state.files.length,
      standard: state.files.filter(f => f.storageClass === 'STANDARD').length,
      glacier: state.files.filter(f => f.storageClass === 'GLACIER').length,
      eligible: eligible.length,
    },
    inject: state.inject,
  };
}

// ---------- http ----------
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.json': 'application/json' };

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise(resolve => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  if (p === '/api/stats' && req.method === 'GET') return json(res, 200, stats());
  if (p === '/api/files' && req.method === 'GET') return json(res, 200, state.files);

  if (p === '/api/press' && req.method === 'POST') {
    if (state.device.forceOffline) return json(res, 503, { error: 'Device is offline' });
    const run = runArchive();
    const buzzer = run.status === 'success' ? [150] : run.status === 'partial' ? [150, 150] : [1200];
    return json(res, 200, { run, buzzer });
  }
  if (p === '/api/inject' && req.method === 'POST') {
    const { mode } = await readBody(req);
    state.inject = ['none', 'partial', 'failure'].includes(mode) ? mode : 'none';
    return json(res, 200, { inject: state.inject });
  }
  if (p === '/api/device' && req.method === 'POST') {
    const { online } = await readBody(req);
    state.device.forceOffline = !online;
    if (online) state.device.lastSeen = Date.now();
    save();
    return json(res, 200, deviceStatus());
  }
  if (p === '/api/heartbeat' && req.method === 'POST') {   // for a real device
    state.device.lastSeen = Date.now();
    return json(res, 200, { ok: true });
  }
  if (p === '/api/age-limit' && req.method === 'POST') {
    const { days } = await readBody(req);
    if (Number.isFinite(days) && days >= 1 && days <= 3650) state.ageLimitDays = Math.round(days);
    save();
    return json(res, 200, { ageLimitDays: state.ageLimitDays });
  }
  if (p === '/api/reset' && req.method === 'POST') {
    state = fresh();
    save();
    return json(res, 200, { ok: true });
  }

  // static files
  const rel = p === '/' ? 'index.html' : p.slice(1);
  const file = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
});

server.listen(PORT, () => console.log(`Archive Button running at http://localhost:${PORT}`));
