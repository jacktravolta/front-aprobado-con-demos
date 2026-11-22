// api/server.mjs — own Node API for the static front.
//
// Responsibilities:
//   - Serve the static front from ../front (same origin, no CORS).
//   - Persist config, generated-file metadata and front records as plain JSON.
//   - Be the ONLY component that talks to meta-api (http://127.0.0.1:8055).
//   - Force meta-api fileStorage=local, download the generated ZIP, store the
//     bytes locally and hand the front a same-origin /api/files/... URL.
//
// Node built-ins only. No npm dependencies.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  classifyKind,
  extractZipSafely,
  isZipBuffer,
  mimeForName,
} from "./media.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const FRONT_DIR = path.join(ROOT, "front");
const DATA_DIR = path.resolve(process.env.API_DATA_DIR || path.join(HERE, "data"));
const STORAGE_DIR = path.resolve(
  process.env.API_STORAGE_DIR || path.join(HERE, "storage", "files"),
);
const CONFIG_PATH = path.join(DATA_DIR, "config.json");
const RECORDS_PATH = path.join(DATA_DIR, "records.json");
const FILES_PATH = path.join(DATA_DIR, "files.json");
const OWNER_PATH = path.join(DATA_DIR, "owner.json");

const DEFAULTS = {
  baseUrl: "http://127.0.0.1:8055",
  model: "meta-ai",
  forceZip: true,
  useLocalFiles: true,
  allowExternalBaseUrl: false,
};

// Budgets: the provider is trusted, but a runaway response or a zip bomb must
// not take the local machine down.
const MAX_UPSTREAM_TEXT_BYTES = 32 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 2000;
const MAX_ZIP_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;

const DELIVERY_RULES = [
  "",
  "---",
  "REGLAS DE ENTREGA (no negociables):",
  "1. Genera TODOS los archivos solicitados: imagenes, videos, audio, subtitulos SRT/VTT, documentos y cualquier otro recurso multimedia.",
  "2. Publica cada archivo generado como un enlace markdown con su nombre exacto: [nombre.ext](url de descarga directa al archivo).",
  "3. Pon la lista completa de enlaces al FINAL del mensaje, una linea por archivo, para que la entrega no se corte.",
  "4. No respondas solo con texto ni con un enlace a un documento de Meta: la entrega debe incluir los archivos generados.",
].join("\n");

const IMPROVE_SYSTEM_TEXT = [
  "Eres un editor profesional. Tu unica tarea es mejorar el texto que recibes.",
  "",
  "Reglas obligatorias:",
  "- Devuelve unicamente el texto final mejorado.",
  "- No agregues explicaciones, comentarios, saludos, titulos, prefijos, etiquetas, markdown ni comillas.",
  '- No escribas frases como "Aqui esta el texto mejorado" ni "Texto mejorado:".',
  "- No inventes datos ni cambies el significado.",
  "- Conserva el idioma, el tono y los hechos del original.",
  "- Corrige ortografia, gramatica, claridad y precision.",
  "- Si el texto ya es claro, aplica mejoras minimas.",
].join("\n");

const IMPROVE_SYSTEM_PROMPT = [
  "Eres un experto en ingenieria de prompts. Tu unica tarea es mejorar el prompt que recibes.",
  "",
  "Reglas obligatorias:",
  "- Devuelve unicamente el prompt final mejorado.",
  "- No ejecutes el prompt. No respondas a la tarea que describe. Solo reescribelo.",
  "- No agregues explicaciones, comentarios, saludos, titulos, prefijos, etiquetas, markdown ni comillas.",
  '- No escribas frases como "Aqui esta el prompt mejorado" ni "Prompt mejorado:".',
  "- No cambies la intencion, el objetivo ni las restricciones del prompt original.",
  "- Hazlo mas claro, especifico, estructurado y accionable.",
  "- Conserva el idioma original.",
  "- No inventes requisitos nuevos.",
  "- Si el prompt ya es claro, aplica mejoras minimas.",
].join("\n");

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

