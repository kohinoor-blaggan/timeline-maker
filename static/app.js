'use strict';

// ── State ──────────────────────────────────────────────────────────────────
let allEvents = [];
let eventsCache = {};
let currentEventId = null;
let currentEventType = 'point';

// View state
let pxPerDay = 3;
let viewStartMs = null;
let isDragging = false, dragStartX = 0, dragStartMs = 0;

let svgEl = null, ctnEl = null;

// Layout constants
const DAY_MS          = 86400000;
const AXIS_RATIO      = 0.40;   // center line at 40% of container height
const POINT_STEMS     = [50, 80, 110]; // stem lengths above axis (cycles 0,1,2)
const BELOW_STEM      = 48;     // stem length for below-axis points (every 4th)
const PERIOD_H        = 24;     // period bar height
const PERIOD_GAP      = 5;      // vertical gap between period lanes
const PERIOD_OFFSET   = 38;     // gap between axis and first period lane
const SVGNS           = 'http://www.w3.org/2000/svg';

// ── Date utilities ─────────────────────────────────────────────────────────
function dms(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}
function msToX(ms)  { return (ms - viewStartMs) / DAY_MS * pxPerDay; }
function xToMs(x)   { return viewStartMs + x / pxPerDay * DAY_MS; }

// ── SVG helpers ────────────────────────────────────────────────────────────
function mkEl(tag, attrs) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}
function mkTxt(content, attrs) {
  const e = mkEl('text', attrs);
  e.textContent = content;
  return e;
}
function contrastColor(hex) {
  const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
  return (0.299*r + 0.587*g + 0.114*b)/255 > 0.55 ? '#1e293b' : '#ffffff';
}
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Tick generation ────────────────────────────────────────────────────────
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function tickConfig(ppd) {
  // isMajor is based purely on the date value — never on loop index — so labels
  // stay on the same fixed dates regardless of scroll position.
  if (ppd > 40)   return { step:1,   unit:'day',   fmt: d => `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`, isMajor: d => d.getUTCDay() === 1 };
  if (ppd > 8)    return { step:7,   unit:'day',   fmt: d => `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`, isMajor: d => d.getUTCDate() <= 7 };
  if (ppd > 2)    return { step:1,   unit:'month', fmt: d => `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`, isMajor: d => d.getUTCMonth() === 0 };
  if (ppd > 0.25) return { step:1,   unit:'year',  fmt: d => String(d.getUTCFullYear()), isMajor: d => d.getUTCFullYear() % 5 === 0 };
  if (ppd > 0.04) return { step:5,   unit:'year',  fmt: d => String(d.getUTCFullYear()), isMajor: d => d.getUTCFullYear() % 10 === 0 };
  if (ppd > 0.008)return { step:10,  unit:'year',  fmt: d => String(d.getUTCFullYear()), isMajor: d => d.getUTCFullYear() % 100 === 0 };
  return               { step:50,  unit:'year',  fmt: d => String(d.getUTCFullYear()), isMajor: d => d.getUTCFullYear() % 100 === 0 };
}

function generateTicks(startMs, endMs) {
  const cfg = tickConfig(pxPerDay);
  const ticks = [];
  let ms;

  if (cfg.unit === 'day') {
    const d = new Date(startMs);
    ms = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    while (ms <= endMs + DAY_MS) {
      const dd = new Date(ms);
      ticks.push({ ms, label: cfg.fmt(dd), major: cfg.isMajor(dd) });
      ms += cfg.step * DAY_MS;
    }
  } else if (cfg.unit === 'month') {
    const d = new Date(startMs);
    let y = d.getUTCFullYear(), mo = d.getUTCMonth();
    ms = Date.UTC(y, mo, 1);
    while (ms <= endMs) {
      const dd = new Date(ms);
      ticks.push({ ms, label: cfg.fmt(dd), major: cfg.isMajor(dd) });
      mo++; if (mo > 11) { mo = 0; y++; }
      ms = Date.UTC(y, mo, 1);
    }
  } else {
    const d = new Date(startMs);
    let yr = Math.floor(d.getUTCFullYear() / cfg.step) * cfg.step;
    ms = Date.UTC(yr, 0, 1);
    while (ms <= endMs) {
      const dd = new Date(ms);
      ticks.push({ ms, label: cfg.fmt(dd), major: cfg.isMajor(dd) });
      yr += cfg.step; ms = Date.UTC(yr, 0, 1);
    }
  }
  return ticks;
}

