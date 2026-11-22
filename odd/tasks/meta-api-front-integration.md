# Meta API Front Integration

## Objective
Split the project into a static front and an own API. The own API is the only component that communicates with `meta-api`; the front only calls the own API.

## Problem
The current front is a single static `index.html` that generates prompts locally and calls `actions` for persistence. It cannot talk to `meta-api` directly because `meta-api` has no CORS and the browser must not handle the Meta session or API key.

## Scope
- Create `api/` as an own Node HTTP API.
- Move the current front into `front/`.
- The own API serves the front statically and exposes `/api/*`.
- The own API configures `meta-api` as an OpenAI-compatible provider: base URL, API key, model.
- The own API forwards chat requests to `meta-api` `/v1/chat/completions`.
- The own API forces a ZIP result, downloads it from `meta-api`, stores it under its own storage, and returns a same-origin download URL to the front.
- The own API manages generated file metadata and bytes with plain JSON text files and filesystem folders. No database.
- The own API implements the existing `actions` persistence contract with a plain JSON store.
- The front gets a settings panel for the own API connection.
- The front gets a real "Generar ZIP con Meta AI" action on prompt cards.
- The front lists the files managed by the own API and saves generated ZIP links in "Mis Resultados".

## Constraints
- Do not modify `/home/test/test/meta-api`.
- Do not invent `meta-api` endpoints; use the verified `/v1/chat/completions`, `/v1/models`, `/v1/ajustes`, `/v1/media`, `/v1/chat/clear`.
- The front must not receive or store the Meta API key; the own API stores it server-side.
- The front must work same-origin; no CORS.
- `meta-api` is currently open (`auth: abierta`); it will later require `Authorization: Bearer <key>` or `X-API-Key`.
- The generated ZIP must be downloadable from the own API, not from a raw Meta CDN URL.

## Tasks
- [x] Create `api/server.mjs` with config, health, chat, file proxy, and `actions` persistence.
- [x] Create `front/` and move `index.html`, `demos/`, and `README.txt` into it.
- [x] Add `front/meta-api-client.js` with settings, generate, download, and results-link UI.
- [x] Insert the client script into `front/index.html` before the React bundle.
- [x] Add root `README.md` and `start.sh`.
- [x] Verify the own API starts, serves the front, and proxies `/api/health`.
- [x] Verify text + attachment -> ZIP through the own API.
- [x] Verify the front can save the ZIP link in `Mis Resultados`.
- [x] Add `POST /api/improve` to the own API: receives `{text, mode?: 'text' | 'prompt', module?, field?}`, calls `meta-api` with a strict "return only the final result" prompt, and returns `{text}`.
- [x] Add a "Mejorar con IA" button to every text input and textarea in every module. The button is disabled when the field is empty, calls `/api/improve`, and writes the returned text back into the same field.
- [x] Add the same "Mejorar con IA" button to every prompt field of every module functionality, using `mode: 'prompt'`. This button improves the prompt itself, not the legal text, and returns only the rewritten prompt.
- [x] Make every module prompt dynamic: it is built from the current input values and regenerated with the "Generar prompt" button (verified: the typed and improved field value appears in the generated prompt). No separate "Actualizar prompt" control was delivered; the "Generar prompt" button is the refresh action.
- [x] Verify the improve endpoint returns clean text without comments, prefixes, quotes, or markdown wrappers for both `text` and `prompt` modes.
- [x] Add an "Implementar" button to every module where a prompt is generated. It sends the full prompt through the own API to `meta-api` and downloads every generated asset.
- [x] Extend the own API generation endpoint to return and store all `meta_files`: images, videos, audio, SRT/subtitles, ZIP bundles, documents, and any other multimedia file.
- [x] Classify each stored file as `image`, `video`, `audio`, `subtitle`, `archive`, `document`, or `other`, and expose that kind in `files.json` and `GET /api/files`.
- [x] If `meta-api` returns a ZIP, keep the ZIP as a downloadable bundle and extract its entries (safe extraction, zip-slip rejected) indexing each file as an individual asset.
- [x] Build the front result panel from the stored assets: image gallery, video player, audio player, SRT preview/download, ZIP download, and generic file downloads.
- [x] Make "Implementar" the primary action on every prompt; keep a separate ZIP download when a ZIP bundle exists.
- [x] Verify a real generation through the own API: ZIP downloaded, extracted and indexed.
- [x] Verify visually in a real browser engine: live walkthrough over the Chrome DevTools Protocol (headless Chrome), including the "Implementar" and "Mis Resultados" flows.

