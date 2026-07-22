'use strict';

// ── State ──────────────────────────────────────────────────────────────────
let allEvents = [];
let eventsCache = {};
let currentEventId = null;
let currentEventType = 'point';
let lastUsedColor = '#1d4ed8';

// View state
let pxPerDay = 3;
let viewStartMs = null;
let isDragging = false, dragStartX = 0, dragStartMs = 0;

// Vertical drag of a period bar between rows. Null when no drag is in progress.
let laneDrag = null;        // { id, startY, row, baseRow, maxRow, moved, cx, cy }
let suppressBgClick = false; // eat the click that follows a bar interaction

let svgEl = null, ctnEl = null;

// Layout constants
const DAY_MS          = 86400000;
const AXIS_RATIO      = 0.40;   // center line at 40% of container height
const PERIOD_H        = 24;     // period bar height
const PERIOD_GAP      = 5;      // vertical gap between period lanes
const PERIOD_OFFSET   = 38;     // gap between axis and first period lane
const ONGOING_ARROW   = 11;     // arrow length past the end of an ongoing bar
const SVGNS           = 'http://www.w3.org/2000/svg';

// Point-label layout
const LABEL_FONT      = '600 11px system-ui, sans-serif';
const FIRST_STEM      = 46;     // stem length of the level nearest the axis
const LEVEL_STEP      = 24;     // vertical distance between adjacent levels
const LABEL_PAD       = 10;     // min horizontal gap between neighbouring labels
const EDGE_MARGIN     = 22;     // keep the furthest level inside the canvas

// ── Date utilities ─────────────────────────────────────────────────────────
function dms(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}
function msToX(ms)  { return (ms - viewStartMs) / DAY_MS * pxPerDay; }
function xToMs(x)   { return viewStartMs + x / pxPerDay * DAY_MS; }

// Midnight UTC today — where an ongoing period's bar is drawn up to.
function todayMs() {
  const n = new Date();
  return Date.UTC(n.getFullYear(), n.getMonth(), n.getDate());
}

// The date a period visually ends at. Ongoing periods run to today.
function eventEndMs(e) {
  if (e.ongoing) return todayMs();
  return dms(e.end_date);
}

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

// ── Zoom helpers ───────────────────────────────────────────────────────────
const PX_MIN = 0.001, PX_MAX = 300;
const LOG_RANGE = Math.log10(PX_MAX / PX_MIN);

