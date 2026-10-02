import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { CONFIG } from "./config.js";
import { db } from "./db.js";
import { presignGet, imagePreviewUrl } from "./cos.js";

const FALLBACK_TEMPLATE = [
  "label start:",
  "    return",
  "",
].join("\n");

const CARD_KINDS = {
  card: "card",
  datecard: "date",
  titlecard: "title",
  sectioncard: "section",
  quotecard: "quote",
};

const LABEL_NO = {
  p0: "PROLOGUE",
  ending: "ENDING",
};

/* ---------------------------- url helpers ---------------------------- */

function signedUrl(relativeKey) {
  if (!relativeKey) return "";
  return presignGet(relativeKey, {}).url;
}

function previewUrl(relativeKey) {
  if (!relativeKey) return "";
  return imagePreviewUrl(relativeKey) || signedUrl(relativeKey);
}

function assetUrl(relativeKey) {
  if (!relativeKey) return { key: "", url: "", previewUrl: "" };
  return { key: relativeKey, url: signedUrl(relativeKey), previewUrl: previewUrl(relativeKey) };
}

/* ---------------------------- file access ---------------------------- */

function managedPath() {
  return resolve(process.cwd(), CONFIG.scriptPath);
}

function sourcePath() {
  return CONFIG.scriptSource ? resolve(process.cwd(), CONFIG.scriptSource) : "";
}

export function readScriptText() {
  const file = managedPath();
  if (existsSync(file)) return readFileSync(file, "utf8");

  mkdirSync(dirname(file), { recursive: true });
  const src = sourcePath();
  if (src && existsSync(src)) {
    const text = readFileSync(src, "utf8");
    writeFileSync(file, text, "utf8");
    return text;
  }
  writeFileSync(file, FALLBACK_TEMPLATE, "utf8");
  return FALLBACK_TEMPLATE;
}

export function writeScriptText(text) {
  const file = managedPath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, String(text), "utf8");
  const stat = statSync(file);
  return { bytes: stat.size, updatedAt: new Date(stat.mtimeMs).toISOString() };
}

export function fileInfo() {
  const file = managedPath();
  if (!existsSync(file)) return { path: CONFIG.scriptPath, bytes: 0, updatedAt: "" };
  const stat = statSync(file);
  return {
    path: CONFIG.scriptPath,
    bytes: stat.size,
    updatedAt: new Date(stat.mtimeMs).toISOString(),
  };
}

/* ----------------------------- block doc ----------------------------- */

function docPath() {
  return resolve(process.cwd(), CONFIG.scriptDocPath);
}

export function readScriptDoc() {
  const file = docPath();
  if (!existsSync(file)) return { version: 1, labels: {} };
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    if (!data || typeof data !== "object") return { version: 1, labels: {} };
    if (!data.labels || typeof data.labels !== "object") data.labels = {};
    return data;
  } catch (e) {
    return { version: 1, labels: {} };
  }
}

export function writeScriptDoc(doc) {
  const file = docPath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(doc, null, 2), "utf8");
  const stat = statSync(file);
  return { path: CONFIG.scriptDocPath, bytes: stat.size, updatedAt: new Date(stat.mtimeMs).toISOString() };
}

export function scriptDocInfo() {
  const file = docPath();
  if (!existsSync(file)) return { path: CONFIG.scriptDocPath, bytes: 0, updatedAt: "" };
  const stat = statSync(file);
  return { path: CONFIG.scriptDocPath, bytes: stat.size, updatedAt: new Date(stat.mtimeMs).toISOString() };
}

/* ------------------------------ tokenize ------------------------------ */

function tokenize(text) {
  return String(text).split(/\r?\n/).map(function (raw) {
    const expanded = raw.replace(/\t/g, "    ");
    const stripped = expanded.replace(/^\s+/, "");
    return { indent: expanded.length - stripped.length, text: stripped.trimEnd() };
  });
}

