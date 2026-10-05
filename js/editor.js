// editor.js — SVG floor-plan editor (walls). Units: cm.
const Editor = (() => {
  const SVGNS = 'http://www.w3.org/2000/svg';
  let project, projectPath, svg, world, overlay;
  let mode = 'select';         // 'draw' | 'select' | 'edit' | place door/window handled via pendingAsset
  let pendingAsset = null;     // 'door' | 'window' when placing
  let selectedAssets = new Set(); // ids of selected assets
  let assetDrag = null;        // {asset, wall}
  let snap = true;
  let wallThickness = 15;      // cm
  let zoom = 1, panX = 0, panY = 0;
  let drawing = null;          // {x1,y1,x2,y2,line}
  let dragging = null;         // {wall, ox, oy, startX, startY, moved}
  let calibrating = null;      // first world point of scale calibration
  let endpointDrag = null;     // {wall, end: 'p1'|'p2'}
  let panning = null;
  let marquee = null;          // {x1,y1,x2,y2} world-space rubber band
  let maybeToggle = null;      // {kind:'wall'|'asset', id} deferred Ctrl+click toggle
  let lastDown = { id: null, time: 0 }; // manual double-click tracking
  let selectedIds = new Set();
  let saveTimer = null;
  let bgSize = { w: 0, h: 0 };
  let clipboard = null;       // {walls, assets} in-memory copy
  let pasteCount = 0;         // offset each consecutive paste
  const history = { stack: [], idx: -1 };

  function snapshot() { return JSON.stringify({ walls: project.walls, assets: project.assets || [], bgImage: project.bgImage || null, bgX: project.bgX || 0, bgY: project.bgY || 0, bgScale: project.bgScale || null, measOverlay: project.measOverlay || null }); }
  function pushHistory() {
    history.stack = history.stack.slice(0, history.idx + 1);
    history.stack.push(snapshot());
    if (history.stack.length > 100) history.stack.shift();
    history.idx = history.stack.length - 1;
    updateUndoBtns();
  }
  function restore(snap) {
    const s = JSON.parse(snap);
    project.walls = s.walls; project.assets = s.assets;
    project.bgImage = s.bgImage || null; project.bgX = s.bgX || 0; project.bgY = s.bgY || 0; project.bgScale = s.bgScale || null; project.measOverlay = s.measOverlay || null;
    selectedIds = new Set(); selectedAssets = new Set();
    scheduleSave(); updateDeleteBtn(); render();
  }
  function undo() { if (history.idx > 0) { history.idx--; restore(history.stack[history.idx]); updateUndoBtns(); } }
  function redo() { if (history.idx < history.stack.length - 1) { history.idx++; restore(history.stack[history.idx]); updateUndoBtns(); } }
  function updateUndoBtns() {
    const u = document.getElementById('undoBtn'), r = document.getElementById('redoBtn');
    if (u) u.disabled = history.idx <= 0;
    if (r) r.disabled = history.idx >= history.stack.length - 1;
  }

  const GRID = 25;             // cm
  const snapTo = v => v;

  // A wall end is "connected" when another wall starts/ends at the same point
  // or passes through it. Only connected ends may extend past the endpoint.
  function endConnected(w, end) {
    const p = end === 'p1' ? { x: w.x1, y: w.y1 } : { x: w.x2, y: w.y2 };
    for (const o of project.walls) {
      if (o === w) continue;
      if (Math.hypot(o.x1 - p.x, o.y1 - p.y) < 1e-6 || Math.hypot(o.x2 - p.x, o.y2 - p.y) < 1e-6) return true;
      if (liesOnWallInterior(o, p)) return true;
    }
    return false;
  }

  // Geometry of the wall's stroke. Free ends are pulled in by half the
  // thickness so the square cap's outer edge lands exactly on the endpoint —
  // changing the thickness then only fattens the wall, never lengthens it.
  // Connected ends keep the full square cap so joints stay closed.
  function strokeEnds(w) {
    const dx = w.x2 - w.x1, dy = w.y2 - w.y1;
    const l = Math.hypot(dx, dy); if (!l) return { x1: w.x1, y1: w.y1, x2: w.x2, y2: w.y2 };
    const ux = dx / l, uy = dy / l, o = w.thickness / 2;
    const a = endConnected(w, 'p1') ? 0 : Math.min(o, l / 2);
    const b = endConnected(w, 'p2') ? 0 : Math.min(o, l / 2);
    return { x1: w.x1 + ux * a, y1: w.y1 + uy * a, x2: w.x2 - ux * b, y2: w.y2 - uy * b };
  }

  function endpoints(excludeId) {
    const pts = [];
    for (const w of project.walls) {
      if (w.id === excludeId) continue;
      const dx = w.x2 - w.x1, dy = w.y2 - w.y1;
      const l = Math.hypot(dx, dy) || 1;
      const ux = dx / l, uy = dy / l;
      const o1 = endConnected(w, 'p1') ? w.thickness / 2 : 0; // very edge of the square cap
      const o2 = endConnected(w, 'p2') ? w.thickness / 2 : 0;
      pts.push({ x: w.x1 - ux * o1, y: w.y1 - uy * o1 }, { x: w.x2 + ux * o2, y: w.y2 + uy * o2 });
    }
    return pts;
  }
  function snapPoint(p, excludeId) {
    const r = 12 / zoom;
    let best = null, bd = r;
    for (const q of endpoints(excludeId)) {
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d <= bd) { bd = d; best = { x: q.x, y: q.y }; }
    }
    for (const w of project.walls) {
      if (w.id === excludeId) continue;
      const dx = w.x2 - w.x1, dy = w.y2 - w.y1;
      const l2 = dx * dx + dy * dy; if (!l2) continue;
      let t = ((p.x - w.x1) * dx + (p.y - w.y1) * dy) / l2;
      t = Math.max(0, Math.min(1, t));
      const px = w.x1 + t * dx, py = w.y1 + t * dy;
      const d = Math.hypot(px - p.x, py - p.y);
      if (d < bd) { bd = d; best = { x: px, y: py }; }
    }
    return best || { x: p.x, y: p.y };
  }

  // AutoCAD-style dimension along wall w, from joint q to its closest extremity.
  // (dirx, diry) = direction of the connecting wall at q (used to place dim on opposite side).
  function addConnDim(g, w, q, dirx, diry) {
    const dx = w.x2 - w.x1, dy = w.y2 - w.y1;
    const len = Math.hypot(dx, dy); if (!len) return;
    const ux = dx / len, uy = dy / len;
    const d1 = Math.hypot(q.x - w.x1, q.y - w.y1);
    const d2 = Math.hypot(q.x - w.x2, q.y - w.y2);
    const end = d1 <= d2 ? { x: w.x1, y: w.y1 } : { x: w.x2, y: w.y2 };
    const dist = Math.min(d1, d2);
    let nx = -uy, ny = ux;
    if (nx * dirx + ny * diry > 0) { nx = -nx; ny = -ny; }
    const off = w.thickness / 2 + 14 / zoom;
    const ax = q.x + nx * off, ay = q.y + ny * off;
    const bx = end.x + nx * off, by = end.y + ny * off;
    const g2 = el('g', { stroke: '#ffd166', 'stroke-width': 1.2 / zoom, fill: 'none' });
    // extension lines
    for (const p of [q, end]) {
      g2.appendChild(el('line', {
        x1: p.x + nx * (w.thickness / 2 + 2 / zoom), y1: p.y + ny * (w.thickness / 2 + 2 / zoom),
        x2: p.x + nx * (off + 4 / zoom), y2: p.y + ny * (off + 4 / zoom),
      }));
    }
    // dimension line
    g2.appendChild(el('line', { x1: ax, y1: ay, x2: bx, y2: by }));
    // arrowheads
    const s = 7 / zoom, wd = 3 / zoom;
    const ang = Math.atan2(by - ay, bx - ax);
    for (const [tip, a] of [[ [ax, ay], ang ], [ [bx, by], ang + Math.PI ]]) {
      const p1 = `${tip[0]},${tip[1]}`;
      const b1x = tip[0] + Math.cos(a) * s + Math.cos(a + Math.PI / 2) * wd, b1y = tip[1] + Math.sin(a) * s + Math.sin(a + Math.PI / 2) * wd;
      const b2x = tip[0] + Math.cos(a) * s - Math.cos(a + Math.PI / 2) * wd, b2y = tip[1] + Math.sin(a) * s - Math.sin(a + Math.PI / 2) * wd;
      g2.appendChild(el('path', { d: `M${p1} L${b1x},${b1y} L${b2x},${b2y} Z`, fill: '#ffd166', stroke: 'none' }));
    }
    // text — same direction rules as the wall labels
    let la;
    const adeg = Math.atan2(uy, ux) * 180 / Math.PI;
    if (Math.abs(adeg) > 89.5 && Math.abs(adeg) < 90.5) la = -90; // vertical: read down→up
    else if (Math.abs(adeg) < 0.5 || Math.abs(adeg) > 179.5) la = 0; // horizontal: read L→R
    else { la = adeg; if (la < -90) la += 180; else if (la > 90) la -= 180; }
    const mxp = (ax + bx) / 2 + nx * 12 / zoom, myp = (ay + by) / 2 + ny * 12 / zoom;
    const t = el('text', { x: mxp, y: myp, 'text-anchor': 'middle', fill: '#ffd166', 'font-size': 12 / zoom, stroke: 'none', transform: `rotate(${la} ${mxp} ${myp})` });
    t.textContent = fmtLen(dist);
    g2.appendChild(t);
    g.appendChild(g2);
  }

  function liesOnWallInterior(w, p) {
    const dx = w.x2 - w.x1, dy = w.y2 - w.y1;
    const l2 = dx * dx + dy * dy; if (!l2) return false;
    const t = ((p.x - w.x1) * dx + (p.y - w.y1) * dy) / l2;
    if (t <= 1e-6 || t >= 1 - 1e-6) return false;
    return Math.hypot(w.x1 + t * dx - p.x, w.y1 + t * dy - p.y) < 1e-6;
  }

  function el(tag, attrs) {
    const e = document.createElementNS(SVGNS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

  function toWorld(evt) {
    const pt = svg.createSVGPoint();
    pt.x = evt.clientX; pt.y = evt.clientY;
    const m = world.getScreenCTM().inverse();
    return pt.matrixTransform(m);
  }

  function wallLength(w) { return Math.hypot(w.x2 - w.x1, w.y2 - w.y1); }
  function wallAngle(w) {
    let a = Math.atan2(w.y2 - w.y1, w.x2 - w.x1) * 180 / Math.PI;
    if (a < 0) a += 360;
    return a;
  }
  function fmtLen(cm) { return (cm / 100).toFixed(2) + ' m'; }

  function render() {
    world.innerHTML = '';
    // imported floor-plan picture (drawn first, behind everything)
    if (project.bgImage && bgSize.w) {
      const img = el('image', {
        href: project.bgImage, x: project.bgX || 0, y: project.bgY || 0,
        width: bgSize.w * (project.bgScale || 1), height: bgSize.h * (project.bgScale || 1),
        opacity: 0.55, preserveAspectRatio: 'none',
      });
      world.appendChild(img);
    }
    if (project.measOverlay) {
      const s = project.bgScale || 1;
      world.appendChild(el('image', {
        href: project.measOverlay, x: project.bgX || 0, y: project.bgY || 0,
        width: bgSize.w * s, height: bgSize.h * s, opacity: 0.8, preserveAspectRatio: 'none',
      }));
    }
    // grid
    const g = el('g', { opacity: 0.15 });
    const extent = 20000;
    for (let x = -extent; x <= extent; x += GRID * 4) g.appendChild(el('line', { x1: x, y1: -extent, x2: x, y2: extent, stroke: '#888', 'stroke-width': 1 / zoom }));
    for (let y = -extent; y <= extent; y += GRID * 4) g.appendChild(el('line', { x1: -extent, y1: y, x2: extent, y2: y, stroke: '#888', 'stroke-width': 1 / zoom }));
    world.appendChild(g);

    for (const w of project.walls) {
      const grp = el('g', { 'data-id': w.id, cursor: mode === 'select' ? 'move' : mode === 'edit' ? 'pointer' : 'crosshair' });
      const selected = selectedIds.has(w.id);
      const fill = w.fill || 'solid';
      const se = strokeEnds(w);
      if (fill !== 'solid' && !selected) {
        grp.appendChild(el('line', { x1: se.x1, y1: se.y1, x2: se.x2, y2: se.y2, stroke: '#e0e0e0', 'stroke-opacity': 0.2, 'stroke-width': w.thickness, 'stroke-linecap': 'square' }));
      }
      grp.appendChild(el('line', {
        x1: se.x1, y1: se.y1, x2: se.x2, y2: se.y2,
        stroke: selected ? '#ffd166' : fill === 'solid' ? '#e0e0e0' : fill === 'dots' ? 'url(#patDots)' : 'url(#patDash)',
        'stroke-opacity': fill === 'solid' && !selected ? 0.75 : 1,
        'stroke-width': w.thickness,
        'stroke-linecap': 'square',
      }));
      // hit area
      grp.appendChild(el('line', { x1: w.x1, y1: w.y1, x2: w.x2, y2: w.y2, stroke: 'transparent', 'stroke-width': Math.max(w.thickness, 20) }));
      // label
      const mx = (w.x1 + w.x2) / 2, my = (w.y1 + w.y2) / 2;
      const off = w.thickness / 2 + 10 / zoom;
      const dx = w.x2 - w.x1, dy = w.y2 - w.y1;
      let lx, ly, la;
      const adeg = Math.atan2(dy, dx) * 180 / Math.PI;
      if (Math.abs(adeg) > 89.5 && Math.abs(adeg) < 90.5) { lx = mx - off; ly = my; la = -90; }  // vertical: left side, read down→up
      else if (Math.abs(adeg) < 0.5 || Math.abs(adeg) > 179.5) { lx = mx; ly = my - off; la = 0; } // horizontal: top, read L→R
      else {
        // angled wall: parallel to the wall, above the line, read left→right
        la = adeg;
        if (la < -90) la += 180; else if (la > 90) la -= 180;
        const rad = la * Math.PI / 180;
        lx = mx + Math.sin(rad) * off; ly = my - Math.cos(rad) * off;
      }
      const t = el('text', {
        x: lx, y: ly, 'text-anchor': 'middle', fill: '#9ecbff', 'font-size': 14 / zoom,
        transform: `rotate(${la} ${lx} ${ly})`,
      });
      t.textContent = `${fmtLen(wallLength(w))} · ${wallAngle(w).toFixed(1)}°`;
      grp.appendChild(t);
      grp.addEventListener('pointerdown', e => onWallDown(e, w));
      grp.addEventListener('dblclick', e => { e.stopPropagation(); mode = 'edit'; drawing = null; selectedIds = new Set([w.id]); selectedAssets = new Set(); updateDeleteBtn(); render(); });
      world.appendChild(grp);
      if (selected && mode === 'edit' && selectedIds.size === 1) {
        for (const end of ['p1', 'p2']) {
          const hx = end === 'p1' ? w.x1 : w.x2, hy = end === 'p1' ? w.y1 : w.y2;
          const h = el('circle', { cx: hx, cy: hy, r: 8 / zoom, fill: '#ffd166', stroke: '#111', 'stroke-width': 2 / zoom, cursor: 'crosshair' });
          h.addEventListener('pointerdown', e => {
            e.stopPropagation();
            endpointDrag = { wall: w, end };
            svg.setPointerCapture(e.pointerId);
          });
          world.appendChild(h);
        }
      }
    }
    for (const a of (project.assets || [])) {
      const w = project.walls.find(x => x.id === a.wallId);
      if (!w) continue;
      const dx = w.x2 - w.x1, dy = w.y2 - w.y1;
      const len = Math.hypot(dx, dy); if (!len) continue;
      const ux = dx / len, uy = dy / len;
      const hw = Math.min(a.width / 2, len / 2);
      const cx = w.x1 + ux * a.t * len, cy = w.y1 + uy * a.t * len;
      const x1 = cx - ux * hw, y1 = cy - uy * hw, x2 = cx + ux * hw, y2 = cy + uy * hw;
      const nx = -uy, ny = ux;
      const selected = selectedAssets.has(a.id);
      const grp = el('g', { 'data-id': a.id, cursor: 'move' });
      if (a.type === 'door') {
        // open space: erase the wall segment
        grp.appendChild(el('line', { x1, y1, x2, y2, stroke: '#111', 'stroke-width': w.thickness, 'stroke-linecap': 'butt' }));
        const side = a.swing || 1;
        const hingeStart = (a.hinge || 1) === 1;
        const hx = hingeStart ? x1 : x2, hy = hingeStart ? y1 : y2;
        const ox = hingeStart ? x2 : x1, oy = hingeStart ? y2 : y1;
        const leafX = hx + nx * side * a.width, leafY = hy + ny * side * a.width;
        grp.appendChild(el('line', { x1: hx, y1: hy, x2: leafX, y2: leafY, stroke: selected ? '#ffd166' : '#9ecbff', 'stroke-width': 2.5 / zoom }));
        grp.appendChild(el('path', {
          d: `M ${ox},${oy} A ${a.width} ${a.width} 0 0 ${side * (hingeStart ? 1 : -1) > 0 ? 1 : 0} ${leafX},${leafY}`,
          fill: 'none', stroke: selected ? '#ffd166' : '#9ecbff', 'stroke-width': 1.2 / zoom, 'stroke-dasharray': `${4 / zoom} ${3 / zoom}`,
        }));
      } else if (a.type === 'window') {
        // rectangle on top of the wall
        const th = w.thickness / 2;
        const pts = [
          `${x1 + nx * th},${y1 + ny * th}`, `${x2 + nx * th},${y2 + ny * th}`,
          `${x2 - nx * th},${y2 - ny * th}`, `${x1 - nx * th},${y1 - ny * th}`,
        ].join(' ');
        grp.appendChild(el('polygon', { points: pts, fill: selected ? 'rgba(255,209,102,0.35)' : 'rgba(77,171,247,0.35)', stroke: selected ? '#ffd166' : '#4dabf7', 'stroke-width': 2 / zoom }));
        grp.appendChild(el('line', { x1, y1, x2, y2, stroke: selected ? '#ffd166' : '#4dabf7', 'stroke-width': 1.5 / zoom }));
        // direction arc showing which way the window opens
        const side = a.swing || 1;
        const hingeStart = (a.hinge || 1) === 1;
        const hx = hingeStart ? x1 : x2, hy = hingeStart ? y1 : y2;
        const ox = hingeStart ? x2 : x1, oy = hingeStart ? y2 : y1;
        const leafX = hx + nx * side * a.width, leafY = hy + ny * side * a.width;
        grp.appendChild(el('line', { x1: hx, y1: hy, x2: leafX, y2: leafY, stroke: selected ? '#ffd166' : '#a5d8ff', 'stroke-width': 2 / zoom }));
        grp.appendChild(el('path', {
          d: `M ${ox},${oy} A ${a.width} ${a.width} 0 0 ${side * (hingeStart ? 1 : -1) > 0 ? 1 : 0} ${leafX},${leafY}`,
          fill: 'none', stroke: selected ? '#ffd166' : '#a5d8ff', 'stroke-width': 1.2 / zoom, 'stroke-dasharray': `${4 / zoom} ${3 / zoom}`,
        }));
      }
      if (selected) {
        grp.appendChild(el('line', { x1, y1, x2, y2, stroke: '#ffd166', 'stroke-opacity': 0.4, 'stroke-width': w.thickness + 8 / zoom }));
      }
      const hit = el('line', { x1, y1, x2, y2, stroke: 'transparent', 'stroke-width': Math.max(w.thickness, 16 / zoom + w.thickness) });
      hit.addEventListener('pointerdown', e => onAssetDown(e, a));
      hit.addEventListener('dblclick', e => { e.stopPropagation(); mode = 'edit'; drawing = null; selectedAssets = new Set([a.id]); selectedIds = new Set(); updateDeleteBtn(); render(); });
      grp.appendChild(hit);
      world.appendChild(grp);
    }
    // persistent dimensions for T-connections (endpoint on the middle of another wall)
    for (const a of project.walls) {
      for (const ep of [[a.x1, a.y1], [a.x2, a.y2]]) {
        for (const b of project.walls) {
          if (b === a) continue;
          if (liesOnWallInterior(b, { x: ep[0], y: ep[1] })) {
            const ox = ep[0] === a.x1 && ep[1] === a.y1 ? a.x2 : a.x1;
            const oy = ep[0] === a.x1 && ep[1] === a.y1 ? a.y2 : a.y1;
            addConnDim(world, b, { x: ep[0], y: ep[1] }, ox - ep[0], oy - ep[1]);
          }
        }
      }
    }
    if (drawing) {
      overlay.innerHTML = '';
      const dse = strokeEnds({ x1: drawing.x1, y1: drawing.y1, x2: drawing.x2, y2: drawing.y2, thickness: wallThickness });
      overlay.appendChild(el('line', { x1: dse.x1, y1: dse.y1, x2: dse.x2, y2: dse.y2, stroke: '#4dabf7', 'stroke-width': wallThickness, 'stroke-linecap': 'square', 'stroke-dasharray': `${8 / zoom} ${6 / zoom}` }));
      const dx = drawing.x2 - drawing.x1, dy = drawing.y2 - drawing.y1;
      let dmx = (drawing.x1 + drawing.x2) / 2, dmy = (drawing.y1 + drawing.y2) / 2, da;
      const doff = wallThickness / 2 + 10 / zoom;
      const dadeg = Math.atan2(dy, dx) * 180 / Math.PI;
      if (Math.abs(dadeg) > 89.5 && Math.abs(dadeg) < 90.5) { dmx -= doff; da = -90; }
      else if (Math.abs(dadeg) < 0.5 || Math.abs(dadeg) > 179.5) { dmy -= doff; da = 0; }
      else {
        da = dadeg;
        if (da < -90) da += 180; else if (da > 90) da -= 180;
        const rad = da * Math.PI / 180;
        dmx += Math.sin(rad) * doff; dmy -= Math.cos(rad) * doff;
      }
      const t = el('text', { x: dmx, y: dmy, 'text-anchor': 'middle', fill: '#4dabf7', 'font-size': 14 / zoom, transform: `rotate(${da} ${dmx} ${dmy})` });
      t.textContent = fmtLen(Math.hypot(drawing.x2 - drawing.x1, drawing.y2 - drawing.y1));
      overlay.appendChild(t);
      // live dimension when an end joins the middle of an existing wall
      for (const ep of [[drawing.x1, drawing.y1], [drawing.x2, drawing.y2]]) {
        for (const w of project.walls) {
          if (liesOnWallInterior(w, { x: ep[0], y: ep[1] })) {
            const ox = ep[0] === drawing.x1 && ep[1] === drawing.y1 ? drawing.x2 : drawing.x1;
            const oy = ep[0] === drawing.x1 && ep[1] === drawing.y1 ? drawing.y2 : drawing.y1;
            addConnDim(overlay, w, { x: ep[0], y: ep[1] }, ox - ep[0], oy - ep[1]);
          }
        }
      }
    } else overlay.innerHTML = '';
    if (calibrating) {
      overlay.appendChild(el('circle', { cx: calibrating.x, cy: calibrating.y, r: 6 / zoom, fill: '#ff6b6b', stroke: '#111', 'stroke-width': 1.5 / zoom }));
    }
    if (marquee) {
      overlay.appendChild(el('rect', {
        x: Math.min(marquee.x1, marquee.x2), y: Math.min(marquee.y1, marquee.y2),
        width: Math.abs(marquee.x2 - marquee.x1), height: Math.abs(marquee.y2 - marquee.y1),
        fill: 'rgba(77,171,247,0.12)', stroke: '#4dabf7', 'stroke-width': 1.2 / zoom, 'stroke-dasharray': `${6 / zoom} ${4 / zoom}`,
      }));
    }
    if (mode === 'draw') {
      for (const q of endpoints()) {
        overlay.appendChild(el('circle', { cx: q.x, cy: q.y, r: 5 / zoom, fill: '#4dabf7', stroke: '#111', 'stroke-width': 1.5 / zoom }));
      }
    }
    updateInspector();
  }

  function applyView() {
    world.setAttribute('transform', `translate(${panX} ${panY}) scale(${zoom})`);
    overlay.setAttribute('transform', `translate(${panX} ${panY}) scale(${zoom})`);
  }

  function onAssetDown(e, a) {
    if (pendingAsset) return;
    e.stopPropagation();
    if (lastDown.id === a.id && performance.now() - lastDown.time < 450) { // double click → edit mode
      lastDown = { id: null, time: 0 };
      mode = 'edit'; drawing = null; calibrating = null;
      selectedAssets = new Set([a.id]); selectedIds = new Set();
      updateDeleteBtn(); render(); return;
    }
    lastDown = { id: a.id, time: performance.now() };
    if (e.ctrlKey || e.metaKey) {
      // defer: plain click toggles, drag starts a marquee (multi-select)
      maybeToggle = { kind: 'asset', id: a.id, sx: e.clientX, sy: e.clientY };
      svg.setPointerCapture(e.pointerId);
      return;
    }
    // single click → select/move mode + immediate drag
    selectedAssets = new Set([a.id]);
    selectedIds = new Set();
    mode = 'select'; drawing = null; calibrating = null;
    const w = project.walls.find(x => x.id === a.wallId);
    assetDrag = { asset: a, wall: w };
    svg.setPointerCapture(e.pointerId);
    updateDeleteBtn(); render();
  }

  function onWallDown(e, w) {
    if (pendingAsset) return;
    e.stopPropagation();
    // manual double-click detection (click count resets because render() replaces the DOM)
    const now = performance.now();
    if (lastDown.id === w.id && now - lastDown.time < 450) {
      lastDown = { id: null, time: 0 };
      mode = 'edit'; drawing = null; calibrating = null; dragging = null;
      selectedIds = new Set([w.id]); selectedAssets = new Set();
      updateDeleteBtn(); render(); return;
    }
    lastDown = { id: w.id, time: now };
    if (mode === 'draw' || mode === 'calibrate') { mode = 'select'; drawing = null; calibrating = null; }
    if (e.ctrlKey || e.metaKey) {
      // defer: plain click toggles, drag starts a marquee (multi-select)
      maybeToggle = { kind: 'wall', id: w.id, sx: e.clientX, sy: e.clientY };
      svg.setPointerCapture(e.pointerId);
      return;
    }
    selectedAssets = new Set();
    selectedIds = new Set([w.id]);
    // single click on a wall switches to select/move and starts a drag
    mode = 'select';
    const p = toWorld(e);
    dragging = { wall: w, ox: p.x, oy: p.y, x1: w.x1, y1: w.y1, x2: w.x2, y2: w.y2 };
    svg.setPointerCapture(e.pointerId);
    updateDeleteBtn();
    render();
  }

  function updateDeleteBtn() {
    document.getElementById('deleteSelected').disabled = selectedIds.size === 0 && selectedAssets.size === 0;
    updateInspector();
  }

  function onlySelected() { return selectedIds.size === 1 ? [...selectedIds][0] : null; }

  function copySelection() {
    const wallIds = new Set(selectedIds);
    const assets = (project.assets || []).filter(a => selectedAssets.has(a.id) || selectedIds.has(a.wallId));
    for (const a of assets) wallIds.add(a.wallId);
    const walls = project.walls.filter(w => wallIds.has(w.id));
    if (!walls.length && !assets.length) return;
    clipboard = JSON.parse(JSON.stringify({ walls, assets }));
    pasteCount = 0;
  }

  function pasteClipboard() {
    if (!clipboard) return;
    pasteCount++;
    const d = 25 * pasteCount; // cm
    const idMap = {};
    const newWalls = clipboard.walls.map(w => {
      const id = crypto.randomUUID(); idMap[w.id] = id;
      return { ...w, id, x1: w.x1 + d, y1: w.y1 + d, x2: w.x2 + d, y2: w.y2 + d };
    });
    const newAssets = clipboard.assets.filter(a => idMap[a.wallId]).map(a => ({
      ...a, id: crypto.randomUUID(), wallId: idMap[a.wallId],
    }));
    project.walls.push(...newWalls);
    project.assets = (project.assets || []).concat(newAssets);
    selectedIds = new Set(newWalls.map(w => w.id));
    selectedAssets = new Set(newAssets.map(a => a.id));
    scheduleSave(); updateDeleteBtn(); render(); pushHistory();
  }

  function applyInspector() {
    const w = project.walls.find(w => w.id === onlySelected());
    if (!w) return;
    const lenCm = Math.max(5, parseFloat(document.getElementById('wallLen').value) || 0);
    const ang = (parseFloat(document.getElementById('wallAngle').value) || 0) * Math.PI / 180;
    const thick = parseFloat(document.getElementById('wallThick').value);
    w.x2 = w.x1 + Math.cos(ang) * lenCm;
    w.y2 = w.y1 + Math.sin(ang) * lenCm;
    if (thick) w.thickness = Math.min(60, Math.max(5, thick));
    scheduleSave(); render(); updateInspector(); pushHistory();
  }

  function applyAssetInspector() {
    const a = selectedAssets.size === 1 ? (project.assets || []).find(a => a.id === [...selectedAssets][0]) : null;
    if (!a) return;
    const w = project.walls.find(x => x.id === a.wallId); if (!w) return;
    const len = wallLength(w);
    const width = Math.min(Math.max(5, parseFloat(document.getElementById('assetWidth').value) || 0), len);
    a.width = width;
    const hw = Math.min(a.width / 2, len / 2);
    a.t = Math.min(Math.max(a.t, hw / len), 1 - hw / len);
    scheduleSave(); render(); updateAssetInspector(); pushHistory();
  }

  function updateAssetInspector() {
    const a = selectedAssets.size === 1 ? (project.assets || []).find(a => a.id === [...selectedAssets][0]) : null;
    const box = document.getElementById('assetInspector');
    if (!a) { box.classList.add('d-none'); box.classList.remove('d-flex'); return; }
    box.classList.remove('d-none'); box.classList.add('d-flex');
    document.getElementById('assetType').textContent = a.type === 'door' ? 'Door' : 'Window';
    document.getElementById('assetWidth').value = a.width;
  }

  function applyAssetDir() {
    const a = selectedAssets.size === 1 ? (project.assets || []).find(a => a.id === [...selectedAssets][0]) : null;
    if (!a) return;
    a.swing = (a.swing || 1) === 1 ? -1 : 1;
    scheduleSave(); render(); pushHistory();
  }

  function updateInspector() {
    const w = project.walls.find(w => w.id === onlySelected());
    const box = document.getElementById('inspector');
    updateAssetInspector();
    if (!w || mode !== 'edit') { box.classList.add('d-none'); box.classList.remove('d-flex'); return; }
    box.classList.remove('d-none'); box.classList.add('d-flex');
    document.getElementById('wallLen').value = wallLength(w).toFixed(1);
    document.getElementById('wallAngle').value = wallAngle(w).toFixed(1);
    document.getElementById('wallThick').value = w.thickness;
    document.getElementById('wallFill').value = w.fill || 'solid';
  }

  function applyFill() {
    const w = project.walls.find(w => w.id === onlySelected());
    if (!w) return;
    w.fill = document.getElementById('wallFill').value;
    scheduleSave(); render(); pushHistory();
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => DB.save(projectPath, project), 600);
  }

  function init(p, path) {
    project = p; projectPath = path;
    project.assets = project.assets || [];
    svg = document.getElementById('plan');
    world = document.getElementById('world');
    overlay = document.getElementById('overlay');

    svg.addEventListener('pointerdown', e => {
      if (e.button === 1 || e.shiftKey) { panning = { x: e.clientX, y: e.clientY, panX, panY }; svg.setPointerCapture(e.pointerId); return; }
      const p = toWorld(e);
      if (pendingAsset) {
        // place asset on the nearest wall within tolerance
        const r = Math.max(12 / zoom, 10);
        let best = null, bd = Infinity, bestT = 0;
        for (const w of project.walls) {
          const dx = w.x2 - w.x1, dy = w.y2 - w.y1;
          const l2 = dx * dx + dy * dy; if (!l2) continue;
          let t = ((p.x - w.x1) * dx + (p.y - w.y1) * dy) / l2;
          t = Math.max(0, Math.min(1, t));
          const px = w.x1 + t * dx, py = w.y1 + t * dy;
          const d = Math.hypot(px - p.x, py - p.y);
          if (d < bd) { bd = d; best = w; bestT = t; }
        }
        if (best && bd <= Math.max(best.thickness / 2, 10 / zoom) + 8) {
          project.assets = project.assets || [];
          const width = pendingAsset === 'door' ? 90 : 120;
          const len = wallLength(best);
          const hw = Math.min(width / 2, len / 2);
          const t = Math.min(Math.max(bestT, hw / len), Math.max(hw / len, 1 - hw / len));
          const a = { id: crypto.randomUUID(), type: pendingAsset, wallId: best.id, t, width, swing: 1 };
          project.assets.push(a);
          selectedAssets = new Set([a.id]); selectedIds = new Set();
          scheduleSave(); updateDeleteBtn(); pushHistory();
        }
        pendingAsset = null; mode = 'select'; render(); return;
      }
      if (mode === 'calibrate') {
        const p = toWorld(e);
        if (!calibrating) { calibrating = p; }
        else {
          const dWorld = Math.hypot(p.x - calibrating.x, p.y - calibrating.y);
          const s0 = project.bgScale || 1;
          const pxDist = dWorld / s0;
          const input = window.prompt('Real distance between the two points, in meters:');
          const meters = parseFloat(input);
          if (meters > 0 && pxDist > 0) {
            const s1 = (meters * 100) / pxDist;
            project.bgX = calibrating.x - ((calibrating.x - (project.bgX || 0)) / s0) * s1;
            project.bgY = calibrating.y - ((calibrating.y - (project.bgY || 0)) / s0) * s1;
            project.bgScale = s1;
            scheduleSave(); pushHistory();
          }
          calibrating = null; mode = 'select';
        }
        render(); return;
      }
      if (mode === 'draw') {
        if (!drawing) {
          const s = snapPoint(p);
          drawing = { x1: s.x, y1: s.y, x2: s.x, y2: s.y };
        } else {
          const s = snapPoint(p);
          drawing.x2 = s.x; drawing.y2 = s.y;
          if (wallLength(drawing) > 0) {
            project.walls.push({ id: crypto.randomUUID(), x1: drawing.x1, y1: drawing.y1, x2: drawing.x2, y2: drawing.y2, thickness: wallThickness });
            scheduleSave(); pushHistory();
          }
          drawing = null;
        }
        render(); return;
      }
      // select mode, clicked empty space
      if (e.target === svg || e.target.tagName === 'line' && e.target.parentNode === world) {
        if (e.ctrlKey || e.metaKey) {
          // Ctrl+drag on empty space also starts the multi-select marquee
          const p = toWorld(e);
          marquee = { x1: p.x, y1: p.y, x2: p.x, y2: p.y };
          svg.setPointerCapture(e.pointerId);
          render();
          return;
        }
        selectedIds = new Set(); selectedAssets = new Set(); panning = { x: e.clientX, y: e.clientY, panX, panY }; svg.setPointerCapture(e.pointerId); updateDeleteBtn(); render();
      }
    });

    svg.addEventListener('pointermove', e => {
      if (panning) { panX = panning.panX + (e.clientX - panning.x); panY = panning.panY + (e.clientY - panning.y); applyView(); return; }
      if (maybeToggle && !marquee) {
        if (Math.hypot(e.clientX - maybeToggle.sx, e.clientY - maybeToggle.sy) > 4) {
          const p = toWorld(e);
          marquee = { x1: p.x, y1: p.y, x2: p.x, y2: p.y };
          maybeToggle = null;
        }
      }
      if (marquee) { const p = toWorld(e); marquee.x2 = p.x; marquee.y2 = p.y; render(); return; }
      if (dragging) {
        const p = toWorld(e);
        let ddx = snapTo(p.x) - snapTo(dragging.ox);
        let ddy = snapTo(p.y) - snapTo(dragging.oy);
        // snap dragged wall endpoints onto other walls (endpoints or middle) for exact connections
        const r = 12 / zoom;
        outer: for (const c of [{ x: dragging.x1 + ddx, y: dragging.y1 + ddy }, { x: dragging.x2 + ddx, y: dragging.y2 + ddy }]) {
          const s = snapPoint(c, dragging.wall.id);
          const dd = Math.hypot(s.x - c.x, s.y - c.y);
          if (dd > 0 && dd <= r) { ddx += s.x - c.x; ddy += s.y - c.y; break outer; }
        }
        dragging.wall.x1 = dragging.x1 + ddx; dragging.wall.y1 = dragging.y1 + ddy;
        dragging.wall.x2 = dragging.x2 + ddx; dragging.wall.y2 = dragging.y2 + ddy;
        render(); return;
      }
      if (endpointDrag) {
        const p = toWorld(e); const s = snapPoint(p, endpointDrag.wall.id);
        if (endpointDrag.end === 'p1') { endpointDrag.wall.x1 = s.x; endpointDrag.wall.y1 = s.y; }
        else { endpointDrag.wall.x2 = s.x; endpointDrag.wall.y2 = s.y; }
        render(); return;
      }
      if (assetDrag) {
        const p = toWorld(e);
        // pick the wall closest to the pointer so the asset can move to any wall
        let best = assetDrag.wall, bd = Infinity, bestT = assetDrag.asset.t;
        for (const w of project.walls) {
          const dx = w.x2 - w.x1, dy = w.y2 - w.y1;
          const l2 = dx * dx + dy * dy; if (!l2) continue;
          let t = ((p.x - w.x1) * dx + (p.y - w.y1) * dy) / l2;
          t = Math.max(0, Math.min(1, t));
          const px = w.x1 + t * dx, py = w.y1 + t * dy;
          const d = Math.hypot(px - p.x, py - p.y);
          if (d < bd) { bd = d; best = w; bestT = t; }
        }
        const w = best;
        const dx = w.x2 - w.x1, dy = w.y2 - w.y1;
        const len = Math.hypot(dx, dy) || 1;
        const hw = Math.min(assetDrag.asset.width / 2, len / 2);
        bestT = Math.min(Math.max(bestT, hw / len), Math.max(hw / len, 1 - hw / len));
        assetDrag.asset.wallId = w.id;
        assetDrag.asset.t = bestT;
        assetDrag.wall = w;
        render();
        return;
      }
      if (drawing) { const p = toWorld(e); const s = snapPoint(p); drawing.x2 = s.x; drawing.y2 = s.y; render(); }
    });

    svg.addEventListener('pointerup', e => {
      if (panning) panning = null;
      if (maybeToggle) {
        // Ctrl+click without drag → toggle that item in the selection
        if (maybeToggle.kind === 'wall') {
          if (selectedIds.has(maybeToggle.id)) selectedIds.delete(maybeToggle.id); else selectedIds.add(maybeToggle.id);
        } else {
          if (selectedAssets.has(maybeToggle.id)) selectedAssets.delete(maybeToggle.id); else selectedAssets.add(maybeToggle.id);
        }
        maybeToggle = null;
        updateDeleteBtn(); render();
      }
      if (marquee) {
        const rx1 = Math.min(marquee.x1, marquee.x2), rx2 = Math.max(marquee.x1, marquee.x2);
        const ry1 = Math.min(marquee.y1, marquee.y2), ry2 = Math.max(marquee.y1, marquee.y2);
        if (Math.abs(marquee.x2 - marquee.x1) > 2 / zoom || Math.abs(marquee.y2 - marquee.y1) > 2 / zoom) {
          for (const w of project.walls) {
            const wx1 = Math.min(w.x1, w.x2), wx2 = Math.max(w.x1, w.x2);
            const wy1 = Math.min(w.y1, w.y2), wy2 = Math.max(w.y1, w.y2);
            if (wx1 <= rx2 && wx2 >= rx1 && wy1 <= ry2 && wy2 >= ry1) selectedIds.add(w.id);
          }
          for (const a of (project.assets || [])) {
            const w = project.walls.find(x => x.id === a.wallId);
            if (!w) continue;
            const cx = w.x1 + (w.x2 - w.x1) * a.t, cy = w.y1 + (w.y2 - w.y1) * a.t;
            if (cx >= rx1 && cx <= rx2 && cy >= ry1 && cy <= ry2) selectedAssets.add(a.id);
          }
        }
        marquee = null;
        updateDeleteBtn(); render();
      }
      if (dragging) { scheduleSave(); pushHistory(); dragging = null; }
      if (endpointDrag) { scheduleSave(); pushHistory(); endpointDrag = null; }
      if (assetDrag) { scheduleSave(); pushHistory(); assetDrag = null; }
    });

    svg.addEventListener('wheel', e => {
      e.preventDefault();
      const r = svg.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      const wx = (mx - panX) / zoom, wy = (my - panY) / zoom;
      const f = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      zoom *= f;
      panX = mx - wx * zoom; panY = my - wy * zoom;
      applyView(); render();
    }, { passive: false });

    document.addEventListener('keydown', e => {
      const typing = e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA');
      if (typing) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') { e.preventDefault(); copySelection(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') { e.preventDefault(); pasteClipboard(); }
      if ((e.key === 'Delete' || e.key === 'Backspace') && (selectedIds.size || selectedAssets.size)) {
        project.walls = project.walls.filter(w => !selectedIds.has(w.id));
        project.assets = (project.assets || []).filter(a => !selectedAssets.has(a.id) && !selectedIds.has(a.wallId));
        selectedIds = new Set(); selectedAssets = new Set(); scheduleSave(); updateDeleteBtn(); render(); pushHistory();
      }
      if (e.key === 'Escape' && drawing) { drawing = null; render(); }
      if (e.key === 'Escape' && pendingAsset) { pendingAsset = null; render(); }
      if (e.key === 'Escape' && calibrating) { calibrating = null; mode = 'select'; render(); }
      if (e.key === 'Escape' && marquee) { marquee = null; render(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
    });

    // toolbar
    document.getElementById('modeDraw').onclick = () => { mode = 'draw'; selectedIds = new Set(); calibrating = null; updateDeleteBtn(); render(); };
    document.getElementById('modeEdit').onclick = () => { mode = 'edit'; drawing = null; calibrating = null; updateDeleteBtn(); render(); };
    document.getElementById('modeSelect').onclick = () => { mode = 'select'; drawing = null; calibrating = null; updateDeleteBtn(); render(); };

    // ---- import floor-plan picture ----
    function updateBgButtons() {
      const has = !!project.bgImage;
      document.getElementById('calibrateBg').disabled = !has;
      document.getElementById('detectWalls').disabled = !has;
      document.getElementById('removeBg').disabled = !has;
    }
    function loadBgMeta() {
      if (!project.bgImage) { bgSize = { w: 0, h: 0 }; updateBgButtons(); render(); return; }
      const im = new Image();
      im.onload = () => {
        bgSize = { w: im.naturalWidth, h: im.naturalHeight };
        if (!project.bgScale) project.bgScale = 1200 / im.naturalWidth; // default: ~12 m wide
        updateBgButtons(); fitToContent();
      };
      im.src = project.bgImage;
    }

    document.getElementById('importBg').onclick = () => document.getElementById('bgFile').click();
    document.getElementById('bgFile').onchange = e => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      const rd = new FileReader();
      rd.onload = () => {
        project.bgImage = rd.result;
        project.bgX = 0; project.bgY = 0; project.bgScale = null;
        calibrating = null; drawing = null;
        scheduleSave(); pushHistory(); loadBgMeta();
      };
      rd.readAsDataURL(f);
      e.target.value = '';
    };
    document.getElementById('calibrateBg').onclick = () => {
      if (!project.bgImage) return;
      mode = 'calibrate'; calibrating = null; drawing = null;
      selectedIds = new Set(); selectedAssets = new Set();
      updateDeleteBtn(); render();
    };
    document.getElementById('removeBg').onclick = () => {
      project.bgImage = null; project.bgScale = null; project.measOverlay = null; bgSize = { w: 0, h: 0 };
      calibrating = null;
      scheduleSave(); pushHistory(); updateBgButtons(); render();
    };

    // Detect walls in an architectural floor plan:
    // thick, continuous, often double-lined dark lines forming room boundaries.
    // The white interiors between the parallel face lines are flooded (gap fill),
    // producing solid filled wall-thickness regions; thin markings (room labels,
    // dimension lines, notes) are discarded by the thickness filter.
    document.getElementById('detectWalls').onclick = async () => {
      if (!project.bgImage || !bgSize.w) return;
      const s = project.bgScale || 1;
      const img = new Image();
      img.src = project.bgImage;
      try { await img.decode(); } catch { await new Promise(r => img.onload = r); }
      const W = img.naturalWidth, H = img.naturalHeight;
      const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
      const cx = cv.getContext('2d');
      cx.drawImage(img, 0, 0);
      const d = cx.getImageData(0, 0, W, H).data;
      const dark = new Uint8Array(W * H);
      for (let i = 0; i < W * H; i++) dark[i] = (d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2]) / 3 < 128 ? 1 : 0;
      const toWorldX = px => (project.bgX || 0) + px * s;
      const toWorldY = py => (project.bgY || 0) + py * s;

      // ---- wall mask: solid filled regions over the entire wall thickness.
      // Works for both solid black walls and double-lined (parallel face lines) walls:
      // for each row/column, short white gaps between two dark runs are flooded,
      // so the interior between the face lines becomes solid.
      const maxGap = Math.max(8, Math.round(45 / s)); // px — interior gaps up to ~45 cm get filled
      const maskH = new Uint8Array(dark);
      for (let y = 0; y < H; y++) {
        let x = 0, prevEnd = -1;
        while (x < W) {
          if (dark[y * W + x]) {
            let q = x; while (q + 1 < W && dark[y * W + q + 1]) q++;
            if (prevEnd >= 0 && x - prevEnd - 1 <= maxGap) for (let k = prevEnd + 1; k < x; k++) maskH[y * W + k] = 1;
            prevEnd = q; x = q + 1;
          } else x++;
        }
      }
      const maskV = new Uint8Array(dark);
      for (let x = 0; x < W; x++) {
        let y = 0, prevEnd = -1;
        while (y < H) {
          if (dark[y * W + x]) {
            let q = y; while (q + 1 < H && dark[(q + 1) * W + x]) q++;
            if (prevEnd >= 0 && y - prevEnd - 1 <= maxGap) for (let k = prevEnd + 1; k < y; k++) maskV[k * W + x] = 1;
            prevEnd = q; y = q + 1;
          } else y++;
        }
      }
      const wallMask = new Uint8Array(W * H);
      for (let i = 0; i < W * H; i++) wallMask[i] = (maskH[i] || maskV[i]) ? 1 : 0;

      // ---- wall centerlines from the solid mask (H/V run clustering)
      const minRun = Math.max(10, Math.round(Math.min(W, H) * 0.015));
      function runsAlong(horizontal, mask) {
        const cands = [];
        const L = horizontal ? W : H;
        for (let a = 0; a < (horizontal ? H : W); a++) {
          let p = 0;
          while (p < L) {
            const v = horizontal ? mask[a * W + p] : mask[p * W + a];
            if (v) { let q = p; while (q + 1 < L && (horizontal ? mask[a * W + q + 1] : mask[(q + 1) * W + a])) q++; if (q - p + 1 >= minRun) cands.push(horizontal ? { x1: p, x2: q, y: a } : { y1: p, y2: q, x: a }); p = q + 1; }
            else p++;
          }
        }
        return cands;
      }
      function cluster(cands, horizontal) {
        const groups = [];
        for (const c of cands) {
          const g = groups.find(g => horizontal
            ? Math.abs(g.y - c.y) <= 4 && c.x1 <= g.x2 && c.x2 >= g.x1
            : Math.abs(g.x - c.x) <= 4 && c.y1 <= g.y2 && c.y2 >= g.y1);
          if (g) {
            if (horizontal) { g.x1 = Math.min(g.x1, c.x1); g.x2 = Math.max(g.x2, c.x2); g.ys.push(c.y); g.y = g.ys.reduce((a, b) => a + b, 0) / g.ys.length; }
            else { g.y1 = Math.min(g.y1, c.y1); g.y2 = Math.max(g.y2, c.y2); g.xs.push(c.x); g.x = g.xs.reduce((a, b) => a + b, 0) / g.xs.length; }
          } else groups.push(horizontal ? { x1: c.x1, x2: c.x2, y: c.y, ys: [c.y] } : { y1: c.y1, y2: c.y2, x: c.x, xs: [c.x] });
        }
        return groups;
      }
      const hGroups = cluster(runsAlong(true, wallMask), true);
      const vGroups = cluster(runsAlong(false, wallMask), false);
      const newWalls = [];
      const wallClusters = []; // keep per-cluster profile info for windows/doors
      for (const g of hGroups) {
        const thickPx = g.ys.length;
        const thickCm = thickPx * s;
        if ((g.x2 - g.x1) * s < 30 || thickCm < 8) continue;
        newWalls.push({ id: crypto.randomUUID(), x1: toWorldX(g.x1), y1: toWorldY(g.y), x2: toWorldX(g.x2), y2: toWorldY(g.y), thickness: Math.min(60, Math.max(5, thickCm)) });
        wallClusters.push({ g, horiz: true, W: newWalls[newWalls.length - 1] });
      }
      for (const g of vGroups) {
        const thickPx = g.xs.length;
        const thickCm = thickPx * s;
        if ((g.y2 - g.y1) * s < 30 || thickCm < 8) continue;
        newWalls.push({ id: crypto.randomUUID(), x1: toWorldX(g.x), y1: toWorldY(g.y1), x2: toWorldX(g.x), y2: toWorldY(g.y2), thickness: Math.min(60, Math.max(5, thickCm)) });
        wallClusters.push({ g, horiz: false, W: newWalls[newWalls.length - 1] });
      }
      if (!newWalls.length) { window.alert('No walls detected. Try a clearer image or calibrate the scale first.'); return; }

      // ---- classify positions along each wall: solid / window / opening ----
      // Windows: interior empty but both face lines remain (thin parallel lines).
      // Openings: interior empty AND face lines broken (gap in the wall).
      const windows = [];
      const openings = []; // world-space segments along walls where the wall is interrupted
      for (const { g, horiz } of wallClusters) {
        const span = horiz ? g.x2 - g.x1 : g.y2 - g.y1;
        const half = Math.max(1, Math.floor((horiz ? g.ys.length : g.xs.length) / 2));
        let winStart = -1, opStart = -1;
        for (let i = 0; i <= span; i++) {
          const ax = horiz ? g.x1 + i : g.x, ay = horiz ? g.y : g.y1 + i;
          let fill = 0, total = 0;
          for (let o = -half - 1; o <= half + 1; o++) {
            const px = horiz ? ax : ax + o, py = horiz ? ay + o : ay;
            if (px < 0 || py < 0 || px >= W || py >= H) continue;
            total++; fill += dark[py * W + px];
          }
          const e1 = horiz ? (ay - half >= 0 ? dark[(ay - half) * W + ax] : 0) : (ax - half >= 0 ? dark[ay * W + ax - half] : 0);
          const e2 = horiz ? (ay + half < H ? dark[(ay + half) * W + ax] : 0) : (ax + half < W ? dark[ay * W + ax + half] : 0);
          const f = total ? fill / total : 1;
          const isWindow = f < 0.5 && e1 && e2;
          const isOpening = !isWindow && f < 0.3 && !(e1 && e2);
          if (isWindow) { if (winStart < 0) winStart = i; }
          else { if (winStart >= 0 && i - winStart >= 6 && (i - winStart) * s >= 40 && (i - winStart) * s <= 400) windows.push({ horiz, gx: horiz ? g.x1 + (winStart + i) / 2 : g.x, gy: horiz ? g.y : g.y1 + (winStart + i) / 2, width: (i - winStart) * s }); winStart = -1; }
          if (isOpening) { if (opStart < 0) opStart = i; }
          else { if (opStart >= 0 && i - opStart >= 6 && (i - opStart) * s >= 50 && (i - opStart) * s <= 200) openings.push({ horiz, gx: horiz ? g.x1 + (opStart + i) / 2 : g.x, gy: horiz ? g.y : g.y1 + (opStart + i) / 2, width: (i - opStart) * s }); opStart = -1; }
        }
      }

      // ---- doors: arc + leaf + wall opening ----
      const thin = new Uint8Array(W * H);
      for (let i = 0; i < W * H; i++) thin[i] = dark[i] && !wallMask[i] ? 1 : 0;
      const thinPts = [];
      for (let i = 0; i < W * H; i++) if (thin[i]) thinPts.push([i % W, (i / W) | 0]);
      const arcs = [];
      const rMin = 40 / s, rMax = 160 / s, T = 2500;
      for (let it = 0; it < T && thinPts.length >= 3; it++) {
        const a = thinPts[(Math.random() * thinPts.length) | 0];
        const b = thinPts[(Math.random() * thinPts.length) | 0];
        const c = thinPts[(Math.random() * thinPts.length) | 0];
        const d2 = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
        if (Math.abs(d2) < 1e-6) continue;
        const ux = ((a[0]*a[0]+a[1]*a[1]) * (b[1]-c[1]) + (b[0]*b[0]+b[1]*b[1]) * (c[1]-a[1]) + (c[0]*c[0]+c[1]*c[1]) * (a[1]-b[1])) / d2;
        const uy = ((a[0]*a[0]+a[1]*a[1]) * (c[0]-b[0]) + (b[0]*b[0]+b[1]*b[1]) * (a[0]-c[0]) + (c[0]*c[0]+c[1]*c[1]) * (b[0]-a[0])) / d2;
        const r = Math.hypot(a[0] - ux, a[1] - uy);
        if (r < rMin || r > rMax) continue;
        let inliers = 0; const quad = [0, 0, 0, 0];
        for (const p of thinPts) {
          if (Math.abs(Math.hypot(p[0] - ux, p[1] - uy) - r) < 1.6) { inliers++; quad[((p[0] >= ux ? 1 : 0) + (p[1] >= uy ? 2 : 0))]++; }
        }
        const arcLen = Math.max(...quad);
        if (inliers >= 20 && arcLen / inliers >= 0.6 && r * s >= 40 && r * s <= 160) arcs.push({ ux, uy, r, inliers });
      }
      arcs.sort((a, b) => b.inliers - a.inliers);
      const doors = [];
      for (const a of arcs) {
        if (doors.some(o => Math.hypot(o.ux - a.ux, o.uy - a.uy) < 15 && Math.abs(o.r - a.r) < 10)) continue;
        doors.push(a); if (doors.length >= 12) break;
      }

      // ---- measurements: dimension lines (long thin H/V runs outside walls)
      // plus digit/number components sitting next to them. Room names, notes,
      // symbols, hatching etc. are thin but not beside a dimension line → ignored.
      const measMask = new Uint8Array(W * H);
      const measLines = [];
      {
        const lim = Math.max(8, Math.round(0.5 / s * 100)); // ~ min 50 cm line
        for (const horiz of [true, false]) {
          const out = runsAlong(horiz, thin);
          for (const c of out) {
            const lenPx = horiz ? c.x2 - c.x1 : c.y2 - c.y1;
            if (lenPx * s >= 40) measLines.push({ horiz, ...c });
          }
        }
        for (const L of measLines) for (let i = 0; i <= (L.horiz ? L.x2 - L.x1 : L.y2 - L.y1); i++) {
          const px = L.horiz ? L.x1 + i : L.x, py = L.horiz ? L.y : L.y1 + i;
          if (px >= 0 && py >= 0 && px < W && py < H) measMask[py * W + px] = 1;
        }
        // nearby text components count as measurement numbers
        const seen = new Uint8Array(W * H);
        const stack = [];
        for (let i = 0; i < W * H; i++) {
          if (!thin[i] || seen[i]) continue;
          const comp = []; stack.length = 0; stack.push(i); seen[i] = 1;
          let sumX = 0, sumY = 0;
          while (stack.length) {
            const j = stack.pop(); comp.push(j); sumX += j % W; sumY += (j / W) | 0;
            const x = j % W, y = (j / W) | 0;
            for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
              const nx = x + dx, ny = y + dy, k = ny * W + nx;
              if (nx >= 0 && ny >= 0 && nx < W && ny < H && !seen[k] && thin[k]) { seen[k] = 1; stack.push(k); }
            }
          }
          if (comp.length < 4 || comp.length > 2000) continue; // ticks/smudges or huge letters
          const cxp = sumX / comp.length, cyp = sumY / comp.length;
          const near = measLines.some(L => {
            const lx = L.horiz ? Math.min(Math.max(cxp, L.x1), L.x2) : L.x;
            const ly = L.horiz ? L.y : Math.min(Math.max(cyp, L.y1), L.y2);
            return Math.hypot(cxp - lx, cyp - ly) < Math.max(30, 80 / (s * 2.5));
          });
          if (near) for (const j of comp) measMask[j] = 1;
        }
      }

      // ---- build result: wall assets as geometry, door/window assets snapped to walls
      const projs = newWalls.map(w => ({ x1: w.x1, y1: w.y1, x2: w.x2, y2: w.y2 }));
      function snap(wx, wy) {
        let best = -1, bd = Infinity, bt = 0;
        projs.forEach((w, i) => {
          const dx = w.x2 - w.x1, dy = w.y2 - w.y1, l2 = dx * dx + dy * dy;
          if (!l2) return;
          let t = ((wx - w.x1) * dx + (wy - w.y1) * dy) / l2; t = Math.max(0, Math.min(1, t));
          const d = Math.hypot(w.x1 + t * dx - wx, w.y1 + t * dy - wy);
          if (d < bd) { bd = d; bt = t; best = i; }
        });
        return best < 0 || bd > 150 ? null : { i: best, t: bt };
      }
      const newAssets = [];
      for (const wd of windows) {
        const hit = snap(toWorldX(wd.gx), toWorldY(wd.gy));
        if (!hit) continue;
        const w = projs[hit.i];
        const len = Math.hypot(w.x2 - w.x1, w.y2 - w.y1) || 1;
        const hw = Math.min(wd.width / 2, len / 2);
        newAssets.push({ id: crypto.randomUUID(), type: 'window', wallId: newWalls[hit.i].id, t: Math.min(Math.max(hit.t, hw / len), 1 - hw / len), width: wd.width, swing: 1 });
      }
      for (const op of openings) {
        // door = arc + leaf + opening: require an arc whose hinge sits on this opening
        const opW = { x: toWorldX(op.gx), y: toWorldY(op.gy) };
        const match = doors.find(dr => Math.hypot(toWorldX(dr.ux) - opW.x, toWorldY(dr.uy) - opW.y) < Math.max(op.width / 2, 40));
        if (!match) continue;
        const hit = snap(opW.x, opW.y);
        if (!hit) continue;
        const w = projs[hit.i];
        const len = Math.hypot(w.x2 - w.x1, w.y2 - w.y1) || 1;
        const width = Math.min(match.r * s, op.width * 1.2);
        const hw = Math.min(width / 2, len / 2);
        newAssets.push({ id: crypto.randomUUID(), type: 'door', wallId: newWalls[hit.i].id, t: Math.min(Math.max(hit.t, hw / len), 1 - hw / len), width, swing: 1 });
      }

      project.walls.push(...newWalls);
      project.assets = (project.assets || []).concat(newAssets);

      // measurement mask overlay (kept separate from geometry)
      try {
        const mc = document.createElement('canvas'); mc.width = W; mc.height = H;
        const mctx = mc.getContext('2d');
        const im = mctx.createImageData(W, H);
        for (let i = 0; i < W * H; i++) if (measMask[i]) { im.data[i * 4] = 255; im.data[i * 4 + 1] = 153; im.data[i * 4 + 2] = 0; im.data[i * 4 + 3] = 200; }
        mctx.putImageData(im, 0, 0);
        project.measOverlay = mc.toDataURL();
      } catch { project.measOverlay = null; }
      scheduleSave(); pushHistory(); fitToContent();
      window.alert(`Detected ${newWalls.length} wall(s), ${newAssets.filter(a => a.type === 'door').length} door(s), ${newAssets.filter(a => a.type === 'window').length} window(s), ${measLines.length} dimension line(s). Orange overlay shows the measurement mask.`);
    };

    document.getElementById('zoomIn').onclick = () => { zoom *= 1.25; applyView(); render(); };
    document.getElementById('zoomOut').onclick = () => { zoom /= 1.25; applyView(); render(); };
    function fitToContent() {
      const r = svg.getBoundingClientRect();
      if (!project.walls.length && !(project.bgImage && bgSize.w)) { panX = r.width / 2; panY = r.height / 2; zoom = 0.5; applyView(); render(); return; }
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const w of project.walls) {
        minX = Math.min(minX, w.x1, w.x2); maxX = Math.max(maxX, w.x1, w.x2);
        minY = Math.min(minY, w.y1, w.y2); maxY = Math.max(maxY, w.y1, w.y2);
      }
      if (project.bgImage && bgSize.w) {
        const s = project.bgScale || 1;
        minX = Math.min(minX, project.bgX || 0); maxX = Math.max(maxX, (project.bgX || 0) + bgSize.w * s);
        minY = Math.min(minY, project.bgY || 0); maxY = Math.max(maxY, (project.bgY || 0) + bgSize.h * s);
      }
      if (!isFinite(minX)) { panX = r.width / 2; panY = r.height / 2; zoom = 0.5; applyView(); render(); return; }
      const pad = 80 / 1;
      const bw = Math.max(maxX - minX, 1), bh = Math.max(maxY - minY, 1);
      zoom = Math.min((r.width - 80) / bw, (r.height - 80) / bh, 2);
      panX = (r.width - (maxX + minX) * zoom) / 2;
      panY = (r.height - (maxY + minY) * zoom) / 2;
      applyView(); render();
    }

    document.getElementById('zoomReset').onclick = fitToContent;
    document.getElementById('deleteSelected').onclick = () => {
      if (!selectedIds.size && !selectedAssets.size) return;
      project.walls = project.walls.filter(w => !selectedIds.has(w.id));
      project.assets = (project.assets || []).filter(a => !selectedAssets.has(a.id) && !selectedIds.has(a.wallId));
      selectedIds = new Set(); selectedAssets = new Set(); scheduleSave(); render(); updateDeleteBtn(); pushHistory();
    };
    document.getElementById('assetWidth').onchange = applyAssetInspector;
    document.getElementById('assetDir').onclick = applyAssetDir;
    document.getElementById('assetHinge').onclick = () => {
      const a = selectedAssets.size === 1 ? (project.assets || []).find(a => a.id === [...selectedAssets][0]) : null;
      if (!a) return;
      a.hinge = (a.hinge || 1) === 1 ? -1 : 1;
      scheduleSave(); render(); pushHistory();
    };
    // add-asset dropdown
    document.getElementById('addAssetBtn').onclick = () => {
      pendingAsset = document.getElementById('addAsset').value;
      mode = 'select'; selectedIds = new Set(); selectedAssets = new Set();
      updateDeleteBtn(); render();
    };
    document.getElementById('undoBtn').onclick = undo;
    document.getElementById('redoBtn').onclick = redo;
    document.getElementById('wallLen').onchange = applyInspector;
    document.getElementById('wallAngle').onchange = applyInspector;
    document.getElementById('wallThick').onchange = applyInspector;
    document.getElementById('wallFill').onchange = applyFill;

    // initial view: fit the project's walls
    loadBgMeta();
    updateBgButtons();
    fitToContent();
    pushHistory();
  }

  return { init };
})();