function pxToSlider(ppd) {
  return Math.round((Math.log10(ppd) - Math.log10(PX_MIN)) / LOG_RANGE * 100);
}
function sliderToPx(v) {
  return PX_MIN * Math.pow(PX_MAX / PX_MIN, v / 100);
}
function adjustZoom(factor) {
  const W = ctnEl.clientWidth;
  const centerMs = xToMs(W / 2);
  pxPerDay = Math.max(PX_MIN, Math.min(PX_MAX, pxPerDay * factor));
  viewStartMs = centerMs - (W / 2) / pxPerDay * DAY_MS;
  render();
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
// A period's occupied span. Ongoing bars never free their row (end = Infinity).
function periodSpan(e) {
  return { s: dms(e.start_date), end: e.ongoing ? Infinity : dms(e.end_date) };
}

// Time overlap test. Touching spans (one ends exactly where the next starts)
// do NOT overlap, so back-to-back periods are allowed to share a row.
function spansOverlap(a, b) {
  return a.s < b.end && b.s < a.end;
}

/**
 * Resolve each period to a display row index.
 *
 * `e.lane` is a stored *group key*, not a row position: periods sharing a key
 * are one explicit group and always share a row (the continuity case). Unpinned
 * periods auto-pack among themselves — into the earliest row with no time
 * overlap — but never into a pinned group's row, so a group's row shows exactly
 * its members. Finally every row is ordered top-to-bottom by its earliest start
 * date, so rows read chronologically and a pinned group is never yanked to the
 * top.
 */
function assignLanes(periods) {
  const pinned = periods.filter(e => e.lane != null);
  const auto   = periods.filter(e => e.lane == null)
                        .sort((a,b) => dms(a.start_date) - dms(b.start_date));

  const rows = [];   // each: { spans: [...], ids: [...] }

  // One row per distinct group key.
  const rowByKey = new Map();
  for (const e of pinned) {
    let row = rowByKey.get(e.lane);
    if (!row) { row = { spans: [], ids: [] }; rowByKey.set(e.lane, row); rows.push(row); }
    row.spans.push(periodSpan(e));
    row.ids.push(e.id);
  }
  const autoStart = rows.length;   // pinned rows occupy [0, autoStart)

  // Auto periods pack only among auto rows, never onto a pinned group's row.
  for (const e of auto) {
    const span = periodSpan(e);
    let row = null;
    for (let i = autoStart; i < rows.length; i++) {
      if (!rows[i].spans.some(o => spansOverlap(span, o))) { row = rows[i]; break; }
    }
    if (!row) { row = { spans: [], ids: [] }; rows.push(row); }
    row.spans.push(span);
    row.ids.push(e.id);
  }

  // Order rows by earliest start; that ordering is the display row index.
  const rowStart = r => Math.min(...r.spans.map(s => s.s));
  rows.sort((a,b) => rowStart(a) - rowStart(b));

  const laneOfId = new Map();
  rows.forEach((r, i) => r.ids.forEach(id => laneOfId.set(id, i)));
  return periods.map(e => ({ ...e, lane: laneOfId.get(e.id) }));
}

// Next free group key — max stored key + 1 (keys are opaque, only equality and
// "fresh" matter since rows are ordered by date, not by key).
function nextLaneKey() {
  return allEvents.reduce((m, e) => Math.max(m, e.lane == null ? -1 : e.lane), -1) + 1;
}

/**
 * Persist the result of dropping period `id` onto display row `targetRow`.
 * Dropping onto another row merges the bar into that row's group; dropping past
 * the last row (or onto its own row) gives it a fresh singleton group.
 */
async function dropOnRow(id, targetRow) {
  // Resolve the committed layout to see who currently sits in each row.
  const committed = assignLanes(allEvents.filter(e => e.type === 'period'));
  const rowMembers = new Map();
  let fromRow = null;
  for (const p of committed) {
    if (!rowMembers.has(p.lane)) rowMembers.set(p.lane, []);
    rowMembers.get(p.lane).push(p.id);
    if (p.id === id) fromRow = p.lane;
  }
  if (targetRow === fromRow) { render(); return; }   // dropped back on its row

  const members = (rowMembers.get(targetRow) || []).filter(m => m !== id);
  // Join an existing pinned group if the target row has one; else form a new
  // group (which also pins any previously-auto bars sharing that row).
  const pinnedKey = members.map(m => eventsCache[m].lane).find(v => v != null);
  const key = (members.length && pinnedKey != null) ? pinnedKey : nextLaneKey();

  const toSet = [id, ...members].filter(m => eventsCache[m].lane !== key);
  for (const m of toSet) {
    await fetch(`/api/event/${m}/lane`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lane: key })
    });
  }
  await loadEvents(true);
}

// ── Point label layout ─────────────────────────────────────────────────────
// Measure label widths with a canvas using the same font the SVG renders, so
// collision tests reflect actual pixels rather than a character-count guess.
let _measureCtx = null;
function labelHalfWidth(text) {
  if (!_measureCtx) {
    _measureCtx = document.createElement('canvas').getContext('2d');
    _measureCtx.font = LABEL_FONT;
  }
  return _measureCtx.measureText(text).width / 2;
}

/**
 * Assign each point a vertical level so no two labels overlap horizontally.
 *
 * Levels fan out from the axis alternating above/below, so dense clusters use
 * both directions instead of stacking ever higher on one side. Points are
 * visited left-to-right and greedily take the level closest to the axis whose
 * last label ended before this one begins — the standard interval-packing
 * approach, which keeps the common sparse case flat against the axis.
 *
 * Returns one entry per point: { below, stem, halfW } or null when the canvas
 * has no free level left, in which case the caller draws a bare dot.
 */
