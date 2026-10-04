// editor.js — SVG floor-plan editor (walls). Units: cm.
const Editor = (() => {
  const SVGNS = 'http://www.w3.org/2000/svg';
  let project, projectPath, svg, world, overlay;
  let mode = 'select';         // 'draw' | 'select' | 'edit'
  let snap = true;
  let wallThickness = 15;      // cm
  let zoom = 1, panX = 0, panY = 0;
  let drawing = null;          // {x1,y1,x2,y2,line}
  let dragging = null;         // {wall, ox, oy, startX, startY, moved}
  let endpointDrag = null;     // {wall, end: 'p1'|'p2'}
  let panning = null;
  let selectedIds = new Set();
  let saveTimer = null;

  const GRID = 25;             // cm
  const snapTo = v => v;

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
      grp.appendChild(el('line', {
        x1: w.x1, y1: w.y1, x2: w.x2, y2: w.y2,
        stroke: selected ? '#ffd166' : '#e0e0e0', 'stroke-width': w.thickness,
        'stroke-linecap': 'square',
      }));
      // hit area
      grp.appendChild(el('line', { x1: w.x1, y1: w.y1, x2: w.x2, y2: w.y2, stroke: 'transparent', 'stroke-width': Math.max(w.thickness, 20) }));
      // label
      const mx = (w.x1 + w.x2) / 2, my = (w.y1 + w.y2) / 2;
      const len = wallLength(w) || 1;
      const nx = -(w.y2 - w.y1) / len, ny = (w.x2 - w.x1) / len;
      let la = Math.atan2(w.y2 - w.y1, w.x2 - w.x1) * 180 / Math.PI;
      if (Math.abs(Math.sin(la * Math.PI / 180)) < 1e-6) la = 0; // horizontal: keep readable
      else if (Math.sin(la * Math.PI / 180) > 0) la += 180;      // make text read "upwards" along the wall
      const off = w.thickness / 2 + 10 / zoom;
      const t = el('text', {
        x: mx + nx * off, y: my + ny * off, 'text-anchor': 'middle', fill: '#9ecbff', 'font-size': 14 / zoom,
        transform: `rotate(${la} ${mx + nx * off} ${my + ny * off})`,
      });
      t.textContent = `${fmtLen(wallLength(w))} · ${wallAngle(w).toFixed(0)}°`;
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
    if (drawing) {
      overlay.innerHTML = '';
      overlay.appendChild(el('line', { x1: drawing.x1, y1: drawing.y1, x2: drawing.x2, y2: drawing.y2, stroke: '#4dabf7', 'stroke-width': wallThickness, 'stroke-linecap': 'square', 'stroke-dasharray': `${8 / zoom} ${6 / zoom}` }));
      const dl = Math.hypot(drawing.x2 - drawing.x1, drawing.y2 - drawing.y1) || 1;
      const dnx = -(drawing.y2 - drawing.y1) / dl, dny = (drawing.x2 - drawing.x1) / dl;
      let da = Math.atan2(drawing.y2 - drawing.y1, drawing.x2 - drawing.x1) * 180 / Math.PI;
      if (Math.abs(Math.sin(da * Math.PI / 180)) < 1e-6) da = 0;
      else if (Math.sin(da * Math.PI / 180) > 0) da += 180;
      const dmx = (drawing.x1 + drawing.x2) / 2 + dnx * (wallThickness / 2 + 10 / zoom);
      const dmy = (drawing.y1 + drawing.y2) / 2 + dny * (wallThickness / 2 + 10 / zoom);
      const t = el('text', { x: dmx, y: dmy, 'text-anchor': 'middle', fill: '#4dabf7', 'font-size': 14 / zoom, transform: `rotate(${da} ${dmx} ${dmy})` });
      t.textContent = fmtLen(Math.hypot(drawing.x2 - drawing.x1, drawing.y2 - drawing.y1));
      overlay.appendChild(t);
    } else overlay.innerHTML = '';
    updateInspector();
  }

  function applyView() {
    world.setAttribute('transform', `translate(${panX} ${panY}) scale(${zoom})`);
    overlay.setAttribute('transform', `translate(${panX} ${panY}) scale(${zoom})`);
  }

  function onWallDown(e, w) {
    if (mode !== 'select' && mode !== 'edit') return;
    e.stopPropagation();
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
    document.getElementById('deleteSelected').disabled = selectedIds.size === 0;
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
    scheduleSave(); render(); updateInspector();
  }

  function updateInspector() {
    const w = project.walls.find(w => w.id === onlySelected());
    const box = document.getElementById('inspector');
    if (!w || mode !== 'edit') { box.classList.add('d-none'); box.classList.remove('d-flex'); return; }
    box.classList.remove('d-none'); box.classList.add('d-flex');
    document.getElementById('wallLen').value = wallLength(w).toFixed(0);
    document.getElementById('wallAngle').value = wallAngle(w).toFixed(0);
    document.getElementById('wallThick').value = w.thickness;
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => DB.save(projectPath, project), 600);
  }

  function init(p, path) {
    project = p; projectPath = path;
    svg = document.getElementById('plan');
    world = document.getElementById('world');
    overlay = document.getElementById('overlay');

    svg.addEventListener('pointerdown', e => {
      if (e.button === 1 || e.shiftKey) { panning = { x: e.clientX, y: e.clientY, panX, panY }; svg.setPointerCapture(e.pointerId); return; }
      const p = toWorld(e);
      if (mode === 'draw') {
        if (!drawing) {
          drawing = { x1: snapTo(p.x), y1: snapTo(p.y), x2: snapTo(p.x), y2: snapTo(p.y) };
        } else {
          drawing.x2 = snapTo(p.x); drawing.y2 = snapTo(p.y);
          if (wallLength(drawing) > 0) {
            project.walls.push({ id: crypto.randomUUID(), x1: drawing.x1, y1: drawing.y1, x2: drawing.x2, y2: drawing.y2, thickness: wallThickness });
            scheduleSave();
          }
          drawing = null;
        }
        render(); return;
      }
      // select mode, clicked empty space
      if (e.target === svg || e.target.tagName === 'line' && e.target.parentNode === world) {
        selectedIds = new Set(); panning = { x: e.clientX, y: e.clientY, panX, panY }; svg.setPointerCapture(e.pointerId); updateDeleteBtn(); render();
      }
    });

    svg.addEventListener('pointermove', e => {
      if (panning) { panX = panning.panX + (e.clientX - panning.x); panY = panning.panY + (e.clientY - panning.y); applyView(); return; }
      if (dragging) {
        const p = toWorld(e);
        const ddx = snapTo(p.x) - snapTo(dragging.ox);
        const ddy = snapTo(p.y) - snapTo(dragging.oy);
        dragging.wall.x1 = dragging.x1 + ddx; dragging.wall.y1 = dragging.y1 + ddy;
        dragging.wall.x2 = dragging.x2 + ddx; dragging.wall.y2 = dragging.y2 + ddy;
        render(); return;
      }
      if (endpointDrag) {
        const p = toWorld(e);
        if (endpointDrag.end === 'p1') { endpointDrag.wall.x1 = snapTo(p.x); endpointDrag.wall.y1 = snapTo(p.y); }
        else { endpointDrag.wall.x2 = snapTo(p.x); endpointDrag.wall.y2 = snapTo(p.y); }
        render(); return;
      }
      if (drawing) { const p = toWorld(e); drawing.x2 = snapTo(p.x); drawing.y2 = snapTo(p.y); render(); }
    });

    svg.addEventListener('pointerup', e => {
      if (panning) panning = null;
      if (dragging) { scheduleSave(); dragging = null; }
      if (endpointDrag) { scheduleSave(); endpointDrag = null; }
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
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIds.size) {
        project.walls = project.walls.filter(w => !selectedIds.has(w.id));
        selectedIds = new Set(); scheduleSave(); updateDeleteBtn(); render();
      }
      if (e.key === 'Escape' && drawing) { drawing = null; render(); }
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
      if (!selectedIds.size) return;
      project.walls = project.walls.filter(w => !selectedIds.has(w.id));
      selectedIds = new Set(); scheduleSave(); render(); updateDeleteBtn();
    };
    document.getElementById('wallLen').onchange = applyInspector;
    document.getElementById('wallAngle').onchange = applyInspector;
    document.getElementById('wallThick').onchange = applyInspector;

    // initial view: fit the project's walls
    fitToContent();
  }

  return { init };
})();
