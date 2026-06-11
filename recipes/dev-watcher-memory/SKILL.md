---
name: dev-watcher-memory
description: >
  Use when a dev server (Metro/Expo, Next.js, webpack, Vite, nodemon) balloons
  to many GB of RAM, the machine starts swapping, or HMR/Fast Refresh slows to a
  crawl over time. Covers the two-layer watch model (OS watcher vs bundler
  file-map), how to find what's being crawled, and the scope/worker/heap caps
  that fix it.
---

# Dev Watcher Memory

A dev server's RSS is dominated by how many files it *watches and parses*, not
by your app's size. The default behavior of every JS dev tool is to crawl
**everything under the project root** — and a Goliath project root holds far
more than app source: built output (`dist/`), a Python venv (`verbatim/`,
thousands of files), `logs/`, `uploads/`, scrape caches, `test-fixtures/`. None
of it is imported by the app, but the watcher crawls it, dependency-parses it,
holds it in an in-memory file-map, and re-walks it on every change. That's how a
dev server quietly grows past 8 GB and HMR latency climbs as the day goes on.

The fix is almost never "give it more heap." It's **narrow the scope** so the
watcher only sees real source. The single highest-leverage insight:

> **There are TWO independent watch layers and you must scope BOTH.** The OS
> file watcher (Watchman / chokidar / `fs.watch`) is one. The bundler's own
> file-map / haste-map / module graph crawler is a *separate* layer that walks
> and dependency-parses the tree regardless of what the OS watcher ignores.
> Telling Watchman to skip `verbatim/` does nothing if Metro's file-map still
> crawls it. Excluding it in the bundler does nothing if Watchman still streams
> 2,000 change events from a venv. Scope one and the leak persists through the
> other.

Reference implementation: `docpost/docpost-app` —
[`metro.config.js`](metro.config.js) (file-map `blockList` + `maxWorkers`),
[`.watchmanconfig`](.watchmanconfig) (`ignore_dirs`), and the `dev` script in
`package.json` (`NODE_OPTIONS=--max-old-space-size`). In that repo, an unscoped
file-map crawling `dist/` (~90 multi-MB built API bundles) and `verbatim/` (a
~2.5k-file Python venv) drove dev RSS past 8 GB; scoping both layers brought it
back down.

## The two layers

| Layer | What it does | Where you scope it |
|---|---|---|
| **OS file watcher** | Subscribes to filesystem change events; emits them to the bundler. Watchman maintains its own crawl + in-memory tree per watched root. | Watchman: `.watchmanconfig` `ignore_dirs`. chokidar/nodemon: `ignored` option. |
| **Bundler file-map / module graph** | Crawls the tree to build a map of every module, then dependency-parses files to resolve `require`/`import`. This is the big memory consumer — it holds ASTs and metadata. | Metro: `resolver.blockList`. Next/webpack: `watchOptions.ignored`. Vite: `server.watch.ignored`. |

Both default to "the entire project root." Both must be told the same exclusion
list. Keep the two lists **in sync** — a dir in one but not the other still
leaks through the unscoped layer.

## Diagnose first

Don't guess. Measure which process, how big, and what it's crawling.

**1. Find the offending process and its RSS** (macOS):
```bash
ps aux | grep -iE "expo|metro|next|node|vite" | grep -v grep \
  | awk '{printf "%6.0fMB  %s %s\n",$6/1024,$11,$12}' | sort -rn | head
```
A healthy Metro/Next dev server is a few hundred MB to ~1.5 GB. Multiple GB, or
steady growth across a session, means scope or a leak.

**2. See what the OS watcher is rooted on:**
```bash
watchman watch-list                       # which roots are watched
watchman watch-project "$PWD"             # what root a dir resolves to
watchman -j <<< '["query","'$PWD'",{"expression":["type","f"],"fields":["name"]}]' \
  | python3 -c 'import sys,json;print(len(json.load(sys.stdin)["files"]),"files watched")'
```
If the file count is 5–50× your source file count, the watcher is crawling
non-source trees.