function layoutPoints(points, axisY, H, belowBase) {
  const aboveRoom = axisY - EDGE_MARGIN - FIRST_STEM;
  const belowRoom = H - axisY - EDGE_MARGIN - belowBase;
  const nAbove = Math.max(1, Math.floor(aboveRoom / LEVEL_STEP) + 1);
  const nBelow = Math.max(0, Math.floor(belowRoom / LEVEL_STEP) + 1);

  // Preference order: nearest the axis first, alternating sides.
  const levels = [];
  for (let r = 0; r < Math.max(nAbove, nBelow); r++) {
    if (r < nAbove) levels.push({ below: false, stem: FIRST_STEM + r * LEVEL_STEP });
    if (r < nBelow) levels.push({ below: true,  stem: belowBase  + r * LEVEL_STEP });
  }

  const lastRight = new Array(levels.length).fill(-Infinity);
  return points.map(e => {
    const x = msToX(dms(e.start_date));
    const halfW = labelHalfWidth(e.title);
    const left = x - halfW - LABEL_PAD;

    const idx = lastRight.findIndex(r => r <= left);
    if (idx === -1) return null;          // fully packed — label would collide
    lastRight[idx] = x + halfW;
    return { ...levels[idx], halfW };
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

  // Painter layers (gStem sits behind gPeriod so dashed lines don't overdraw bars)
  const gGrid   = mkEl('g', {}); svgEl.appendChild(gGrid);
  const gStem   = mkEl('g', {}); svgEl.appendChild(gStem);
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
  // Compute lanes for all periods up front so point stems can clear them.
  const periods = assignLanes(allEvents.filter(e => e.type === 'period'));
  // While dragging, show the grabbed bar at the hovered row (may be a new one).
  if (laneDrag) {
    const d = periods.find(p => p.id === laneDrag.id);
    if (d) d.lane = laneDrag.row;
  }
  const numPeriodLanes = periods.length > 0 ? Math.max(...periods.map(p => p.lane)) + 1 : 0;

  // Faint guide across the row the dragged bar will land in.
  if (laneDrag && laneDrag.moved) {
    const guideY = axisY + PERIOD_OFFSET + laneDrag.row * (PERIOD_H + PERIOD_GAP);
    gStem.appendChild(mkEl('rect', {
      x: 0, y: guideY - 2, width: W, height: PERIOD_H + 4,
      fill: '#1d4ed8', opacity: '0.07', rx: '4'
    }));
  }
  // Stem length for below-axis points: long enough that the label clears the lowest period bar.
  const belowStem = numPeriodLanes > 0
    ? PERIOD_OFFSET + numPeriodLanes * (PERIOD_H + PERIOD_GAP) + 20
    : BELOW_STEM;

  for (const e of periods) {
    const x1 = msToX(dms(e.start_date));
    const x2 = msToX(eventEndMs(e));
    if (x2 < -20 || x1 > W + 20) continue;

    const barY = axisY + PERIOD_OFFSET + e.lane * (PERIOD_H + PERIOD_GAP);
    const cx1  = Math.max(x1, -4);
    const cx2  = Math.min(x2, W + 4);
    const w    = Math.max(cx2 - cx1, 4);
    const fg   = contrastColor(e.color);

    const dragging = laneDrag && laneDrag.id === e.id && laneDrag.moved;
    const g = mkEl('g', { style: `cursor:${dragging ? 'grabbing' : 'grab'}` });
    g.appendChild(mkEl('rect', Object.assign({
      x:cx1, y:barY, width:w, height:PERIOD_H,
      rx:'4', fill:e.color, opacity: dragging ? '1' : '0.92'
    }, dragging ? { stroke:'#1e293b', 'stroke-width':'1.5' } : {})));

    // Ongoing periods get an arrow past "today" so the bar doesn't read as a
    // hard end. Only drawn when the real end is actually on screen.
    if (e.ongoing && cx2 < W + 4) {
      const tip = cx2 + ONGOING_ARROW;
      const midY = barY + PERIOD_H / 2;
      g.appendChild(mkEl('polygon', {
        points: `${cx2},${barY + 3} ${tip},${midY} ${cx2},${barY + PERIOD_H - 3}`,
        fill: e.color, opacity: '0.92'
      }));
    }
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
    // Start a vertical row-drag. A drag repins the bar; a click (no move) opens
    // the info bubble — both handled in the window mouseup below.
    g.addEventListener('mousedown', ev => {
      if (ev.button !== 0) return;
      ev.stopPropagation();               // keep the background pan from starting
      const maxRow = periods.length ? Math.max(...periods.map(p => p.lane)) + 1 : 0;
      laneDrag = {
        id: e.id, startY: ev.clientY, row: e.lane,
        maxRow, moved: false, cx: barCenterX, cy: barCenterY
      };
    });
    gPeriod.appendChild(g);
  }

  // ── Point events ──
  const points = [...allEvents.filter(e => e.type === 'point')]
    .sort((a,b) => dms(a.start_date) - dms(b.start_date));

  const layout = layoutPoints(points, axisY, H, belowStem);

  points.forEach((e, i) => {
    const x = Math.round(msToX(dms(e.start_date)));
    if (x < -100 || x > W + 100) return;

    const dotY = axisY;
    const slot = layout[i];

    // No level was free — draw just the dot so the cluster stays readable.
    if (!slot) {
      const bare = mkEl('g', { style: 'cursor:pointer' });
      bare.appendChild(mkEl('circle', {
        cx: x, cy: dotY, r: '4',
        fill: e.color, stroke: '#ffffff', 'stroke-width': '1.5', opacity: '0.85'
      }));
      bare.addEventListener('click', ev => { ev.stopPropagation(); openInfoBubble(e.id, x, dotY); });
      gPoint.appendChild(bare);
      return;
    }

    const below   = slot.below;
    const stemLen = slot.stem;
    const lineY1 = below ? dotY + 5  : dotY - 5;
    const lineY2 = below ? dotY + stemLen : dotY - stemLen;
    const labelY = below ? lineY2 + 14 : lineY2 - 8;

    // Dashed stem goes behind period bars
    gStem.appendChild(mkEl('line', {
      x1:x, y1:lineY1, x2:x, y2:lineY2,
      stroke:e.color, 'stroke-width':'1.5',
      'stroke-dasharray':'3,3', opacity:'0.8'
    }));

    const g = mkEl('g', { style:'cursor:pointer' });

    // Invisible hit area covering dot + stem + label. Sized to the measured
    // label so it never spills onto a neighbour's territory.
    const hitHalf   = Math.max(10, slot.halfW);
    const hitTop    = Math.min(labelY - 14, lineY2 - 2);
    const hitBottom = Math.max(labelY + 4,  dotY   + 7);
    g.appendChild(mkEl('rect', {
      x: x - hitHalf, y: hitTop, width: hitHalf * 2, height: hitBottom - hitTop,
      fill: 'transparent', stroke: 'none'
    }));

    // Dot on axis
    g.appendChild(mkEl('circle', {
      cx:x, cy:dotY, r:'5',
      fill:e.color, stroke:'#ffffff', 'stroke-width':'2'
    }));

    // Label (drawn in label layer so it sits on top of everything)
    gLabel.appendChild(mkTxt(e.title, {
      x, y:labelY,
      'text-anchor':'middle',
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

  // Sync zoom slider
  const zSlider = document.getElementById('zoom-slider');
  if (zSlider) zSlider.value = pxToSlider(pxPerDay);
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
    [dms(e.start_date), ...(e.type === 'period' ? [eventEndMs(e)] : [])]
  );
  const minMs = Math.min(...dates);
  const maxMs = Math.max(...dates);
  const range = Math.max(maxMs - minMs, 30 * DAY_MS);
  const pad   = range * 0.18;
  pxPerDay    = W / ((range + 2 * pad) / DAY_MS) * 1.3;
  viewStartMs = minMs - pad - (pad * 0.3 / 2); // re-center after zoom
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
    // A period row-drag takes priority over background pan.
    if (laneDrag) {
      const dy = ev.clientY - laneDrag.startY;
      if (!laneDrag.moved && Math.abs(dy) < 4) return;   // tolerate a jittery click
      laneDrag.moved = true;
      const H = ctnEl.clientHeight;
      const axisY = Math.round(H * AXIS_RATIO);
      const mouseY = ev.clientY - svgEl.getBoundingClientRect().top;
      let row = Math.round((mouseY - axisY - PERIOD_OFFSET) / (PERIOD_H + PERIOD_GAP));
      laneDrag.row = Math.max(0, Math.min(row, laneDrag.maxRow));
      render();
      return;
    }
    if (!isDragging) return;
    const dx = ev.clientX - dragStartX;
    viewStartMs = dragStartMs - dx / pxPerDay * DAY_MS;
    render();
  });
  window.addEventListener('mouseup', async () => {
    isDragging = false;
    if (svgEl) svgEl.style.cursor = 'grab';

    if (!laneDrag) return;
    const d = laneDrag;
    laneDrag = null;
    suppressBgClick = true;   // don't let the trailing click close things

    if (!d.moved) {
      openInfoBubble(d.id, d.cx, d.cy);   // it was a click, not a drag
      return;
    }
    await dropOnRow(d.id, d.row);
  });

  // Click on SVG background → close panel and bubble (unless a bar interaction
  // just handled this same click).
  svgEl.addEventListener('click', () => {
    if (suppressBgClick) { suppressBgClick = false; return; }
    closePanel();
    closeInfoBubble();
  });

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
  if (e.type === 'period' && e.ongoing) {
    dateEl.textContent = `${formatDate(e.start_date)} – Present`;
  } else if (e.type === 'period' && e.end_date) {
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
  setOngoing(false);
  setColorValue(lastUsedColor);
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
  // After setEventType, which clears the flag for point events.
  setOngoing(!!e.ongoing);
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
  // "Ongoing" is meaningless for a point event.
  if (type === 'point') setOngoing(false);
}

function setOngoing(on) {
  document.getElementById('f-ongoing').checked = on;
  const end = document.getElementById('f-end');
  end.disabled = on;
  if (on) end.value = '';
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
  const type        = currentEventType;
  const ongoing     = type === 'period' && document.getElementById('f-ongoing').checked;
  const end_date    = ongoing ? null : (document.getElementById('f-end').value || null);

  if (!title)      { showPanelError('Title is required.'); return; }
  if (!start_date) { showPanelError('Start date is required.'); return; }
  if (type === 'period' && !ongoing) {
    if (!end_date)                { showPanelError('End date is required, or mark the event ongoing.'); return; }
    if (end_date < start_date)    { showPanelError('End date must be on or after start date.'); return; }
  }

  const body = { title, description, type, start_date, end_date, color, ongoing };
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
  lastUsedColor = color;
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

async function autoArrange() {
  await fetch(`/api/timeline/${TIMELINE_ID}/lanes/reset`, { method: 'POST' });
  await loadEvents(true);
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

  const zoomSlider = document.getElementById('zoom-slider');
  if (zoomSlider) {
    zoomSlider.addEventListener('input', () => {
      const W = ctnEl.clientWidth;
      const centerMs = xToMs(W / 2);
      pxPerDay = sliderToPx(Number(zoomSlider.value));
      viewStartMs = centerMs - (W / 2) / pxPerDay * DAY_MS;
      render();
    });
    // Prevent drag-pan from starting when the user grabs the slider
    zoomSlider.addEventListener('mousedown', ev => ev.stopPropagation());
  }

  const zoomBar = document.getElementById('zoom-bar');
  if (zoomBar) zoomBar.addEventListener('mousedown', ev => ev.stopPropagation());

  initSVG();
  loadEvents(false);
});
