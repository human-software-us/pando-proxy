# npm publishing

Release flow:

```sh
# 1. bump the package version
npm version patch --no-git-tag-version

# 2. verify the package from the exact tree you will publish
deno task check
npm pack --dry-run

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