**3. Find the heavy directories under the root** — these are your exclusion
candidates. Big *or* file-dense both hurt (file-dense is worse for the
file-map):
```bash
du -sh */ 2>/dev/null | sort -rh | head
for d in */; do printf "%-20s %s files\n" "$d" "$(find "$d" -type f 2>/dev/null | wc -l)"; done | sort -k2 -rn | head
```
Usual suspects: `dist/`, `build/`, `.next/`, a Python venv, `logs/`,
`uploads/`, scrape/raw caches, `test-fixtures/`, `coverage/`, `.expo/web/cache`.

**4. Confirm none are imported by app source** before excluding — `grep` the
import graph. If a dir is genuinely a source dependency, excluding it breaks
resolution; the fix there is different (move it, or symlink real source in).

## Fix: scope the watcher

### Watchman (`.watchmanconfig` at the watched root)
```json
{
  "ignore_dirs": ["dist", "verbatim", "logs", "uploads", "test-fixtures", "node_modules/.cache", ".expo/web/cache"]
}
```
Paths are relative to the watched root, no globs. `node_modules` is already
ignored by Watchman's defaults; list only the *extra* trees.

### chokidar / nodemon / generic `fs.watch`
Pass an `ignored` matcher (anchored regex or function, not a bare glob that
also matches substrings):
```js
chokidar.watch(root, { ignored: /[\\/](dist|verbatim|logs|uploads|node_modules)[\\/]/ })
```
nodemon: `"ignore": ["dist/*", "logs/*", "uploads/*"]` in `nodemon.json`. If
you've reached for `CHOKIDAR_USEPOLLING=true`, that's a red flag — polling
re-`stat`s the whole tree on an interval and is far heavier; remove it and fix
scope instead.

## Fix: scope the bundler file-map

### Metro / Expo (`metro.config.js`)
Add an anchored regex to `resolver.blockList`. Anchor to the project root so you
exclude `<root>/dist` but not a legitimately-imported `node_modules/.../dist`:
```js
const path = require("path");
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const IGNORED_DIRS = ["dist", "verbatim", "logs", "uploads", "test-fixtures"];
const ignoreRe = new RegExp(
  `^${escapeRe(__dirname + path.sep)}(${IGNORED_DIRS.join("|")})(${escapeRe(path.sep)}.*)?$`,
);
const prior = config.resolver.blockList;
config.resolver.blockList = Array.isArray(prior) ? [...prior, ignoreRe]
  : prior ? [prior, ignoreRe] : ignoreRe;
```
**Why anchored + preserve prior:** an unanchored `/dist/` matches inside
`node_modules` and breaks real packages; clobbering `prior` drops Expo's own
defaults. Keep the same dir list as `.watchmanconfig`.

### Next.js / webpack (`next.config.js`)
```js
webpack: (config, { dev }) => {
  if (dev) config.watchOptions = {
    ...config.watchOptions,
    ignored: ["**/node_modules/**", "**/dist/**", "**/logs/**", "**/uploads/**"],
  };
  return config;
},
```
On Next 14+ also consider `experimental.webpackMemoryOptimizations: true`. For
Turbopack, scope via `turbo.watchOptions` / move non-source out of the root —
Turbopack honors fewer ignore knobs, so relocation matters more there.

### Vite
```js
server: { watch: { ignored: ["**/dist/**", "**/logs/**", "**/uploads/**"] } }
```

## Fix: cap workers and heap (secondary, not a substitute for scope)

**Worker count.** Metro/jest-style transformers default to
`os.cpus().length` workers, and each holds ~400–700 MB of Babel/AST state during
bundling. On a 10+ core Mac that's 4–7 GB of transform workers alone. Cap it,
with an env override so CI (many vCPUs, lots of RAM) isn't throttled:
```js
config.maxWorkers = Number(process.env.METRO_MAX_WORKERS) || 4;
```

**Heap ceiling.** Set `NODE_OPTIONS=--max-old-space-size=<MB>` on the dev
script so a runaway crashes loudly instead of swapping the machine to death:
```json
"dev": "NODE_OPTIONS=--max-old-space-size=4096 expo start --port {PORT}"
```
This is a *guardrail*, not a fix. **Why it's not the fix:** raising the cap to
mask a scope problem just lets the leak grow until it OOMs anyway, while
swapping makes the whole machine unusable first. Fix scope, then set a ceiling
that real workloads stay under. (Global rule: never escalate
`--max-old-space-size` to paper over a crawl — slow and resource-abusive.)

