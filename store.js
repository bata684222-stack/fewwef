// WorkshopAG — постоянное хранилище.
// Драйвер выбирается по переменным окружения:
//   DATABASE_URL            → PostgreSQL (Render Postgres) — база и файлы
//   REDIS_URL / KV_URL      → Key Value (Redis) — база и файлы
//   ничего                  → файлы на диске (локальная разработка)
//
// Диск на хостинге обнуляется при каждом деплое, поэтому с DATABASE_URL/REDIS_URL
// переживает редеплой, рестарт и смену образа.
'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const UP_DIR = path.join(ROOT, 'public', 'uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const DB_KEY = 'workshopag:db';
const FILE_KEY = name => 'workshopag:f:' + name;

const mime = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.json': 'application/json'
};
function mimeOf(name) { return mime[path.extname(name).toLowerCase()] || 'application/octet-stream'; }

function newName(ext) { return Date.now() + '-' + crypto.randomBytes(8).toString('hex') + ext; }

class Store {
  constructor() { this.kind = 'file'; this.pg = null; this.redis = null; }

  async init() {
    const PG = process.env.DATABASE_URL;
    const RD = process.env.REDIS_URL || process.env.KV_URL;
    if (PG) {
      try { await this.initPG(PG); return; }
      catch (e) { console.error('[store] PostgreSQL недоступен (' + e.message + ') — падаю на диск. Данные не переживут деплой.'); }
    }
    if (RD) {
      try { await this.initRedis(RD); return; }
      catch (e) { console.error('[store] Key Value недоступен (' + e.message + ') — падаю на диск. Данные не переживут деплой.'); }
    }
    await this.initFile();
  }

  // ───────── PostgreSQL ─────────
  async initPG(url) {
    const { Pool } = require('pg');
    const pool = new Pool({
      connectionString: url,
      ssl: url.includes('localhost') ? false : { rejectUnauthorized: false },
      max: 5, idleTimeoutMillis: 30e3
    });
    const probe = await pool.connect(); probe.release();
    await pool.query(`CREATE TABLE IF NOT EXISTS ag_state (
      id text PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS ag_files (
      name text PRIMARY KEY, data bytea NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`);
    this.pg = pool; this.kind = 'pg';
    console.log('[store] PostgreSQL ✓');
  }
  async load() {
    if (this.kind === 'pg') {
      const r = await this.pg.query('SELECT data FROM ag_state WHERE id=$1', [DB_KEY]);
      return r.rows.length ? r.rows[0].data : null;
    }
    if (this.kind === 'redis') return this.loadRedis();
    try { return JSON.parse(await fsp.readFile(DB_FILE, 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }
  async save(db) {
    const json = JSON.stringify(db);
    if (this.kind === 'pg') { await this.pg.query(
      `INSERT INTO ag_state (id,data) VALUES ($1,$2::jsonb)
       ON CONFLICT (id) DO UPDATE SET data=$2::jsonb, updated_at=now()`, [DB_KEY, json]); return; }
    if (this.kind === 'redis') { await this.redis.set(DB_KEY, json); return; }
    await fsp.mkdir(DATA_DIR, { recursive: true });
    const tmp = DB_FILE + '.tmp';
    await fsp.writeFile(tmp, json);
    await fsp.rename(tmp, DB_FILE);
  }

  // ───────── Key Value (Redis) ─────────
  async initRedis(url) {
    const { createClient } = require('redis');
    const c = createClient({ url });
    c.on('error', e => console.error('[store] redis:', e.message));
    await c.connect();
    await c.ping();
    this.redis = c; this.kind = 'redis';
    console.log('[store] Key Value ✓');
  }
  async loadRedis() {
    const raw = await this.redis.get(DB_KEY);
    return raw ? JSON.parse(raw) : null;
  }

  // ───────── файлы (фото и чертежи) ─────────
  async putFile(ext, buf) {
    const name = newName(ext);
    if (this.kind === 'pg') { await this.pg.query('INSERT INTO ag_files (name,data) VALUES ($1,$2)', [name, buf]); return name; }
    if (this.kind === 'redis') { await this.redis.set(FILE_KEY(name), buf.toString('base64')); return name; }
    await fsp.mkdir(UP_DIR, { recursive: true });
    await fsp.writeFile(path.join(UP_DIR, name), buf);
    return name;
  }
  async getFile(name) {
    if (this.kind === 'pg') {
      const r = await this.pg.query('SELECT data FROM ag_files WHERE name=$1', [name]);
      return r.rows.length ? r.rows[0].data : null;
    }
    if (this.kind === 'redis') {
      const b64 = await this.redis.get(FILE_KEY(name));
      return b64 ? Buffer.from(b64, 'base64') : null;
    }
    try { return await fsp.readFile(path.join(UP_DIR, path.basename(name))); }
    catch (_) { return null; }
  }
  async delFile(name) {
    if (!name) return;
    if (this.kind === 'pg') { await this.pg.query('DELETE FROM ag_files WHERE name=$1', [name]); return; }
    if (this.kind === 'redis') { await this.redis.del(FILE_KEY(name)); return; }
    await fsp.unlink(path.join(UP_DIR, path.basename(name))).catch(() => {});
  }
  async fileCount() {
    if (this.kind === 'pg') { const r = await this.pg.query('SELECT count(*)::int c FROM ag_files'); return r.rows[0].c; }
    if (this.kind === 'redis') { const ks = await this.redis.keys('workshopag:f:*'); return ks.length; }
    try { return (await fsp.readdir(UP_DIR)).length; } catch (_) { return 0; }
  }
  async migrateFilesFromDisk() { // один раз: забрать накопленное на диске в постоянное хранилище
    if (this.kind === 'file') return 0;
    let names = [];
    try { names = await fsp.readdir(UP_DIR); } catch (_) { return 0; }
    let n = 0;
    for (const nm of names) {
      if (!nm || nm === '.gitkeep') continue;
      try {
        const buf = await fsp.readFile(path.join(UP_DIR, nm));
        await this.putFile(path.extname(nm), buf);
        await fsp.unlink(path.join(UP_DIR, nm));
        n++;
      } catch (_) {}
    }
    return n;
  }
  async initFile() {
    this.kind = 'file';
    await fsp.mkdir(UP_DIR, { recursive: true });
    await fsp.mkdir(DATA_DIR, { recursive: true });
    console.log('[store] локальные файлы (данные не переживут деплой)');
  }
}

module.exports = { store: new Store(), DB_FILE, UP_DIR, mimeOf };