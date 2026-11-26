# Pages publication and FTP demo publication

## Objective
Publish the front in two places and make every static asset resolve in both:
- GitHub Pages: `https://jacktravolta.github.io/front-aprobado-con-demos/`
- FTP demo folder: `public_html/demo/` on `osaka.tecnoinver.cl:21` (account `web@creacionesharu.cl`)

## Problem
The front shipped with `<base href="/">`. That makes every relative reference resolve against the domain root, so on a project Pages site the browser asked for `https://jacktravolta.github.io/demos/...` instead of `https://jacktravolta.github.io/front-aprobado-con-demos/demos/...` and every image, video and audio returned 404. The same base breaks the FTP copy, where the front lives one level down under `/demo/`.

The FTP account for `web@creacionesharu.cl` has its docroot at the FTP root: the login lands directly on the landing site (`index.html`, `css/`, `js/`, `assets/`, `robots.txt`, `sitemap.xml`), there is no `public_html/` directory inside the account.

## Why
The user wants the front reachable in public places with the videos visible, not only the React shell. A demo folder keeps the landing at `/` untouched.

## Scope
- `front/index.html`: one attribute, the document base URL.
- `gh-pages` branch: republish the `front/` subtree with the corrected base.
- FTP: upload the front under `demo/`, without touching the landing files at the FTP root.

## Constraints
- Do not modify the landing files that live at the FTP root (`index.html`, `css/`, `js/`, `assets/`, `robots.txt`, `sitemap.xml`).
- Do not modify `/home/test/test/meta-api`.
- The own API keeps serving the front at `/`; the local mode must not regress.
- The static host has no own API: `/api/*` and `/actions` are expected to fail there. The demo content is what must work.

## Design decisions
**Relative base in the repo.** `<base href="./">` resolves against the directory of the current document, so the same file works at the Pages project path, at the FTP subfolder and at the local server root. No per-target patch in the repository.

**Target-specific base for the FTP copy.** The FTP artifact is generated from a staging copy with `<base href="/demo/">`, because the live path is known there and an explicit path cannot drift with a missing trailing slash.

**Relative fetch paths left untouched.** `media-results.js` calls `/api/chat`, `/api/improve`, `/api/files` and `/actions` as absolute paths, which the base tag does not affect. Those endpoints belong to the own API and are unavailable on a static host.

## Tasks
- [x] T1. FTP: confirm login, locate the real docroot and the quota.
- [x] T2. FTP: create `demo/` and upload the 24 front files (23 assets plus `index.html`), generating the subfolder copy with the `/demo/` base.
- [ ] T3. Repo: set the document base to `./` so the same file resolves on Pages, on the FTP subfolder and on the local server.
- [ ] T4. Publish the `front/` subtree to `gh-pages` and verify the live assets return 200 from the project path.

## Acceptance criteria
- `https://jacktravolta.github.io/front-aprobado-con-demos/` serves the front.
- `https://jacktravolta.github.io/front-aprobado-con-demos/demos/modelos/01_mujer_musculosa_pelo_negro.webp` and `.../demos/modulo1/video_modulo1_gym_pelea.mp4` return 200.
- The served HTML carries the relative base, and no asset request targets the domain root.
- `http://127.0.0.1:8787/` still serves the front and its assets.
- The FTP `demo/` folder holds the front and the landing files at the FTP root are unchanged.

## Applicable checks
- `git diff` review of `front/index.html`.
- `node --check` on the touched scripts and `node --test front/srt-codec.test.mjs`.
- HTTP probes on the live Pages paths for the HTML and for one image, one video and one audio file.
- FTP listing of `demo/` and of the root, to prove the landing was not touched.

## Progress
- 2026-11-26: FTP upload finished. 24 files, 73 MB, zero failures. The demo copy carries `<base href="/demo/">`.