function unescapeStr(value) {
  return String(value)
    .replace(/\\(["\\])/g, "$1")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t");
}

function baseName(path) {
  const parts = String(path || "").split("/");
  return parts[parts.length - 1];
}

function stripWith(value) {
  return String(value).replace(/\s+with\s+.+$/, "").trim();
}

/* --------------------------- definitions --------------------------- */

function extractDefinitions(text) {
  const characters = {};
  const audio = {};
  const images = {};
  String(text).split(/\r?\n/).forEach(function (raw) {
    const line = raw.trim();
    let m;
    if ((m = line.match(/^define\s+audio\.(\w+)\s*=\s*"([^"]+)"/))) {
      audio[m[1]] = m[2];
      return;
    }
    if ((m = line.match(/^define\s+(\w+)\s*=\s*Character\(\s*([\s\S]*?)\s*\)\s*$/))) {
      const rest = m[2];
      const nameMatch = rest.match(/^\s*("(?:[^"\\]|\\.)*"|None)/);
      const colorMatch = rest.match(/who_color\s*=\s*"([^"]+)"/);
      let name = "";
      if (nameMatch && nameMatch[1] !== "None") name = unescapeStr(nameMatch[1].slice(1, -1));
      characters[m[1]] = { id: m[1], name: name, color: colorMatch ? colorMatch[1] : "" };
      return;
    }
    if ((m = line.match(/^image\s+(.+?)\s*=\s*"([^"]+)"\s*$/))) {
      images[m[1].trim()] = m[2];
      return;
    }
  });
  return { characters: characters, audio: audio, images: images };
}

/* ----------------------------- statements ----------------------------- */

function splitHead(value) {
  const parts = String(value).split(/\s+/);
  return { head: parts[0] || "", attr: parts.slice(1).join(" ") };
}

function classify(line, defs) {
  const text = line.text;
  if (!text) return null;
  const cardMatch = text.match(/^(\w+)\s+("(?:[^"\\]|\\.)*")\s*$/);
  if (cardMatch && CARD_KINDS[cardMatch[1]]) {
    return { type: "card", kind: CARD_KINDS[cardMatch[1]], text: unescapeStr(cardMatch[2].slice(1, -1)) };
  }

  let m;
  if ((m = text.match(/^scene\s+(.+)$/))) {
    return { type: "scene", image: stripWith(m[1]) };
  }
  if ((m = text.match(/^show\s+(.+)$/))) {
    const rest = stripWith(m[1]);
    if (rest.indexOf("screen ") === 0) return { type: "screen", action: "show", name: rest.slice(7).trim() };
    const split = splitHead(rest);
    return { type: "show", image: rest, char: split.head, attr: split.attr };
  }
  if ((m = text.match(/^hide\s+(.+)$/))) {
    const rest = stripWith(m[1]);
    if (rest.indexOf("screen ") === 0) return { type: "screen", action: "hide", name: rest.slice(7).trim() };
    return { type: "hide", char: splitHead(rest).head };
  }
  if ((m = text.match(/^play\s+(music|ambient|sound)\s+(\w+)(.*)$/))) {
    return { type: "audio", action: "play", channel: m[1], clip: m[2], params: m[3].trim() };
  }
  if ((m = text.match(/^stop\s+(music|ambient|sound)(.*)$/))) {
    return { type: "audio", action: "stop", channel: m[1], clip: "", params: m[2].trim() };
  }
  if (/^pause\b/.test(text)) {
    return { type: "cue", text: text };
  }
  if ((m = text.match(/^("(?:[^"\\]|\\.)*")\s*$/))) {
    return { type: "narr", text: unescapeStr(m[1].slice(1, -1)) };
  }
  if ((m = text.match(/^(\w+)((?:\s+\w+)*)\s+("(?:[^"\\]|\\.)*")\s*$/))) {
    const def = defs.characters[m[1]];
    if (def && def.name) {
      return { type: "line", char: m[1], attr: m[2].trim(), text: unescapeStr(m[3].slice(1, -1)) };
    }
  }
  if (/^with\b/.test(text)) {
    return { type: "cue", text: text };
  }
  return null;
}

function parseNodes(lines, defs) {
  const nodes = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const text = line.text;
    i++;
    if (!text || text.charAt(0) === "#") continue;

    if (text === "menu:") {
      const menuIndent = line.indent;
      const block = [];
      while (i < lines.length && (lines[i].indent > menuIndent || !lines[i].text)) {
        block.push(lines[i]);
        i++;
      }
      nodes.push(parseMenu(block, defs));
      continue;
    }

    const node = classify(line, defs);
    if (node) nodes.push(node);
  }
  return nodes;
}

function parseMenu(block, defs) {
  const menu = { type: "menu", prompt: "", choices: [] };
  let i = 0;
  while (i < block.length && !block[i].text) i++;
  if (i < block.length && /^"(?:[^"\\]|\\.)*"\s*$/.test(block[i].text)) {
    menu.prompt = unescapeStr(block[i].text.trim().slice(1, -1));
    i++;
  }
  while (i < block.length) {
    const line = block[i];
    if (!line.text) {
      i++;
      continue;
    }
    const choiceMatch = line.text.match(/^("(?:[^"\\]|\\.)*")\s*:\s*$/);
    if (!choiceMatch) {
      i++;
      continue;
    }
    const choiceIndent = line.indent;
    const choice = { text: unescapeStr(choiceMatch[1].slice(1, -1)), nodes: [] };
    i++;
    const sub = [];
    while (i < block.length && (block[i].indent > choiceIndent || !block[i].text)) {
      sub.push(block[i]);
      i++;
    }
    choice.nodes = parseNodes(sub, defs);
    menu.choices.push(choice);
  }
  return menu;
}