## Fixes from the live verification
- [x] `data-meta-improve` marker collided between the field and its button, so the click hit the field instead of the button. Field marker is now `data-meta-improve-field`.
- [x] `meta-api` materializes artifacts once per channel, so a second "Implementar" returned nothing. The own API now calls `POST /v1/chat/clear` on the first attempt (`fresh: true`) using a per-prompt `project` slug.
- [x] The "Mis Resultados" file block never rendered: the `MutationObserver` only watched `childList` while React switches tabs through the `aria-hidden` attribute. It now observes attributes and re-creates the block if React wipes it.
- [x] `meta-api` cannot materialize Meta's artifacts in this environment (`systemd-run failed: bwrap: loopback: Failed RTM_NEWADDR`), so files arrived as `meta_files_pendientes`. The own API now downloads them from the direct URLs Meta publishes in the answer, rejects the HTML viewer pages, and expands the ZIP into individual assets.
- [x] Meta sometimes cuts the answer right before the download section. The delivery rules now require one markdown link per file at the end of the message, and a retry asks only for the links.

## Verification evidence
- `node --check api/server.mjs`, `api/media.mjs`, `front/meta-api-client.js`, `front/media-results.js`: OK.
- `GET /api/health` -> `{"ok":true, ... "models":["meta-ai","meta-ai-chat"]}`.
- `POST /api/improve` mode=text -> solo texto mejorado, sin comentarios.
- `POST /api/improve` mode=prompt -> solo prompt reescrito, sin comentarios.
- `POST /api/chat` real -> `files[]` con `resultado.zip` (archive) + `resumen.txt` (document, `parentId` del ZIP);
  `unzip -l` confirma `resumen.txt` dentro del ZIP; el resumen contiene `PRUEBA_ZIP`.
- `GET /api/files/:id/:name?inline=1` -> `content-disposition: inline`; `?download=1` -> `attachment`.
- `api/data/files.json` -> indice con `kind`, `bytes`, `parentId`.
- Live CDP walkthrough (`/usr/bin/google-chrome` + DevTools Protocol, scripts in `/tmp/opencode/cdp*.mjs`):
  - "Mejorar con IA" on a field -> the same field receives the rewritten text.
  - "Mejorar con IA" on a prompt -> the prompt textarea receives the rewritten prompt (only the final prompt).
  - "Implementar" -> `POST /api/chat` 200 in 83-110 s -> result panel with download links, video player and SRT previews.
  - "Mis Resultados" -> injected block "Archivos generados por la API" with 23 files, 3 images, 3 videos, 9 subtitle previews.
  - No browser console errors during the walkthrough.
- API request log: `POST /api/chat -> 200 (83485ms)`, `POST /api/chat -> 200 (110648ms)`.
- Screenshots and JSON reports: `/tmp/opencode/cdp5/01-mis-resultados.png`, `02-resultados.png`, `03-mis-resultados-final.png`, `report.json`.

## Contract notes (meta-api, verified in this session)
- `meta_images[]` trae `{url (CDN), mime, bytes, path, local: "/v1/media/..."}`: la ruta
  descargable es `local`, no `url`.
- `meta_files[]` / `meta_zip` traen `url` con forma `/v1/media/...` en modo local.
- `meta_files_pendientes[]` son archivos que el modelo menciono pero que `meta-api`
  no materializo: se reportan como `warnings`, no se inventan.
- La conversacion se identifica por `user + project` (`canalId`): usar el mismo canal
  hace que `meta-api` marque lo ya entregado como pendiente. Por eso la prueba de
  entrega real usa un `project` propio.
- `POST /v1/chat/clear` conserva el `canalId` (user + project) pero abre una conversacion
  nueva en Meta: es la via para pedir una entrega fresca sin perder el canal.
- Los enlaces que Meta publica en la respuesta (`[nombre](url)`) son descargables
  directamente. La URL de `a.metaaiusercontent.com/document` devuelve el visor HTML
  (no el archivo) y se descarta; el ZIP, MP4, SRT y VTT si devuelven bytes.

## Known limitations
- `meta-api` no puede materializar los artefactos en este entorno (falla `bwrap` por
  permisos de red). La API propia lo compensa descargando los enlaces directos de la
  respuesta, pero los documentos que Meta solo publica como visor HTML quedan como
  warning (su contenido suele venir dentro del ZIP).
- La generacion en Meta es variable: un mismo prompt puede requerir hasta 3 intentos
  (la API reintenta automaticamente y en el reintento pide solo los enlaces).
- El proyecto no es un repositorio git: no hay commits ni work-units posibles.
- RDD esta desactivado (`review mode status` -> off, decided by global): no hay
  revision nativa que ejecutar.
