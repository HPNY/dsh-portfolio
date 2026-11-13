# Contributing to 持仓看板 / dsh-portfolio

Thanks for considering a contribution! This project keeps runtime dependencies at
zero: the browser bundle is plain React (`createElement`) injected via the DSH
module loader, and the host half is plain ESM on top of Node's built-in fetch.
The only dev-only tool is esbuild, which bundles `src/client/*` into the
committed `lib/client.js` artifact.

It is a fork of [`SuCriss/dsh-leekbox`](https://github.com/SuCriss/dsh-leekbox) —
see [NOTICE.md](NOTICE.md) for the attribution and the full change list, and
[lib/identity.js](lib/identity.js) for why some internal identifiers (the
`/api/leekbox/*` route prefix, the `.leekbox-*.json` data filenames, the `lkb_`
CSS prefix) deliberately keep their old names.

## Development setup

1. Clone this repo.
2. Link it into your DSH profile (pick either):

   ```sh
   # junction (Windows)
   mklink /J "%DSH_HOME%\profiles\web\node_modules\dsh-portfolio" "<repo path>"

   # or symlink (macOS / Linux)
   ln -s "<repo path>" "$DSH_HOME/profiles/web/node_modules/dsh-portfolio"
   ```

   Or let DSH do it: `dsh plugin --profile web add github:HPNY/dsh-portfolio`.

3. The plugin row is declared by the bundle patch in
   [`cordis.patch.yml`](cordis.patch.yml), which `dsh plugin` applies as a
   profile bundle layer. If you linked the repo by hand, add the same row to
   `$DSH_HOME/profiles/web/cordis.patch.yml`:

   ```yaml
   - insert:
       - id: portfolio
         name: 'dsh-portfolio'
   ```

4. Refresh the DSH page — the 持仓看板 entry appears in the sidebar panel list.

## Making changes

- Browser code lives in `src/client/` (one file per panel/tab concern). Never
  hand-edit `lib/client.js` — it is the generated bundle:

  ```sh
  npm install     # once (dev-only esbuild, pinned by package-lock.json)
  npm run dev     # watch: rebuild on every save
  # or
  npm run build   # one-shot rebuild
  ```

  Commit the rebuilt `lib/client.js` together with your source changes — CI
  rebuilds it and fails the PR if the committed artifact is stale. A page
  refresh picks up the new bundle (the client half is a linked package, so the
  profile watcher re-imports it).
- `lib/*.js` (the host half) does **not** hot-reload into a running DSH process:
  a page refresh is not enough, and the routes you added will answer 401/404
  and writes will silently not land. Restart DSH, or trigger a profile
  recomposition (e.g. disable and re-enable the plugin row), before testing
  host-side changes.
- Keep runtime dependencies at zero — esbuild is a dev-only tool; React stays
  external (injected by the host's module loader) and must never be bundled.
- Follow the existing tab/region structure and the single CSS string block in
  `src/client/styles.js`. Page layout uses container queries
  (`container-type: inline-size` on `.lkb-page`), not media queries, because the
  panel width depends on whether the sidebar is collapsed.
- A-share color convention: red = up, green = down.
- When a write fails, surface it — never show a state the server did not accept.

## Before opening a PR

```sh
npm run check   # syntax gate over lib/*, build.mjs and src/client/*
npm test        # stubbed regression suite (no network)
```

CI runs this syntax gate, rebuilds the bundle (fails if `lib/client.js` is
stale), runs the full test suite, and validates the manifest. Data sources used
must stay public and free endpoints; never commit credentials or personal
watchlist data.