/* ------------------------------ resolve ------------------------------ */

function loadAssetMap() {
  const rows = db.prepare("SELECT * FROM assets").all();
  const byKey = {};
  rows.forEach(function (row) {
    if (row.asset_key) byKey[row.asset_key] = row;
  });
  return byKey;
}

function loadCharacterRows() {
  return db.prepare("SELECT * FROM characters ORDER BY sort_order, id").all();
}

function matchCharacter(defChar, rows) {
  if (!defChar.name) return null;
  return rows.find(function (row) {
    return row.display_name === defChar.name || row.name === defChar.name;
  }) || null;
}

function buildContext(defs) {
  const assetMap = loadAssetMap();
  const charRows = loadCharacterRows();

  const characters = [];
  const characterMap = {};
  Object.keys(defs.characters).forEach(function (id) {
    const def = defs.characters[id];
    const matched = matchCharacter(def, charRows);
    const avatar = matched ? assetUrl(matched.avatar_key) : { key: "", url: "", previewUrl: "" };
    const entry = {
      id: id,
      name: def.name,
      color: def.color,
      matchedCharacterId: matched ? matched.id : null,
      avatarKey: avatar.key,
      avatarUrl: avatar.url,
      avatarPreviewUrl: avatar.previewUrl,
      avatarCrop: matched ? matched.avatar_crop : "",
    };
    characterMap[id] = entry;
    if (def.name) characters.push(entry);
  });

  const audio = {};
  Object.keys(defs.audio).forEach(function (id) {
    const key = defs.audio[id];
    const asset = assetMap[key];
    audio[id] = Object.assign({ id: id, key: key, display: asset ? asset.name : baseName(key) }, assetUrl(key));
  });

  const images = {};
  Object.keys(defs.images).forEach(function (name) {
    const key = defs.images[name];
    const asset = assetMap[key];
    images[name] = Object.assign({
      name: name,
      key: key,
      kind: name.indexOf("bg ") === 0 ? "bg" : "sprite",
      display: asset ? asset.name : baseName(key),
    }, assetUrl(key));
  });

  return { characters: characters, characterMap: characterMap, audio: audio, images: images, defs: defs };
}

