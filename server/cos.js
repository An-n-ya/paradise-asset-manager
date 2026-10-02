import crypto from "node:crypto";
import { CONFIG, cosReady } from "./config.js";

const EXPIRES = 3600;

export const MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".flac": "audio/flac",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
};

export function mimeFor(name) {
  const dot = String(name).lastIndexOf(".");
  const ext = dot === -1 ? "" : String(name).slice(dot).toLowerCase();
  return MIME[ext] || "application/octet-stream";
}

function hmacSha1(key, data) {
  return crypto.createHmac("sha1", key).update(data, "utf8").digest("hex");
}

function sha1Hex(data) {
  return crypto.createHash("sha1").update(data, "utf8").digest("hex");
}

function uriEncode(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, function (ch) {
    return "%" + ch.charCodeAt(0).toString(16).toUpperCase();
  });
}

function encodeKey(key) {
  return String(key).split("/").map(uriEncode).join("/");
}

function lowerMap(source) {
  const out = {};
  Object.keys(source || {}).forEach(function (k) {
    out[k.toLowerCase()] = source[k];
  });
  return out;
}

function canonicalQuery(query) {
  const map = lowerMap(query);
  return Object.keys(map).sort().map(function (k) {
    const v = map[k];
    return uriEncode(k) + "=" + uriEncode(v === undefined || v === null ? "" : v);
  }).join("&");
}

function canonicalParamKeys(query) {
  return Object.keys(lowerMap(query)).sort().join(";");
}

function buildAuthorization(method, uriPath, query, headers, expires) {
  const c = CONFIG.cos;
  const now = Math.floor(Date.now() / 1000);
  const keyTime = now + ";" + (now + (expires || EXPIRES));
  const signKey = hmacSha1(c.secretKey, keyTime);
  const headerMap = lowerMap(headers);
  const headerKeys = Object.keys(headerMap).sort();
  const headerString = headerKeys.map(function (k) {
    return uriEncode(k) + "=" + uriEncode(headerMap[k]);
  }).join("&");
  const httpString =
    method.toLowerCase() + "\n" +
    uriPath + "\n" +
    canonicalQuery(query) + "\n" +
    headerString + "\n";
  const stringToSign = "sha1\n" + keyTime + "\n" + sha1Hex(httpString) + "\n";
  const signature = hmacSha1(signKey, stringToSign);
  return {
    headerKeys: headerKeys,
    paramKeys: canonicalParamKeys(query),
    authorization:
      "q-sign-algorithm=sha1" +
      "&q-ak=" + c.secretId +
      "&q-sign-time=" + keyTime +
      "&q-key-time=" + keyTime +
      "&q-header-list=" + headerKeys.join(";") +
      "&q-url-param-list=" + canonicalParamKeys(query) +
      "&q-signature=" + signature,
  };
}

export function hostFor() {
  const c = CONFIG.cos;
  return c.bucket + ".cos." + c.region + ".myqcloud.com";
}

export function toObjectKey(relativeKey) {
  const prefix = CONFIG.cos.prefix || "";
  const rel = String(relativeKey || "").replace(/^\/+/, "");
  return rel ? prefix + rel : prefix;
}

export function toRelativeKey(objectKey) {
  const prefix = CONFIG.cos.prefix || "";
  const key = String(objectKey || "");
  return key.startsWith(prefix) ? key.slice(prefix.length) : key;
}

export function publicUrl(objectKey) {
  return CONFIG.cos.domain + "/" + encodeKey(objectKey);
}

const COMPRESSIBLE_IMAGE_EXT = [".png", ".jpg", ".jpeg", ".bmp", ".webp", ".gif", ".avif", ".heic", ".tiff"];

/*
 * Build a lightweight preview URL for raster images using COS on-the-fly
 * transcoding. Returns an empty string for non-image / non-derivable keys so
 * callers can fall back to a regular signed URL.
 */
export function imagePreviewUrl(relativeKey) {
  const objectKey = toObjectKey(relativeKey);
  const dot = objectKey.lastIndexOf(".");
  const ext = dot === -1 ? "" : objectKey.slice(dot).toLowerCase();
  if (COMPRESSIBLE_IMAGE_EXT.indexOf(ext) === -1) return "";
  return publicUrl(objectKey) + "?imageMogr2/format/avif";
}

/*
 * Build a presigned URL for a raw object key.
 * The string-to-sign uses the raw (decoded) path; only the request URL is
 * percent-encoded. This is required by the COS v5 signature algorithm.
 */
export function presign(method, objectKey, options) {
  const opts = options || {};
  const expires = opts.expires || EXPIRES;
  const query = opts.query || {};
  const headers = Object.assign({ host: hostFor() }, opts.headers || {});
  const signPath = objectKey ? "/" + objectKey : "/";
  const urlPath = objectKey ? "/" + encodeKey(objectKey) : "/";
  const signed = buildAuthorization(method, signPath, query, headers, expires);
  const qs = canonicalQuery(query);
  const full = qs ? qs + "&" + signed.authorization : signed.authorization;
  return "https://" + hostFor() + urlPath + "?" + full;
}