// ── Period lane assignment ─────────────────────────────────────────────────
function assignLanes(periods) {
  const sorted = [...periods].sort((a,b) => dms(a.start_date) - dms(b.start_date));
  const laneEnds = [];
  return sorted.map(e => {
    const s = dms(e.start_date);
    const end = dms(e.end_date);
    const gap = 4 * DAY_MS;
    let lane = laneEnds.findIndex(t => t + gap <= s);
    if (lane === -1) { lane = laneEnds.length; laneEnds.push(end); }
    else laneEnds[lane] = end;
    return { ...e, lane };
  });
}

// ── Main render ────────────────────────────────────────────────────────────
function render() {
  if (!svgEl || !ctnEl || viewStartMs === null) return;

  const W = ctnEl.clientWidth;
  const H = ctnEl.clientHeight;
  const axisY = Math.round(H * AXIS_RATIO);

  svgEl.innerHTML = '';
  svgEl.setAttribute('viewBox', `0 0 ${W} ${H}`);

  const startMs = viewStartMs;
  const endMs   = xToMs(W);

  // Painter layers
  const gGrid   = mkEl('g', {}); svgEl.appendChild(gGrid);
  const gPeriod = mkEl('g', {}); svgEl.appendChild(gPeriod);
  const gAxis   = mkEl('g', {}); svgEl.appendChild(gAxis);
  const gPoint  = mkEl('g', {}); svgEl.appendChild(gPoint);
  const gLabel  = mkEl('g', {}); svgEl.appendChild(gLabel);

  // ── Axis line ──
  gAxis.appendChild(mkEl('line', {
    x1:0, y1:axisY, x2:W, y2:axisY,
    stroke:'#94a3b8', 'stroke-width':'2', 'stroke-linecap':'round'
  }));

  // ── Tick marks ──
  const ticks = generateTicks(startMs, endMs);
  for (const tick of ticks) {
    const x = Math.round(msToX(tick.ms));
    if (x < -30 || x > W + 30) continue;
    const tH = tick.major ? 9 : 4;
    gGrid.appendChild(mkEl('line', {
      x1:x, y1:axisY - tH, x2:x, y2:axisY + tH,
      stroke: tick.major ? '#94a3b8' : '#cbd5e1',
      'stroke-width': tick.major ? 1.5 : 1
    }));
    if (tick.major) {
      gGrid.appendChild(mkTxt(tick.label, {
        x, y: axisY + tH + 15,
        'text-anchor':'middle', 'font-size':'11', 'font-weight':'600',
        fill:'#64748b', 'font-family':'system-ui,sans-serif'
      }));
    } else if (ticks.length < 80) {
      gGrid.appendChild(mkTxt(tick.label, {
        x, y: axisY + tH + 13,
        'text-anchor':'middle', 'font-size':'9',
        fill:'#94a3b8', 'font-family':'system-ui,sans-serif'
      }));
    }
  }

  // ── Period events (below axis) ──
  const periods = assignLanes(allEvents.filter(e => e.type === 'period'));
  for (const e of periods) {
    const x1 = msToX(dms(e.start_date));
    const x2 = msToX(dms(e.end_date));
    if (x2 < -20 || x1 > W + 20) continue;

    const barY = axisY + PERIOD_OFFSET + e.lane * (PERIOD_H + PERIOD_GAP);
    const cx1  = Math.max(x1, -4);
    const cx2  = Math.min(x2, W + 4);
    const w    = Math.max(cx2 - cx1, 4);
    const fg   = contrastColor(e.color);

    const g = mkEl('g', { style:'cursor:pointer' });
    g.appendChild(mkEl('rect', {
      x:cx1, y:barY, width:w, height:PERIOD_H,
      rx:'4', fill:e.color, opacity:'0.92'
    }));
    if (w > 36) {
      const labelX = Math.max(cx1 + 7, 7);
      g.appendChild(mkTxt(e.title, {
        x:labelX, y: barY + PERIOD_H / 2 + 4,
        fill:fg, 'font-size':'11', 'font-weight':'600',
        'font-family':'system-ui,sans-serif',
        'clip-path':'inset(0)'
      }));
    }
    const barCenterX = cx1 + w / 2;
    const barCenterY = barY + PERIOD_H / 2;
    g.addEventListener('click', ev => { ev.stopPropagation(); openInfoBubble(e.id, barCenterX, barCenterY); });
    gPeriod.appendChild(g);
  }

  // ── Point events (above/below axis, alternating) ──
  const points = [...allEvents.filter(e => e.type === 'point')]
    .sort((a,b) => dms(a.start_date) - dms(b.start_date));

  points.forEach((e, i) => {
    const x = Math.round(msToX(dms(e.start_date)));
    if (x < -100 || x > W + 100) return;

    // Every 4th event dips below; the rest alternate through 3 stem heights above
    const posInGroup = i % 4;
    const below   = posInGroup === 3;
    const stemLen = below ? BELOW_STEM : POINT_STEMS[posInGroup];

    const dotY     = axisY;
    const lineY1   = below ? dotY + 5 : dotY - 5;
    const lineY2   = below ? dotY + stemLen : dotY - stemLen;
    const labelY   = below ? lineY2 + 14 : lineY2 - 8;
    const anchor   = 'middle';

    const g = mkEl('g', { style:'cursor:pointer' });

    // Invisible hit area covering dot + stem + label
    const hitTop    = Math.min(labelY - 14, lineY2 - 2);
    const hitBottom = Math.max(labelY + 4,  dotY   + 7);
    g.appendChild(mkEl('rect', {
      x: x - 32, y: hitTop, width: 64, height: hitBottom - hitTop,
      fill: 'transparent', stroke: 'none'
    }));

    // Dashed stem
    g.appendChild(mkEl('line', {
      x1:x, y1:lineY1, x2:x, y2:lineY2,
      stroke:e.color, 'stroke-width':'1.5',
      'stroke-dasharray':'3,3', opacity:'0.8'
    }));

    // Dot on axis
    g.appendChild(mkEl('circle', {
      cx:x, cy:dotY, r:'5',
      fill:e.color, stroke:'#ffffff', 'stroke-width':'2'
    }));

    // Label (drawn in label layer so it sits on top of everything)
    gLabel.appendChild(mkTxt(e.title, {
      x, y:labelY,
      'text-anchor':anchor,
      fill:e.color,
      'font-size':'11', 'font-weight':'600',
      'font-family':'system-ui,sans-serif',
      style:'pointer-events:none'
    }));

    g.addEventListener('click', ev => { ev.stopPropagation(); openInfoBubble(e.id, x, dotY); });
    gPoint.appendChild(g);
  });

  // ── Empty state ──
  if (allEvents.length === 0) {
    svgEl.appendChild(mkTxt('No events yet — click "+ Add Event" to get started', {
      x:W/2, y:H/2,
      'text-anchor':'middle', fill:'#94a3b8',
      'font-size':'14', 'font-family':'system-ui,sans-serif'
    }));
  }
}

