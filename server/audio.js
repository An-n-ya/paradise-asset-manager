import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { CONFIG } from "./config.js";

/*
 * Server-side audio compression for cheap in-app preview.
 *
 * ffmpeg is resolved at runtime and is intentionally NOT a package dependency:
 * it is discovered via, in order:
 *   1. CONFIG.ffmpegPath (the FFMPEG_PATH env var)
 *   2. an optional "ffmpeg-static" package, if the operator installed it
 *   3. an "ffmpeg" binary on the system PATH
 *
 * When no binary can be found the compressor reports itself unavailable and
 * callers degrade gracefully to previewing the original object.
 */

export const PREVIEW_EXT = ".mp3";
export const PREVIEW_MIME = "audio/mpeg";

const PREVIEW_BITRATE = "128k";

let cachedBinary = undefined;
let availabilityCache = undefined;

async function tryFfmpegStatic() {
  try {
    const mod = await import("ffmpeg-static");
    const value = typeof mod.default === "function" ? mod.default() : mod.default;
    if (typeof value === "string" && value) return value;
  } catch (e) {
    // optional dependency not installed
  }
  return "";
}

/*
 * Resolve an ffmpeg command to invoke. Returns "" when none is available.
 */
export async function resolveFfmpeg() {
  if (cachedBinary !== undefined) return cachedBinary;

  const explicit = CONFIG.ffmpegPath;
  if (explicit) {
    cachedBinary = existsSync(explicit) ? explicit : "";
    return cachedBinary;
  }

  const fromStatic = await tryFfmpegStatic();
  if (fromStatic) {
    cachedBinary = existsSync(fromStatic) ? fromStatic : "";
    return cachedBinary;
  }

  // Fall back to whatever is on PATH; validity is confirmed by the caller
  // (which treats a spawn error as "unavailable").
  cachedBinary = whichFfmpeg();
  return cachedBinary;
}

function whichFfmpeg() {
  // spawn() resolves a bare command name through PATH, so "ffmpeg" is enough
  // when it is installed system-wide. We cannot stat PATH entries portably
  // here, so trust the spawn attempt to fail cleanly if it is missing.
  return process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
}

export async function ffmpegAvailable() {
  const bin = await resolveFfmpeg();
  if (!bin) return false;
  if (availabilityCache !== undefined) return availabilityCache;
  availabilityCache = await probe(bin);
  return availabilityCache;
}

// Confirm the resolved binary actually runs (needed for the bare PATH fallback
// command, which cannot be stat'd). Cached after the first successful probe.
function probe(bin) {
  return new Promise(function (resolve) {
    let child;
    try {
      child = spawn(bin, ["-version"], { stdio: "ignore" });
    } catch (e) {
      resolve(false);
      return;
    }
    child.on("error", function () { resolve(false); });
    child.on("close", function (code) { resolve(code === 0); });
  });
}

/*
 * Compress a raw audio buffer to a small mp3 for preview. Returns the encoded
 * buffer. Throws if ffmpeg is unavailable or fails.
 */
export function compressAudio(input) {
  return resolveFfmpeg().then(function (bin) {
    if (!bin) {
      const err = new Error("ffmpeg is not available on the server");
      err.status = 501;
      throw err;
    }
    return runffmpeg(bin, input);
  });
}

function runffmpeg(bin, input) {
  return new Promise(function (resolve, reject) {
    const args = [
      "-i", "pipe:0",
      "-vn",
      "-ac", "1",
      "-b:a", PREVIEW_BITRATE,
      "-f", "mp3",
      "pipe:1",
    ];
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    const chunks = [];
    let stderr = "";
    let settled = false;

    const fail = function (err) {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch (e) {}
      reject(err);
    };

    child.stdout.on("data", function (c) { chunks.push(c); });
    child.stderr.on("data", function (c) {
      stderr += c.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    child.on("error", function (err) {
      fail(new Error("failed to spawn ffmpeg: " + err.message));
    });
    child.on("close", function (code) {
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolve(Buffer.concat(chunks));
      } else {
        const err = new Error("ffmpeg exited with code " + code + ": " + stderr.slice(-400));
        err.status = 502;
        reject(err);
      }
    });

    child.on("disconnected", function () {});
    child.stdin.on("error", function () {
      // EPIPE if ffmpeg exits early; the "close" handler reports the real error.
    });

    child.stdin.end(input);
  });
}

/*
 * Derive the object key for the compressed preview variant of an original key.
 * The preview always lives beside the original and keeps its own suffix so the
 * original is never overwritten, even when the original is itself an mp3.
 *
 *   audio/bgm/foo.ogg  ->  audio/bgm/foo.preview.mp3
 */
export function previewKeyFor(relativeKey) {
  const key = String(relativeKey || "").replace(/^\/+/, "");
  const slash = key.lastIndexOf("/");
  const dir = slash === -1 ? "" : key.slice(0, slash + 1);
  const base = slash === -1 ? key : key.slice(slash + 1);
  const dot = base.lastIndexOf(".");
  const stem = dot === -1 ? base : base.slice(0, dot);
  return dir + stem + ".preview" + PREVIEW_EXT;
}
