// api/media.mjs — media classification and safe ZIP handling.
//
// This module is intentionally dependency-free. The own API uses it to classify
// every file returned by meta-api and, when `unzip` is available, to expose the
// files inside a generated ZIP as individual front assets.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const IMAGE_EXT = new Set([
  "png", "jpg", "jpeg", "webp", "gif", "svg", "avif", "bmp", "tif", "tiff",
]);
const VIDEO_EXT = new Set([
  "mp4", "webm", "mov", "m4v", "mkv", "avi", "mpeg", "mpg", "ogv",
]);
const AUDIO_EXT = new Set([
  "mp3", "m4a", "wav", "ogg", "aac", "flac", "opus", "weba",
]);
const SUBTITLE_EXT = new Set(["srt", "vtt", "ass", "ssa"]);
const ARCHIVE_EXT = new Set(["zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz"]);
const DOCUMENT_EXT = new Set([
  "pdf", "doc", "docx", "txt", "md", "html", "htm", "csv",
  "xls", "xlsx", "ppt", "pptx", "json", "xml",
]);

export const MIME_TYPES = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  srt: "text/plain; charset=utf-8",
  vtt: "text/vtt; charset=utf-8",
  ass: "text/plain; charset=utf-8",
  ssa: "text/plain; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  ico: "image/x-icon",
  mp4: "video/mp4",
  webm: "video/webm",
  m4v: "video/mp4",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
  ogv: "video/ogg",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  ogg: "audio/ogg",
  aac: "audio/aac",
  flac: "audio/flac",
  opus: "audio/opus",
  zip: "application/zip",
  rar: "application/vnd.rar",
  "7z": "application/x-7z-compressed",
  tar: "application/x-tar",
  gz: "application/gzip",
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
};

export function extOf(name) {
  return path.extname(String(name || "")).slice(1).toLowerCase();
}

export function mimeForName(name, fallback = "application/octet-stream") {
  return MIME_TYPES[extOf(name)] || fallback;
}

export function classifyKind(name, mime) {
  const m = String(mime || "").toLowerCase();
  const ext = extOf(name);

  if (m.startsWith("image/") || IMAGE_EXT.has(ext)) return "image";
  if (m.startsWith("video/") || VIDEO_EXT.has(ext)) return "video";
  if (m.startsWith("audio/") || AUDIO_EXT.has(ext)) return "audio";
  if (SUBTITLE_EXT.has(ext) || m.includes("subrip") || m.includes("vtt")) {
    return "subtitle";
  }
  if (ARCHIVE_EXT.has(ext) || m.includes("zip")) return "archive";
  if (DOCUMENT_EXT.has(ext) || m.startsWith("text/")) return "document";
  return "other";
}

export function safeFileName(name, fallback = "archivo") {
  const base = path.basename(String(name || "").replace(/\\/g, "/"));
  const cleaned = base
    .replace(/[^\w.\- ()[\]]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "");
  if (!cleaned || cleaned === "." || cleaned === "..") return fallback;
  if (cleaned.length <= 180) return cleaned;
  const ext = path.extname(cleaned);
  return cleaned.slice(0, Math.max(1, 180 - ext.length)) + ext;
}

export function isZipBuffer(buf) {
  if (!buf || buf.length < 4) return false;
  return (
    (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) ||
    (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x05 && buf[3] === 0x06) ||
    (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x07 && buf[3] === 0x08)
  );
}

export function listZipEntries(zipPath) {
  try {
    const out = execFileSync("unzip", ["-Z1", zipPath], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export function extractZipSafely(zipPath, destDir, limits = {}) {
  const maxEntries = Number(limits.maxEntries || 2000);
  const maxUncompressedBytes = Number(limits.maxUncompressedBytes || 512 * 1024 * 1024);
  const entries = listZipEntries(zipPath);
  if (!entries.length) {
    return { ok: false, entries: [], files: [], error: "unzip no disponible o ZIP vacio" };
  }

  if (entries.length > maxEntries) {
    return {
      ok: false,
      entries: [],
      files: [],
      error: `el ZIP tiene ${entries.length} entradas (maximo ${maxEntries})`,
    };
  }

  for (const entry of entries) {
    const normalized = entry.replace(/\\/g, "/");
    if (
      normalized.startsWith("/") ||
      /^[A-Za-z]:/.test(normalized) ||
      normalized.split("/").includes("..")
    ) {
      return {
        ok: false,
        entries: [],
        files: [],
        error: `entrada ZIP insegura: ${entry}`,
      };
    }
  }

  try {
    fs.mkdirSync(destDir, { recursive: true, mode: 0o700 });
    execFileSync("unzip", ["-o", zipPath, "-d", destDir], {
      stdio: "ignore",
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    return {
      ok: false,
      entries,
      files: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const root = path.resolve(destDir) + path.sep;
  const files = [];
  let totalBytes = 0;
  for (const entry of entries) {
    const abs = path.resolve(destDir, entry);
    if (!abs.startsWith(root)) continue;
    try {
      const stat = fs.statSync(abs);
      if (!stat.isFile()) continue;
      totalBytes += stat.size;
      if (totalBytes > maxUncompressedBytes) {
        return {
          ok: false,
          entries: [],
          files: [],
          error: `el ZIP descomprime mas de ${maxUncompressedBytes} bytes`,
        };
      }
      files.push({ entry, abs });
    } catch {
      /* ignore missing entries */
    }
  }
  return { ok: true, entries, files, error: null };
}
