// Minimal in-memory stand-in for the MongoDB driver, covering only what server.js and engine.js use.
// For automated tests without a MongoDB server; the real server uses MongoDB.
const { ObjectId } = require('mongodb');

const get = (doc, path) => path.split('.').reduce((v, k) => (v == null ? undefined : v[k]), doc);
const set = (doc, path, value) => {
  const keys = path.split('.');
  let cur = doc;
  keys.slice(0, -1).forEach((k) => { cur[k] = cur[k] && typeof cur[k] === 'object' ? cur[k] : {}; cur = cur[k]; });
  cur[keys[keys.length - 1]] = value;
};
const val = (x) => (x instanceof Date ? x.getTime() : x instanceof ObjectId ? String(x) : x);
const eq = (a, b) => val(a) === val(b);
const isOps = (c) => c && typeof c === 'object' && !(c instanceof Date) && !(c instanceof ObjectId) && !Array.isArray(c)
  && Object.keys(c).every((k) => k.startsWith('$'));
const OPS = {
  $gte: (v, c) => v !== undefined && v !== null && val(v) >= val(c),
  $gt: (v, c) => v !== undefined && v !== null && val(v) > val(c),
  $lte: (v, c) => v !== undefined && v !== null && val(v) <= val(c),
  $lt: (v, c) => v !== undefined && v !== null && val(v) < val(c),
  $ne: (v, c) => !eq(v, c),
  $in: (v, c) => c.some((x) => eq(v, x)),
  $exists: (v, c) => (v !== undefined) === Boolean(c)
};
const matches = (doc, filter) => Object.entries(filter).every(([path, cond]) => {
  const v = get(doc, path);
  if (isOps(cond)) return Object.entries(cond).every(([op, c]) => OPS[op](v, c));
  return eq(v, cond);
});

class Cursor {
  constructor(docs, projection) { this.docs = docs; this.projection = projection; }
  sort(spec) {
    const entries = Object.entries(spec);
    this.docs.sort((a, b) => {
      for (const [key, dir] of entries) {
        const x = val(get(a, key)); const y = val(get(b, key));
        if (x < y) return -dir;
        if (x > y) return dir;
      }
      return 0;
    });
    return this;
  }
  limit(n) { this.docs = this.docs.slice(0, n); return this; }
  async toArray() {
    if (!this.projection) return this.docs.map((d) => ({ ...d }));
    const include = Object.entries(this.projection).filter(([, v]) => v === 1).map(([k]) => k);
    const exclude = Object.entries(this.projection).filter(([, v]) => v === 0).map(([k]) => k);
    return this.docs.map((d) => {
      if (include.length) return Object.fromEntries(include.filter((k) => k in d).map((k) => [k, d[k]]));
      const copy = { ...d }; exclude.forEach((k) => delete copy[k]); return copy;
    });
  }
}

class Collection {
  constructor() { this.docs = []; this.unique = []; }
  checkUnique(doc) {
    for (const key of this.unique) {
      const v = get(doc, key);
      if (v !== undefined && this.docs.some((d) => d !== doc && eq(get(d, key), v))) {
        const err = new Error('duplicate key'); err.code = 11000; throw err;
      }
    }
  }
  async insertOne(doc) {
    const d = { _id: new ObjectId(), ...doc };
    this.checkUnique(d); this.docs.push(d);
    return { insertedId: d._id };
  }
  async insertMany(docs) { for (const d of docs) await this.insertOne(d); return { insertedCount: docs.length }; }
  async findOne(filter) { const d = this.docs.find((x) => matches(x, filter)); return d ? { ...d } : null; }
  find(filter = {}, options = {}) { return new Cursor(this.docs.filter((d) => matches(d, filter)), options.projection); }
  async updateOne(filter, update, options = {}) {
    let doc = this.docs.find((d) => matches(d, filter));
    let upserted = false;
    if (!doc && options.upsert) {
      doc = { _id: filter._id !== undefined ? filter._id : new ObjectId() };
      Object.entries(filter).forEach(([k, v]) => { if (!isOps(v)) set(doc, k, v); });
      Object.entries(update.$setOnInsert || {}).forEach(([k, v]) => set(doc, k, v));
      this.docs.push(doc);
      upserted = true;
    }
    if (doc) {
      Object.entries(update.$set || {}).forEach(([k, v]) => set(doc, k, v));
      Object.entries(update.$inc || {}).forEach(([k, v]) => set(doc, k, (get(doc, k) || 0) + v));
      Object.entries(update.$addToSet || {}).forEach(([k, v]) => {
        const list = get(doc, k) || [];
        if (!list.some(x => String(x) === String(v))) list.push(v);
        set(doc, k, list);
      });
    }
    return { matchedCount: doc && !upserted ? 1 : 0, upsertedCount: upserted ? 1 : 0 };
  }
  async countDocuments(filter = {}) { return this.docs.filter((d) => matches(d, filter)).length; }
  async deleteMany(filter = {}) {
    const before = this.docs.length;
    this.docs = this.docs.filter((d) => !matches(d, filter));
    return { deletedCount: before - this.docs.length };
  }
  async updateMany(filter, update) {
    const hit = this.docs.filter((d) => matches(d, filter));
    for (const doc of hit) Object.entries(update.$set || {}).forEach(([k, v]) => set(doc, k, v));
    return { matchedCount: hit.length, modifiedCount: hit.length };
  }
  async createIndex(spec, opts = {}) { if (opts.unique && Object.keys(spec).length === 1) this.unique.push(...Object.keys(spec)); }
}

class FakeDb {
  constructor() { this.cols = {}; }
  collection(name) { return (this.cols[name] = this.cols[name] || new Collection()); }
  listCollections(filter = {}) { const names = Object.keys(this.cols).filter((n) => !filter.name || n === filter.name); return { toArray: async () => names.map((name) => ({ name })) }; }
  async createCollection(name) { this.collection(name); }
  async command() { return { ok: 1 }; }
}

module.exports = { FakeDb };