function resolveNodes(rawNodes, ctx, label) {
  const state = { sprites: {} };
  const out = [];
  rawNodes.forEach(function (node) {
    if (node.type === "scene") {
      const img = ctx.images[node.image];
      const resolved = Object.assign({}, node, {
        display: img ? img.display : (node.image === "black" ? "BLACK" : node.image),
        key: img ? img.key : "",
        url: img ? img.url : "",
        previewUrl: img ? img.previewUrl : "",
      });
      out.push(resolved);
      return;
    }
    if (node.type === "show") {
      const img = ctx.images[node.image];
      if (img && ctx.characterMap[node.char]) state.sprites[node.char] = img;
      if (ctx.characterMap[node.char]) addCast(label, node.char);
      out.push(Object.assign({}, node, {
        display: img ? img.display : node.image,
        key: img ? img.key : "",
        url: img ? img.url : "",
        previewUrl: img ? img.previewUrl : "",
      }));
      return;
    }
    if (node.type === "line") {
      const character = ctx.characterMap[node.char] || null;
      if (character) addCast(label, node.char);
      const sprite = state.sprites[node.char];
      out.push(Object.assign({}, node, {
        speaker: character ? character.name : node.char,
        color: character ? character.color : "",
        avatarUrl: character ? character.avatarUrl : "",
        avatarPreviewUrl: character ? character.avatarPreviewUrl : "",
        avatarCrop: character ? character.avatarCrop : "",
        spriteUrl: sprite ? sprite.url : "",
        spritePreviewUrl: sprite ? sprite.previewUrl : "",
      }));
      return;
    }
    if (node.type === "audio") {
      const clip = node.clip ? ctx.audio[node.clip] : null;
      if (node.action === "play" && node.channel === "music" && clip) addBgm(label, clip);
      out.push(Object.assign({}, node, {
        display: clip ? clip.display : node.clip,
        key: clip ? clip.key : "",
        url: clip ? clip.url : "",
        previewUrl: clip ? clip.previewUrl : "",
      }));
      return;
    }
    if (node.type === "hide") {
      if (ctx.characterMap[node.char]) addCast(label, node.char);
      out.push(node);
      return;
    }
    if (node.type === "menu") {
      out.push(Object.assign({}, node, {
        choices: node.choices.map(function (choice) {
          return Object.assign({}, choice, { nodes: resolveNodes(choice.nodes, ctx, label) });
        }),
      }));
      return;
    }
    out.push(node);
  });
  return out;
}

function addCast(label, charId) {
  if (label.castIds.indexOf(charId) === -1) label.castIds.push(charId);
}

function addBgm(label, clip) {
  const exists = label.bgm.some(function (item) { return item.key === clip.key; });
  if (!exists) label.bgm.push(clip);
}

function labelNo(id) {
  if (LABEL_NO[id]) return LABEL_NO[id];
  const match = id.match(/^s(\d+)$/);
  if (match) return "SCENE " + match[1];
  return id.toUpperCase();
}

function labelTitle(label) {
  const scene = label.nodes.find(function (n) { return n.type === "scene" && n.display && n.key; });
  if (scene) return scene.display;
  const card = label.nodes.find(function (n) { return n.type === "card"; });
  if (card) return card.text.split("\n")[0].slice(0, 28);
  const line = label.nodes.find(function (n) { return n.type === "line"; });
  if (line) return line.text.slice(0, 22);
  return label.id;
}

function closingBackground(label) {
  let bg = null;
  label.nodes.forEach(function (n) {
    if (n.type === "scene") bg = n;
  });
  return bg;
}

/* ------------------------------- model ------------------------------- */

export function buildModel(text) {
  const defs = extractDefinitions(text);
  const ctx = buildContext(defs);

  const labels = [];
  splitLabels(text, defs).forEach(function (raw) {
    const label = { id: raw.id, castIds: [], bgm: [] };
    const resolved = resolveNodes(raw.nodes, ctx, label);
    if (!resolved.length) return;
    label.nodes = resolved;
    label.no = labelNo(raw.id);
    label.title = labelTitle(label);
    label.background = closingBackground(label);
    label.cast = label.castIds.map(function (id) { return ctx.characterMap[id]; }).filter(Boolean);
    labels.push(label);
  });

  const stats = {
    labelCount: labels.length,
    nodeCount: labels.reduce(function (sum, l) { return sum + l.nodes.length; }, 0),
    lineCount: labels.reduce(function (sum, l) {
      return sum + l.nodes.filter(function (n) { return n.type === "line"; }).length;
    }, 0),
    characterCount: ctx.characters.length,
  };

  return {
    file: fileInfo(),
    characters: ctx.characters,
    audio: Object.keys(ctx.audio).map(function (k) { return ctx.audio[k]; }),
    images: Object.keys(ctx.images).map(function (k) { return ctx.images[k]; }),
    labels: labels,
    stats: stats,
  };
}

function splitLabels(text, defs) {
  const lines = tokenize(text);
  const blocks = [];
  let active = null;
  lines.forEach(function (line) {
    const match = line.text.match(/^label\s+(\w+)\s*:\s*$/);
    if (match) {
      active = { id: match[1], body: [] };
      blocks.push(active);
      return;
    }
    if (active) active.body.push(line);
  });
  return blocks.map(function (item) {
    return { id: item.id, nodes: parseNodes(item.body, defs) };
  });
}

export function parseScript(text) {
  return buildModel(text);
}
