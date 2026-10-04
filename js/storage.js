// storage.js — folder mode (File System Access API) + file mode fallback
const Storage = (() => {
  const DB_NAME = 'moodiva';
  const STORE = 'handles';

  // ---- tiny IndexedDB helper ----
  function idbOpen() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function idbSet(key, val) {
    const db = await idbOpen();
    return new Promise((res, rej) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(val, key);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  }
  async function idbGet(key) {
    const db = await idbOpen();
    return new Promise((res, rej) => {
      const tx = db.transaction(STORE, 'readonly');
      const r = tx.objectStore(STORE).get(key);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }

  // ---- state ----
  let folderHandle = null;       // FileSystemDirectoryHandle (folder mode)
  let fileHandle = null;         // FileSystemFileHandle (single-file mode, not used in M1)
  let mode = null;               // 'folder' | 'browser'
  let browserMirror = {};        // in-browser mirror for file mode: {filename: jsonString}

  const hasFSAA = typeof window.showDirectoryPicker === 'function';

  async function ensurePermission(handle, write) {
    const opts = { mode: write ? 'readwrite' : 'read' };
    if ((await handle.queryPermission(opts)) === 'granted') return true;
    return (await handle.requestPermission(opts)) === 'granted';
  }

  return {
    get mode() { return mode; },
    get folderName() { return folderHandle ? folderHandle.name : null; },
    hasFSAA,

    // Reconnect to remembered folder (call on startup)
    async tryReconnect() {
      const h = await idbGet('folderHandle').catch(() => null);
      if (h && (await ensurePermission(h, true).catch(() => false))) {
        folderHandle = h; mode = 'folder';
        return true;
      }
      const mirror = await idbGet('browserMirror').catch(() => null);
      if (mirror) { browserMirror = mirror; mode = 'browser'; return true; }
      return false;
    },

    async openFolder() {
      const h = await window.showDirectoryPicker({ mode: 'readwrite' });
      folderHandle = h; mode = 'folder';
      await idbSet('folderHandle', h);
      await this.ensureSubfolders();
      return h.name;
    },

    useBrowserMode() {
      mode = 'browser';
      folderHandle = null;
      return this.listProjects().then(() => this.listProjects());
    },

    async ensureSubfolders() {
      if (mode !== 'folder') return;
      await folderHandle.getDirectoryHandle('Backups', { create: true });
      await folderHandle.getDirectoryHandle('Projects', { create: true });
    },

    async getProjectsDir() {
      if (mode !== 'folder') return null;
      await this.ensureSubfolders();
      return folderHandle.getDirectoryHandle('Projects');
    },

    async listProjects() {
      if (mode === 'folder') {
        const dir = await this.getProjectsDir();
        const out = [];
        for await (const [name, handle] of dir.entries()) {
          if (handle.kind === 'file' && name.endsWith('.json')) {
            out.push({ file: name.replace(/\.json$/, ''), path: name });
          }
        }
        return out.sort((a, b) => a.file.localeCompare(b.file));
      }
      return Object.keys(browserMirror)
        .filter(n => n.endsWith('.json') && n.startsWith('Projects/'))
        .map(n => ({ file: n.replace(/^Projects\//, '').replace(/\.json$/, ''), path: n.replace(/^Projects\//, '') }))
        .sort((a, b) => a.file.localeCompare(b.file));
    },

    async readJSON(path) {
      if (mode === 'folder') {
        const dir = await this.getProjectsDir();
        const fh = await dir.getFileHandle(path);
        return JSON.parse(await (await fh.getFile()).text());
      }
      const raw = browserMirror['Projects/' + path];
      return raw ? JSON.parse(raw) : null;
    },

    async writeJSON(path, obj) {
      const text = JSON.stringify(obj, null, 2);
      if (mode === 'folder') {
        const dir = await this.getProjectsDir();
        const fh = await dir.getFileHandle(path, { create: true });
        const w = await fh.createWritable();
        await w.write(text);
        await w.close();
        return;
      }
      browserMirror['Projects/' + path] = text;
      await idbSet('browserMirror', browserMirror);
    },

    async deleteJSON(path) {
      if (mode === 'folder') {
        const dir = await this.getProjectsDir();
        await dir.removeEntry(path);
        return;
      }
      delete browserMirror['Projects/' + path];
      await idbSet('browserMirror', browserMirror);
    },

    async backup(path, obj) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const name = path.replace(/\.json$/, '') + '_' + stamp + '.json';
      const text = JSON.stringify(obj, null, 2);
      if (mode === 'folder') {
        const dir = await folderHandle.getDirectoryHandle('Backups');
        const fh = await dir.getFileHandle(name, { create: true });
        const w = await fh.createWritable();
        await w.write(text);
        await w.close();
        return;
      }
      browserMirror['Backups/' + name] = text;
      await idbSet('browserMirror', browserMirror);
    },
  };
})();