**Persistent transform cache (optional).** Pin Metro's cache to an explicit
`FileStore` (`METRO_CACHE_DIR`) so only changed modules re-transform between
runs. Cache keys include content + transformer-config hashes, so a stale cache
is colder, never wrong.

## Fit-to-Project

Before implementing, check:
- **Which dev tool(s) actually run here?** Expo→Metro+Watchman; Next→webpack or
  Turbopack; a custom server→nodemon/chokidar. A Goliath stack can have a
  Metro app *and* a Next SSR app — scope each independently.
- **Is the git repo a subfolder of the project root?** It usually is. The
  watched root and the heavy non-source trees (`verbatim/`, raw caches, large
  data) often sit at the *project root* outside the repo subfolder — that's
  exactly why they're not in `.gitignore` and get crawled. Run the diagnostic
  from the watched root, not the repo.
- **What's the exclusion list for THIS repo?** Derive it from the diagnostic
  (step 3), don't copy docpost's verbatim. Confirm each candidate isn't an
  imported source dependency (step 4) before adding it.
- **Worker cap:** 4 is a sane laptop default; tune to `cores/2` and override in
  CI via env. **Heap cap:** size to ~1.5× observed steady-state RSS *after*
  scoping, not before.

## Anti-Patterns

- **Raising `--max-old-space-size` as the fix** — masks an unbounded crawl; the
  leak grows to the new ceiling and OOMs anyway, after swapping the machine.
  The cap is a guardrail; scope is the fix.
- **Scoping only one layer** — ignoring `verbatim/` in `.watchmanconfig` but not
  Metro's `blockList` (or vice versa). The unscoped layer still crawls it and
  RSS stays high. Always change both, with the same list.
- **`CHOKIDAR_USEPOLLING=true` to "fix" missed changes** — polling re-`stat`s
  the entire tree on a timer; it multiplies the cost of an already-too-broad
  scope. Fix the scope; reserve polling for network/virtual filesystems only.
- **Unanchored exclusion regex** — `/dist/` or `/logs/` without a root anchor
  matches the same-named dir inside `node_modules` or a package, silently
  breaking module resolution. Anchor to the project root.
- **Clobbering the tool's existing ignore list** — assigning `blockList` /
  `watchOptions.ignored` directly instead of appending drops the framework's
  own defaults (e.g. Expo's). Spread the prior value in.
- **Excluding a directory that IS imported** — moves the leak into a broken
  build. Verify against the import graph first; if real source lives in a heavy
  tree, relocate the *non-source* part instead of excluding the whole dir.
- **Treating it as a code memory leak first** — it almost never is. The 10×
  RSS is watch scope. Profiling app heap before checking what's being crawled
  burns hours; run the diagnostic first.
- **Spawning a fresh dev server to "test the fix"** — the first compile is slow
  and you lose the warm cache; the running server picks up `metro.config.js` /
  `.watchmanconfig` changes on restart of *that* process only. Kill and
  relaunch the existing one; don't leave a second instance running.

## Verification

After scoping, prove it dropped — don't assume:
1. Restart the affected dev process (config files like `metro.config.js`,
   `.watchmanconfig`, `next.config.js` are boot-time — HMR will NOT pick them
   up; this is one of the rare edits that genuinely requires a restart).
2. Re-run the watched-file count (`watchman` query) — it should fall to roughly
   your source file count.
3. Re-run the RSS check after a warm-up bundle and a few HMR cycles. Expect a
   multi-GB → sub-GB (or low-GB) drop and a flat, not climbing, curve.
4. Exercise HMR on a real source file to confirm watching still works for code
   that matters.

## Logging

No runtime component to log. For diagnosis, capture the before/after of the
watched-file count and steady-state RSS in the PR/commit message — it's the
evidence the scope change worked and the baseline for catching regressions when
someone later adds a new heavy dir under the root without updating both lists.
