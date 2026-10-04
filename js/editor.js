// editor.js — SVG floor-plan editor (walls). Units: cm.
const Editor = (() => {
  const SVGNS = 'http://www.w3.org/2000/svg';
  let project, projectPath, svg, world, overlay;
  let mode = 'select';         // 'draw' | 'select' | 'edit' | place door/window handled via pendingAsset
  let pendingAsset = null;     // 'door' | 'window' when placing
  let selectedAsset = null;    // id of selected asset
  let assetDrag = null;        // {asset, wall}
  let snap = true;
  let wallThickness = 15;      // cm
  let zoom = 1, panX = 0, panY = 0;
  let drawing = null;          // {x1,y1,x2,y2,line}
  let dragging = null;         // {wall, ox, oy, startX, startY, moved}
  let endpointDrag = null;     // {wall, end: 'p1'|'p2'}
  let panning = null;
  let selectedIds = new Set();
  let saveTimer = null;
  const history = { stack: [], idx: -1 };

  function snapshot() { return JSON.stringify({ walls: project.walls, assets: project.assets || [] }); }
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
    selectedIds = new Set(); selectedAsset = null;
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

  function endpoints(excludeId) {
    const pts = [];
    for (const w of project.walls) {
      if (w.id === excludeId) continue;
      const dx = w.x2 - w.x1, dy = w.y2 - w.y1;
      const l = Math.hypot(dx, dy) || 1;
      const ux = dx / l, uy = dy / l, o = w.thickness / 2; // very edge of the square cap
      pts.push({ x: w.x1 - ux * o, y: w.y1 - uy * o }, { x: w.x2 + ux * o, y: w.y2 + uy * o });
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
      if (fill !== 'solid' && !selected) {
        grp.appendChild(el('line', { x1: w.x1, y1: w.y1, x2: w.x2, y2: w.y2, stroke: '#e0e0e0', 'stroke-opacity': 0.2, 'stroke-width': w.thickness, 'stroke-linecap': 'square' }));
      }
      grp.appendChild(el('line', {
        x1: w.x1, y1: w.y1, x2: w.x2, y2: w.y2,
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
      const selected = selectedAsset === a.id;
      const grp = el('g', { 'data-id': a.id, cursor: 'move' });
      if (a.type === 'door') {
        // open space: erase the wall segment
        grp.appendChild(el('line', { x1, y1, x2, y2, stroke: '#111', 'stroke-width': w.thickness, 'stroke-linecap': 'butt' }));
        const side = a.swing || 1;
        const leafX = x1 + nx * side * a.width, leafY = y1 + ny * side * a.width;
        grp.appendChild(el('line', { x1, y1, x2: leafX, y2: leafY, stroke: selected ? '#ffd166' : '#9ecbff', 'stroke-width': 2.5 / zoom }));
        grp.appendChild(el('path', {
          d: `M ${x2},${y2} A ${a.width} ${a.width} 0 0 ${side > 0 ? 1 : 0} ${leafX},${leafY}`,
          fill: 'none', stroke: selected ? '#ffd166' : '#9ecbff', 'stroke-width': 1.2 / zoom, 'stroke-dasharray': `${4 / zoom} ${3 / zoom}`,
        }));
      } else {
        // window: rectangle on top of the wall
        const th = w.thickness / 2;
        const pts = [
          `${x1 + nx * th},${y1 + ny * th}`, `${x2 + nx * th},${y2 + ny * th}`,
          `${x2 - nx * th},${y2 - ny * th}`, `${x1 - nx * th},${y1 - ny * th}`,
        ].join(' ');
        grp.appendChild(el('polygon', { points: pts, fill: selected ? 'rgba(255,209,102,0.35)' : 'rgba(77,171,247,0.35)', stroke: selected ? '#ffd166' : '#4dabf7', 'stroke-width': 2 / zoom }));
        grp.appendChild(el('line', { x1, y1, x2, y2, stroke: selected ? '#ffd166' : '#4dabf7', 'stroke-width': 1.5 / zoom }));
      }
      if (selected) {
        grp.appendChild(el('line', { x1, y1, x2, y2, stroke: '#ffd166', 'stroke-opacity': 0.4, 'stroke-width': w.thickness + 8 / zoom }));
      }
      const hit = el('line', { x1, y1, x2, y2, stroke: 'transparent', 'stroke-width': Math.max(w.thickness, 16 / zoom + w.thickness) });
      hit.addEventListener('pointerdown', e => onAssetDown(e, a));
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
      overlay.appendChild(el('line', { x1: drawing.x1, y1: drawing.y1, x2: drawing.x2, y2: drawing.y2, stroke: '#4dabf7', 'stroke-width': wallThickness, 'stroke-linecap': 'square', 'stroke-dasharray': `${8 / zoom} ${6 / zoom}` }));
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
    if (mode !== 'select' && mode !== 'edit') return;
    e.stopPropagation();
    selectedAsset = a.id; selectedIds = new Set();
    if (mode === 'select') {
      const w = project.walls.find(x => x.id === a.wallId);
      assetDrag = { asset: a, wall: w };
      svg.setPointerCapture(e.pointerId);
    }
    updateDeleteBtn(); render();
  }

  function onWallDown(e, w) {
    if (pendingAsset) return;
    if (mode !== 'select' && mode !== 'edit') return;
    e.stopPropagation();
    selectedAsset = null;
    if (e.ctrlKey || e.metaKey) {
      if (selectedIds.has(w.id)) selectedIds.delete(w.id); else selectedIds.add(w.id);
    } else {
      selectedIds = new Set([w.id]);
    }
    const p = toWorld(e);
    if (mode === 'select' && !(e.ctrlKey || e.metaKey)) {
      dragging = { wall: w, ox: p.x, oy: p.y, x1: w.x1, y1: w.y1, x2: w.x2, y2: w.y2 };
      svg.setPointerCapture(e.pointerId);
    }
    updateDeleteBtn();
    render();
  }

  function updateDeleteBtn() {
    document.getElementById('deleteSelected').disabled = selectedIds.size === 0 && !selectedAsset;
    updateInspector();
  }

  function onlySelected() { return selectedIds.size === 1 ? [...selectedIds][0] : null; }

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
    const a = (project.assets || []).find(a => a.id === selectedAsset);
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
    const a = (project.assets || []).find(a => a.id === selectedAsset);
    const box = document.getElementById('assetInspector');
    if (!a) { box.classList.add('d-none'); box.classList.remove('d-flex'); return; }
    box.classList.remove('d-none'); box.classList.add('d-flex');
    document.getElementById('assetType').textContent = a.type === 'door' ? 'Door' : 'Window';
    document.getElementById('assetWidth').value = a.width;
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
          selectedAsset = a.id; selectedIds = new Set();
          scheduleSave(); updateDeleteBtn(); pushHistory();
        }
        pendingAsset = null; mode = 'select'; render(); return;
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
        selectedIds = new Set(); selectedAsset = null; panning = { x: e.clientX, y: e.clientY, panX, panY }; svg.setPointerCapture(e.pointerId); updateDeleteBtn(); render();
      }
    });

    svg.addEventListener('pointermove', e => {
      if (panning) { panX = panning.panX + (e.clientX - panning.x); panY = panning.panY + (e.clientY - panning.y); applyView(); return; }
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
        const p = toWorld(e); const w = assetDrag.wall;
        const dx = w.x2 - w.x1, dy = w.y2 - w.y1;
        const l2 = dx * dx + dy * dy;
        if (l2) {
          let t = ((p.x - w.x1) * dx + (p.y - w.y1) * dy) / l2;
          const len = Math.sqrt(l2);
          const hw = Math.min(assetDrag.asset.width / 2, len / 2);
          t = Math.min(Math.max(t, hw / len), Math.max(hw / len, 1 - hw / len));
          assetDrag.asset.t = t;
          render();
        }
        return;
      }
      if (drawing) { const p = toWorld(e); const s = snapPoint(p); drawing.x2 = s.x; drawing.y2 = s.y; render(); }
    });

    svg.addEventListener('pointerup', e => {
      if (panning) panning = null;
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
      if ((e.key === 'Delete' || e.key === 'Backspace') && (selectedIds.size || selectedAsset)) {
        project.walls = project.walls.filter(w => !selectedIds.has(w.id));
        project.assets = (project.assets || []).filter(a => a.id !== selectedAsset && !selectedIds.has(a.wallId));
        selectedIds = new Set(); selectedAsset = null; scheduleSave(); updateDeleteBtn(); render(); pushHistory();
      }
      if (e.key === 'Escape' && drawing) { drawing = null; render(); }
      if (e.key === 'Escape' && pendingAsset) { pendingAsset = null; render(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
    });

    // toolbar
    document.getElementById('modeDraw').onclick = () => { mode = 'draw'; selectedIds = new Set(); updateDeleteBtn(); render(); };
    document.getElementById('modeEdit').onclick = () => { mode = 'edit'; drawing = null; updateDeleteBtn(); render(); };
    document.getElementById('modeSelect').onclick = () => { mode = 'select'; drawing = null; updateDeleteBtn(); render(); };
    document.getElementById('zoomIn').onclick = () => { zoom *= 1.25; applyView(); render(); };
    document.getElementById('zoomOut').onclick = () => { zoom /= 1.25; applyView(); render(); };
    function fitToContent() {
      const r = svg.getBoundingClientRect();
      if (!project.walls.length) { panX = r.width / 2; panY = r.height / 2; zoom = 0.5; applyView(); render(); return; }
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const w of project.walls) {
        minX = Math.min(minX, w.x1, w.x2); maxX = Math.max(maxX, w.x1, w.x2);
        minY = Math.min(minY, w.y1, w.y2); maxY = Math.max(maxY, w.y1, w.y2);
      }
      const pad = 80 / 1;
      const bw = Math.max(maxX - minX, 1), bh = Math.max(maxY - minY, 1);
      zoom = Math.min((r.width - 80) / bw, (r.height - 80) / bh, 2);
      panX = (r.width - (maxX + minX) * zoom) / 2;
      panY = (r.height - (maxY + minY) * zoom) / 2;
      applyView(); render();
    }

    document.getElementById('zoomReset').onclick = fitToContent;
    document.getElementById('deleteSelected').onclick = () => {
      if (!selectedIds.size && !selectedAsset) return;
      project.walls = project.walls.filter(w => !selectedIds.has(w.id));
      project.assets = (project.assets || []).filter(a => a.id !== selectedAsset && !selectedIds.has(a.wallId));
      selectedIds = new Set(); selectedAsset = null; scheduleSave(); render(); updateDeleteBtn(); pushHistory();
    };
    document.getElementById('modeDoor').onclick = () => { pendingAsset = 'door'; mode = 'select'; selectedIds = new Set(); selectedAsset = null; updateDeleteBtn(); render(); };
    document.getElementById('modeWindow').onclick = () => { pendingAsset = 'window'; mode = 'select'; selectedIds = new Set(); selectedAsset = null; updateDeleteBtn(); render(); };
    document.getElementById('assetWidth').onchange = applyAssetInspector;
    document.getElementById('undoBtn').onclick = undo;
    document.getElementById('redoBtn').onclick = redo;
    document.getElementById('wallLen').onchange = applyInspector;
    document.getElementById('wallAngle').onchange = applyInspector;
    document.getElementById('wallThick').onchange = applyInspector;
    document.getElementById('wallFill').onchange = applyFill;

    // initial view: fit the project's walls
    fitToContent();
    pushHistory();
  }

  return { init };
})();