function ensureDirs() {
  for (const dir of [DATA_DIR, STORAGE_DIR]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

function writeJsonAtomic(file, data, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
  fs.chmodSync(file, mode);
}

function readJson(file, fallback) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return fallback;
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    // A corrupted store must never be silently replaced by an empty one: the
    // file is quarantined so the data can still be recovered by hand.
    const quarantine = `${file}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(file, quarantine);
      console.error(
        `[api] ${path.basename(file)} corrupto (${String(error?.message || error)}): movido a ${path.basename(quarantine)}`,
      );
    } catch {
      console.error(`[api] ${path.basename(file)} corrupto y no se pudo aislar`);
    }
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Host / origin validation
// ---------------------------------------------------------------------------

function isLoopbackHost(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  return (
    host === "localhost" ||
    host === "::1" ||
    host === "0.0.0.0" ||
    /^127\./.test(host) ||
    host.endsWith(".localhost")
  );
}

// The bind address is different from the destination host: 0.0.0.0 means
// "every interface", so it exposes the API to the network.
function isLoopbackBind(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "0.0.0.0" || host === "::" || host === "*" || host === "") return false;
  return isLoopbackHost(host);
}

function isPrivateHost(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (isLoopbackHost(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  if (host.endsWith(".local") || host.endsWith(".internal")) return true;
  return false;
}

// The provider is reached from the server, so an unrestricted baseUrl turns
// this API into a proxy that can leak the stored key to any host.
function validateBaseUrl(baseUrl, { allowExternal = false } = {}) {
  const raw = String(baseUrl || "").trim();
  if (!/^https?:\/\/[^\s]+$/i.test(raw)) {
    return { ok: false, error: "baseUrl invalida (usa http(s)://...)" };
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: "baseUrl invalida" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: "baseUrl debe usar http o https" };
  }
  if (url.username || url.password) {
    return { ok: false, error: "baseUrl no puede incluir usuario ni clave" };
  }
  if (!isPrivateHost(url.hostname) && !allowExternal) {
    return {
      ok: false,
      error: `baseUrl debe apuntar a un host local o privado (${url.hostname}). Para usar un proveedor externo, habilitalo en el backend: "allowExternalBaseUrl": true en api/data/config.json o ALLOW_EXTERNAL_BASE_URL=1.`,
    };
  }
  return { ok: true, url: raw.replace(/\/+$/, "") };
}

// The front is same-origin: a browser page from another site must not be able
// to drive this API. Requests without an Origin header (curl, local scripts)
// are allowed because the API is bound to loopback and a local process can
// already read the stored key. Extra origins (front served elsewhere) are
// declared in the backend with ALLOWED_ORIGINS.
function checkOrigin(req) {
  const origin = String(req.headers.origin || "").trim();
  if (!origin) return { ok: true };
  if (origin === "null") {
    return { ok: false, error: "origen no permitido" };
  }
  const host = String(req.headers.host || "").trim();
  if (!host) return { ok: false, error: "Host ausente" };
  const allowed = new Set([`http://${host}`, `https://${host}`]);
  for (const extra of String(process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    allowed.add(extra.replace(/\/+$/, ""));
  }
  if (!allowed.has(origin)) {
    return { ok: false, error: `origen no permitido (${origin})` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Config (never return the key)
// ---------------------------------------------------------------------------

function readConfigFile() {
  ensureDirs();
  const raw = readJson(CONFIG_PATH, {});
  const allowExternal =
    typeof raw.allowExternalBaseUrl === "boolean"
      ? raw.allowExternalBaseUrl
      : DEFAULTS.allowExternalBaseUrl;
  const storedBaseUrl =
    typeof raw.baseUrl === "string" && raw.baseUrl.trim()
      ? raw.baseUrl.trim().replace(/\/+$/, "")
      : DEFAULTS.baseUrl;
  // The stored value is validated on read too: a file edited by hand (or
  // written by another process) must not be able to point the API anywhere.
  const check = validateBaseUrl(storedBaseUrl, { allowExternal });
  if (!check.ok) {
    console.error(
      `[api] baseUrl guardado no permitido ("${storedBaseUrl}"): ${check.error}. Se usa el valor por defecto.`,
    );
  }
  return {
    baseUrl: check.ok ? check.url : DEFAULTS.baseUrl,
    apiKey: typeof raw.apiKey === "string" ? raw.apiKey : "",
    model:
      typeof raw.model === "string" && raw.model.trim()
        ? raw.model.trim()
        : DEFAULTS.model,
    forceZip: typeof raw.forceZip === "boolean" ? raw.forceZip : DEFAULTS.forceZip,
    useLocalFiles:
      typeof raw.useLocalFiles === "boolean" ? raw.useLocalFiles : DEFAULTS.useLocalFiles,
    allowExternalBaseUrl: allowExternal,
  };
}

function readConfig() {
  const cfg = readConfigFile();
  // ALLOW_EXTERNAL_BASE_URL is a decision of the running process: it applies
  // here and is never persisted into the store.
  if (process.env.ALLOW_EXTERNAL_BASE_URL === "1") cfg.allowExternalBaseUrl = true;
  return cfg;
}

function writeConfig(cfg) {
  ensureDirs();
  const current = readConfigFile();
  writeJsonAtomic(
    CONFIG_PATH,
    { ...cfg, allowExternalBaseUrl: current.allowExternalBaseUrl },
    0o600,
  );
}

function publicConfig(cfg) {
  return {
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    hasKey: !!cfg.apiKey,
    forceZip: cfg.forceZip,
    useLocalFiles: cfg.useLocalFiles,
    allowExternalBaseUrl: cfg.allowExternalBaseUrl,
  };
}

// Accept baseUrl with or without a trailing /v1.
function metaRoot(baseUrl) {
  let root = String(baseUrl || DEFAULTS.baseUrl).trim().replace(/\/+$/, "");
  root = root.replace(/\/v1$/i, "");
  return root;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

const SESSION_ID_RE = /^[A-Za-z0-9_-]{16,128}$/;
const OWNER_SESSION = SESSION_ID_RE.test(process.env.OWNER_SESSION || "")
  ? process.env.OWNER_SESSION
  : "";

function sessionIdFromRequest(req) {
  for (const part of String(req.headers.cookie || "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== "sid") continue;
    let value;
    try {
      value = decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      continue;
    }
    if (SESSION_ID_RE.test(value)) return value;
  }
  return null;
}

function ensureSession(req, res) {
  let sessionId = sessionIdFromRequest(req);
  if (!sessionId) {
    sessionId = crypto.randomUUID();
    res.setHeader("set-cookie", `sid=${sessionId}; Path=/; HttpOnly; SameSite=Strict`);
  }
  // A pinned operator session overrides the cookie for ownership only.
  req.sessionId = OWNER_SESSION || sessionId;
}

function readBody(req, maxBytes = 80 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("cuerpo demasiado grande"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function truncate(text, max = 4000) {
  const s = String(text || "");
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

// Removes the wrappers models like to add around an improved text/prompt.
function cleanImprovedText(raw) {
  let text = String(raw || "").trim();
  if (!text) return "";

  text = text
    .replace(/^```[a-zA-Z0-9_-]*\s*\n?/, "")
    .replace(/\n?```\s*$/, "")
    .trim();

  const prefixes = [
    /^aqu[ií]\s+(?:est[aá]|tienes)\s+(?:el|la)\s+(?:texto|prompt)\s+(?:mejorad[oa]|final)\s*:?\s*/i,
    /^(?:texto|prompt)\s+(?:mejorad[oa]|final)\s*:?\s*/i,
    /^(?:resultado|respuesta)\s*:?\s*/i,
    /^(?:claro|por supuesto)[,.]?\s*/i,
  ];
  for (const prefix of prefixes) text = text.replace(prefix, "").trim();

  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'")) ||
    (text.startsWith("`") && text.endsWith("`"))
  ) {
    text = text.slice(1, -1).trim();
  }

  return text;
}

// meta-api exposes every materialized file under /v1/media. The path can arrive
// as `url` (meta_files/meta_zip) or as `local` (meta_images).
function mediaPathOf(file) {
  const local = String(file?.local || "").trim();
  if (local.startsWith("/v1/media/")) return local;
  const url = String(file?.url || "").trim();
  if (url.startsWith("/v1/media/")) return url;
  return null;
}

// Maps the CDN links written in the assistant answer to the file label the
// model used, so stored files keep a human readable name.
function nameMapFromContent(content) {
  const map = new Map();
  const text = String(content || "");
  const re = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  const looksLikeFile = (value) => /\.[A-Za-z0-9]{2,5}$/.test(value);
  let match;
  while ((match = re.exec(text)) !== null) {
    const label = match[1].trim();
    if (!label) continue;
    const current = map.get(match[2]);
    if (!current) {
      map.set(match[2], label);
      continue;
    }
    // A generic alt text like "imagen" must not replace a real file name.
    if (looksLikeFile(label) && !looksLikeFile(current)) {
      map.set(match[2], label);
    }
  }
  return map;
}

// meta-api delivers the files of a channel once: on the next turn the same
// names are reported as "pendientes". /v1/chat/clear keeps the channel id but
// opens a fresh meta conversation, so an explicit "Implementar" always gets
// freshly materialized artifacts.
async function clearMetaChannel(cfg, req, user, project) {
  if (!user && !project) {
    return { ok: false, error: "falta user o project para limpiar el canal" };
  }
  const root = metaRoot(cfg.baseUrl);
  const response = await fetchJson(
    `${root}/v1/chat/clear`,
    {
      method: "POST",
      headers: metaHeaders(cfg, req, { "content-type": "application/json" }),
      body: JSON.stringify({ user, project }),
    },
    30000,
  );
  if (!response.ok) {
    return {
      ok: false,
      error: `meta-api no pudo limpiar el canal (${response.status || "sin conexion"})`,
      detail: truncate(response.text, 1000),
    };
  }
  return {
    ok: true,
    canal: response.json?.canal || null,
    generacion: response.json?.generacion ?? null,
  };
}

// Downloads a file published directly by Meta (the answer contains the links
// when meta-api could not materialize the artifact in its own sandbox).
const MAX_ARTIFACT_BYTES = 150 * 1024 * 1024;

async function fetchRemoteArtifact(url, { timeoutMs = 300000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { "user-agent": "Mozilla/5.0" },
      signal: ctrl.signal,
    });
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}` };
    }
    const mime = String(response.headers.get("content-type") || "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    const declared = Number(response.headers.get("content-length") || 0);
    if (declared && declared > MAX_ARTIFACT_BYTES) {
      return { ok: false, error: `archivo demasiado grande (${declared} bytes)` };
    }
    const chunks = [];
    let total = 0;
    for await (const chunk of response.body) {
      total += chunk.length;
      if (total > MAX_ARTIFACT_BYTES) {
        return { ok: false, error: "archivo demasiado grande" };
      }
      chunks.push(Buffer.from(chunk));
    }
    const buf = Buffer.concat(chunks);
    if (!buf.length) return { ok: false, error: "archivo vacio" };
    return { ok: true, buf, mime: mime || "application/octet-stream" };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  } finally {
    clearTimeout(timer);
  }
}

// Extracts the file links that Meta publishes inside the answer.
function linksFromContent(content) {
  const text = String(content || "");
  const links = [];
  const seen = new Set();
  const push = (label, url) => {
    const clean = String(url || "").trim();
    if (!/^https?:\/\//i.test(clean) || seen.has(clean)) return;
    seen.add(clean);
    const cleanLabel = String(label || "").trim();
    links.push({
      label: cleanLabel,
      url: clean,
      name: path.basename(cleanLabel || clean.split(/[?#]/)[0].split("/").pop() || ""),
    });
  };

  // Markdown links: [nombre del archivo](url)
  const markdown = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;
  let match;
  while ((match = markdown.exec(text)) !== null) push(match[1], match[2]);

  // Bare urls: some turns announce the files without the markdown wrapper.
  const bare = /(?<!\]\()\b(https?:\/\/[^\s)"'<>]+)/g;
  while ((match = bare.exec(text)) !== null) push("", match[1]);

  return links;
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Reads an upstream body with a hard cap: a provider that streams forever
// must not be able to exhaust the memory of the local API.
async function readUpstreamBody(response, maxBytes) {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared && declared > maxBytes) {
    return { ok: false, error: `respuesta demasiado grande (${declared} bytes)`, text: "" };
  }
  if (!response.body) {
    const text = await response.text();
    if (text.length > maxBytes) {
      return { ok: false, error: "respuesta demasiado grande", text: "" };
    }
    return { ok: true, text };
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > maxBytes) {
      return { ok: false, error: "respuesta demasiado grande", text: "" };
    }
    chunks.push(Buffer.from(chunk));
  }
  return { ok: true, text: Buffer.concat(chunks).toString("utf8") };
}

async function fetchJson(url, opts = {}, timeoutMs = 8000) {
  try {
    const r = await fetchWithTimeout(url, opts, timeoutMs);
    const body = await readUpstreamBody(r, MAX_UPSTREAM_TEXT_BYTES);
    if (!body.ok) {
      return {
        status: r.status,
        ok: false,
        text: body.error,
        json: null,
        headers: r.headers,
      };
    }
    const text = body.text;
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: r.status, ok: r.ok, text, json, headers: r.headers };
  } catch (err) {
    return {
      status: 0,
      ok: false,
      text: String(err?.message || err),
      json: null,
      headers: null,
    };
  }
}

async function fetchBuffer(url, opts = {}, timeoutMs = 180000) {
  try {
    const r = await fetchWithTimeout(url, opts, timeoutMs);
    const buf = Buffer.from(await r.arrayBuffer());
    return { status: r.status, ok: r.ok, buf, headers: r.headers, text: "" };
  } catch (err) {
    return {
      status: 0,
      ok: false,
      buf: Buffer.alloc(0),
      headers: null,
      text: String(err?.message || err),
    };
  }
}

// Key precedence: X-API-Key from the front (optional) > stored config key.
function metaHeaders(cfg, req, extra = {}) {
  const headers = { ...extra };
  const fromFront = req ? String(req.headers["x-api-key"] || "").trim() : "";
  const key = fromFront || cfg.apiKey;
  if (key) headers.authorization = `Bearer ${key}`;
  return headers;
}

// ---------------------------------------------------------------------------
// meta-api: force local file storage
// ---------------------------------------------------------------------------

// Last known original value, restored on graceful shutdown.
let originalFileStorage = null;
let fileStorageRestored = false;

async function ensureLocalFileStorage(cfg, req) {
  if (!cfg.useLocalFiles) return { ok: true, changed: false };
  const root = metaRoot(cfg.baseUrl);

  const current = await fetchJson(
    `${root}/v1/ajustes`,
    { headers: metaHeaders(cfg, req) },
    8000,
  );
  if (current.status === 401 || current.status === 403) {
    return {
      ok: false,
      auth: true,
      message:
        "meta-api rechazo la autenticacion al leer /v1/ajustes. Revisa la API key en la configuracion.",
      detail: truncate(current.text, 2000),
    };
  }
  if (!current.ok) {
    return {
      ok: false,
      message: `No se pudo leer /v1/ajustes de meta-api (${current.status || "sin conexion"}).`,
      detail: truncate(current.text, 2000),
    };
  }

  const previous = current.json?.fileStorage;
  if (originalFileStorage === null && typeof previous === "string") {
    originalFileStorage = previous;
  }
  if (previous === "local") return { ok: true, changed: false };

  const saved = await fetchJson(
    `${root}/v1/ajustes`,
    {
      method: "PUT",
      headers: metaHeaders(cfg, req, { "content-type": "application/json" }),
      body: JSON.stringify({ fileStorage: "local" }),
    },
    8000,
  );
  if (saved.status === 401 || saved.status === 403) {
    return {
      ok: false,
      auth: true,
      message:
        "meta-api rechazo la autenticacion al cambiar fileStorage a local. Revisa la API key.",
      detail: truncate(saved.text, 2000),
    };
  }
  if (!saved.ok) {
    return {
      ok: false,
      message: `No se pudo poner fileStorage=local en meta-api (${saved.status}).`,
      detail: truncate(saved.text, 2000),
    };
  }
  return { ok: true, changed: true, previous };
}

async function restoreFileStorage() {
  if (originalFileStorage === null || fileStorageRestored) return;
  fileStorageRestored = true;
  const cfg = readConfig();
  const root = metaRoot(cfg.baseUrl);
  const r = await fetchJson(
    `${root}/v1/ajustes`,
    {
      method: "PUT",
      headers: metaHeaders(cfg, null, { "content-type": "application/json" }),
      body: JSON.stringify({ fileStorage: originalFileStorage }),
    },
    5000,
  );
  if (!r.ok) {
    console.error(
      `[api] no se pudo restaurar fileStorage=${originalFileStorage}: ${r.status} ${truncate(r.text, 300)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Generated file metadata (plain JSON)
// ---------------------------------------------------------------------------

function recordPrimaryOwner(owner) {
  const current = readJson(OWNER_PATH, {});
  const primary = String(current?.primary || "");
  if (primary === owner) return;
  const files = readJson(FILES_PATH, { files: [] });
  const records = readJson(RECORDS_PATH, { records: [] });
  const primaryOwns =
    (Array.isArray(files?.files) && files.files.some((entry) => entry.owner === primary)) ||
    (Array.isArray(records?.records) && records.records.some((entry) => entry.owner === primary));
  if (primary && primaryOwns) return;
  writeJsonAtomic(OWNER_PATH, { primary: owner }, 0o600);
}

function readOwnedEntries(file, key, owner) {
  const data = readJson(file, { [key]: [] });
  const entries = Array.isArray(data?.[key]) ? data[key] : [];
  if (!owner) return entries;
  let changed = false;
  for (const entry of entries) {
    if (!entry.owner) {
      entry.owner = owner;
      changed = true;
    }
  }
  if (changed) {
    writeJsonAtomic(file, { [key]: entries }, 0o600);
    recordPrimaryOwner(owner);
  }
  return entries.filter((entry) => entry.owner === owner);
}

function writeOwnedEntries(file, key, entries, owner) {
  const data = readJson(file, { [key]: [] });
  const all = Array.isArray(data?.[key]) ? data[key] : [];
  const replacements = new Map(entries.map((entry) => [entry.id, entry]));
  const known = new Set(all.map((entry) => entry.id));
  const next = [];
  for (const entry of all) {
    if (entry.owner !== owner) {
      next.push(entry);
    } else if (replacements.has(entry.id)) {
      next.push(replacements.get(entry.id));
    }
  }
  for (const entry of entries) {
    if (!known.has(entry.id)) next.push(entry);
  }
  writeJsonAtomic(file, { [key]: next }, 0o600);
}

function readFiles(owner) {
  return readOwnedEntries(FILES_PATH, "files", owner);
}

function writeFiles(files, owner) {
  writeOwnedEntries(FILES_PATH, "files", files, owner);
}

function appendFileMeta(meta, owner) {
  const files = readFiles(owner);
  files.push({ ...meta, owner });
  writeFiles(files, owner);
}

function safeFileName(name, fallback = "resultado.zip") {
  let n = path.basename(String(name || "").replace(/\\/g, "/"));
  n = n.replace(/[^\p{L}\p{N}._\-+ ()]/gu, "_").trim();
  if (!n || n === "." || n === "..") n = fallback;
  return n.slice(0, 180);
}

// ---------------------------------------------------------------------------
// Records (plain JSON, single file)
// ---------------------------------------------------------------------------

function readRecords(owner) {
  return readOwnedEntries(RECORDS_PATH, "records", owner);
}

function writeRecords(records, owner) {
  writeOwnedEntries(RECORDS_PATH, "records", records, owner);
}

async function handleAction(req, res, body) {
  let payload;
  try {
    payload = JSON.parse(body || "{}");
  } catch {
    return sendJson(res, 400, { error: "JSON invalido" });
  }

  const action = String(payload.action || "");
  const args = payload.args && typeof payload.args === "object" ? payload.args : {};
  const owner = req.sessionId;
  const records = readRecords(owner);

  if (action === "records.list") {
    const collection = args.collection ? String(args.collection) : "";
    const list = collection
      ? records.filter((r) => r.collection === collection)
      : records;
    return sendJson(res, 200, { data: { records: list } });
  }

  if (action === "records.create") {
    const collection = String(args.collection || "").trim();
    if (!collection) {
      return sendJson(res, 400, { error: "records.create requiere collection" });
    }
    const value =
      args.value && typeof args.value === "object" && !Array.isArray(args.value)
        ? args.value
        : {};
    const idempotencyKey = args.idempotency_key
      ? String(args.idempotency_key)
      : "";

    if (idempotencyKey) {
      const existing = records.find(
        (r) => r.idempotency_key === idempotencyKey,
      );
      if (existing) return sendJson(res, 200, { data: { record: existing } });
    }

    const record = {
      id: crypto.randomUUID(),
      collection,
      value,
      created_at: new Date().toISOString(),
      owner,
    };
    if (idempotencyKey) record.idempotency_key = idempotencyKey;
    records.push(record);
    writeRecords(records, owner);
    return sendJson(res, 200, { data: { record } });
  }

  if (action === "records.delete") {
    const collection = String(args.collection || "").trim();
    const id = String(args.id || "");
    const index = records.findIndex(
      (r) => r.collection === collection && r.id === id,
    );
    if (index === -1) {
      return sendJson(res, 200, { data: { ok: true, deleted: 0 } });
    }
    records.splice(index, 1);
    writeRecords(records, owner);
    return sendJson(res, 200, { data: { ok: true, deleted: 1 } });
  }

  return sendJson(res, 400, { error: `accion no soportada: ${action || "(vacia)"}` });
}

// ---------------------------------------------------------------------------
// API handlers
// ---------------------------------------------------------------------------

async function handleHealth(req, res) {
  const cfg = readConfig();
  const root = metaRoot(cfg.baseUrl);
  const out = {
    ok: false,
    baseUrl: cfg.baseUrl,
    hasKey: !!cfg.apiKey,
    metaApiStatus: {
      health: null,
      models: null,
    },
  };

  const health = await fetchJson(
    `${root}/health`,
    { headers: metaHeaders(cfg, req) },
    5000,
  );
  out.metaApiStatus.health = { ok: health.ok, status: health.status };
  if (!health.ok) {
    out.error = `meta-api /health no respondio correctamente (${health.status || "sin conexion"})`;
    return sendJson(res, 502, out);
  }

  const models = await fetchJson(
    `${root}/v1/models`,
    { headers: metaHeaders(cfg, req) },
    5000,
  );
  out.metaApiStatus.models = { ok: models.ok, status: models.status };
  if (!models.ok) {
    out.error =
      models.status === 401 || models.status === 403
        ? "meta-api rechazo la autenticacion en /v1/models. Revisa la API key."
        : `meta-api /v1/models no respondio correctamente (${models.status || "sin conexion"})`;
    return sendJson(res, 502, out);
  }

  out.ok = true;
  out.models = Array.isArray(models.json?.data)
    ? models.json.data.map((m) => m.id).filter(Boolean)
    : [];
  return sendJson(res, 200, out);
}

function attachmentMime(att) {
  const explicit = String(att?.mime || "").trim();
  if (explicit) return explicit;
  const match = /^data:([^;,]+)[;,]/.exec(String(att?.dataUrl || ""));
  return match ? match[1] : "application/octet-stream";
}

function attachmentPart(att) {
  const mime = attachmentMime(att);
  const url = String(att.dataUrl || "");
  if (/^image\//i.test(mime)) {
    return { type: "image_url", image_url: { url } };
  }
  if (/^video\//i.test(mime)) {
    return { type: "video_url", video_url: { url } };
  }
  return { type: "document_url", document_url: { url } };
}

// Improves either a text field (mode=text) or a prompt (mode=prompt).
// meta-api must answer with the final result only: no comments, no wrappers.
async function handleImprove(req, res) {
  let body;
  try {
    body = JSON.parse((await readBody(req, 8 * 1024 * 1024)) || "{}");
  } catch {
    return sendJson(res, 400, { ok: false, error: "JSON invalido" });
  }

  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) {
    return sendJson(res, 400, { ok: false, error: "falta text" });
  }

  const mode = body.mode === "prompt" ? "prompt" : "text";
  const cfg = readConfig();
  const root = metaRoot(cfg.baseUrl);
  const system = mode === "prompt" ? IMPROVE_SYSTEM_PROMPT : IMPROVE_SYSTEM_TEXT;
  const user =
    mode === "prompt"
      ? `Prompt original:\n"""\n${text}\n"""\n\nDevuelve solo el prompt mejorado.`
      : `Texto original:\n"""\n${text}\n"""\n\nDevuelve solo la version mejorada.`;

  const payload = {
    model: cfg.model,
    user: String(body.user || "front-aprobado"),
    project: String(body.project || ""),
    channel: String(body.channel || "front"),
    title: `mejorar-${mode}`,
    temperature: 0.2,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };

  const response = await fetchJson(
    `${root}/v1/chat/completions`,
    {
      method: "POST",
      headers: metaHeaders(cfg, req, { "content-type": "application/json" }),
      body: JSON.stringify(payload),
    },
    120000,
  );

  if (response.status === 401 || response.status === 403) {
    return sendJson(res, 401, {
      ok: false,
      error:
        "meta-api rechazo la autenticacion. Revisa la API key en la configuracion.",
      detail: truncate(response.text, 2000),
    });
  }
  if (!response.ok) {
    return sendJson(res, 502, {
      ok: false,
      error: `meta-api respondio ${response.status || "sin conexion"}.`,
      detail: truncate(response.text, 4000),
    });
  }

  const content = response.json?.choices?.[0]?.message?.content;
  const cleaned = cleanImprovedText(typeof content === "string" ? content : "");
  if (!cleaned) {
    return sendJson(res, 502, {
      ok: false,
      error: "meta-api no devolvio texto mejorado.",
      detail: truncate(response.text, 4000),
    });
  }

  return sendJson(res, 200, { ok: true, mode, text: cleaned });
}

async function handleChat(req, res) {
  const owner = req.sessionId;
  let body;
  try {
    body = JSON.parse((await readBody(req)) || "{}");
  } catch {
    return sendJson(res, 400, { ok: false, error: "JSON invalido" });
  }

  const text = typeof body.text === "string" ? body.text.trim() : "";
  const attachment =
    body.attachment && typeof body.attachment === "object"
      ? body.attachment
      : null;

  if (!text && !attachment) {
    return sendJson(res, 400, {
      ok: false,
      error: "falta text o attachment",
    });
  }
  if (attachment && !/^data:/i.test(String(attachment.dataUrl || ""))) {
    return sendJson(res, 400, {
      ok: false,
      error: "attachment.dataUrl debe ser una data URL",
    });
  }

  const cfg = readConfig();
  const root = metaRoot(cfg.baseUrl);
  const warnings = [];

  const prep = await ensureLocalFileStorage(cfg, req);
  if (!prep.ok) {
    return sendJson(res, prep.auth ? 401 : 502, {
      ok: false,
      error: prep.message,
      ...(prep.detail ? { detail: prep.detail } : {}),
    });
  }

  const user = String(body.user || "front-aprobado");
  const project = String(body.project || "");

  // "Implementar" asks for a fresh delivery: meta-api only materializes the
  // artifacts once per channel, so the channel is cleared first.
  if (body.fresh === true || body.clear === true) {
    const cleared = await clearMetaChannel(cfg, req, user, project);
    if (!cleared.ok) {
      warnings.push({
        error: cleared.error,
        detail: cleared.detail || null,
      });
    }
  }

  const baseText =
    text ||
    "Procesa el archivo adjunto y entrega el resultado solicitado en un ZIP.";
  const zipRule = cfg.forceZip
    ? "5. Crea tambien un archivo ZIP llamado exactamente resultado.zip que contenga TODOS los archivos generados."
    : "5. El ZIP es opcional: prioriza devolver cada archivo individual.";

  const timeoutMs = Number(process.env.CHAT_TIMEOUT_MS || 600000);
  const attempts = Math.max(1, Math.min(3, Number(body.attempts || 2)));

  let stored = [];
  let answerText = "";
  let conversationId = null;
  let lastError = "meta-api no devolvio archivos descargables.";
  let lastDetail = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1) {
      warnings.push({
        error: `intento ${attempt - 1} sin archivos descargables; reintentando`,
      });
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    stored = [];

    // A retry asks Meta only for the links: the first turn is sometimes cut
    // off right before the download section.
    const retryHint =
      attempt > 1
        ? "\n\nIMPORTANTE: publica AHORA los enlaces de descarga de todos los archivos que generaste, uno por linea, con el formato [nombre.ext](url de descarga directa). No repitas el texto del guion."
        : "";
    const prompt = `${baseText}\n${DELIVERY_RULES}\n${zipRule}${retryHint}`;

    const content = [{ type: "text", text: prompt }];
    if (attachment) content.push(attachmentPart(attachment));

    const payload = {
      model: cfg.model,
      user,
      project,
      channel: String(body.channel || "front"),
      title: String(body.title || body.module || ""),
      messages: [{ role: "user", content }],
    };

    const response = await fetchJson(
      `${root}/v1/chat/completions`,
      {
        method: "POST",
        headers: metaHeaders(cfg, req, { "content-type": "application/json" }),
        body: JSON.stringify(payload),
      },
      timeoutMs,
    );

    if (response.status === 401 || response.status === 403) {
      return sendJson(res, 401, {
        ok: false,
        error:
          "meta-api rechazo la autenticacion. Revisa la API key en la configuracion.",
        detail: truncate(response.text, 2000),
      });
    }
    if (!response.ok) {
      lastError = `meta-api respondio ${response.status || "sin conexion"}.`;
      lastDetail = truncate(response.text, 4000);
      continue;
    }

    const json = response.json || {};
    const answer = json?.choices?.[0]?.message?.content;
    answerText = typeof answer === "string" ? answer : "";
    conversationId = json.meta_conversation_id ?? null;

    const contentNames = nameMapFromContent(answerText);
  const candidates = [];
  if (Array.isArray(json.meta_files)) {
    for (const f of json.meta_files) {
      if (f && typeof f === "object") candidates.push(f);
    }
  }
  if (json.meta_zip && typeof json.meta_zip === "object") {
    candidates.push(json.meta_zip);
  }
  if (Array.isArray(json.meta_images)) {
    for (const img of json.meta_images) {
      if (img && typeof img === "object") candidates.push(img);
    }
  }

  // Stores one artifact and registers it in files.json.
  const storeArtifact = ({
    name,
    buf,
    mime,
    module,
    parentId = null,
    entry = null,
    owner: artifactOwner = owner,
  }) => {
    const safe = safeFileName(name, "archivo");
    const kind = classifyKind(safe, mime);
    const id = crypto.randomUUID();
    const dir = path.join(STORAGE_DIR, id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, safe), buf, { mode: 0o600 });
    const meta = {
      id,
      name: safe,
      mime: mime || mimeForName(safe, "application/octet-stream"),
      bytes: buf.length,
      url: `/api/files/${id}/${encodeURIComponent(safe)}`,
      created_at: new Date().toISOString(),
      module: module || null,
      kind,
      parentId,
      entry,
      owner: artifactOwner,
    };
    appendFileMeta(meta, artifactOwner);
    return meta;
  };

  // A ZIP is kept as the bundle AND exploded into individual assets so the
  // front can render images, videos, audio and subtitles directly.
  const expandArchive = (archiveMeta, buf, module) => {
    const dir = path.join(STORAGE_DIR, archiveMeta.id);
    const extractDir = path.join(dir, "extracted");
    const extracted = extractZipSafely(path.join(dir, archiveMeta.name), extractDir, {
      maxEntries: MAX_ZIP_ENTRIES,
      maxUncompressedBytes: MAX_ZIP_UNCOMPRESSED_BYTES,
    });
    const children = [];
    if (!extracted.ok) {
      warnings.push({
        name: archiveMeta.name,
        error: extracted.error || "no se pudo extraer el ZIP",
      });
    } else {
      for (const entry of extracted.files) {
        try {
          const childBuf = fs.readFileSync(entry.abs);
          if (!childBuf.length) continue;
          const childMeta = storeArtifact({
            name: path.basename(entry.entry),
            buf: childBuf,
            mime: mimeForName(path.basename(entry.entry), "application/octet-stream"),
            module,
            parentId: archiveMeta.id,
            entry: entry.entry,
            owner: archiveMeta.owner,
          });
          children.push(childMeta);
        } catch (error) {
          warnings.push({
            name: archiveMeta.name,
            entry: entry.entry,
            error: String(error?.message || error),
          });
        }
      }
    }
    try {
      fs.rmSync(extractDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    return children;
  };

  const pending = Array.isArray(json.meta_files_pendientes)
    ? json.meta_files_pendientes.filter((p) => p && typeof p === "object")
    : [];

  const seenPaths = new Set();
  const downloadable = [];
  for (const candidate of candidates) {
    const mediaPath = mediaPathOf(candidate);
    if (!mediaPath) continue;
    if (seenPaths.has(mediaPath)) continue;
    seenPaths.add(mediaPath);
    downloadable.push({ candidate, mediaPath });
  }

  for (const { candidate, mediaPath } of downloadable) {
    const download = await fetchBuffer(
      `${root}${mediaPath}`,
      { headers: metaHeaders(cfg, req) },
      180000,
    );
    if (!download.ok || !download.buf.length) {
      warnings.push({
        url: mediaPath,
        error: download.ok
          ? "archivo vacio"
          : `descarga fallo (${download.status || "sin conexion"})`,
      });
      continue;
    }

    const mediaBase = path.basename(
      String(mediaPath).split("/").filter(Boolean).pop() || "",
    );
    let name = safeFileName(
      candidate.nombre || contentNames.get(String(candidate.url || "")) || mediaBase,
      "archivo",
    );
    if (!name) name = "archivo";
    if (!/\.[A-Za-z0-9]{2,5}$/.test(name) && path.extname(mediaBase)) {
      name += path.extname(mediaBase);
    }
    if (isZipBuffer(download.buf) && !/\.zip$/i.test(name)) name += ".zip";

    const meta = storeArtifact({
      name,
      buf: download.buf,
      mime: candidate.mime || mimeForName(name, "application/octet-stream"),
      module: body.module ? String(body.module) : null,
    });
    stored.push(meta);
    if (meta.kind === "archive" && isZipBuffer(download.buf)) {
      stored.push(...expandArchive(meta, download.buf, body.module));
    }
  }

  // Fallback: meta-api could not materialize the artifacts (its sandbox is
  // restricted in this environment) but Meta publishes every file with a
  // direct URL inside the answer. Those links are downloaded here so the front
  // still gets the real bytes.
  if (pending.length) {
    const links = linksFromContent(answerText);
    const usedLinks = new Set();

    // Meta names the same file differently in each turn ("resultado.zip" vs
    // "ZIP con todo - resultado.zip"), so the match goes from the exact name
    // to "the link mentions the name" and finally to "same extension".
    const pickLink = (wanted) => {
      const base = path.basename(wanted).toLowerCase();
      const ext = path.extname(base).toLowerCase();
      const free = links.filter((l) => !usedLinks.has(l.url));
      let hit = free.find((l) => l.name.toLowerCase() === base);
      if (!hit) {
        hit = free.find(
          (l) =>
            l.label.toLowerCase().includes(base) || l.name.toLowerCase().includes(base),
        );
      }
      if (!hit && ext) {
        hit = free.find((l) => path.extname(l.name).toLowerCase() === ext);
      }
      if (hit) usedLinks.add(hit.url);
      return hit;
    };

    for (const pendingFile of pending) {
      const wanted = String(pendingFile.nombre || "").trim();
      if (!wanted) continue;
      const base = path.basename(wanted).toLowerCase();
      if (stored.some((f) => f.name.toLowerCase() === base)) continue;

      const link = pickLink(wanted);
      if (!link) {
        warnings.push({
          name: wanted,
          error: "meta-api no lo materializo y no hay enlace directo en la respuesta",
        });
        continue;
      }

      const remote = await fetchRemoteArtifact(link.url);
      if (!remote.ok) {
        warnings.push({ name: wanted, error: remote.error });
        continue;
      }
      if (remote.mime.includes("text/html")) {
        warnings.push({
          name: wanted,
          error:
            "el enlace de Meta devuelve la vista HTML del documento, no el archivo",
        });
        continue;
      }

      const rawName = path.extname(link.name) ? link.name : wanted;
      let name = safeFileName(rawName, "archivo");
      if (!/\.[A-Za-z0-9]{2,5}$/.test(name) && path.extname(link.name)) {
        name += path.extname(link.name);
      }
      if (isZipBuffer(remote.buf) && !/\.zip$/i.test(name)) name += ".zip";

      const meta = storeArtifact({
        name,
        buf: remote.buf,
        mime: remote.mime || mimeForName(name, "application/octet-stream"),
        module: body.module ? String(body.module) : null,
      });
      stored.push(meta);
      if (meta.kind === "archive" && isZipBuffer(remote.buf)) {
        stored.push(...expandArchive(meta, remote.buf, body.module));
      }
    }
  }

    if (stored.length) break;
    lastError =
      "meta-api no devolvio archivos descargables. Activa 'Usar archivos locales' y revisa la respuesta de meta-api.";
    lastDetail = truncate(response.text, 6000);
  }

  if (!stored.length) {
    return sendJson(res, 502, {
      ok: false,
      error: lastError,
      warnings,
      detail: lastDetail,
      text: answerText,
      meta_conversation_id: conversationId,
    });
  }

  const bundle = stored.find((f) => f.kind === "archive") || null;
  return sendJson(res, 200, {
    ok: true,
    text: answerText,
    files: stored,
    bundle,
    warnings,
    meta_conversation_id: conversationId,
  });
}

function listFiles(res, owner) {
  const files = readFiles(owner)
    .slice()
    .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
  return sendJson(res, 200, { ok: true, files });
}

function serveStoredFile(req, res, id, rawName) {
  res.setHeader("x-content-type-options", "nosniff");
  if (!/^[A-Za-z0-9-]+$/.test(id)) {
    return sendJson(res, 400, { error: "id invalido" });
  }
  let name;
  try {
    name = decodeURIComponent(rawName || "");
  } catch {
    return sendJson(res, 400, { error: "nombre invalido" });
  }
  if (!safeFileName(name, "")) {
    return sendJson(res, 400, { error: "nombre invalido" });
  }

  const meta = readFiles(req.sessionId).find((file) => file.id === id);
  if (!meta) return sendJson(res, 404, { error: "no existe" });
  const safe = safeFileName(meta.name, "");
  if (!safe) return sendJson(res, 404, { error: "no existe" });

  const base = path.join(STORAGE_DIR, id);
  const file = path.join(base, safe);
  if (!file.startsWith(base + path.sep)) {
    return sendJson(res, 400, { error: "ruta invalida" });
  }

  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return sendJson(res, 404, { error: "no existe" });
  }
  if (!stat.isFile()) return sendJson(res, 404, { error: "no existe" });

  const ext = path.extname(safe).slice(1).toLowerCase();
  const extensionMime = MIME_TYPES[ext] || "application/octet-stream";
  const kind = classifyKind(safe, extensionMime);
  const media = ["image", "video", "audio"].includes(kind);
  const storedMime = String(meta.mime || "").split(";")[0].trim().toLowerCase();
  let mime = extensionMime;
  if (
    media &&
    extensionMime === "application/octet-stream" &&
    storedMime.startsWith(`${kind}/`)
  ) {
    mime = storedMime;
  }
  if (!media && /^(text\/html|text\/javascript)$/i.test(mime.split(";")[0].trim())) {
    mime = "text/plain; charset=utf-8";
  }

  // Media is served inline so the front can render it. Every other kind is
  // always an attachment; ?inline=1 cannot turn active content into a preview.
  let forceDownload = false;
  try {
    const url = new URL(
      req.url || "/",
      `http://${req.headers.host || "127.0.0.1"}`,
    );
    forceDownload = url.searchParams.get("download") === "1";
  } catch {
    /* ignore malformed URL */
  }
  const inline = media && !forceDownload;

  const asciiName = safe.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "_");
  const disposition = `${
    inline ? "inline" : "attachment"
  }; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
  const headers = {
    "content-type": mime,
    "content-disposition": disposition,
    "accept-ranges": "bytes",
    "cache-control": "private, max-age=300",
    ...(inline
      ? { "content-security-policy": "sandbox; default-src 'none'" }
      : {}),
  };

  const range = req.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(String(range));
    if (match) {
      const size = stat.size;
      let start = match[1] === "" ? null : Number(match[1]);
      let end = match[2] === "" ? null : Number(match[2]);
      if (start === null && end !== null) {
        start = Math.max(0, size - end);
        end = size - 1;
      } else if (start !== null && end === null) {
        end = size - 1;
      }
      if (start === null || start >= size || end < start) {
        res.writeHead(416, { "content-range": `bytes */${size}` });
        return res.end();
      }
      end = Math.min(end, size - 1);
      res.writeHead(206, {
        ...headers,
        "content-range": `bytes ${start}-${end}/${size}`,
        "content-length": end - start + 1,
      });
      if (req.method === "HEAD") return res.end();
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
  }

  res.writeHead(200, { ...headers, "content-length": stat.size });
  if (req.method === "HEAD") return res.end();
  return fs.createReadStream(file).pipe(res);
}

function deleteStoredFile(res, id, owner) {
  if (!/^[A-Za-z0-9-]+$/.test(id)) {
    return sendJson(res, 400, { error: "id invalido" });
  }
  const files = readFiles(owner);
  if (!files.some((file) => file.id === id)) {
    return sendJson(res, 404, { error: "no existe" });
  }
  const dir = path.join(STORAGE_DIR, id);
  if (!dir.startsWith(STORAGE_DIR + path.sep)) {
    return sendJson(res, 400, { error: "ruta invalida" });
  }

  const children = files.filter((file) => file.parentId === id);
  const ids = [id, ...children.map((child) => child.id)];
  for (const target of ids) {
    const targetDir = path.join(STORAGE_DIR, target);
    if (!targetDir.startsWith(STORAGE_DIR + path.sep)) continue;
    try {
      fs.rmSync(targetDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  writeFiles(files.filter((file) => !ids.includes(file.id)), owner);
  return sendJson(res, 200, { ok: true, deleted: ids.length });
}

// ---------------------------------------------------------------------------
// Static front
// ---------------------------------------------------------------------------

const MIME_TYPES = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  srt: "text/plain; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
  mp4: "video/mp4",
  webm: "video/webm",
  m4v: "video/mp4",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  ogg: "audio/ogg",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
};

function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return sendJson(res, 400, { error: "ruta invalida" });
  }
  if (rel === "/" || rel === "") rel = "/index.html";

  const target = path.resolve(FRONT_DIR, `.${rel}`);
  if (target !== FRONT_DIR && !target.startsWith(FRONT_DIR + path.sep)) {
    return sendJson(res, 403, { error: "ruta fuera del front" });
  }

  let stat;
  try {
    stat = fs.statSync(target);
    if (stat.isDirectory()) {
      const index = path.join(target, "index.html");
      stat = fs.statSync(index);
      return sendFile(req, res, index, stat);
    }
  } catch {
    return sendJson(res, 404, { error: "no existe" });
  }
  return sendFile(req, res, target, stat);
}

function sendFile(req, res, file, stat) {
  const ext = path.extname(file).slice(1).toLowerCase();
  const mime = MIME_TYPES[ext] || "application/octet-stream";
  const headers = {
    "content-type": mime,
    "cache-control": ext === "html" ? "no-cache" : "public, max-age=300",
    "accept-ranges": "bytes",
  };

  const range = req.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(String(range));
    if (match) {
      const size = stat.size;
      let start = match[1] === "" ? null : Number(match[1]);
      let end = match[2] === "" ? null : Number(match[2]);
      if (start === null && end !== null) {
        start = Math.max(0, size - end);
        end = size - 1;
      } else if (start !== null && end === null) {
        end = size - 1;
      }
      if (start === null || start >= size || end < start) {
        res.writeHead(416, { "content-range": `bytes */${size}` });
        return res.end();
      }
      end = Math.min(end, size - 1);
      res.writeHead(206, {
        ...headers,
        "content-range": `bytes ${start}-${end}/${size}`,
        "content-length": end - start + 1,
      });
      if (req.method === "HEAD") return res.end();
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
  }

  res.writeHead(200, { ...headers, "content-length": stat.size });
  if (req.method === "HEAD") return res.end();
  return fs.createReadStream(file).pipe(res);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  ensureSession(req, res);
  const startedAt = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - startedAt;
    const label = `${req.method} ${req.url} -> ${res.statusCode} (${ms}ms)`;
    if (res.statusCode >= 400 || ms > 2000 || /^\/api\/(chat|generate|improve)/.test(req.url || "")) {
      console.log(`[api] ${label}`);
    }
  });

  let pathname = "/";
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    pathname = url.pathname;
  } catch {
    return sendJson(res, 400, { error: "URL invalida" });
  }

  try {
    // A browser page from another site must not be able to drive this API.
    if (!["GET", "HEAD"].includes(req.method || "GET")) {
      const origin = checkOrigin(req);
      if (!origin.ok) {
        return sendJson(res, 403, { error: origin.error });
      }
    }

    // Config
    if (pathname === "/api/config" && req.method === "GET") {
      return sendJson(res, 200, publicConfig(readConfig()));
    }
    if (pathname === "/api/config" && req.method === "PUT") {
      let body;
      try {
        body = JSON.parse((await readBody(req, 1024 * 1024)) || "{}");
      } catch {
        return sendJson(res, 400, { error: "JSON invalido" });
      }
      const cfg = readConfig();

      if (body.allowExternalBaseUrl !== undefined) {
        // This switch is a backend decision: a browser must not be able to
        // open the door that lets the stored key travel to any host.
        return sendJson(res, 400, {
          error:
            "allowExternalBaseUrl no se cambia desde el panel: definalo en el backend (api/data/config.json con \"allowExternalBaseUrl\": true, o ALLOW_EXTERNAL_BASE_URL=1).",
        });
      }
      if (body.baseUrl !== undefined) {
        const check = validateBaseUrl(String(body.baseUrl || "").trim(), {
          allowExternal: cfg.allowExternalBaseUrl,
        });
        if (!check.ok) {
          return sendJson(res, 400, { error: check.error });
        }
        cfg.baseUrl = check.url;
      }
      if (body.model !== undefined) {
        const model = String(body.model || "").trim();
        if (!model) return sendJson(res, 400, { error: "model no puede estar vacio" });
        cfg.model = model;
      }
      if (body.forceZip !== undefined) cfg.forceZip = !!body.forceZip;
      if (body.useLocalFiles !== undefined) cfg.useLocalFiles = !!body.useLocalFiles;
      if (body.clearKey === true) {
        cfg.apiKey = "";
      } else if (typeof body.apiKey === "string" && body.apiKey.trim()) {
        cfg.apiKey = body.apiKey.trim();
      }

      writeConfig(cfg);
      return sendJson(res, 200, publicConfig(cfg));
    }

    // Health
    if (pathname === "/api/health" && (req.method === "GET" || req.method === "HEAD")) {
      return handleHealth(req, res);
    }

    // Improve a text field or a prompt (meta-api answers with the final text only)
    if (pathname === "/api/improve" && req.method === "POST") {
      return handleImprove(req, res);
    }

    // Chat / generate media
    if (
      (pathname === "/api/chat" || pathname === "/api/generate") &&
      req.method === "POST"
    ) {
      return handleChat(req, res);
    }

    // Files
    if (pathname === "/api/files" && req.method === "GET") {
      return listFiles(res, req.sessionId);
    }
    const fileMatch = /^\/api\/files\/([^/]+)\/(.+)$/.exec(pathname);
    if (fileMatch && (req.method === "GET" || req.method === "HEAD")) {
      return serveStoredFile(req, res, fileMatch[1], fileMatch[2]);
    }
    const deleteMatch = /^\/api\/files\/([^/]+)$/.exec(pathname);
    if (deleteMatch && req.method === "DELETE") {
      return deleteStoredFile(res, deleteMatch[1], req.sessionId);
    }

    // Records / actions (the existing front calls fetch("actions")).
    if ((pathname === "/actions" || pathname === "/api/actions") && req.method === "POST") {
      return handleAction(req, res, await readBody(req));
    }

    if (pathname.startsWith("/api/")) {
      return sendJson(res, 404, { error: "endpoint no encontrado" });
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      return sendJson(res, 405, { error: "metodo no permitido" });
    }

    return serveStatic(req, res, pathname);
  } catch (err) {
    console.error("[api]", err);
    if (!res.headersSent) {
      return sendJson(res, 500, { error: String(err?.message || err) });
    }
    try {
      res.end();
    } catch {
      /* ignore */
    }
  }
});

// ---------------------------------------------------------------------------
// Start / shutdown
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";

ensureDirs();

server.listen(PORT, HOST, () => {
  console.log(`Front:    http://${HOST}:${PORT}/`);
  console.log(`Own API:  http://${HOST}:${PORT}/api/`);
  if (OWNER_SESSION) {
    console.log(`[api] sesion fijada por OWNER_SESSION: ${OWNER_SESSION}`);
  }
  if (!isLoopbackBind(HOST)) {
    console.warn(
      `[api] AVISO: la API escucha en ${HOST}, no es loopback. Queda expuesta a la red: usa un proxy inverso con autenticacion antes de abrirla.`,
    );
  }
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[api] ${signal}: cerrando...`);
  try {
    await restoreFileStorage();
  } catch {
    /* best effort */
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