// ── Fit view to event range ────────────────────────────────────────────────
function fitView() {
  const W = ctnEl ? ctnEl.clientWidth : 800;
  if (allEvents.length === 0) {
    const now = Date.now();
    pxPerDay = W / (10 * 365);
    viewStartMs = now - 5 * 365 * DAY_MS;
    return;
  }
  const dates = allEvents.flatMap(e =>
    [dms(e.start_date), ...(e.end_date ? [dms(e.end_date)] : [])]
  );
  const minMs = Math.min(...dates);
  const maxMs = Math.max(...dates);
  const range = Math.max(maxMs - minMs, 30 * DAY_MS);
  const pad   = range * 0.18;
  pxPerDay    = W / ((range + 2 * pad) / DAY_MS);
  viewStartMs = minMs - pad;
}

// ── Load events ────────────────────────────────────────────────────────────
async function loadEvents(preserveView) {
  const res = await fetch(`/api/timeline/${TIMELINE_ID}/events`);
  allEvents = await res.json();
  eventsCache = {};
  allEvents.forEach(e => { eventsCache[e.id] = e; });
  if (!preserveView) fitView();
  render();
}

// ── SVG init & interaction ─────────────────────────────────────────────────
function initSVG() {
  ctnEl = document.getElementById('vis-container');
  svgEl = document.createElementNS(SVGNS, 'svg');
  svgEl.style.cssText = 'width:100%;height:100%;cursor:grab;user-select:none;display:block';
  ctnEl.appendChild(svgEl);

  // Wheel → zoom about mouse position
  svgEl.addEventListener('wheel', ev => {
    ev.preventDefault();
    const rect = svgEl.getBoundingClientRect();
    const mouseX = ev.clientX - rect.left;
    const msAtMouse = xToMs(mouseX);
    const factor = ev.deltaY < 0 ? 1.15 : 1 / 1.15;
    pxPerDay = Math.max(0.001, Math.min(300, pxPerDay * factor));
    viewStartMs = msAtMouse - mouseX / pxPerDay * DAY_MS;
    render();
  }, { passive: false });

  // Drag → pan
  svgEl.addEventListener('mousedown', ev => {
    if (ev.button !== 0) return;
    isDragging = true;
    dragStartX  = ev.clientX;
    dragStartMs = viewStartMs;
    svgEl.style.cursor = 'grabbing';
    ev.preventDefault();
  });
  window.addEventListener('mousemove', ev => {
    if (!isDragging) return;
    const dx = ev.clientX - dragStartX;
    viewStartMs = dragStartMs - dx / pxPerDay * DAY_MS;
    render();
  });
  window.addEventListener('mouseup', () => {
    isDragging = false;
    if (svgEl) svgEl.style.cursor = 'grab';
  });

  // Click on SVG background → close panel and bubble
  svgEl.addEventListener('click', () => { closePanel(); closeInfoBubble(); });

  // ResizeObserver fires when ctnEl itself changes size (e.g. panel open/close),
  // unlike window.resize which only fires on browser-window resize.
  new ResizeObserver(() => render()).observe(ctnEl);
}

