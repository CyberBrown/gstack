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

Current base: upstream `959c8a6a4` (v1.91.327.0), synced 2026-10-29 on
`sync/upstream-2026-10-29`, which supersedes the earlier fork delta (PRs #1-#8) and the
live-install branch `fix/sessionstart-anchor` (PR #4).

## Fork delta

Kept small and additive so each upstream sync stays cheap. Upstream code paths are left
in place; the fork adds a run-time layer in front of them.

| Change | Files |
|---|---|
| Muse Code host (`./setup --host muse`) | `hosts/muse.ts`, `hosts/index.ts`, `setup`, `bin/gstack-install-registry.sh`, `bin/gstack-host-renders.sh`, `bin/gstack-uninstall`, README host matrix |
| LiteLLM lane: every outside call goes through the gateway or does not run | `lib/llm-lane.ts`, `bin/gstack-codex-probe` (`-p <profile>` on every codex call), `scripts/resolve-codex-generation-model.ts`, `lib/claude-code.ts`, `lib/outside-voice-api.ts`, `lib/outside-voice-runner.ts` |
| Run-time provider swap: Codex, Claude Code or Hermes per call, with fallback | `lib/outside-voice-runner.ts` (`hermes`, `claude-code` runners, `selectOutsideProvider`), `bin/gstack-outside-voice select`, `scripts/resolvers/outside-voice.ts` (select + swap + fallback in every rendered invocation) |
| Repo trust gate for every outside voice (SEC-06 mechanism) | `lib/outside-trust.ts`, `lib/outside-consent.ts`, `bin/gstack-codex-probe` consent check |
| Config keys | `bin/gstack-config` (`llm_lane`, `outside_voice`, `outside_voice_fallback`, `hermes_profile`, `outside_voice_trust_deny`) |
| Fork CI and the fork-sync skill | `.github/workflows/fork-ci.yml`, `gstack-fork-sync/` |
| Fork tests | `test/fork-outside-lane.test.ts`, `test/transcript-sessionstart-anchor.test.ts`, fork cases in `test/autoplan-publication-guard.test.ts` |
| Test hermeticity for the lane | `test-setup.ts` pins `GSTACK_LLM_LANE=direct` and clears the fork's provider env |

Not carried over, on purpose:

- **Host pruning** (old 4fb3339: drop kiro, opencode, factory, cursor, slate). Upstream
  threads those hosts through ~3,000 lines of `setup`; removing them would conflict on every
  sync. They are inert unless named with `--host`.
- **Prompt-file helper** (old PR #5, `bin/gstack-outside-prompt`). Upstream now writes every
  outside-voice prompt to a private file and never interpolates it into shell source.
- **SessionStart anchor and pending-call hook fixes** (old b9cabb3, ea7286a, 927cded,
  57973f0). Upstream's own rewrites cover them; only the regression tests carry over. One
  case was dropped: upstream now requires a journaled `true autoplan-published` no-op before
  a phase entry, and asserts that deny itself.
- **Upstream-only workflow `if:` guards** (old PR #7). Upstream tests pin job conditions, so
  code guards break 19 of them. The upstream-only workflows are disabled on the fork repo
  instead (`gh workflow disable`); re-check after each sync for newly added ones.

## Lane configuration

- **Mode.** `gstack-config set llm_lane litellm|direct` (env `GSTACK_LLM_LANE` wins).
  Default `litellm`: Codex, Claude Code, Hermes and the api runner all go through the
  LiteLLM gateway with `GSTACK_LLM_API_KEY`. If the lane is not configured the outside voice
  is unavailable (missing coverage) with a repair line; it never falls back to a direct
  provider. `direct` is upstream behavior.
- **Gateway.** Described by the Codex profile file
  `${CODEX_HOME:-~/.codex}/gstack.config.toml` (profile: `GSTACK_CODEX_PROFILE`, default
  `gstack`): top-level `model` (the lane model, e.g. `pro`), `model_provider`, and that
  provider table's `base_url` and `env_key = "GSTACK_LLM_API_KEY"`. `GSTACK_LLM_BASE_URL`
  overrides the URL; it must be https (http only to localhost). Claude Code uses the URL
  without `/v1`, or `GSTACK_LLM_ANTHROPIC_BASE_URL`. The key comes from the secret store,
  never from a file in this repo.
- **Codex.** Every gstack-owned codex call carries `-p <profile>` (added in
  `gstack-codex-probe`'s timeout wrapper) and the lane model. A local `codex` launcher that
  also adds `-p` must skip it when one is already present.
- **Claude Code.** The child gets `ANTHROPIC_BASE_URL` (gateway), `ANTHROPIC_AUTH_TOKEN`
  (lane key) and the lane model on every model slot; `ANTHROPIC_API_KEY`, OAuth tokens and
  Bedrock/Vertex/Foundry switches are removed, and the non-secret part is repeated in the
  `--settings` flag so a user `settings.json` env block cannot repoint it.
- **Hermes.** Select with `gstack-config set outside_voice hermes`. Profile:
  `gstack-config set hermes_profile <name>` (default `gstack-reviewer`). On the lane the
  profile's `model.base_url` must be the gateway, or the Hermes voice is unavailable. Recipe:

  ```bash
  hermes profile create gstack-reviewer --no-skills --no-alias \
    --description "Adversarial outside-voice reviewer for gstack"
  hermes --profile gstack-reviewer config set model.default pro
  hermes --profile gstack-reviewer config set model.provider custom
  hermes --profile gstack-reviewer config set model.base_url <gateway>/v1
  hermes --profile gstack-reviewer config set model.api_key '${GSTACK_LLM_API_KEY}'
  hermes --profile gstack-reviewer config set agent.max_turns 40
  hermes --profile gstack-reviewer tools disable web browser terminal \
    code_execution vision image_gen video_gen tts skills todo memory \
    session_search clarify delegation cronjob computer_use kanban
  ```

  `hermes --profile gstack-reviewer tools list` should show only `file` enabled. `file` is not
  guaranteed read-only, so the runner fingerprints the working tree around each call and
  discards the review if anything changed. `hermes -z` takes the prompt as one argument, so
  prompts over 100 KiB make the Hermes voice unavailable for that call.

## Provider swap

`outside_voice` (env `GSTACK_OUTSIDE_VOICE`): `auto` (the upstream harness rule: Codex
from Claude and other hosts, Claude Code from Codex) or `codex`, `claude-code`, `hermes`.
`outside_voice_fallback` (env `GSTACK_OUTSIDE_FALLBACK`): `auto` (first available of
hermes, codex, claude-code), `none`, or one provider. Every rendered outside-voice block
runs `gstack-outside-voice select` first. If the chosen voice cannot run here it is swapped
for the first available fallback, and if it fails mid-call the fallback runs once. A
provider is never its own harness's outside voice. `OUTSIDE_STATUS` always names the
provider that actually reviewed. `/codex` and `/claude-code` (asked for by name) do not swap.

## Repo trust gate

`gstack-config set outside_voice_trust_deny '~/projects/52L/*:~/clients/*'`
(colon-separated globs, no spaces; also `GSTACK_OUTSIDE_TRUST_DENY`, and the lists add up
across state roots). From a working directory, repo root or worktree of a repo under one of
them, nothing is sent to any outside voice, including `/codex` asked for by name. Checks
fail closed. `GSTACK_OUTSIDE_TRUST_OVERRIDE=1 <command>` lets one deliberate command
through. Which paths to list is Chris's decision (SEC-06). Not handled: Windows drive paths
and case-insensitive filesystems.

## Installs (monsta)

| Path | Harness | Notes |
|---|---|---|
| `~/.claude/skills/gstack` | Claude Code | Its `origin` is upstream; the fork is remote `cyberbrown`. |
| `~/.agents/skills/gstack` | Codex | Plain upstream checkout. |
| `~/.hermes/skills/gstack` | Hermes | Plain upstream checkout. |
| `~/.config/muse/skills/gstack` | Muse | Symlinks into the dev checkout `~/projects/gstack`. |

Landing a PR here changes none of these. Which revision each install runs is a separate,
deliberate step. Deploy procedure: CLAUDE.md, "Deploying to the active skill (fork-aware)".
Never hard-reset an install to its `origin/main`, and remember that `/gstack-upgrade` pulls
`origin main`, which is upstream on these checkouts.

## Upstream sync procedure

1. `git fetch upstream` (fetch only).
2. `git checkout -b sync/upstream-<YYYY-MM-DD> upstream/main` and re-apply the fork delta
   above as small commits (this is how 2026-10-29 was done; OPS-01 is still Chris's call).
3. Review the upstream diff before merging (supply-chain checklist): new network hosts in
   `bin/`, `lib/` and `browse/`; new hooks under `hosts/claude/hooks`; `package.json` scripts and
   overrides; installers in `setup`; new telemetry fields; new workflows (disable the
   upstream-only ones on the fork repo).
4. `bun install --frozen-lockfile && bun run gen:skill-docs && git diff --exit-code && bun run test`.
   Prove any failure pre-exists on plain upstream before calling it pre-existing.
5. PR into the default branch on CyberBrown/gstack, then tag (`fork-v<upstream-version>-<n>`).

## Public-repo hygiene

This repo is public. Keep estate hostnames, IPs, internal URLs and gateway names out of
commits, commit messages, code comments and PR text.

## Open decisions (Chris)

- OPS-01: upstream consolidation strategy and new default branch name.
- SEC-01: branch protection on this public repo; "reviewed fork tag only" upgrades for every install.
- SEC-05: telemetry to upstream's Supabase (`off` vs `anonymous`).
- SEC-06: which repos and data classes may go to the LiteLLM `pro` lane (the deny list).
- OPS-05: GitHub-only hosting (record the exception) or a Forgejo mirror.

## Fork changelog

- 2026-10-29: upstream sync to v1.91.327.0. LiteLLM lane for every outside voice, run-time
  provider swap (Codex, Claude Code, Hermes) with fallback, trust gate on every send path,
  Muse on `defineHost`.
- 2026-10-27: `/autoplan` repo trust gate; prompt-file plumbing; fork manual (PRs #5-#8).
- 2026-10-16: Hermes outside voice and LiteLLM Codex lane (PR #2).
- 2026-09-27: Muse host, host pruning (PR #1).
