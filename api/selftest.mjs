import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(ROOT, "api", "server.mjs");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function requestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function startUpstream() {
  const server = http.createServer(async (req, res) => {
    const json = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/health") return json(200, { ok: true });
    if (req.url === "/v1/models") return json(200, { data: [{ id: "test-model" }] });
    if (req.url === "/v1/ajustes") return json(200, { fileStorage: "local" });
    if (req.url === "/v1/chat/completions") {
      const raw = await requestBody(req);
      const name = raw.includes("unsafe.html") ? "unsafe.html" : "sample.png";
      return json(200, {
        choices: [{ message: { content: `[${name}](/v1/media/${name})` } }],
        meta_files: [
          {
            url: `/v1/media/${name}`,
            nombre: name,
            mime: name.endsWith(".html") ? "text/html" : "image/png",
          },
        ],
        meta_conversation_id: "test-conversation",
      });
    }
    if (req.url?.startsWith("/v1/media/")) {
      const name = req.url.slice("/v1/media/".length);
      const body = name.endsWith(".html")
        ? Buffer.from("<script>alert('unsafe')</script>")
        : Buffer.from("fake-png");
      res.writeHead(200, {
        "content-type": name.endsWith(".html") ? "text/html" : "image/png",
        "content-length": body.length,
      });
      return res.end(body);
    }
    return json(404, { error: "not found" });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  return { server, url: `http://127.0.0.1:${port}` };
}

async function startApi(t, { legacy = false, reuse = null, ownerSession = "" } = {}) {
  const temp = reuse?.temp || fs.mkdtempSync(path.join(os.tmpdir(), "own-api-selftest-"));
  const dataDir = reuse?.dataDir || path.join(temp, "data");
  const storageDir = reuse?.storageDir || path.join(temp, "storage", "files");
  let upstream = reuse?.upstream || null;
  let child;
  let exited = Promise.resolve();
  t.after(async () => {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([exited, delay(2000)]);
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await Promise.race([exited, delay(2000)]);
      }
    }
    if (!reuse && upstream) {
      upstream.server.closeAllConnections?.();
      await new Promise((resolve) => upstream.server.close(resolve));
    }
    if (!reuse) fs.rmSync(temp, { recursive: true, force: true });
  });

  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(storageDir, { recursive: true });
  if (!upstream) upstream = await startUpstream();
  fs.writeFileSync(
    path.join(dataDir, "config.json"),
    JSON.stringify({
      baseUrl: upstream.url,
      model: "test-model",
      forceZip: true,
      useLocalFiles: true,
      allowExternalBaseUrl: false,
    }),
    { mode: 0o600 },
  );

  if (legacy) {
    const file = {
      id: "legacy-file",
      name: "legacy.txt",
      mime: "text/plain",
      bytes: 6,
      url: "/api/files/legacy-file/legacy.txt",
      created_at: "2026-01-01T00:00:00.000Z",
      module: null,
      kind: "document",
      parentId: null,
      entry: null,
    };
    fs.writeFileSync(
      path.join(dataDir, "files.json"),
      JSON.stringify({ files: [file] }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(dataDir, "records.json"),
      JSON.stringify({
        records: [
          {
            id: "legacy-record",
            collection: "legacy",
            value: { kept: true },
            created_at: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
      { mode: 0o600 },
    );
    const dir = path.join(storageDir, file.id);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, file.name), "legacy", { mode: 0o600 });
  }

  const port = await freePort();
  child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      API_DATA_DIR: dataDir,
      API_STORAGE_DIR: storageDir,
      OWNER_SESSION: ownerSession,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (chunk) => (logs += chunk));
  child.stderr.on("data", (chunk) => (logs += chunk));
  exited = new Promise((resolve) => child.once("exit", resolve));

  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${base}/api/health`);
      await response.arrayBuffer();
      if (response.ok) {
        return { base, dataDir, storageDir, temp, upstream, logs: () => logs };
      }
    } catch {
      /* server is still starting */
    }
    await delay(100);
  }
  throw new Error(`API did not become healthy:\n${logs}`);
}

function request(base, route, { cookie, method = "GET", body, headers = {} } = {}) {
  return fetch(`${base}${route}`, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function cookieFrom(response) {
  const value = response.headers.get("set-cookie");
  assert.ok(value, "expected a Set-Cookie header");
  return value.split(";", 1)[0];
}

async function createFile(base, cookie, name, extra = {}) {
  const response = await request(base, "/api/chat", {
    cookie,
    method: "POST",
    body: { text: `create ${name}`, ...extra },
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  const body = JSON.parse(text);
  assert.equal(body.files.length, 1);
  return body.files[0];
}

test("issues a strict session cookie and keeps health and config working", async (t) => {
  const { base } = await startApi(t);
  const health = await request(base, "/api/health");
  assert.equal(health.status, 200);
  assert.match(
    health.headers.get("set-cookie"),
    /^sid=[A-Za-z0-9_-]+; Path=\/; HttpOnly; SameSite=Strict$/,
  );

  const config = await request(base, "/api/config");
  assert.equal(config.status, 200);
  assert.deepEqual(Object.keys(await config.json()).sort(), [
    "allowExternalBaseUrl",
    "baseUrl",
    "forceZip",
    "hasKey",
    "model",
    "useLocalFiles",
  ]);
});

test("isolates file lists, downloads and deletes by session", async (t) => {
  const { base } = await startApi(t);
  const cookieA = cookieFrom(await request(base, "/api/files"));
  const file = await createFile(base, cookieA, "sample.png");
  assert.equal(file.owner, cookieA.slice(4));

  const cookieB = cookieFrom(await request(base, "/api/files"));
  assert.notEqual(cookieA, cookieB);
  assert.deepEqual((await (await request(base, "/api/files", { cookie: cookieB })).json()).files, []);
  const deniedDownload = await request(base, file.url, { cookie: cookieB });
  assert.equal(deniedDownload.status, 404);
  assert.equal(deniedDownload.headers.get("x-content-type-options"), "nosniff");
  assert.equal(
    (await request(base, `/api/files/${file.id}`, { cookie: cookieB, method: "DELETE" })).status,
    404,
  );
  assert.equal((await request(base, file.url, { cookie: cookieA })).status, 200);
  const filesA = (await (await request(base, "/api/files", { cookie: cookieA })).json()).files;
  assert.equal(filesA.length, 1);
  assert.equal(filesA[0].id, file.id);
});

test("ignores client-supplied ownership when creating files", async (t) => {
  const { base, dataDir } = await startApi(t);
  const cookieA = cookieFrom(await request(base, "/api/files"));
  const file = await createFile(base, cookieA, "sample.png", {
    owner: "attacker_owner_12345",
    user_id: "attacker_user_12345",
  });
  const owner = cookieA.slice(4);
  assert.equal(file.owner, owner);
  assert.notEqual(file.owner, "attacker_owner_12345");

  const storedFiles = JSON.parse(
    fs.readFileSync(path.join(dataDir, "files.json"), "utf8"),
  );
  assert.equal(storedFiles.files.find((entry) => entry.id === file.id)?.owner, owner);

  const cookieB = cookieFrom(await request(base, "/api/files"));
  const filesB = (await (await request(base, "/api/files", { cookie: cookieB })).json()).files;
  assert.deepEqual(filesB, []);
  assert.equal((await request(base, file.url, { cookie: cookieB })).status, 404);
});

test("pins ownership with OWNER_SESSION while preserving the browser cookie", async (t) => {
  const first = await startApi(t);
  const cookieA = cookieFrom(await request(first.base, "/api/files"));
  const file = await createFile(first.base, cookieA, "sample.png");
  const owner = cookieA.slice(4);

  const second = await startApi(t, { reuse: first, ownerSession: owner });
  const cookieB = cookieFrom(await request(second.base, "/api/files"));
  assert.notEqual(cookieA, cookieB);
  const files = (await (await request(second.base, "/api/files", { cookie: cookieB })).json()).files;
  assert.equal(files.length, 1);
  assert.equal(files[0].id, file.id);
  assert.equal(files[0].owner, owner);
  for (let attempt = 0; attempt < 20 && !second.logs().includes("OWNER_SESSION"); attempt += 1) {
    await delay(10);
  }
  assert.match(second.logs(), /sesion fijada por OWNER_SESSION/);
});

test("adopts legacy entries once and isolates them from later sessions", async (t) => {
  const { base, dataDir } = await startApi(t, { legacy: true });
  const cookieA = cookieFrom(await request(base, "/api/files"));
  const cookieB = cookieFrom(await request(base, "/api/files"));
  const files = (await (await request(base, "/api/files", { cookie: cookieA })).json()).files;
  assert.equal(files.length, 1);
  assert.equal(files[0].owner, cookieA.slice(4));
  const legacyDownload = await request(base, files[0].url, { cookie: cookieA });
  assert.equal(legacyDownload.status, 200);
  assert.equal(await legacyDownload.text(), "legacy");
  const ownerPath = path.join(dataDir, "owner.json");
  const primary = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
  assert.deepEqual(primary, { primary: cookieA.slice(4) });
  assert.equal(fs.statSync(ownerPath).mode & 0o777, 0o600);

  const recordsResponse = await request(base, "/api/actions", {
    cookie: cookieA,
    method: "POST",
    body: { action: "records.list", args: {} },
  });
  const records = (await recordsResponse.json()).data.records;
  assert.equal(records.length, 1);
  assert.equal(records[0].owner, cookieA.slice(4));

  const createRecord = async (cookie) => {
    const response = await request(base, "/api/actions", {
      cookie,
      method: "POST",
      body: {
        action: "records.create",
        args: { collection: "owned", value: { ok: true }, idempotency_key: "same-key" },
      },
    });
    return (await response.json()).data.record;
  };
  const recordA = await createRecord(cookieA);
  const recordB = await createRecord(cookieB);
  assert.equal(recordA.owner, cookieA.slice(4));
  assert.equal(recordB.owner, cookieB.slice(4));
  assert.notEqual(recordA.id, recordB.id);

  const storedFiles = JSON.parse(fs.readFileSync(path.join(dataDir, "files.json"), "utf8"));
  const storedRecords = JSON.parse(fs.readFileSync(path.join(dataDir, "records.json"), "utf8"));
  assert.equal(storedFiles.files[0].owner, cookieA.slice(4));
  assert.equal(storedRecords.records[0].owner, cookieA.slice(4));

  const deleteRecord = async (cookie, id) => {
    const response = await request(base, "/api/actions", {
      cookie,
      method: "POST",
      body: { action: "records.delete", args: { collection: "owned", id } },
    });
    return (await response.json()).data.deleted;
  };
  assert.equal(await deleteRecord(cookieB, recordA.id), 0);
  assert.equal(await deleteRecord(cookieA, recordA.id), 1);

  assert.deepEqual((await (await request(base, "/api/files", { cookie: cookieB })).json()).files, []);
  const recordsB = await request(base, "/api/actions", {
    cookie: cookieB,
    method: "POST",
    body: { action: "records.list", args: {} },
  });
  const recordsBData = (await recordsB.json()).data.records;
  assert.equal(recordsBData.some((record) => record.id === "legacy-record"), false);
});

test("serves documents as attachments and media inline with hardening headers", async (t) => {
  const { base } = await startApi(t);
  const cookie = cookieFrom(await request(base, "/api/files"));
  const html = await createFile(base, cookie, "unsafe.html");
  const htmlResponse = await request(base, `${html.url}?inline=1`, { cookie });
  assert.equal(htmlResponse.status, 200);
  assert.equal(htmlResponse.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.match(htmlResponse.headers.get("content-disposition"), /^attachment;/);
  assert.equal(htmlResponse.headers.get("x-content-type-options"), "nosniff");

  const png = await createFile(base, cookie, "sample.png");
  const pngResponse = await request(base, png.url, { cookie });
  assert.equal(pngResponse.status, 200);
  assert.equal(pngResponse.headers.get("content-type"), "image/png");
  assert.match(pngResponse.headers.get("content-disposition"), /^inline;/);
  assert.equal(pngResponse.headers.get("x-content-type-options"), "nosniff");
  assert.equal(pngResponse.headers.get("content-security-policy"), "sandbox; default-src 'none'");

  const range = await request(base, png.url, { cookie, headers: { range: "bytes=0-3" } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get("content-range"), "bytes 0-3/8");
  assert.equal((await range.arrayBuffer()).byteLength, 4);
});