// ── Info bubble ────────────────────────────────────────────────────────────
let infoBubbleEventId = null;

function formatDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC'
  });
}

function openInfoBubble(id, svgX, svgY) {
  const e = eventsCache[id];
  if (!e) return;
  infoBubbleEventId = id;

  document.getElementById('info-title').textContent = e.title;
  document.getElementById('bubble-accent').style.background = e.color || '#1d4ed8';
  document.getElementById('info-desc').textContent = e.description || '';

  const dateEl = document.getElementById('info-date');
  if (e.type === 'period' && e.end_date) {
    dateEl.textContent = `${formatDate(e.start_date)} – ${formatDate(e.end_date)}`;
  } else {
    dateEl.textContent = formatDate(e.start_date);
  }

  const bubble = document.getElementById('event-info-bubble');
  // Show offscreen first so we can measure its size
  bubble.style.left = '-9999px';
  bubble.style.top  = '-9999px';
  bubble.style.display = 'block';

  const bW = bubble.offsetWidth;
  const bH = bubble.offsetHeight;
  const cW = ctnEl.clientWidth;
  const cH = ctnEl.clientHeight;
  const PAD = 10;

  // Center on event, then clamp so it stays inside the canvas
  let left = Math.round(Math.max(PAD + bW / 2, Math.min(svgX, cW - PAD - bW / 2)));
  let top  = Math.round(Math.max(PAD + bH / 2, Math.min(svgY, cH - PAD - bH / 2)));

  bubble.style.left = left + 'px';
  bubble.style.top  = top  + 'px';
}

function closeInfoBubble() {
  document.getElementById('event-info-bubble').style.display = 'none';
  infoBubbleEventId = null;
}

function openEditFromBubble() {
  const id = infoBubbleEventId;
  closeInfoBubble();
  if (id !== null) openEditPanel(id);
}

// ── Panel management ───────────────────────────────────────────────────────
function openAddPanel() {
  currentEventId = null;
  document.getElementById('panel-title').textContent = 'Add Event';
  document.getElementById('panel-delete-btn').style.display = 'none';
  document.getElementById('f-title').value = '';
  document.getElementById('f-desc').value  = '';
  document.getElementById('f-start').value = '';
  document.getElementById('f-end').value   = '';
  setColorValue('#1d4ed8');
  setEventType('point');
  clearPanelError();
  document.getElementById('event-panel').classList.add('open');
  document.getElementById('f-title').focus();
}

