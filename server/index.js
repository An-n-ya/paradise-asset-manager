import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { CONFIG } from "./config.js";
import { db, ASSET_TYPES } from "./db.js";
import {
  presignPut,
  presignGet,
  listObjects,
  deleteObject,
  toRelativeKey,
  imagePreviewUrl,
  status as cosStatus,
  mimeFor,
} from "./cos.js";
import { buildModel, readScriptText, writeScriptText, readScriptDoc, writeScriptDoc, scriptDocInfo } from "./script.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(__dirname, "..", "public");

const app = express();
app.use(express.json({ limit: "2mb" }));

const nowIso = () => new Date().toISOString();

function signedUrl(relativeKey, expires) {
  if (!relativeKey) return "";
  return presignGet(relativeKey, { expires: expires }).url;
}

function previewUrl(relativeKey) {
  if (!relativeKey) return "";
  return imagePreviewUrl(relativeKey) || signedUrl(relativeKey);
}

function wrap(handler) {
  return function (req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function badRequest(res, message) {
  return res.status(400).json({ error: message });
}

function notFound(res, message) {
  return res.status(404).json({ error: message || "Not found" });
}

function cleanText(value, fallback) {
  if (value === undefined || value === null) return fallback === undefined ? "" : fallback;
  return String(value);
}

function normalizeCrop(value) {
  if (value === undefined || value === null || value === "") return "";
  let obj = value;
  if (typeof value === "string") {
    try {
      obj = JSON.parse(value);
    } catch (e) {
      return "";
    }
  }
  if (!obj || typeof obj !== "object") return "";
  const nums = [obj.x, obj.y, obj.w, obj.h].map(Number);
  if (!nums.every(function (n) { return Number.isFinite(n); })) return "";
  const x = Math.min(1, Math.max(0, nums[0]));
  const y = Math.min(1, Math.max(0, nums[1]));
  const w = Math.min(1, Math.max(0, nums[2]));
  const h = Math.min(1, Math.max(0, nums[3]));
  if (w <= 0 || h <= 0) return "";
  return JSON.stringify({ x, y, w, h });
}

function nextSortOrder(table, where) {
  const clause = where ? " WHERE " + where.column + " = ?" : "";
  const args = where ? [where.value] : [];
  const row = db.prepare("SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM " + table + clause).get(...args);
  return row.n;
}

/* ----------------------------- meta ----------------------------- */

app.get("/api/status", function (_req, res) {
  const counts = {
    characters: db.prepare("SELECT COUNT(*) AS c FROM characters").get().c,
    expressions: db.prepare("SELECT COUNT(*) AS c FROM expressions").get().c,
    assets: db.prepare("SELECT COUNT(*) AS c FROM assets").get().c,
  };
  res.json({ cos: cosStatus(), counts, assetTypes: ASSET_TYPES });
});

/* --------------------------- characters --------------------------- */

app.get("/api/characters", function (_req, res) {
  const rows = db.prepare(`
    SELECT c.*, (SELECT COUNT(*) FROM expressions e WHERE e.character_id = c.id) AS expression_count
    FROM characters c
    ORDER BY c.sort_order, c.id
  `).all();
  res.json(rows.map((r) => Object.assign({}, r, {
    avatarUrl: signedUrl(r.avatar_key),
    avatarPreviewUrl: previewUrl(r.avatar_key),
  })));
});

app.get("/api/characters/:id", function (req, res) {
  const row = db.prepare("SELECT * FROM characters WHERE id = ?").get(req.params.id);
  if (!row) return notFound(res, "Character not found");
  const expressions = db.prepare("SELECT * FROM expressions WHERE character_id = ? ORDER BY sort_order, id").all(req.params.id);
  res.json({
    character: Object.assign({}, row, {
      avatarUrl: signedUrl(row.avatar_key),
      avatarPreviewUrl: previewUrl(row.avatar_key),
    }),
    expressions: expressions.map((e) => Object.assign({}, e, {
      url: signedUrl(e.asset_key),
      previewUrl: previewUrl(e.asset_key),
    })),
  });
});

app.post("/api/characters", function (req, res) {
  const name = cleanText(req.body && req.body.name).trim();
  if (!name) return badRequest(res, "name is required");
  const t = nowIso();
  const info = db.prepare(`
    INSERT INTO characters (name, display_name, note, avatar_key, avatar_crop, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    name,
    cleanText(req.body.display_name),
    cleanText(req.body.note),
    cleanText(req.body.avatar_key),
    normalizeCrop(req.body && req.body.avatar_crop),
    nextSortOrder("characters"),
    t,
    t
  );
  res.status(201).json({ id: info.lastInsertRowid });
});

app.put("/api/characters/:id", function (req, res) {
  const existing = db.prepare("SELECT * FROM characters WHERE id = ?").get(req.params.id);
  if (!existing) return notFound(res, "Character not found");
  const body = req.body || {};
  const next = {
    name: body.name !== undefined ? cleanText(body.name).trim() : existing.name,
    display_name: body.display_name !== undefined ? cleanText(body.display_name) : existing.display_name,
    note: body.note !== undefined ? cleanText(body.note) : existing.note,
    avatar_key: body.avatar_key !== undefined ? cleanText(body.avatar_key) : existing.avatar_key,
    avatar_crop: body.avatar_crop !== undefined ? normalizeCrop(body.avatar_crop) : existing.avatar_crop,
    sort_order: body.sort_order !== undefined ? Number(body.sort_order) : existing.sort_order,
  };
  if (!next.name) return badRequest(res, "name is required");
  db.prepare(`
    UPDATE characters
    SET name = @name, display_name = @display_name, note = @note,
        avatar_key = @avatar_key, avatar_crop = @avatar_crop,
        sort_order = @sort_order, updated_at = @updated_at
    WHERE id = @id
  `).run(Object.assign({}, next, { id: existing.id, updated_at: nowIso() }));
  res.json({ ok: true });
});

app.delete("/api/characters/:id", function (req, res) {
  const info = db.prepare("DELETE FROM characters WHERE id = ?").run(req.params.id);
  if (info.changes === 0) return notFound(res, "Character not found");
  res.json({ ok: true });
});

/* --------------------------- expressions --------------------------- */

app.post("/api/characters/:id/expressions", function (req, res) {
  const character = db.prepare("SELECT id FROM characters WHERE id = ?").get(req.params.id);
  if (!character) return notFound(res, "Character not found");
  const name = cleanText(req.body && req.body.name).trim();
  if (!name) return badRequest(res, "name is required");
  const t = nowIso();
  const info = db.prepare(`
    INSERT INTO expressions (character_id, name, asset_key, note, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    character.id,
    name,
    cleanText(req.body.asset_key),
    cleanText(req.body.note),
    nextSortOrder("expressions", { column: "character_id", value: character.id }),
    t,
    t
  );
  res.status(201).json({ id: info.lastInsertRowid });
});

app.put("/api/expressions/:id", function (req, res) {
  const existing = db.prepare("SELECT * FROM expressions WHERE id = ?").get(req.params.id);
  if (!existing) return notFound(res, "Expression not found");
  const body = req.body || {};
  const next = {
    name: body.name !== undefined ? cleanText(body.name).trim() : existing.name,
    asset_key: body.asset_key !== undefined ? cleanText(body.asset_key) : existing.asset_key,
    note: body.note !== undefined ? cleanText(body.note) : existing.note,
    sort_order: body.sort_order !== undefined ? Number(body.sort_order) : existing.sort_order,
  };
  if (!next.name) return badRequest(res, "name is required");
  db.prepare(`
    UPDATE expressions
    SET name = @name, asset_key = @asset_key, note = @note,
        sort_order = @sort_order, updated_at = @updated_at
    WHERE id = @id
  `).run(Object.assign({}, next, { id: existing.id, updated_at: nowIso() }));
  res.json({ ok: true });
});

app.delete("/api/expressions/:id", function (req, res) {
  const info = db.prepare("DELETE FROM expressions WHERE id = ?").run(req.params.id);
  if (info.changes === 0) return notFound(res, "Expression not found");
  res.json({ ok: true });
});

/* ----------------------------- assets ----------------------------- */

app.get("/api/assets", function (req, res) {
  const type = req.query.type;
  let rows;
  if (type) {
    rows = db.prepare("SELECT * FROM assets WHERE type = ? ORDER BY sort_order, id").all(type);
  } else {
    rows = db.prepare("SELECT * FROM assets ORDER BY type, sort_order, id").all();
  }
  res.json(rows.map((r) => Object.assign({}, r, {
    url: signedUrl(r.asset_key),
    previewUrl: previewUrl(r.asset_key),
  })));
});

app.post("/api/assets", function (req, res) {
  const body = req.body || {};
  const name = cleanText(body.name).trim();
  const type = cleanText(body.type).trim();
  if (!name) return badRequest(res, "name is required");
  if (!ASSET_TYPES.includes(type)) return badRequest(res, "invalid type: " + type);
  const t = nowIso();
  const info = db.prepare(`
    INSERT INTO assets (type, name, asset_key, note, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    type,
    name,
    cleanText(body.asset_key),
    cleanText(body.note),
    nextSortOrder("assets", { column: "type", value: type }),
    t,
    t
  );
  res.status(201).json({ id: info.lastInsertRowid });
});

app.put("/api/assets/:id", function (req, res) {
  const existing = db.prepare("SELECT * FROM assets WHERE id = ?").get(req.params.id);
  if (!existing) return notFound(res, "Asset not found");
  const body = req.body || {};
  const next = {
    type: body.type !== undefined ? cleanText(body.type).trim() : existing.type,
    name: body.name !== undefined ? cleanText(body.name).trim() : existing.name,
    asset_key: body.asset_key !== undefined ? cleanText(body.asset_key) : existing.asset_key,
    note: body.note !== undefined ? cleanText(body.note) : existing.note,
    sort_order: body.sort_order !== undefined ? Number(body.sort_order) : existing.sort_order,
  };
  if (!next.name) return badRequest(res, "name is required");
  if (!ASSET_TYPES.includes(next.type)) return badRequest(res, "invalid type: " + next.type);
  db.prepare(`
    UPDATE assets
    SET type = @type, name = @name, asset_key = @asset_key, note = @note,
        sort_order = @sort_order, updated_at = @updated_at
    WHERE id = @id
  `).run(Object.assign({}, next, { id: existing.id, updated_at: nowIso() }));
  res.json({ ok: true });
});

app.delete("/api/assets/:id", function (req, res) {
  const info = db.prepare("DELETE FROM assets WHERE id = ?").run(req.params.id);
  if (info.changes === 0) return notFound(res, "Asset not found");
  res.json({ ok: true });
});

/* ------------------------------- cos ------------------------------- */

app.post("/api/cos/presign-upload", function (req, res) {
  const relativeKey = cleanText(req.body && req.body.key).trim().replace(/^\/+/, "");
  if (!relativeKey) return badRequest(res, "key is required");
  const contentType = cleanText(req.body.contentType) || mimeFor(relativeKey);
  res.json(presignPut(relativeKey, { contentType }));
});

app.get("/api/cos/presign-download", function (req, res) {
  const relativeKey = cleanText(req.query.key).trim();
  if (!relativeKey) return badRequest(res, "key is required");
  const expires = Number(req.query.expires) || undefined;
  res.json(presignGet(relativeKey, { expires }));
});

app.get("/api/cos/objects", wrap(async function (req, res) {
  const prefix = req.query.prefix !== undefined ? String(req.query.prefix) : CONFIG.cos.prefix;
  const objects = await listObjects(prefix);
  res.json(objects.map((o) => ({
    key: o.key,
    relativeKey: toRelativeKey(o.key),
    size: o.size,
    lastModified: o.lastModified,
    url: signedUrl(toRelativeKey(o.key)),
    previewUrl: previewUrl(toRelativeKey(o.key)),
  })));
}));

app.delete("/api/cos/objects", wrap(async function (req, res) {
  const relativeKey = cleanText(req.query.key || (req.body && req.body.key)).trim();
  if (!relativeKey) return badRequest(res, "key is required");
  await deleteObject(relativeKey);
  res.json({ ok: true });
}));

/* ------------------------------ script ------------------------------ */

app.get("/api/script", wrap(async function (req, res) {
  const text = readScriptText();
  const model = buildModel(text);
  res.json(Object.assign({ text: text }, model));
}));

app.put("/api/script", wrap(async function (req, res) {
  const text = req.body && req.body.text;
  if (typeof text !== "string") return badRequest(res, "text is required");
  const saved = writeScriptText(text);
  const model = buildModel(text);
  res.json(Object.assign({ text: text, saved: saved }, model));
}));

app.get("/api/script-doc", wrap(async function (req, res) {
  res.json({ doc: readScriptDoc(), file: scriptDocInfo() });
}));

app.put("/api/script-doc", wrap(async function (req, res) {
  const doc = req.body && req.body.doc;
  if (!doc || typeof doc !== "object" || !doc.labels) return badRequest(res, "doc is required");
  const saved = writeScriptDoc(doc);
  res.json({ doc: doc, saved: saved });
}));

/* ----------------------------- static ----------------------------- */

app.use(express.static(PUBLIC_DIR));

app.use(function (err, _req, res, _next) {
  const status = err && err.status ? err.status : 500;
  res.status(status).json({ error: err && err.message ? err.message : String(err) });
});

app.listen(CONFIG.port, CONFIG.host, function () {
  console.log("asset manager listening on http://" + CONFIG.host + ":" + CONFIG.port);
  console.log("static dir: " + PUBLIC_DIR);
  if (!cosStatus().ready) {
    console.log("warning: COS credentials are not configured; upload/preview will fail");
  }
});
