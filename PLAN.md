# Moodiva — Project Plan (Phase 1)

## Concept
Moodiva: a static web app (GitHub Pages) to design a 2D floor plan of a house/apartment and place furniture on it. All data stored as local JSON files in a user-chosen folder, mirroring LibertyFinance's storage approach.

## Hosting & Storage (replicate LibertyFinance)
- **Hosting**: GitHub Pages, static only (`index.html`, `app.html`-style SPA or single page).
- **Storage**: vanilla JS, File System Access API (folder mode: Chrome/Edge/Opera) with a file-mode fallback (IndexedDB mirror + download/upload) for Firefox/Safari.
- User picks their data folder once; app remembers and reconnects.
- Data format: plain JSON — one file per project/floor plan, e.g. `projects/<name>.json`, plus a shared `furniture-catalog.json` and a `Backups/` subfolder.

## Tech Stack
| Layer | Choice |
|---|---|
| Frontend | HTML5, CSS3, vanilla JS (keep it simple, no build step) |
| UI | Bootstrap 5 (like LibertyFinance) |
| Canvas / 2D editor | Plain `<canvas>` 2D API or SVG (SVG is easier to hit-test/drag; canvas for performance) — decide in phase 1 |
| Storage | File System Access API + IndexedDB fallback |
| Dev server | tiny static `server.js` |

## Data Model (draft)
```jsonc
// project file: my-apartment.json
{
  "id": "...",
  "name": "My Apartment",
  "unit": "cm",
  "walls": [{ "id", "x1", "y1", "x2", "y2", "thickness", "angle" }],
  "rooms": [{ "id", "name", "points": [] }],   // optional phase 1.5
  "placedFurniture": [{ "id", "catalogId", "x", "y", "rotation", "width", "depth" }]
}

// furniture-catalog.json
{ "categories": ["Living Room", "Bedroom", "Kitchen"],
  "items": [{ "id", "name", "category", "width", "depth", "height", "color", "shape": "rect|circle" }] }
```

## Phase 1 Scope (stable & simple)
1. **Skeleton**: repo structure, `index.html` (project picker / folder picker), static server, `.nojekyll`, README.
2. **Storage layer**: folder mode + file mode adapters (port pattern from LibertyFinance `js/storage.js`).
3. **Project CRUD**: create/open/delete/rename floor-plan projects; auto-backup on open.
4. **Floor plan editor (2D)**:
   - Add walls as segments (click-click or drag), set length, thickness; auto-compute/display angles.
   - Select/move/delete walls; snap to grid; zoom & pan.
   - Dimension labels on walls.
5. **Furniture catalog**: list organized by category; each item has size + simple 2D shape. Add new furniture items.
6. **Placement**: drag furniture from catalog onto plan; move/rotate/delete; sizes rendered to scale.
7. **Persistence**: save project JSON to the chosen folder automatically (debounced) and on demand.
8. **Stability pass**: no build tooling, no backend, offline-capable, works with same files across browsers via export/import.

## Explicitly Out of Scope (Phase 1)
- 3D view, rendering realism, textures
- Multi-user / cloud sync / accounts
- Precise collision detection beyond wall/furniture bounds overlap warning (simple)
- Doors/windows/openings as first-class objects (maybe simple placeholders later)
- Undo/redo (nice-to-have; add only if time permits)

## Repo Layout (proposed)
```
moodiva/
├── index.html            # landing: pick folder, list projects
├── app.html              # editor SPA
├── css/style.css
├── js/
│   ├── storage.js        # folder/file adapters
│   ├── db.js             # project CRUD API
│   ├── catalog.js        # furniture catalog
│   ├── editor.js         # 2D canvas/SVG editor
│   ├── furniture.js      # placement & rendering
│   └── app.js            # router/mode orchestration
├── server.js
└── .nojekyll
```

## Decisions (confirmed)
1. **Renderer**: SVG for the 2D editor.
2. **Wall editing**: free-form segments with snapping.
3. **Units**: store in cm internally, display in m.
4. **Floors**: single floor per project in phase 1.

## Open for Later

## Milestones
- M1: storage layer + project picker working end-to-end
- M2: wall editor (draw, edit, dimensions, snap, zoom/pan)
- M3: furniture catalog + placement
- M4: save/load stability, backups, export/import, GitHub Pages deploy