function openEditPanel(id) {
  const e = eventsCache[id];
  if (!e) return;
  currentEventId = id;
  document.getElementById('panel-title').textContent = 'Edit Event';
  document.getElementById('panel-delete-btn').style.display = '';
  document.getElementById('f-title').value = e.title;
  document.getElementById('f-desc').value  = e.description || '';
  document.getElementById('f-start').value = e.start_date;
  document.getElementById('f-end').value   = e.end_date || '';
  setColorValue(e.color || '#1d4ed8');
  setEventType(e.type);
  clearPanelError();
  document.getElementById('event-panel').classList.add('open');
}

function closePanel() {
  document.getElementById('event-panel').classList.remove('open');
  currentEventId = null;
  clearPanelError();
}

function setEventType(type) {
  currentEventType = type;
  document.getElementById('btn-point').classList.toggle('active', type === 'point');
  document.getElementById('btn-period').classList.toggle('active', type === 'period');
  document.getElementById('end-date-row').style.display = type === 'period' ? 'block' : 'none';
}

function setColorValue(hex) {
  document.getElementById('f-color').value = hex;
  document.getElementById('color-hex').textContent = hex;
}

function clearPanelError() {
  const el = document.getElementById('panel-error');
  el.style.display = 'none';
  el.textContent = '';
}

function showPanelError(msg) {
  const el = document.getElementById('panel-error');
  el.textContent = msg;
  el.style.display = 'block';
}

// ── Save / delete events ───────────────────────────────────────────────────
async function saveEvent() {
  clearPanelError();
  const title       = document.getElementById('f-title').value.trim();
  const description = document.getElementById('f-desc').value.trim();
  const color       = document.getElementById('f-color').value;
  const start_date  = document.getElementById('f-start').value;
  const end_date    = document.getElementById('f-end').value || null;
  const type        = currentEventType;

  if (!title)      { showPanelError('Title is required.'); return; }
  if (!start_date) { showPanelError('Start date is required.'); return; }
  if (type === 'period' && !end_date)          { showPanelError('End date is required for period events.'); return; }
  if (type === 'period' && end_date < start_date) { showPanelError('End date must be on or after start date.'); return; }

  const body = { title, description, type, start_date, end_date, color };
  let res;
  if (currentEventId === null) {
    res = await fetch(`/api/timeline/${TIMELINE_ID}/events`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } else {
    res = await fetch(`/api/event/${currentEventId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  }
  const data = await res.json();
  if (data.error) { showPanelError(data.error); return; }
  closePanel();
  await loadEvents(true);
}

async function deleteCurrentEvent() {
  if (!confirm('Delete this event?')) return;
  const res  = await fetch(`/api/event/${currentEventId}`, { method: 'DELETE' });
  const data = await res.json();
  if (data.error) { showPanelError(data.error); return; }
  closePanel();
  await loadEvents(true);
}

// ── Timeline-level actions ─────────────────────────────────────────────────
async function startRename() {
  const current = document.getElementById('tl-name').textContent;
  const name = prompt('New timeline name:', current);
  if (!name || name.trim() === current) return;
  const res  = await fetch(`/timeline/${TIMELINE_ID}/rename`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name.trim() })
  });
  const data = await res.json();
  if (data.error) { alert(data.error); return; }
  document.getElementById('tl-name').textContent = name.trim();
  document.title = name.trim() + ' — Timeline Maker';
}

async function deleteThisTimeline() {
  const name = document.getElementById('tl-name').textContent;
  if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;
  const res  = await fetch(`/timeline/${TIMELINE_ID}`, { method: 'DELETE' });
  const data = await res.json();
  if (data.error) { alert(data.error); return; }
  window.location.href = '/';
}

// ── Boot ───────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const colorInput = document.getElementById('f-color');
  if (colorInput) {
    colorInput.addEventListener('input', () => {
      document.getElementById('color-hex').textContent = colorInput.value;
    });
  }
  initSVG();
  loadEvents(false);
});
