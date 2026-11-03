---
name: gstack-fork-sync
version: 0.2.0
description: "Sync the CyberBrown/gstack fork with upstream garrytan/gstack: fetch-only upstream remote, a sync branch cut from upstream with the fork delta re-applied as small commits, upstream-diff... (gstack)"
triggers:
  - sync gstack fork with upstream
  - rebase gstack fork onto upstream
  - update the gstack fork
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
  - AskUserQuestion
---
<!-- AUTO-GENERATED from SKILL.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->

# /gstack-fork-sync — Sync the CyberBrown fork with upstream

This skill is for the **CyberBrown/gstack** fork only. It never writes to
upstream: `garrytan/gstack` is fetch-only. Never push, open PRs or issues, or
comment there.

Read `docs/FORK.md` in the fork checkout first. It lists the fork delta, the
lane config, the installs and the default branch. If it is missing, stop:
this is not the fork. Below, "the default branch" means the one `docs/FORK.md`
names (today `chris/remove-unused-hosts`).

## Step 1: Work in a fresh clone, never in an install

The installs listed in `docs/FORK.md` (Claude, Codex, Hermes, Muse) and the
dev checkout are off limits: the Muse install symlinks into the dev checkout,
so switching branches there changes a live install. Clone fresh outside
`/tmp` (it can be a small tmpfs):

```bash
_FORK_DIR="${GSTACK_FORK_DIR:-$HOME/.cache/gstack-fork-sync/gstack}"
_BASE=chris/remove-unused-hosts
if [ ! -d "$_FORK_DIR/.git" ]; then
  mkdir -p "$(dirname "$_FORK_DIR")"
  git clone --branch "$_BASE" git@github.com:CyberBrown/gstack.git "$_FORK_DIR"
fi
cd "$_FORK_DIR"
git remote get-url upstream >/dev/null 2>&1 || git remote add upstream https://github.com/garrytan/gstack.git
git remote set-url --push upstream DISABLED
git remote -v
git fetch origin --tags && git fetch upstream
echo "BEHIND: $(git rev-list --count "origin/$_BASE..upstream/main")"
echo "AHEAD:  $(git rev-list --count "upstream/main..origin/$_BASE")"
```

If `docs/FORK.md` names a different default branch, use it for `_BASE` here
and in every later step. Confirm `origin` is CyberBrown/gstack and the
`upstream` push URL is `DISABLED` before going on. If BEHIND is 0, report
"already in sync" and stop.

## Step 2: Build the sync branch

Cut the branch from upstream, then re-apply the fork delta from
`docs/FORK.md` as small commits, one logical change each:

```bash
cd "${GSTACK_FORK_DIR:-$HOME/.cache/gstack-fork-sync/gstack}"
_SYNC="sync/upstream-$(date +%Y-%m-%d)"
git checkout -b "$_SYNC" upstream/main
git log --oneline "upstream/main..origin/chris/remove-unused-hosts" --no-merges
```

For each fork commit in that list, oldest first, try `git cherry-pick -x
<sha>`. On a conflict:

1. Check whether upstream already absorbed the change. Keep upstream's code,
   carry the fork's regression test over, and run it. If it passes, the
   commit is a test-only carryover; say so in its message.
2. Otherwise keep upstream's structure and re-apply the fork change on top.
   Keep the fork delta small and resolver-based.
3. Never resolve a conflict on a generated `SKILL.md` by picking a side.
   Resolve the `.tmpl` and `scripts/` sources, then regenerate.
4. If a conflict needs a judgment call about fork behavior, ask the user
   with AskUserQuestion instead of guessing.

Do not bump upstream VERSION/CHANGELOG for fork changes. Update the fork
delta table and add a line to the changelog in `docs/FORK.md`.

## Step 3: Upstream-diff supply-chain review (mandatory)

Everything upstream added runs with the user's full rights the first time a
skill or hook fires. Review the upstream range before opening the PR:

