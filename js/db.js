// db.js — project CRUD on top of Storage
const DB = (() => {
  function slug(name) {
    return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project';
  }
  function newProject(name) {
    return {
      id: crypto.randomUUID(),
      name,
      unit: 'cm',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      walls: [],
      placedFurniture: [],
      assets: [],
    };
  }
  return {
    async list() { return Storage.listProjects(); },
    async create(name) {
      const p = newProject(name);
      await Storage.writeJSON(slug(name) + '.json', p);
      return p;
    },
    async open(path) {
      const p = await Storage.readJSON(path);
      if (p) await Storage.backup(path, p);
      return p;
    },
    async save(path, p) {
      p.updatedAt = new Date().toISOString();
      await Storage.writeJSON(path, p);
    },
    async remove(path) { await Storage.deleteJSON(path); },
    slug,
  };
})();
