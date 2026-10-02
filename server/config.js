import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

function loadDotEnv(file) {
  if (!existsSync(file)) return;
  const text = readFileSync(file, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv(resolve(process.cwd(), ".env"));

export const CONFIG = {
  port: Number(process.env.PORT || 8787),
  host: process.env.HOST || "127.0.0.1",
  dbPath: process.env.DB_PATH || "./data/assets.db",
  scriptPath: process.env.SCRIPT_PATH || "./data/script.rpy",
  scriptSource: process.env.SCRIPT_SOURCE || "",
  scriptDocPath: process.env.SCRIPT_DOC_PATH || "./data/script-doc.json",
  rosterPath: process.env.ROSTER_PATH || "./data/roster.json",
  cos: {
    secretId: process.env.COS_SECRET_ID || "",
    secretKey: process.env.COS_SECRET_KEY || "",
    bucket: process.env.COS_BUCKET || "",
    region: process.env.COS_REGION || "ap-nanjing",
    domain: (process.env.COS_DOMAIN || "").replace(/\/+$/, ""),
    prefix: process.env.COS_PREFIX || "",
  },
};

export function cosReady() {
  const c = CONFIG.cos;
  return Boolean(c.secretId && c.secretKey && c.bucket && c.region);
}
