# npm publishing

## Package checks

Run these checks before publishing or handing off a release candidate:

```sh
# full repo quality gate
deno task check

# build the npm bundle and inspect the package contents without publishing
npm run pack:check
```

`npm run pack:check` runs `npm pack --dry-run`. npm also runs the package `prepack` script first,
which bundles `src/main.ts` into `dist/main.js`.

Before publishing, inspect the dry-run output and confirm it includes the expected shipped files:

- `bin/`
- `dist/main.js`
- `src/`
- `deno.json`
- package docs listed in `package.json` `files`

Do not publish if the dry-run package is missing `dist/main.js`, includes local state/log files, or
contains secrets such as `.env`.

Release flow:

```sh
# 1. bump the package version
npm version patch --no-git-tag-version

# 2. verify the package from the exact tree you will publish
deno task check
npm run pack:check

# 3. commit the release
git add -A
git commit -m "Release x.y.z"

# 4. publish using an npm token loaded from .env
set -a
. ./.env
set +a
npm publish --//registry.npmjs.org/:_authToken="$NPM_TOKEN"
```

Notes:

- `.env` should provide `NPM_TOKEN`.
- Do not commit `.env`.
- The `--//registry.npmjs.org/:_authToken=...` flag overrides any token baked into `~/.npmrc` for
  this invocation. Without it, a stale non-publish token in `~/.npmrc` will win over the env var and
  you'll get `EOTP` even with a publish-capable token in `.env`.
- If your npm account enforces an OTP on top of a publish token, rerun with
  `npm publish --otp=<code>` and the same `--//registry.npmjs.org/:_authToken="$NPM_TOKEN"` flag.
- After publish, the existing shell alias `codex='npx -y pando-proxy'` will pick up the new package
  version automatically.
