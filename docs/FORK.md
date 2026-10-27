# CyberBrown/gstack: fork guide

Chris's fork of [garrytan/gstack](https://github.com/garrytan/gstack). It is a plain
repository, not a GitHub fork, and it is public.

## Remotes and branches

| Name | Points at | Rule |
|---|---|---|
| `origin` (in a clone of this repo) | `CyberBrown/gstack` | All pushes and PRs go here. |
| `upstream` | `https://github.com/garrytan/gstack.git` | Fetch only. Run `git remote set-url --push upstream DISABLED`. Never push, open PRs or issues, or comment there. |

- **Default branch:** `chris/remove-unused-hosts`. Every change is a branch + PR into it.
- `main` is a stale mirror (v1.35.0.0 + PR #1). Do not target it.
- `fix/sessionstart-anchor` is upstream v1.91.1.0 + 5 fork commits. It is what the Claude
  install runs today and is kept open as PR #4 until the upstream consolidation absorbs it.

Fork point: upstream `40e34de` (v1.35.0.0, 2026-05-14).

## Fork delta (on the default branch)

| Commit | Change | Files |
|---|---|---|
| 4fb3339 | Remove unused hosts: kiro, opencode, factory, cursor, slate | `hosts/*`, `setup`, `docs/ADDING_A_HOST.md`, README |
| cbbd17f | Muse Code host (`./setup --host muse`) | `hosts/muse.ts`, `hosts/index.ts`, `scripts/host-config.ts`, `setup` |
| 3fa9af9 | Route the autoplan Codex voice through the LiteLLM `gstack` profile | `autoplan/SKILL.md.tmpl`, `bin/gstack-codex-probe` |
| f2964eb, 4815a67 | Hermes as an alternative outside voice for `/autoplan` | `bin/gstack-hermes-probe`, `bin/gstack-config`, `autoplan/SKILL.md.tmpl`, `test/hermes-hardening.test.ts` |
| PR #5 | Outside-voice prompts travel via private files; Hermes tree-write guard | `bin/gstack-outside-prompt`, `bin/gstack-hermes-probe`, `autoplan/SKILL.md.tmpl`, `test/outside-prompt.test.ts` |
| PR #6 | Fork manual, probe hardening (SEC-08, BUG-05) | `CLAUDE.md`, `AGENTS.md`, README, this file, `bin/gstack-*-probe` |

Fork commits on `fix/sessionstart-anchor` only (not yet on the default branch): 7e294e6
(`-p gstack` on every Codex call), b9cabb3, ea7286a, 927cded, 57973f0 (SessionStart anchor and
pending-call fixes). Known issue: 7e294e6 adds `-p gstack` unconditionally (BUG-02). Make it
conditional on the profile file when re-applying it.

## Lane configuration

- **Codex outside voice.** `/autoplan` uses Codex profile `gstack` only when both
  `GSTACK_LLM_API_KEY` is set and `${CODEX_HOME:-$HOME/.codex}/gstack.config.toml` exists.
  Otherwise it uses default Codex auth. The key comes from the secret store, never from a
  file in this repo. `bin/gstack-codex-probe` requires the profile file when that key is the
  only auth signal.
- **Hermes outside voice.** Select it with `gstack-config set outside_voice hermes` (or
  `GSTACK_OUTSIDE_VOICE=hermes`). Profile name: `gstack-config set hermes_profile <name>`
  (default `gstack-reviewer`). The profile recipe, including the expected
  `hermes tools list` output, is in the header of `bin/gstack-hermes-probe`. The voice must be
  read-only: `/autoplan` fingerprints the working tree around every Hermes call and discards
  the voice if anything changed.
- **Prompts.** Outside-voice prompts are written to a private file (`bin/gstack-outside-prompt`)
  and passed as `"$_OUTSIDE_PROMPT"`. Never interpolate model-written text into shell source.

## Installs (monsta)

| Path | Harness | Notes |
|---|---|---|
| `~/.claude/skills/gstack` | Claude Code | Runs `fix/sessionstart-anchor`. Its `origin` is upstream; the fork is remote `cyberbrown`. |
| `~/.agents/skills/gstack` | Codex | Plain upstream checkout. |
| `~/.hermes/skills/gstack` | Hermes | Plain upstream checkout (v1.35). |
| `~/.config/muse/skills/gstack` | Muse | Symlinks into the dev checkout `~/projects/gstack`. |

Landing a PR here changes none of these. Which revision each install runs is a separate,
deliberate step: the install pin, decided in claude-config. Deploy procedure: CLAUDE.md,
"Deploying to the active skill (fork-aware)". Never hard-reset an install to its
`origin/main`, and remember that `/gstack-upgrade` pulls `origin main`, which is upstream on
these checkouts.

## Upstream sync procedure

1. `git fetch upstream` (fetch only).
2. `git checkout -b sync/upstream-<YYYY-MM-DD> upstream/main` and re-apply the fork delta as
   small commits, or rebase the default branch onto `upstream/main`. The choice of strategy
   is pending with Chris (OPS-01).
3. Review the upstream diff before merging (supply-chain checklist): new network hosts in
   `bin/`, `lib/` and `browse/`; new hooks under `hosts/claude/hooks`; `package.json` scripts and
   overrides; installers in `setup`; new telemetry fields.
4. `bun install --frozen-lockfile && bun test && bun run gen:skill-docs && git diff --exit-code`.
5. PR into the default branch on CyberBrown/gstack, then tag (`fork-v<upstream-version>-<n>`).

## Public-repo hygiene

This repo is public. Keep estate hostnames, IPs, internal URLs and gateway names out of
commits, commit messages, code comments and PR text. Past commit 7e294e6 names a gateway
host. A history rewrite is not worth it; just don't repeat it.

## Open decisions (Chris)

- OPS-01: upstream consolidation strategy and new default branch name.
- SEC-01: branch protection on this public repo; "reviewed fork tag only" upgrades for every install.
- SEC-05: telemetry to upstream's Supabase (`off` vs `anonymous`). Code default is `off`.
- SEC-06: which repos and data classes may go to the LiteLLM `pro` lane.
- OPS-05: GitHub-only hosting (record the exception) or a Forgejo mirror.

## Fork changelog

- 2026-10-27: prompt-file plumbing for outside voices + Hermes tree guard (PR #5); fork
  manual, `docs/FORK.md`, Hermes recipe update, probe hardening (SEC-08, BUG-05).
- 2026-10-16: Hermes outside voice and LiteLLM Codex lane (PR #2).
- 2026-09-27: Muse host, host pruning (PR #1).
