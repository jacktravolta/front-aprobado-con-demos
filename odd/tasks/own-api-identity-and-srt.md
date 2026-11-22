# Own API identity, strict document serving and real SRT codec

## Objective
Close the three items left open by the API hardening review: per-user identity for the stores, strict MIME/CSP handling for generated documents served inline, and a real SRT/VTT parser plus a real Blob export in the front.

## Problem
- `api/data/files.json` and `api/data/records.json` are a single global store: any caller that reaches the API sees and mutates every file and record.
- `serveStoredFile` trusts the MIME recorded by the upstream. A generated HTML (or anything else with an active type) served same-origin with `Content-Disposition: inline` can run script against the API origin.
- The minified front only *previews* the subtitle export: "Exportar SRT" / "Exportar VTT" write the text into a `<pre>` and never download a file. "Importar SRT pegado" splits the pasted text into 8 lines and fabricates 4-second timings, ignoring the real cue structure of an SRT.

## Why
The API is the only component holding the provider key and the only component that stores artifacts. If a single browser profile can drive it, the store is shared by every profile on the machine; if an upstream-provided document is served as active content, the API origin becomes an execution target for content that nobody reviewed.

## Scope
- Backend: session identity + ownership scoping for files and records, with legacy adoption.
- Backend: strict serving of stored files (attachment for active types, `nosniff`, sandbox CSP, MIME derived from the extension for documents).
- Front: a real SRT/VTT codec (parse + serialize) with unit tests, wired into the existing editor.
- Front: "Exportar SRT" / "Exportar VTT" download a real file instead of only previewing it.
- Front: "Importar SRT pegado" fills the rows with the real cues and timings when the pasted text is a valid SRT/VTT.

## Constraints
- Do not modify `/home/test/test/meta-api`.
- Keep the front calling the API same-origin without credentials: the session must ride on a cookie the browser sends automatically.
- Keep plain JSON persistence (no database).
- Do not patch the minified React bundle: the new behavior lives in the integration layer.
- Keep the change small enough for one reviewable work unit per area.

## Design decisions
**Session identity.** The API issues an `HttpOnly`, `SameSite=Strict` session cookie (`sid`). The browser sends it automatically on every same-origin request, so the front needs no secret and no token. `SameSite=Strict` plus the existing origin check means a foreign page cannot ride the cookie. Ownership is enforced on every read, write and delete of a file or a record.

**Legacy adoption.** Files and records created before this change have no owner. The first session that lists the store adopts them, so the operator keeps seeing the artifacts generated so far. Later sessions see an empty store: that is the isolation working, not data loss (the bytes stay on disk).

**Serving rules.** The stored MIME is not trusted for document kinds: the MIME comes from the extension, `text/html` is downgraded to `text/plain`, everything that is not a media kind is served as an attachment, and every response carries `X-Content-Type-Options: nosniff` plus `Content-Security-Policy: sandbox; default-src 'none'` when it is served inline.

**Subtitle codec.** The parse/serialize logic lives in `front/srt-codec.js`, a plain browser script that also exports for Node, so it can be unit-tested without a browser. The DOM wiring lives in `front/media-results.js`.

## Tasks
- [x] T1. Backend: make the data and storage directories overridable by env so the API can be tested in isolation (`API_DATA_DIR`, `API_STORAGE_DIR`).
- [x] T2. Backend: issue and read the session cookie, scope files and records by owner, adopt the legacy unowned entries.
- [x] T3. Backend: serve stored documents with a safe MIME, `nosniff`, a sandbox CSP and an attachment disposition for non-media kinds.
- [x] T4. Backend: add `api/selftest.mjs` (node:test, no dependencies) covering the session scoping and the strict serving.
- [x] T5. Front: add `front/srt-codec.js` with a real SRT/VTT parser and serializer plus `front/srt-codec.test.mjs`.
- [x] T6. Front: wire the codec into the editor: "Exportar SRT" / "Exportar VTT" download a real file; "Importar SRT pegado" fills the rows with the real cues.
- [x] T7. Front: load the codec from `front/index.html` before the integration scripts.

