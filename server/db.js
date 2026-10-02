import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { CONFIG } from "./config.js";

const DB_FILE = resolve(process.cwd(), CONFIG.dbPath);
mkdirSync(dirname(DB_FILE), { recursive: true });

export const db = new Database(DB_FILE);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

const nowIso = () => new Date().toISOString();

db.exec(`
  CREATE TABLE IF NOT EXISTS characters (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT    NOT NULL,
    display_name TEXT    NOT NULL DEFAULT '',
    note         TEXT    NOT NULL DEFAULT '',
    avatar_key   TEXT    NOT NULL DEFAULT '',
    avatar_crop  TEXT    NOT NULL DEFAULT '',
    sort_order   INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT    NOT NULL,
    updated_at   TEXT    NOT NULL
  );

  CREATE TABLE IF NOT EXISTS expressions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    name         TEXT    NOT NULL,
    asset_key    TEXT    NOT NULL DEFAULT '',
    note         TEXT    NOT NULL DEFAULT '',
    sort_order   INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT    NOT NULL,
    updated_at   TEXT    NOT NULL
  );

  CREATE TABLE IF NOT EXISTS assets (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    type       TEXT    NOT NULL,
    name       TEXT    NOT NULL,
    asset_key  TEXT    NOT NULL DEFAULT '',
    note       TEXT    NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT    NOT NULL,
    updated_at TEXT    NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_expressions_character ON expressions(character_id);
  CREATE INDEX IF NOT EXISTS idx_assets_type ON assets(type);
`);

function columnNames(table) {
  return db.prepare("PRAGMA table_info(" + table + ")").all().map(function (c) { return c.name; });
}

function migrate() {
  if (!columnNames("characters").includes("avatar_crop")) {
    db.exec("ALTER TABLE characters ADD COLUMN avatar_crop TEXT NOT NULL DEFAULT ''");
  }
}

migrate();

export const ASSET_TYPES = ["scene", "bgm", "se", "voice", "dataset", "dynamic"];

function loadRoster() {
  const file = resolve(process.cwd(), CONFIG.rosterPath);
  if (!existsSync(file)) return { characters: [], assets: [] };
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    return {
      characters: Array.isArray(data.characters) ? data.characters : [],
      assets: Array.isArray(data.assets) ? data.assets : [],
    };
  } catch (e) {
    return { characters: [], assets: [] };
  }
}

function syncRoster() {
  const roster = loadRoster();
  const t = nowIso();

  const insertCharacter = db.prepare(`
    INSERT INTO characters (name, display_name, note, avatar_key, sort_order, created_at, updated_at)
    VALUES (@name, @display_name, @note, @avatar_key, @sort_order, @created_at, @updated_at)
  `);
  const insertExpression = db.prepare(`
    INSERT INTO expressions (character_id, name, asset_key, note, sort_order, created_at, updated_at)
    VALUES (@character_id, @name, @asset_key, @note, @sort_order, @created_at, @updated_at)
  `);
  const insertAsset = db.prepare(`
    INSERT INTO assets (type, name, asset_key, note, sort_order, created_at, updated_at)
    VALUES (@type, @name, @asset_key, @note, @sort_order, @created_at, @updated_at)
  `);

  const knownNames = new Set();
  db.prepare("SELECT name, display_name FROM characters").all().forEach(function (row) {
    knownNames.add(row.name);
    knownNames.add(row.display_name);
  });

  const knownKeys = new Set();
  db.prepare("SELECT asset_key FROM assets").all().forEach(function (row) {
    if (row.asset_key) knownKeys.add(row.asset_key);
  });

  let characterOrder = db.prepare("SELECT COALESCE(MAX(sort_order), -1) AS m FROM characters").get().m + 1;
  let assetOrder = db.prepare("SELECT COALESCE(MAX(sort_order), -1) AS m FROM assets").get().m + 1;

  const run = db.transaction(() => {
    for (const c of roster.characters) {
      if (!c.name) continue;
      if (knownNames.has(c.name) || knownNames.has(c.display_name)) continue;
      const info = insertCharacter.run({
        name: c.name,
        display_name: c.display_name || c.name,
        note: c.note || "",
        avatar_key: c.avatar_key || "",
        sort_order: characterOrder++,
        created_at: t,
        updated_at: t,
      });
      knownNames.add(c.name);
      if (c.display_name) knownNames.add(c.display_name);
      let expressionOrder = 0;
      for (const expr of (c.expressions || [])) {
        const exprName = Array.isArray(expr) ? expr[0] : expr.name;
        const exprKey = Array.isArray(expr) ? expr[1] : expr.asset_key;
        insertExpression.run({
          character_id: info.lastInsertRowid,
          name: exprName,
          asset_key: exprKey || "",
          note: "",
          sort_order: expressionOrder++,
          created_at: t,
          updated_at: t,
        });
      }
    }
    for (const a of roster.assets) {
      if (!a.asset_key || !a.type || knownKeys.has(a.asset_key)) continue;
      insertAsset.run({
        type: a.type,
        name: a.name,
        asset_key: a.asset_key,
        note: a.note || "",
        sort_order: assetOrder++,
        created_at: t,
        updated_at: t,
      });
      knownKeys.add(a.asset_key);
    }
  });

  run();
}

syncRoster();
