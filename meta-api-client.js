// front/meta-api-client.js — connection panel and generated-file manager.
//
// The front NEVER talks to meta-api. It only calls the own API:
//   GET/PUT /api/config, GET /api/health, GET/DELETE /api/files.
//
// The panel keeps the meta-api base URL and API key on the server side, so the
// browser never stores the key. Generated files are managed by the own API and
// persisted as plain JSON plus files on disk.

