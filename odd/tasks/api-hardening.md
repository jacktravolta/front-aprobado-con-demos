# Own API Hardening

## Objective
Close the security and data-integrity gaps found by the code review of the own API, without breaking the working front -> API -> meta-api flow.

## Problem
The own API was a control plane with no request-origin validation, an unrestricted `baseUrl`, no output/extraction budgets, and a JSON store that silently reset to empty when a file was corrupted. Deleting a ZIP bundle left its extracted children downloadable. The front also declared `lang="en"` and a placeholder title.

## Scope
- Validate the browser origin of every state-changing request.
- Restrict `baseUrl` to loopback/private hosts unless the operator opts in **in the backend**.
- Cap the upstream response body and the ZIP extraction.
- Quarantine a corrupted JSON store instead of silently overwriting it.
- Cascade the deletion of a ZIP bundle to its extracted children.
- Fix the front language, title and the README instructions.

## Constraints
- Do not modify `/home/test/test/meta-api`.
- Do not break the current front: it calls the API same-origin without credentials.
- Keep the API bound to loopback by default; warn loudly otherwise.
- Plain JSON persistence stays (no database).

## Design decision: the provider-host switch lives in the backend
`allowExternalBaseUrl` is **not** settable from the front.

Threat model: the untrusted boundary is the browser (a page from another site driving the API). A local process is not a boundary it can enforce: it already runs as the same user and can read `api/data/config.json` (0600) and the stored key directly. So a switch reachable from the UI would add no real protection while giving the illusion of one.

- The API validates `baseUrl` (http/https, no embedded credentials, local or private host) on **write and on read**: a hand-edited or shared config file cannot point the API anywhere.
- The operator enables an external provider **in the backend**: `"allowExternalBaseUrl": true` in `api/data/config.json` or `ALLOW_EXTERNAL_BASE_URL=1` in the environment.
- `PUT /api/config` rejects the field with an explicit message so nobody believes it was applied.
- `ALLOW_EXTERNAL_BASE_URL=1` applies to the running process only and is never persisted into the store.
- Extra allowed browser origins are declared in the backend with `ALLOWED_ORIGINS` (comma separated).

## Tasks
- [x] Reject state-changing requests whose `Origin` does not match the server origin (`ALLOWED_ORIGINS` extends it).
- [x] Validate `baseUrl`: http/https only, no credentials, loopback/private host unless the backend allows an external provider. Validated on read and on write.
- [x] Move the external-provider switch out of the front and into the backend only.
- [x] Cap the upstream chat response body (32 MB) and the ZIP extraction (2000 entries, 512 MB uncompressed).
- [x] Quarantine a corrupted JSON store on read and log the incident.
- [x] Delete the extracted children when the parent ZIP is deleted.
- [x] Warn when the API is bound to a non-loopback host (`0.0.0.0` counts as exposed).
- [x] Fix `lang`, the document title and `front/README.txt`.

## Verification evidence
- `node --check api/server.mjs`, `api/media.mjs`, `front/meta-api-client.js`, `front/media-results.js`: OK.
- `/tmp/opencode/verify-hardening.mjs`: 12/12 checks OK.
  - foreign `Origin` -> 403; own `Origin` -> 200; no `Origin` (curl) -> 200.
  - external `baseUrl` without backend permission -> 400 with the exact instruction.
  - `PUT /api/config` with `allowExternalBaseUrl` -> 400 ("no se cambia desde el panel").
  - `baseUrl` with a non-http scheme -> 400; local `baseUrl` -> 200.
  - corrupted `files.json` -> moved to `files.json.corrupt-<timestamp>` instead of being reset.
  - deleting a ZIP with 4 children -> 5 entries removed from the index and from disk.
  - front serves `lang="es"` and the real title; the client script has no provider switch.
- Second instance with `ALLOW_EXTERNAL_BASE_URL=1 HOST=0.0.0.0`: the external URL is accepted, the startup warning is printed, and neither the permission nor the URL leaks into the main instance or into `config.json`.
- A `config.json` holding a disallowed external URL is ignored on read (falls back to the default) and the incident is logged.
- Live CDP walkthrough after the hardening: `POST /api/chat -> 200 (101421ms)`, result panel with the video and the subtitle preview, "Mis Resultados" with 19 files / 3 images / 3 videos / 8 subtitle previews, zero console errors. The origin check does not affect the browser flow.

## Known limitations
- A local process can still drive the API: the trust boundary is the loopback binding plus the origin check. Remote exposure requires a reverse proxy with authentication.
- The API has no per-user identity: the records and files are a single global store, which is the intended shape for a single-operator local tool.