export function presignPut(relativeKey, options) {
  const opts = options || {};
  const objectKey = toObjectKey(relativeKey);
  const method = "put";
  const url = presign(method, objectKey, { expires: opts.expires });
  return {
    key: relativeKey,
    objectKey: objectKey,
    url: url,
    method: "PUT",
    contentType: opts.contentType || mimeFor(relativeKey),
    publicUrl: publicUrl(objectKey),
  };
}

export function presignGet(relativeKey, options) {
  const opts = options || {};
  const objectKey = toObjectKey(relativeKey);
  const url = presign("get", objectKey, { expires: opts.expires || EXPIRES });
  return { key: relativeKey, objectKey: objectKey, url: url };
}

async function cosRequest(options) {
  if (!cosReady()) {
    const err = new Error("COS credentials are not configured");
    err.status = 503;
    throw err;
  }
  const method = (options.method || "get").toLowerCase();
  const key = options.key || "";
  const query = options.query || {};
  const headers = options.headers || {};
  const host = hostFor();
  const signPath = key ? "/" + key : "/";
  const urlPath = key ? "/" + encodeKey(key) : "/";
  const signedHeaders = Object.assign({ host: host }, headers);
  const signed = buildAuthorization(method, signPath, query, signedHeaders, options.expires);
  const qs = canonicalQuery(query);
  const url = "https://" + host + urlPath + (qs ? "?" + qs : "");
  const res = await fetch(url, {
    method: method.toUpperCase(),
    headers: Object.assign({ Authorization: signed.authorization }, headers),
    body: options.body,
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error("COS " + res.status + " " + res.statusText + ": " + text.slice(0, 800));
    err.status = res.status;
    throw err;
  }
  return { status: res.status, text: text };
}

function decodeXml(value) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, function (_m, n) { return String.fromCharCode(Number(n)); })
    .replace(/&amp;/g, "&");
}

function pick(xml, tag) {
  const match = xml.match(new RegExp("<" + tag + ">([\\s\\S]*?)</" + tag + ">"));
  return match ? decodeXml(match[1]) : "";
}

function parseList(xml) {
  const objects = [];
  const re = /<Contents>([\s\S]*?)<\/Contents>/g;
  let match;
  while ((match = re.exec(xml))) {
    const block = match[1];
    objects.push({
      key: pick(block, "Key"),
      size: parseInt(pick(block, "Size") || "0", 10),
      lastModified: pick(block, "LastModified"),
      etag: pick(block, "ETag"),
    });
  }
  return {
    objects: objects,
    truncated: pick(xml, "IsTruncated") === "true",
    nextMarker: pick(xml, "NextMarker"),
  };
}

export async function listObjects(prefix) {
  let marker = "";
  const out = [];
  for (;;) {
    const query = { "max-keys": "1000" };
    if (prefix) query.prefix = prefix;
    if (marker) query.marker = marker;
    const res = await cosRequest({ method: "get", query: query });
    const parsed = parseList(res.text);
    parsed.objects.forEach(function (o) { out.push(o); });
    if (!parsed.truncated || !parsed.nextMarker) break;
    marker = parsed.nextMarker;
  }
  return out;
}

export async function deleteObject(relativeKey) {
  const objectKey = toObjectKey(relativeKey);
  await cosRequest({ method: "delete", key: objectKey });
  return { key: relativeKey, objectKey: objectKey };
}

/*
 * Download an object into a Buffer. Used server-side (e.g. to fetch an
 * uploaded original before re-encoding it for preview).
 */
export async function getObjectBuffer(relativeKey) {
  const objectKey = toObjectKey(relativeKey);
  const signPath = objectKey ? "/" + objectKey : "/";
  const urlPath = objectKey ? "/" + encodeKey(objectKey) : "/";
  const signed = buildAuthorization("get", signPath, {}, { host: hostFor() }, EXPIRES);
  const url = "https://" + hostFor() + urlPath + "?" + signed.authorization;
  const res = await fetch(url, { method: "GET" });
  if (!res.ok) {
    const text = await res.text().catch(function () { return ""; });
    const err = new Error("COS GET " + res.status + ": " + text.slice(0, 400));
    err.status = res.status;
    throw err;
  }
  return Buffer.from(await res.arrayBuffer());
}

/*
 * Upload a Buffer to an object key using COS v5 signature. content-type is sent
 * as an unsigned header so it is stored without needing to be part of the
 * signed header list.
 */
export async function putObject(relativeKey, buffer, options) {
  const opts = options || {};
  const objectKey = toObjectKey(relativeKey);
  const contentType = opts.contentType || "application/octet-stream";
  await cosRequest({
    method: "put",
    key: objectKey,
    headers: { "content-type": contentType },
    body: buffer,
    expires: opts.expires,
  });
  return { key: relativeKey, objectKey: objectKey, contentType: contentType };
}

export function status() {
  const c = CONFIG.cos;
  return {
    ready: cosReady(),
    bucket: c.bucket,
    region: c.region,
    domain: c.domain,
    prefix: c.prefix,
  };
}