```bash
cd "${GSTACK_FORK_DIR:-$HOME/.cache/gstack-fork-sync/gstack}"
_RANGE="$(git merge-base origin/chris/remove-unused-hosts upstream/main)..upstream/main"
echo "== new network hosts in bin/ lib/ browse/"
git diff "$_RANGE" -- bin lib browse | grep -E '^\+' | grep -Eo 'https?://[A-Za-z0-9.-]+' | sort -u
echo "== hook changes"
git diff --stat "$_RANGE" -- 'hosts/*/hooks' 'hosts/claude/hooks'
echo "== package.json scripts / overrides / dependencies"
git diff "$_RANGE" -- package.json | grep -E '^[+-]' | grep -Ev '^(\+\+\+|---)'
echo "== setup installers (curl, npm, npx, bunx, pip, brew)"
git diff "$_RANGE" -- setup setup.ps1 | grep -E '^\+' | grep -En 'curl |wget |npm |npx |bunx |pip |brew '
echo "== telemetry fields"
git diff "$_RANGE" -- 'bin/gstack-telemetry-*' | grep -E '^[+-]' | head -50
echo "== new or changed workflows (each new job needs the upstream-only guard)"
git diff --stat "$_RANGE" -- .github/workflows
```

For each new host, hook, install step or telemetry field: say what it is, who
receives data, and whether it is acceptable. Anything that adds egress, a hook,
or an unpinned installer needs the user's explicit approval (AskUserQuestion)
before the PR is opened. Do not silently accept it.

Every job in a new upstream workflow that uses paid runners (ubicloud), paid
secrets, a schedule, or writes (issues, PRs, releases, packages) needs
`if: github.repository == 'garrytan/gstack'`, combined with any existing
`if:` as `github.repository == 'garrytan/gstack' && (<existing>)`. Check that
the fork's guards survived the sync:

```bash
cd "${GSTACK_FORK_DIR:-$HOME/.cache/gstack-fork-sync/gstack}"
find .github/workflows -name '*.yml' -exec grep -L "github.repository == 'garrytan/gstack'" {} +
```

The only files that list may print are `actionlint.yml`, `skill-docs.yml`,
`dependency-review.yml`, `arm-setup-smoke.yml`, `quality-gate.yml`,
`measure-journal-read.yml`, `native-qualification.yml`, the `windows-*`
workflows, and `fork-ci.yml` (guarded to the fork instead). Any other file is
an unguarded upstream workflow: guard it.

## Step 4: Tests

```bash
cd "${GSTACK_FORK_DIR:-$HOME/.cache/gstack-fork-sync/gstack}"
bun install --frozen-lockfile
bun test test/hermes-hardening.test.ts test/codex-hardening.test.ts \
  test/outside-prompt.test.ts test/host-config.test.ts \
  test/gen-skill-docs.test.ts test/skill-validation.test.ts
bun run gen:skill-docs --host all && git diff --exit-code
bun run test
```

Keep this list in step with the fork-delta job in
`.github/workflows/fork-ci.yml`. Bun only, never npm. Compare failures in the
full free suite against a clean `upstream/main` checkout. Only failures that
also occur there may be called pre-existing.

## Step 5: PR into the fork's default branch

```bash
cd "${GSTACK_FORK_DIR:-$HOME/.cache/gstack-fork-sync/gstack}"
git push -u origin HEAD
gh pr create --repo CyberBrown/gstack --base chris/remove-unused-hosts \
  --title "Sync with upstream $(git describe --tags --always upstream/main)"
```

Always pass `--repo CyberBrown/gstack`. The PR body lists the upstream range,
the supply-chain review results from Step 3, and the test results. Keep estate
hostnames, IPs and gateway names out of the PR text: the repo is public.

## Step 6: Tag and install verification (after merge)

After the user merges, tag the merge commit `fork-v<upstream VERSION>-<n>`
and push the tag to `origin`. Moving the installs to the new tag is a
separate, deliberate step (the install pin). Do it only when the user asks,
following CLAUDE.md "Deploying to the active skill (fork-aware)". Then, for
each install listed in `docs/FORK.md`, verify it runs the tag:

```bash
_INSTALL="<install path from docs/FORK.md>"
echo "$_INSTALL: $(git -C "$_INSTALL" describe --tags --always) $(cat "$_INSTALL/VERSION" 2>/dev/null)"
```

Report: upstream range synced, supply-chain findings, test results, PR URL,
and which installs still run an older revision.