## Acceptance criteria
- Two different sessions (two cookies) see different file lists; a session cannot download or delete another session's file.
- The pre-existing files are still visible from the first session that connects.
- A stored HTML document is served as `text/plain` with an attachment disposition; a stored image keeps its inline preview and its real MIME.
- Every stored-file response carries `X-Content-Type-Options: nosniff`.
- `front/srt-codec.test.mjs` proves the parser reads real cues (index, start, end, text), ignores the WEBVTT header, tolerates CRLF, and the serializer produces valid SRT and VTT.
- Clicking "Exportar SRT" downloads an `.srt` file whose content matches the rows of the editor; "Exportar VTT" downloads a `.vtt` file starting with `WEBVTT`.
- Pasting a real SRT and clicking "Importar SRT pegado" fills the rows with the original timings and texts instead of fabricated 4-second windows.
- Pasting a plain script (not an SRT) keeps the current behavior.

## Applicable checks
- `node --test api/selftest.mjs`
- `node --test front/srt-codec.test.mjs`
- `node --check` on every touched JS file.
- Functional probes over HTTP: session isolation, adoption, download headers, delete isolation.
- CDP walkthrough of the front: export download, import filling, "Implementar" still working, zero console errors.

## Route
- T1-T4: delegated writer (backend). Trigger: the backend work touches a non-trivial file plus a new test file.
- T5-T7: delegated writer (front). Trigger: the front work touches a non-trivial file, a new module and a new test file.
- Verification and the live CDP walkthrough: parent orchestrator.

## TDD mode
Off. This project has no test runner and no package manifest; the checks above are the executable evidence (node:test for the new units, HTTP probes and a CDP walkthrough for the runtime behavior).

## Work-unit evidence
- Backend unit: commit `7de1ad3` — `feat(api): scope the stores by session and serve generated files safely`.
- Front unit: pending.
- Branch: `feature/own-api-integration`.

## Backend verification evidence (T1-T4)
- `node --check api/server.mjs`: OK.
- `node --test api/selftest.mjs`: 5/5 pass (cookie issuance + strict attributes, session isolation for list/download/delete, `OWNER_SESSION` pinning, legacy adoption, strict serving).
- Live against the real store (`./start.sh`, `OWNER_SESSION=local-operator-front`):
  - the 19 pre-existing files were adopted by the pinned session and `api/data/owner.json` now holds `{"primary": "local-operator-front"}`;
  - a stored document (`slayer_gym_guion.txt`) -> `text/plain; charset=utf-8`, `content-disposition: attachment`, `x-content-type-options: nosniff`;
  - a subtitle (`.srt`) -> same treatment (attachment, nosniff);
  - an archive (`.zip`) -> `application/octet-stream`, attachment, nosniff;
  - an image (`.png`) -> `image/png`, `content-disposition: inline`, `content-security-policy: sandbox; default-src 'none'`, nosniff.
- The front needs no change for the session: the browser sends the `HttpOnly` cookie on its own.

## Front verification evidence (T5-T7)
- `node --check front/srt-codec.js` and `node --check front/media-results.js`: OK.
- `node --test front/srt-codec.test.mjs`: 9/9 pass (real SRT, VTT header, BOM + CRLF, multi-line text, NOTE and cue settings, plain script rejected, serializers, round trip, rows without milliseconds).
- Live browser (headless Chrome over CDP), replayed independently by the parent:
  - the codec is loaded in the page (`cuesFromRows, isSubtitleText, parseCues, parseTimestamp, toSrt, toVtt`);
  - pasting a real SRT and clicking "Importar SRT pegado" fills the rows with the REAL timings (`00:00:01.250/00:00:04.750`, `00:00:05.500/00:00:09.125`, `00:00:10.000/00:00:14.000`), not the fabricated 4-second windows;
  - "Exportar SRT" downloads a `text/plain;charset=utf-8` blob of 155 bytes named `subtitulos.srt`; "Exportar VTT" downloads a `text/vtt;charset=utf-8` blob named `subtitulos.vtt`; the text preview still renders;
  - a plain script keeps the previous behavior (2 rows, `00:00:00 / 00:00:04`);
  - zero console errors.
- Regression of the main flow after both units: "Implementar" -> `POST /api/chat -> 200 (42822ms)`, "Mis Resultados" lists the files (3 images, 3 videos, 9 subtitles), zero console errors.
- Ownership consistency after the live run: 20 files and 23 records, all owned by `local-operator-front` (no orphans, no cross-owner leaks).

## Delivery note
This feature landed in two work units (690 + 450 authored lines). Both exceed the ~400-line review heuristic on their own, mostly because each unit carries its own test suite (369 lines for `api/selftest.mjs`, 123 for `front/srt-codec.test.mjs`). The size is the honest cost of proving the behavior, not padding: no line was removed to fit a budget. When the branch is turned into a PR, the two units are the natural slice boundaries.
