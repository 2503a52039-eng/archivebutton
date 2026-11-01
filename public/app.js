const $ = id => document.getElementById(id);
const HOLD_MS = 2000;
const CIRC = 2 * Math.PI * 54;

// ---------- buzzer (Web Audio) ----------
let audioCtx;
function beep(ms, freq = 880) {
  if ($('muted').checked) return Promise.resolve();
  audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = 'square';
  osc.frequency.value = freq;
  gain.gain.value = 0.08;
  osc.connect(gain).connect(audioCtx.destination);
  osc.start();
  return new Promise(res => setTimeout(() => { osc.stop(); res(); }, ms));
}
async function playPattern(pattern) {
  const freq = pattern.length === 1 && pattern[0] > 500 ? 220 : 880; // low tone for failure
  for (const ms of pattern) { await beep(ms, freq); await new Promise(r => setTimeout(r, 120)); }
}

// ---------- API ----------
async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// ---------- hold-to-press ----------
const btn = $('bigButton');
const ring = $('ringFg');
let holdStart = 0, raf = 0, busy = false;

function setRing(p) { ring.style.strokeDashoffset = CIRC * (1 - p); }

function startHold(e) {
  if (busy) return;
  e.preventDefault();
  btn.setPointerCapture?.(e.pointerId);
  btn.classList.add('down');
  holdStart = performance.now();
  $('hint').textContent = 'Keep holding…';
  const tick = () => {
    const p = Math.min((performance.now() - holdStart) / HOLD_MS, 1);
    setRing(p);
    if (p >= 1) return fire();
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
}
function cancelHold() {
  if (!holdStart || busy) return;
  cancelAnimationFrame(raf);
  holdStart = 0;
  btn.classList.remove('down');
  setRing(0);
  $('hint').textContent = 'Released too early. Hold for 2 seconds.';
}
async function fire() {
  holdStart = 0;
  busy = true;
  btn.disabled = true;
  $('hint').textContent = 'Archiving…';
  $('result').hidden = true;
  try {
    await beep(60, 1200); // "accepted" tick
    const { run, buzzer } = await api('/api/press', {});
    showResult(run);
    await playPattern(buzzer);
  } catch (err) {
    showResult({ status: 'failed', message: err.message });
    await playPattern([1200]);
  } finally {
    busy = false;
    btn.disabled = false;
    btn.classList.remove('down');
    setRing(0);
    $('hint').textContent = 'Hold to archive';
    refresh();
  }
}
function showResult(run) {
  const el = $('result');
  const label = { success: 'Success', partial: 'Partial', failed: 'Failed' }[run.status];
  el.className = `result ${run.status}`;
  el.innerHTML = `${label}<small>${esc(run.message || '')}</small>`;
  el.hidden = false;
}

btn.addEventListener('pointerdown', startHold);
btn.addEventListener('pointerup', cancelHold);
btn.addEventListener('pointerleave', cancelHold);
btn.addEventListener('pointercancel', cancelHold);
btn.addEventListener('keydown', e => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) startHold(e); });
btn.addEventListener('keyup', e => { if (e.key === ' ' || e.key === 'Enter') cancelHold(); });

// ---------- dashboard ----------
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = iso => {
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { weekday: 'short' }) + ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
};

function drawChart(daily) {
  const W = 600, H = 200, padL = 34, padB = 24, padT = 12;
  const max = Math.max(10, ...daily.map(d => d.files));
  const bw = (W - padL) / daily.length;
  let svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Files archived per day">`;
  for (let i = 0; i <= 4; i++) {
    const y = padT + (H - padB - padT) * (1 - i / 4);
    svg += `<line x1="${padL}" x2="${W}" y1="${y}" y2="${y}" stroke="var(--line)" stroke-width="1"/>`;
    svg += `<text x="${padL - 6}" y="${y + 4}" text-anchor="end">${Math.round(max * i / 4)}</text>`;
  }
  daily.forEach((d, i) => {
    const h = (H - padB - padT) * (d.files / max);
    const x = padL + i * bw + bw * 0.2;
    svg += `<rect class="bar" x="${x}" y="${H - padB - h}" width="${bw * 0.6}" height="${h}" rx="4"><title>${d.label}: ${d.files} files</title></rect>`;
    svg += `<text x="${x + bw * 0.3}" y="${H - 6}" text-anchor="middle">${d.label}</text>`;
  });
  $('chart').innerHTML = svg + '</svg>';
}

async function refresh() {
  let s;
  try { s = await api('/api/stats'); } catch { return; }
  $('kFiles').textContent = s.kpis.filesArchived.toLocaleString();
  $('kGb').textContent = s.kpis.gbMoved + ' GB';
  $('kRuns').textContent = s.kpis.runsThisWeek;
  $('kFail').textContent = s.kpis.failed;
  drawChart(s.daily);

  $('runs').innerHTML = s.runs.map(r => `
    <li><div>${fmtTime(r.time)}<small>${esc(r.message)}</small></div>
    <span class="pill ${r.status}">${r.status[0].toUpperCase() + r.status.slice(1)}</span></li>`).join('');

  $('incidents').innerHTML = s.incidents.length
    ? s.incidents.map(i => `
      <li><div>${esc(i.message)}<small>${fmtTime(i.time)} · ${esc(i.response)} · ${esc(i.escalate)}</small></div>
      <span class="pill ${i.level}">${i.level} ${i.label}</span></li>`).join('')
    : '<li class="empty">No incidents</li>';

  const b = s.bucket;
  $('bucket').innerHTML = [
    [b.standard, 'In standard storage'], [b.glacier, 'In Glacier'],
    [b.eligible, `Older than ${b.ageLimitDays} days`], [b.total, 'Total files'],
  ].map(([n, l]) => `<div><b>${n}</b><span>${l}</span></div>`).join('');

  const badge = $('deviceBadge');
  badge.classList.toggle('off', !s.device.online);
  $('deviceText').textContent = s.device.online ? 'Device online' : 'Device offline';
  $('inject').value = s.inject;
  if (document.activeElement !== $('ageLimit')) $('ageLimit').value = b.ageLimitDays;
  $('offline').checked = s.device.forced;
  btn.disabled = busy || !s.device.online;
}

// ---------- demo controls ----------
$('inject').addEventListener('change', e => api('/api/inject', { mode: e.target.value }));
$('ageLimit').addEventListener('change', async e => { await api('/api/age-limit', { days: Number(e.target.value) }); refresh(); });
$('offline').addEventListener('change', async e => { await api('/api/device', { online: !e.target.checked }); refresh(); });
$('resetBtn').addEventListener('click', async () => { await api('/api/reset', {}); $('result').hidden = true; refresh(); });

refresh();
setInterval(refresh, 5000);
