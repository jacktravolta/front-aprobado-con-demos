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
- Delivery strategy: `ask-on-risk`, resolved by the maintainer as "split into two slices". Chain strategy: `stacked-to-main`.
- Slice A (backend), branch `feature/own-api-backend`, base `origin/main` (`885159b`): backend work unit `c0716a7` (`feat(api): scope the stores by session and serve generated files safely`), regression assertions `b4c8046` (`test(api): assert owner isolation and legacy bytes on disk`), endpoint docs `5d18e78` (`docs(readme): align the file endpoint docs with the serving rules`), and final owner-pin behavior `15039ce` (`revert(api): keep the owner pin unconditional and leave the exposure to the maintainer`). The intermediate loopback-only commits `c712ca6` and `c013fa7` were explicitly reverted. Files: `README.md`, `api/selftest.mjs`, `api/server.mjs`, `start.sh`. Pull request: #2 (https://github.com/jacktravolta/front-aprobado-con-demos/pull/2).
- Slice B (front), branch `feature/own-api-front`, base `origin/main` (`885159b`): feature ledger `14c498d`, front work unit `4bb4b83` (`feat(front): real SRT import and export in the subtitle editor`), ledger updates `4840b60` and `ae385ad`, and the ledger rewrite `6a8e9b6` (`docs(tasks): record the two-slice delivery and the verification evidence`). Files: `front/index.html`, `front/media-results.js`, `front/srt-codec.js`, `front/srt-codec.test.mjs`, `odd/tasks/own-api-identity-and-srt.md`. Pull request: #3 (https://github.com/jacktravolta/front-aprobado-con-demos/pull/3).
- Both slices are based on `origin/main`, are mergeable in either order, and touch disjoint files.
- The former combined pull request #1 is closed as superseded by these two slices.

## Backend verification evidence (Slice A)
- `node --check api/server.mjs`: OK.
- `node --test api/selftest.mjs`: 6/6 pass. The suite covers strict session cookies, per-session file and record isolation, ignored client-supplied ownership, legacy adoption, the unconditional `OWNER_SESSION` pin, and safe document/media serving.
- `git diff --check origin/main...HEAD`: OK.
- Live against the real store (`./start.sh`, `OWNER_SESSION=local-operator-front`): the 19 pre-existing files were adopted and `api/data/owner.json` holds `{"primary": "local-operator-front"}`.
  - Documents and subtitles were attachments with safe MIME and nosniff.
  - ZIP was `application/octet-stream`, with an attachment disposition.
  - PNG was `image/png`, inline, sandboxed and nosniff.
- The front needs no change for the session: the browser sends the `HttpOnly` cookie on its own.

## Front verification evidence (Slice B)
- `node --check front/srt-codec.js` and `node --check front/media-results.js`: OK.
- `node --test front/srt-codec.test.mjs`: 9/9 pass.
- The front suite passes on the front slice without Slice A's backend work (the front diff contains no backend files), proving that the slices are independent.
- Live headless-Chrome/CDP walkthrough (a runtime harness, not an automated test): the codec loads in the page; importing real SRT fills the editor rows with real timings (`00:00:01.250/00:00:04.750`, `00:00:05.500/00:00:09.125`, `00:00:10.000/00:00:14.000`); SRT and VTT exports download `subtitulos.srt` and `subtitulos.vtt` blobs; a plain script keeps the prior behavior; there were zero console errors.
- Known limitation: the DOM/Blob integration in `front/media-results.js` has no automated regression test; the codec itself is covered by `front/srt-codec.test.mjs`.
- Main-flow regression: "Implementar" -> `POST /api/chat -> 200 (42822ms)`, "Mis Resultados" lists the files, with zero console errors.
- Ownership consistency after the live run: 20 files and 23 records, all owned by `local-operator-front` (no orphans, no cross-owner leaks).

## Delivery note
- Authored review load: Slice A's backend work unit = 607 lines (562 additions + 45 deletions, including the 369-line `api/selftest.mjs`); its follow-up commits bring the current slice diff to 635 lines (589 additions + 46 deletions). Slice B = 450 product and test additions plus this ledger.
- Both slices exceed the ~400-line review budget because each unit carries its own test suite. No line was removed or shrunk to fit; each over-budget slice needs an explicit maintainer size exception.

## Owner pin decision
- **Decision (maintainer, 2026-11-22).** The `OWNER_SESSION` pin is unconditional: when it is configured, every request uses that owner session regardless of the bind address. Whether and how the port is exposed remains the maintainer's decision.
- **Implementation.** `api/server.mjs:307` validates `OWNER_SESSION`, `api/server.mjs:333` applies it to every request, `api/server.mjs:1797` logs the pinned session, and `start.sh:14` provides the local operator default. Starting with `OWNER_SESSION` unset keeps strict per-session cookie isolation.
- **Test coverage.** `api/selftest.mjs:286` proves the pin is applied while preserving the browser session cookie; the complete Slice A suite passes 6/6.
- **Operational consequence.** The server does not infer, restrict, or migrate exposure policy. Host, firewall, proxy, and reverse-proxy configuration remain the maintainer's responsibility.
- **Work units.** The final Slice A behavior is `15039ce` (`revert(api): keep the owner pin unconditional and leave the exposure to the maintainer`), which explicitly reverts the intermediate loopback-only implementation `c712ca6` and its documentation `c013fa7`.
