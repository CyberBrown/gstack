# Fable Deep Review — CyberBrown/gstack — 2026-10-20

> Reviewer: Claude (Fable fan-out reviewer), read-only review. The only file written is this report.
> Reviewed clone: `CyberBrown/gstack` default branch `chris/remove-unused-hosts` @ `308496a`, plus the
> installed copies the estate actually runs (read-only inspection, nothing modified).

## Header — derived assumptions (operator blanks were unfilled)

| Field | Derived value |
|---|---|
| Repo | `CyberBrown/gstack`, a **public, non-network copy** (`fork:false`, `parent:null` per `gh api repos/CyberBrown/gstack`) of upstream `garrytan/gstack`, which is MIT. Default branch `chris/remove-unused-hosts`, not `main`. |
| Stack | A Bun/TypeScript + bash skill suite. `*/SKILL.md.tmpl` is rendered by `scripts/gen-skill-docs.ts` into `SKILL.md` per host (`hosts/*.ts`). `bin/` holds about 100 bash/Bun helpers that every skill preamble sources. `browse/` is a Playwright daemon with a Chrome extension. `setup` installs into `~/.claude/skills`, `~/.agents/skills`, `~/.config/muse/skills` and `~/.hermes/skills`. Telemetry goes to upstream's Supabase. |
| Deploy targets | There is no server deploy. "Deploying" means a git checkout plus `./setup` on each agent host (monsta-mash confirmed; prometheus UNVERIFIED). |
| Hard constraints (estate) | (1) Branch + PR only, never push to the default branch directly. (2) **Never open anything against `garrytan/gstack`.** (3) `~/.claude/settings.json` must stay machine-agnostic. (4) Credentials live in OpenBao/Proton Pass, never in files or repos. (5) Never use the monsta RTX 3080. (6) Bun, not npm. |
| Live probes | **FORBIDDEN**, because the field was unfilled. The only checks run were local reads, `git`, `gh api` GETs and `gh run list`. |
| Scope | **In scope:** (a) the fork's delta against upstream and its sync state; (b) the surfaces the estate runs: install topology, hooks, `autoplan`/Codex/Hermes outside voices, `gstack-upgrade`, telemetry/egress, `browse` daemon exposure; (c) the supply-chain risk of running the suite with broad permissions. **Scoped out:** an exhaustive review of the ~770 upstream files (design/iOS/gbrain/make-pdf/extension UI, the eval harness internals, Supabase edge functions). Phases 6, 7 and 8 are N/A for the fork, as explained below. |
| Re-review mode | No prior `docs/reviews/FABLE-REVIEW-*.md` exists, so this is a first review. |

---

## 1. Executive summary

**Overall:** The fork's own code delta is small, careful and well tested. It is 6 commits: Muse host, host pruning, the LiteLLM Codex lane, and Hermes as the outside voice. 133 + 348 unit tests pass locally. The problem is **operational, not code quality**. The default branch is **259 commits / ~56 minor versions behind upstream** (v1.35.0.0 against upstream v1.91.162.0). **No Claude Code install on monsta runs it.** The estate runs **four different gstack builds at once**, they share one `~/.gstack` state directory, and two of them are plain upstream clones with no fork changes. The fork fixes that are actually live in Claude Code sit on an unmerged feature branch. The repo's own CLAUDE.md tells agents to `git reset --hard origin/main` in that install, and on this host `origin` is upstream. In parallel, the stale v1.35 code that *is* live (Muse, Hermes) still carries vulnerabilities upstream has since fixed. One of them: the fork's new Hermes voice copies a shell-interpolation hazard that upstream already removed. The supply chain amounts to "pull a fast-moving single-maintainer main and run `./setup`, under bypass-permissions", with no reviewed-SHA pin.

**Top 10 findings**

| # | ID | Sev | One line |
|---|---|---|---|
| 1 | OPS-01 | High | Four concurrent gstack builds (v1.35 ×2, v1.79, v1.91.1). The default branch is deployed to Claude Code nowhere, and the fork's merged PR #1/#2 work is absent from the Claude install. |
| 2 | SEC-01 | High | Supply chain: unpinned upstream pulls plus `./setup` (bun/bunx/npm installs) execute under bypass-permissions. The GitHub repo has no branch protection, all Actions are allowed, and SHA pinning is not required. |
| 3 | SEC-03 | High | Fork autoplan interpolates model-written summaries into double-quoted bash for `codex exec` and `hermes -z` (`autoplan/SKILL.md.tmpl:506,537,628-629,654-655,782`). Backticks or `$()` in that text execute. Upstream already fixed this with prompt files. |
| 4 | DOC-01 | High | `CLAUDE.md:787` instructs `cd ~/.claude/skills/gstack && git fetch origin && git reset --hard origin/main`. On monsta, `origin` = garrytan, so this destroys the installed fork branch. |
| 5 | OPS-02 | High | The live Claude install runs `fix/sessionstart-anchor` (5 fork commits: LiteLLM lane, SessionStart transcript anchor). It has no PR and is not on the default branch, and `gstack-upgrade` targets upstream `origin/main`. |
| 6 | SEC-02 | Medium | The v1.35 code live via Muse/Hermes carries upstream-fixed issues: basic-ftp 5.2.0 (CVE-2026-39983), old sharp/adm-zip, a `/health` token leak through a forgeable `Origin`, and fail-open `careful` guards. |
| 7 | SEC-06 | Medium | Every gstack Codex call in the live install is hard-routed to the LiteLLM `pro` lane, which maps to Kimi k3 according to code comments. Repo code and plans go to a third-party model with no per-repo consent. |
| 8 | SEC-05 | Medium | `telemetry: anonymous` sends usage events to upstream's Supabase: 124 telemetry-sync + 45 update-check sends recorded between 2026-08-17 and 2026-10-20. |
| 9 | BUG-01 | Medium | `outside_voice: hermes` is set in `~/.gstack/config.yaml`, but the Claude install has no Hermes support, so the setting is silently ignored and Codex/LiteLLM runs instead. |
| 10 | TOOL-01 | Medium | Fork CI never runs the test suite. `evals.yml` only triggers on PRs to `main`, which is not the default branch. Scheduled jobs target `ubicloud-standard-2`, which does not exist, and sit queued until cancelled. |

Counts: **Critical 0 · High 5 · Medium 10 · Low 12 · Polish 1**

## 2. Scorecard

| Phase | Grade | Justification |
|---|---|---|
| 0 Recon | — | Topology mapped. The surprise: the default branch is not what runs. |
| 1 Docs | D | CLAUDE.md, AGENTS.md and README are upstream verbatim, with no fork operating manual. CLAUDE.md contains a destructive instruction that is wrong for the fork. |
| 2 Tooling/CI | D+ | Only actionlint and the skill-docs freshness check run on fork PRs. Test/eval lanes are mis-targeted at `main` or at a nonexistent runner. |
| 3 Security | D | The fork code itself is OK. The supply-chain posture, the live stale code with known vulns, the shell interpolation, and third-party egress pull the grade down. |
| 4 Code quality | B | The delta is tidy, follows hygiene rules and is test-pinned (`test/hermes-hardening.test.ts`, 378 lines). The Hermes block is duplicated 4× instead of going through a resolver. |
| 5 Bugs | C | The configured voice is silently ignored, the profile is hard-wired, a cross-version shared state dir, and temp-file leaks. |
| 6 UI/UX | N/A | The fork does not touch the extension or sidebar. Upstream UI is scoped out. |
| 7 DB/backend | N/A | The only backend is upstream's Supabase telemetry, covered under SEC-05. |
| 8 Web perf | N/A | No site is served. |
| 9 Ops | F | Four builds, three branches claiming to be the trunk, unmerged live fixes, hooks in shared settings with absolute paths, and no sync cadence with upstream. |

---

## 3. Findings by phase

### Phase 0 — Recon

**Architecture sketch**

```
 garrytan/gstack (upstream main, v1.91.162.0, 2026-10-20)
        │  fork point 40e34de = v1.35.0.0 (2026-05-14)
        ▼
 CyberBrown/gstack (public, not a GH fork)
   ├─ chris/remove-unused-hosts  (DEFAULT)  v1.35 + 6 commits  [259 behind]
   │     4fb3339 remove kiro/opencode/factory/cursor/slate
   │     cbbd17f add Muse host            (PR #1)
   │     3fa9af9/f2964eb/4815a67 LiteLLM Codex lane + Hermes voice (PR #2)
   ├─ main                       v1.35 + PR#1 only           [259 behind, 3 ahead]
   ├─ chris/autoplan-hermes-voice (merged; still checked out in ~/projects/gstack)
   └─ fix/sessionstart-anchor    upstream v1.91.1 + 5 fork commits [131 behind]  ← NO PR

 Installs on monsta-mash (what actually executes):
   ~/.claude/skills/gstack   git, branch fix/sessionstart-anchor, v1.91.1, origin=garrytan, remote cyberbrown, 32 untracked
   ~/.agents/skills/gstack   git, garrytan main, v1.79.0.0 (2026-09-01), 31 dirty → Codex harness; running browse+terminal-agent daemons
   ~/.hermes/skills/gstack   git, garrytan main, v1.35.0.0, clean
   ~/.config/muse/skills/gstack → symlinks into ~/projects/gstack (dev checkout, chris/autoplan-hermes-voice, v1.35)
   shared state: ~/.gstack/ (config.yaml, analytics, security/egress.jsonl, sessions, openai.json)
   hooks: ~/.claude/settings.json:210,242,252,316 → /home/chris/.claude/skills/gstack/hosts/claude/hooks/*

 Skill runtime: SKILL.md preamble → bash → ~/.claude/skills/gstack/bin/* (telemetry, config, probes)
                outside voices → codex exec (-s read-only, -p gstack → LiteLLM) | hermes -z (-t file)
```

**Surprises (signal):**
1. The default branch is a dead end for Claude Code. The install that runs is on a different fork branch that rebased onto upstream v1.91.1.
2. `~/.gstack/analytics/skill-usage.jsonl` shows runs from **7 gstack versions** (1.91.1 ×74, 1.79 ×40, 1.67 ×17, 1.88.1 ×15, …). The 40 v1.79 runs come from the plain-upstream `~/.agents` install, and one of them is a `/review` run on 2026-10-20.
3. Live daemons `browse/src/server.ts` (127.0.0.1:44292) and `terminal-agent.ts` (127.0.0.1:28535) were started 2026-10-20 00:12 **from the v1.79 upstream install**, not from the fork.

### Phase 1 — Documentation

| ID | Sev | Evidence | Impact | Fix | Effort |
|---|---|---|---|---|---|
| DOC-01 | High | `CLAUDE.md:782-791` ("Deploying to the active skill": `git fetch origin && git reset --hard origin/main`). The installed checkout's remotes: `origin → https://github.com/garrytan/gstack.git`, `cyberbrown → CyberBrown/gstack`. | An agent following the repo's own manual hard-resets the live install onto unreviewed upstream main, dropping branch `fix/sessionstart-anchor` and its 5 fork commits from the working tree. They survive only on the `cyberbrown` remote. | Replace with a fork-aware deploy section: `git -C ~/.claude/skills/gstack fetch cyberbrown && git checkout <reviewed-tag-or-branch> && ./setup`. State explicitly that "origin is upstream on monsta; never reset to it". | S |
| DOC-02 | Medium | `CLAUDE.md` differs from upstream by 3 lines (`git diff 40e34de HEAD -- CLAUDE.md`). `CLAUDE.md:455-483` (garrytan-agents PR workflow, "push the branch to `garrytan/gstack`"). `CLAUDE.md:485+` (VERSION/CHANGELOG bump rules for upstream releases). There is no mention of the default branch, the upstream remote, the LiteLLM lane, Hermes or Muse. | Agents can open PRs or push against garrytan (forbidden by the estate), bump upstream-style VERSIONs on fork commits, or target `main`. | Add a top-of-file **Fork operating manual** (draft below) and mark the upstream-maintainer sections "upstream-only, do not apply in this fork". | S |
| DOC-03 | Low | `README.md` is upstream's. Its install line (`git clone … garrytan/gstack`) and the host table edited by the fork (`git diff 40e34de HEAD -- README.md`) describe neither the fork nor how the estate installs it. | A human onboarding cold installs upstream, not the fork. | Add a "This is Chris's fork" banner and fork install steps. Link `docs/FORK.md`. | S |
| DOC-04 | Low | The recipe in `bin/gstack-hermes-probe:22-33` disables everything except `file`. The live `~/.hermes/profiles/gstack-reviewer/config.yaml:15-18` has `platform_toolsets.cli: [file, kanban]`. | The documentation and the live profile drift apart (see SEC-04). | Document the expected `hermes tools list` output and add `kanban` to the disable list. | S |

**Proposed replacement CLAUDE.md:** keep upstream's body, prepend the following, and annotate upstream-only sections.

```markdown
# CLAUDE.md — CyberBrown/gstack (Chris's fork of garrytan/gstack)

## READ FIRST — fork operating manual
- This repo is a FORK. Upstream = https://github.com/garrytan/gstack (fetch-only; push URL disabled).
  NEVER push, open PRs, issues or comments against garrytan/gstack.
- Default branch: `chris/remove-unused-hosts` (until OPS-01 consolidation renames it). All work = branch + PR
  into the default branch on CyberBrown/gstack. `main` is a stale mirror — do not target it.
- Fork delta lives in: hosts/muse.ts, hosts/index.ts, scripts/host-config.ts, setup (muse/host pruning),
  bin/gstack-hermes-probe, bin/gstack-codex-probe (GSTACK_LLM_API_KEY), bin/gstack-config (outside_voice,
  hermes_profile), autoplan/SKILL.md.tmpl (outside-voice selection), scripts/resolvers/constants.ts (-p gstack lane).
  Keep it minimal and resolver-based so upstream rebases stay cheap.
- Estate lanes: Codex outside voice → `~/.codex/gstack.config.toml` profile `gstack` → LiteLLM gateway, key
  GSTACK_LLM_API_KEY (from OpenBao, never a file in this repo). Hermes voice → profile `gstack-reviewer`.
- Installs on monsta: ~/.claude/skills/gstack (Claude), ~/.agents/skills/gstack (Codex), ~/.hermes/skills/gstack,
  ~/.config/muse/skills/gstack (symlinks into ~/projects/gstack!). On those checkouts `origin` may be UPSTREAM.
  Deploy = `git fetch cyberbrown && git checkout <reviewed tag> && ./setup`. NEVER `git reset --hard origin/main`.
- Upstream sync: `git fetch upstream && git rebase upstream/main` on a `sync/upstream-<date>` branch, run
  `bun test` + `bun run gen:skill-docs --dry-run`, review the upstream diff for new egress/hooks/postinstall, PR.
- Tests: `bun test` (free suite). Fork-delta minimum: test/hermes-hardening.test.ts test/codex-hardening.test.ts
  test/host-config.test.ts test/gen-skill-docs.test.ts test/skill-collision-sentinel.test.ts.
- Forbidden: committing secrets, editing ~/.claude/settings.json from setup with absolute paths, GPU work on monsta,
  `npm`/`npx` (Bun only), VERSION/CHANGELOG upstream-release bumps on fork commits (use a FORK.md changelog).
## Upstream manual (applies unless overridden above)
… (existing upstream content; sections "Checking out PRs from garrytan-agents", "CHANGELOG + VERSION style",
"Publishing native OpenClaw skills to ClawHub", "Deploying to the active skill" marked UPSTREAM-ONLY)
```

**README/docs fixes:** (1) a fork banner plus install-from-fork snippet; (2) add `docs/FORK.md` (delta inventory, sync procedure, lane config); (3) document the Hermes reviewer profile recipe, including `kanban` disabled; (4) remove the `rm -rf ~/.factory…/~/.kiro…` uninstall lines that the fork already dropped, which is correct, and add the `.config/muse` path, which is already done.

**Verified OK:** `docs/ADDING_A_HOST.md` was updated consistently with the host pruning. The CLAUDE.md project-structure tree reflects `muse.ts`. `bin/gstack-hermes-probe` has an accurate header contract (hygiene rules, functions).

### Phase 2 — Skills, tooling, CI

| ID | Sev | Evidence | Impact | Fix | Effort |
|---|---|---|---|---|---|
| TOOL-01 | Medium | `.github/workflows/evals.yml:2-4` (`pull_request: branches: [main]`) and `make-pdf-gate.yml` (same). The default branch is `chris/remove-unused-hosts`. `gh run list`: PR #2 got only Workflow Lint and Skill Docs Freshness. Windows Free Tests ran once. `evals-periodic.yml:18` and `ci-image.yml:18` use `runs-on: ubicloud-standard-2`, and 4 runs each went queued then cancelled (2 still queued for about 16h on 2026-10-20). | The fork's 378-line Hermes hardening test and the host-config tests never ran in CI. Phantom queued jobs pile up. | Add `fork-ci.yml` on `pull_request` (all branches), `ubuntu-latest`, running `bun install --frozen-lockfile && bun test <free suite>`. Disable the ubicloud scheduled workflows (or `if: github.repository == 'garrytan/gstack'`). | S |
| TOOL-02 | Low | `~/.claude/skills/gstack`: 32 untracked files, including executables `bin/gstack-codex-probe.bak-20260822-182931`, `bin/chrome-cdp`, `bin/gstack-brain-consumer`, `bin/gstack-platform-detect`, and stale tests. `git status --porcelain`. | Stale executables in the `bin/` that skills put on their path. Hard to tell what is live. | `git clean -n` review, then remove leftovers after confirming no references remain (`grep -r <name> */SKILL.md`). | S |
| TOOL-03 | Low | No fork-specific skill or runbook exists for syncing upstream (see OPS-01). | Every sync is ad hoc, which is how the fork ended up 259 commits behind. | Add a `gstack-fork-sync` skill (outline below). | M |

**Recommended skill — `gstack-fork-sync` (SKILL.md outline)**
- *Encodes:* the remotes (`upstream` fetch-only, `origin`=CyberBrown); the fork-delta file list; the rebase procedure on `sync/upstream-YYYY-MM-DD`; the test commands; a mandatory **upstream-diff supply-chain checklist** (new `curl`/`fetch` hosts in `bin/` or `lib/`, new hooks in `hosts/claude/hooks`, `package.json` scripts/overrides, `setup` installers, telemetry fields); PR to the default branch; then a deploy to each install by reviewed tag, with a version check (`cat VERSION` in all 4 installs).
- *Why agents fail without it:* they follow upstream CLAUDE.md (DOC-01/02), reset to `origin` (which is upstream), or run `/gstack-upgrade`, which pulls `origin main`.

**Verified OK:** `actionlint.yml` and `skill-docs.yml` pass on the fork (7/7 success). `bun.lock` is committed, and the default branch's lock matches `~/projects/gstack/bun.lock`. Local run against the fork delta: `bun test test/hermes-hardening.test.ts test/codex-hardening.test.ts test/host-config.test.ts test/skill-collision-sentinel.test.ts` gave **133 pass / 0 fail**, and `bun test test/gen-skill-docs.test.ts` gave **348 pass / 0 fail**. Both runs used deps symlinked read-only from `~/projects/gstack/node_modules`, and the symlink was removed afterwards.

### Phase 3 — Security

| ID | Sev | Evidence | Impact | Fix | Effort |
|---|---|---|---|---|---|
| SEC-01 | High | Execution surface: every skill preamble runs `~/.claude/skills/gstack/bin/*`. 4 hooks run on every AskUserQuestion and Stop (`~/.claude/settings.json:210,242,252,316`). The estate runs Claude Code in bypass-permissions mode. Update path: `gstack-upgrade/SKILL.md:142-145` (`git fetch origin; git pull --ff-only --autostash origin main; ./setup`). `setup:1300-1302` (`bunx playwright install chromium`). `setup:1341-1342` (`npm install --no-save playwright` / `@ngrok/ngrok`, unpinned). Upstream cadence: 259 commits in 5 months, with "~50 community PRs absorbed" waves (CHANGELOG v1.64/v1.67.1). GitHub: default branch unprotected (`.../protection` returns 404), `actions/permissions` = `allowed_actions: all, sha_pinning_required: false`, repo **public**. | Any upstream commit (or compromised dependency or contributor PR absorbed upstream) runs with Chris's full user rights the first time a skill or hook fires: `~/.claude`, the OpenBao CLI, git credentials, SSH keys. Nothing gates an upstream pull on review. Upstream's own 1.67.1 sweep found 6 real issues in absorbed code. | (1) Pin each install to a **reviewed fork tag**, never upstream main. Point every install's `origin` at CyberBrown and keep `upstream` fetch-only. (2) Sync upstream only through the `gstack-fork-sync` checklist (TOOL-03). (3) Enable branch protection on the default branch (required PR + CI). Set Actions to "selected" with SHA pinning. (4) Replace `npm install --no-save` in `setup` with `bun add --exact` pinned versions, or make it fail if they are missing. | M |
| SEC-03 | High | `autoplan/SKILL.md.tmpl:506,537` (`<insert CEO dual voice findings summary …>`), `:628-629,654-655` (`<insert CEO/Design consensus table summary>`), `:782`. These sit inside the double-quoted argument to `codex exec "…"` and `hermes … -z "…"`, which the model fills in and runs through Bash. The Hermes additions at `:372,531,648,808` copy the pattern 4×. Upstream fixed this. Installed `autoplan/sections/design-phase.md` (v1.91.1): "Write the complete prompt … to a private file … never interpolate user text into shell source", followed by `_OUTSIDE_PROMPT=$(cat "$_OUTSIDE_INPUT")`. | Summaries routinely contain backticks (`code`), `$VAR`, `"` and `$(…)`. Inside double quotes, bash executes backtick and `$()` substitutions. A plan file from an untrusted repo, or prompt-injected review text, therefore becomes **arbitrary command execution** in Chris's shell. The minimum symptom is corrupted prompts and quoting breaks. The code is live via Muse (`~/.config/muse/skills/gstack → ~/projects/gstack`). | Port upstream's prompt-file pattern into the fork's Hermes blocks: write the prompt with the Write tool to a `mktemp -d` file, then `hermes … -z "$(cat "$f")"`. This is best solved by rebasing onto upstream (OPS-01) and re-adding Hermes as a resolver that reuses upstream's `_OUTSIDE_PROMPT` plumbing. | M |
| SEC-02 | Medium | Live v1.35 trees: `~/projects/gstack` (runtime for Muse) and `~/.hermes/skills/gstack`. Default-branch `bun.lock` has `basic-ftp@5.2.0`, `sharp@0.34.5` and `adm-zip@0.5.17`. `~/projects/gstack/node_modules/basic-ftp` = 5.2.0. Upstream fixes: `f55e270` (basic-ftp 5.3.1, CVE-2026-39983 + 3 HIGH), v1.87.1 (`6b09a58`, sharp/adm-zip). `browse/src/server.ts:1401-1415` returns `token: AUTH_TOKEN` to any caller whose `Origin` header *starts with* `chrome-extension://`, and any local process can forge that header. Upstream fixed this "/health token leak" in v1.63.0.0 (installed `CHANGELOG.md:2395`). Upstream v1.61.0.0 (`CHANGELOG.md:2493`) fixed safety guards that failed open on chained deletes and command substitution. | Known-fixed vulnerabilities remain executable on monsta. Exploitability is local, since the browse daemon binds 127.0.0.1. | Rebase onto upstream (OPS-01). Until then, stop running v1.35: re-point Muse at the reviewed install, and either delete `~/.hermes/skills/gstack` or re-install it from the reviewed tag. | M |
| SEC-04 | Medium | `autoplan/SKILL.md.tmpl:372` (`hermes --profile … --ignore-rules --in "$_REPO_ROOT" -t file -z …`) compared with the Codex path, which uses `-s read-only`. The Hermes `file` toolset ("File Operations") is enabled in `hermes --profile gstack-reviewer tools list`. Whether it includes write/patch tools is UNVERIFIED (U-2). The live profile also enables `kanban` (`config.yaml:15-18`). | The "outside voice" is not read-only. A prompt-injected plan or repo file could make Hermes modify the working tree during /autoplan. | Enforce read-only at the tool level: a Hermes read-only file toolset or `--readonly` if available, or run inside a throwaway `git worktree` and `git diff --exit-code` after the call (fail the voice if the tree changed). Disable `kanban`. | S |
| SEC-05 | Medium | `~/.gstack/config.yaml`: `telemetry: anonymous`. `~/.gstack/security/egress.jsonl`: `telemetry-sync → frugpmstpnojnhfyimgv.supabase.co` 124 sends (2026-08-17 to 2026-10-20), plus `update-check` to Supabase, github.com and raw.githubusercontent.com 45 each (until 2026-10-08). The payload (`bin/gstack-telemetry-sync:88-103`) strips repo/branch/installation_id. `error_message` is redacted and capped at 200 chars (`bin/gstack-telemetry-log:184-209`). | Estate usage patterns (skills, durations, outcomes, error text) flow to a third party, the upstream maintainer. Controls are reasonable, but this egress belongs to the estate decision ladder and was never explicitly approved. | ⚠ DECISION: set `telemetry: off` via `gstack-config set telemetry off`, or record an explicit approval. Either way, have the fork default `telemetry` to `off`. | S |
| SEC-06 | Medium | Installed `scripts/resolvers/constants.ts:66-76` (fork commit `7e294e6`): `CODEX_FRONTIER_MODEL='pro'`, with `-p "${GSTACK_CODEX_PROFILE:-gstack}"` folded into every Codex flag. The code comment says lane `pro` maps to "Kimi k3-256k". Every /review, /ship, /plan-*, /codex and /autoplan outside voice sends diffs, plans and file contents through it. | Code from every repo, including client repos (Solamp) and possibly 52L repos (52L is not part of the estate, per memory), goes to a third-party model provider by default, with no per-repo opt-out. | ⚠ DECISION: approve or deny the lane per data class. Add a repo trust gate (`gstack-config` key, or upstream's `brain_trust_policy`-style deny list) before any outside-voice call. | M |
| SEC-07 | Low | `~/.gstack/openai.json` (key `api_key`, used by `design-openai`, 18 sends to api.openai.com) is a plaintext secret on disk. Its ACL grants `user:metis:r--`, but the `~/.gstack` directory mask is `---`, so the effective access is blocked. | A credential outside OpenBao, contrary to the estate's credential model. | Source it from OpenBao at runtime (`claude-bao get …`) or env. Remove the metis ACL entry. | S |
| SEC-08 | Low | `bin/gstack-hermes-probe:59-60`: `_var` is parsed from `config.yaml`, then `${!_var:-}`. Verified locally: `_var='a[$(echo INJECTED >&2)]'; "${!_var}"` prints `INJECTED`. | A crafted `api_key: ${a[$(cmd)]}` in a Hermes profile executes `cmd` at preflight. The config is user-owned, so the risk is low, but it is a trivially fixable code-exec gadget. | Validate `[[ $_var =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] \|\| return 1` before indirect expansion. Use `grep -F`/anchored literal for the `.env` lookup. | S |
| SEC-09 | Low | Public commit message `7e294e6` names the estate gateway host (`sandstorm-helsinki-1`). | Minor infrastructure disclosure in a public repo. | Keep estate hostnames out of public commit messages and comments from now on. History rewrite is not worth it. | S |

**Secrets scan:** the fork delta (`git diff 40e34de HEAD`) contains only test placeholders (`sk-litellm-test` in `test/hermes-hardening.test.ts`). The Hermes profile's `api_key` is an env reference (`${…}`), not a literal. No hardcoded live secrets were found in the delta.

**Verified OK:** the Codex outside voice runs `-s read-only` in both branches. The browse and terminal-agent daemons bind `127.0.0.1` only (`ss -ltnp`). The terminal-agent token file is `0600`. `gstack-upgrade`'s reset fallback is gated behind an AskUserQuestion listing the commits it would discard (`gstack-upgrade/SKILL.md:150-165`). `update_check: false` is set, and the last update-check egress was 2026-10-08. Egress receipts are hash-chained and written before sending.

### Phase 4 — Code quality

| ID | Sev | Evidence | Impact | Fix | Effort |
|---|---|---|---|---|---|
| QUAL-01 | Low | The Hermes invocation block is copy-pasted 4× in `autoplan/SKILL.md.tmpl` (`:366-395`, `:525-560`, `:642-672`, `:803-830`, each re-sourcing the probe and re-deriving the profile), while upstream moved voice plumbing into `autoplan/sections/*.md` and resolvers. | Guaranteed rebase conflicts with upstream's carve. A fix to one block (SEC-03, BUG-04) must be repeated 4×. | Implement Hermes as an `{{OUTSIDE_VOICE_HERMES}}` resolver in `scripts/resolvers/`, on top of upstream's section structure. | M |
| QUAL-02 | Polish | `bin/gstack-codex-probe` differs between the default branch and the installed branch: the same `_k3` change with different comments, and the model/profile probe exists only on fix-branch. | Two divergent implementations of one fork feature. | Converge during the OPS-01 consolidation. | S |

**Verified OK:** `bin/gstack-hermes-probe` follows its own hygiene contract (no `set -e`, `trap` or `PATH=`, and namespaced functions), and the test pins it. `_gstack_hermes_voice_ok` correctly treats the usage file as the success signal, because `hermes -z` exits 0 on API errors. `gstack-config` validates `outside_voice` values. The host-config tests cover Muse's `hostSubdir` sharing with Codex.

### Phase 5 — Bugs

| ID | Sev | Evidence / trigger | Confidence | Fix | Effort |
|---|---|---|---|---|---|
| BUG-01 | Medium | `~/.gstack/config.yaml` has `outside_voice: hermes`. The installed Claude tree (v1.91.1) has no `outside_voice` key: `grep -n outside_voice ~/.claude/skills/gstack/bin/gstack-config` returns nothing, and there is no `bin/gstack-hermes-probe`. Every Claude /autoplan therefore silently uses Codex via LiteLLM. Only Muse (v1.35) honours it. | High | Land Hermes on the branch that is actually installed (OPS-01), or surface "configured voice unsupported" in the preamble. | M (via OPS-01) |
| BUG-02 | Medium | Installed `constants.ts` adds `-p "${GSTACK_CODEX_PROFILE:-gstack}"` to every Codex call unconditionally. On any host without `~/.codex/gstack.config.toml` (prometheus? CI? other users of the public fork), every Codex voice errors out. Meanwhile `bin/gstack-codex-probe` (installed, lines 29-33) reports `AUTH_OK` from `GSTACK_LLM_API_KEY` alone, so preflight is green and the voice fails. The default branch handles this correctly (`autoplan/SKILL.md.tmpl:298-307`, which falls back when the profile file is missing). | Medium-High | Make the profile flag conditional on the profile file existing (resolver-generated bash), mirroring the default branch logic, and require the profile file in the auth probe when `-p` will be used. | S |
| BUG-03 | Medium | Shared `~/.gstack` state is written by 4 builds (v1.35, 1.79, 1.91.1, plus history of 1.60-1.88), and 7 versions appear in `skill-usage.jsonl`. Upstream changed state layout and ownership in v1.80 ("hooks share one state root") and v1.88.1 ("harden … owned state"). Observed: `~/.gstack/terminal-port` = 28555, but the live terminal-agent listens on 28535. | Medium | Run a single reviewed build everywhere (OPS-01). Until then, give the stale installs a separate `GSTACK_HOME` or remove them. | M |
| BUG-04 | Low | `autoplan/SKILL.md.tmpl:371,530,647,808`: `mktemp /tmp/gstack-hermes-usage.XXXXXX.json` is never removed, and 1 leftover was observed. It also ignores `$TMPDIR`. | High | `trap 'rm -f "$_HERMES_USAGE"' EXIT` and `${TMPDIR:-/tmp}` (upstream pattern). | S |
| BUG-05 | Low | Default-branch `bin/gstack-codex-probe` returns `AUTH_OK` on `GSTACK_LLM_API_KEY` even when `gstack.config.toml` is absent. autoplan then falls back to the default lane, which 401s according to commit `7e294e6`'s message. The result is a green preflight and a failed voice. | Medium | Have the probe check the profile file when that key is the only signal. | S |

**Verified OK:** the Hermes timeout path handles exit 124 and degrades the voice. `_OUTSIDE_VOICE` is whitelisted (`autoplan/SKILL.md.tmpl:254-255`). The Muse runtime root refuses to `rm -rf` the gstack dir itself (`setup:521+` guards `!= "$gstack_dir"`).

### Phase 6 — UI/UX: N/A
The fork does not modify `extension/` or any UI. Upstream UI was scoped out.

### Phase 7 — Database/backend: N/A
The fork has no DB. Upstream's Supabase telemetry backend is covered in SEC-05. `supabase/` was scoped out.

### Phase 8 — Web performance: N/A
No site is served.

### Phase 9 — Ops / open category

| ID | Sev | Evidence | Impact | Fix | Effort |
|---|---|---|---|---|---|
| OPS-01 | High | Sync state: `git rev-list --count HEAD..upstream/main` = **259**, ahead **6**, merge-base `40e34de` (v1.35.0.0, 2026-05-14). Upstream is now v1.91.162.0. Install matrix as in the Phase 0 sketch: Claude = `fix/sessionstart-anchor` v1.91.1. Codex (`~/.agents`) = garrytan main v1.79, 31 dirty files. Hermes = garrytan v1.35. Muse = symlinks into the dev checkout `~/projects/gstack` (branch `chris/autoplan-hermes-voice`). | No install runs the default branch. PR #1/#2 work (host pruning, Muse, Hermes, LiteLLM-in-autoplan) is absent from Claude and Codex. Bug and security fixes are unevenly applied, and any change to `~/projects/gstack` changes Muse live. | One trunk, one reviewed build: (1) rebase the fork delta (6 default-branch commits + 5 fix-branch commits) onto current upstream on `sync/upstream-2026-10`; (2) make that the default branch and retire `main`/`fix/*`; (3) tag it `fork-v1.91.x-1`; (4) re-install all 4 hosts from that tag, with Muse pointing at an install dir, not the dev checkout. | L |
| OPS-02 | High | `git log 2a113ae..57973f0` in `~/.claude/skills/gstack`: 5 fork commits (LiteLLM routing, SessionStart anchor fixes, 2026-09-25/27). They are pushed to `cyberbrown/fix/sessionstart-anchor` but have no PR (`gh pr list` shows only #1 and #2) and are not on the default branch. The install's `origin` is upstream, and `gstack-upgrade` pulls `origin main`. | The working fixes live only on a feature branch. One `/gstack-upgrade` "A) discard" answer, or a DOC-01 reset, drops them from the running install, which would break /autoplan publication guards and the Codex lane again. | Open a PR for the fix branch now (base default branch, even before the rebase), or fold it into the OPS-01 sync PR. Rename the install's remotes (`origin`→CyberBrown, `upstream`→garrytan). | S |
| OPS-03 | Medium | `~/.claude/settings.json:210,242,252,316` hardcodes `/home/chris/.claude/skills/gstack/hosts/claude/hooks/*`, written by gstack setup, in the **shared, machine-agnostic** claude-config `settings.json`, with no existence guard. Other estate hooks use the `sh -c '[ -x … ] \|\| exit 0; exec …'` guard form. | On a host with a different `$HOME` or without gstack, every AskUserQuestion and Stop fires a failing hook. Setup also rewrites a git-tracked shared file. | Move gstack hook registration to `/etc/claude-code/managed-settings.json` (the per-machine layer), or wrap it in the guarded `exec` form with `$HOME`. Make setup's settings-writer target that file. This is cross-repo with `claude-config`. | S |
| OPS-04 | Low | `origin/main` = v1.35 + PR #1 (3 ahead, 259 behind) is a second stale trunk. Merged branch `chris/autoplan-hermes-voice` is still on the remote and checked out in `~/projects/gstack`. | Agents and humans can target the wrong trunk. | Delete or retire `main` after OPS-01 (or make `main` the real trunk and switch default to it), and delete merged branches. | S |
| OPS-05 | Low | Hosting: the repo is on GitHub only, while the review spec says the canonical host is Forgejo. There is no Forgejo mirror for this repo (UNVERIFIED, U-5). | Inconsistent with the estate's canonical-host convention. | ⚠ DECISION: keep GitHub (it is public and upstream-adjacent) and record the exception in the estate wiki, or mirror to Forgejo. | S |

**Verified OK:** the license is MIT and upstream's LICENSE is preserved. `gstack-upgrade` refuses to auto-reset over dirty or unpushed work without an explicit choice. `auto_upgrade` defaults to `false`.

### Duplicate cross-reference (rule 10)

| Duplicate | Canonical | Note |
|---|---|---|
| "v1.35 stale vulns" (Ops angle) | SEC-02 | OPS-01 is the remediation vehicle. |
| "default branch not deployed" (BUG angle of BUG-01) | OPS-01 | BUG-01 keeps the user-visible symptom. |
| "fix branch lost on reset" (DOC-01 trigger) | OPS-02 | DOC-01 covers the instruction, OPS-02 the branch state. |
| "Hermes duplicated blocks" (SEC-03/BUG-04 fix multiplicity) | QUAL-01 | |
| "codex probe AUTH_OK on key alone" | BUG-02 (installed) / BUG-05 (default) | Separate because the branches differ. They converge in OPS-01. |

---

## 4. Improvement playbook (dependency-ordered)

- **M1 — Stop the bleeding (docs + live-fix preservation):** DOC-01, DOC-02, DOC-03, OPS-02, SEC-08, BUG-04, BUG-05, DOC-04. These are small, safe edits on the current default branch, and they preserve the fix branch via PR.
- **M2 — Consolidate onto current upstream (one trunk):** OPS-01, SEC-03, QUAL-01, QUAL-02, BUG-02, SEC-04, OPS-04, TOOL-02. Depends on M1.
- **M3 — Reinstall all hosts from a reviewed tag + shared-state hygiene:** SEC-02, BUG-01, BUG-03, OPS-03. Depends on M2.
- **M4 — Supply-chain governance + CI:** SEC-01, TOOL-01, TOOL-03. Depends on M2, and can run in parallel with M3.
- **M5 — Egress decisions (human-gated):** SEC-05, SEC-06, SEC-07, SEC-09, OPS-05. Independent, but needs Chris.

## 5. Agent prompts

Every prompt shares this **common header** (paste it at the top):

> Repo: `CyberBrown/gstack` (Chris's fork of garrytan/gstack). Work in a fresh clone or worktree, **not** in
> `~/.claude/skills/gstack`, `~/.agents/skills/gstack`, `~/.hermes/skills/gstack` or `~/projects/gstack` unless the
> prompt says so. Default branch: `chris/remove-unused-hosts`. Create a branch `<prefix>/<slug>`, then commit (author
> Claude, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`), push, and open a PR with
> `gh pr create --repo CyberBrown/gstack --base <default-branch>`.
> **Hard constraints (verbatim):** "Branch + PR only, never push to the default branch directly." "NEVER push,
> open PRs, issues or comments against garrytan/gstack." "`~/.claude/settings.json` must stay machine-agnostic."
> "Credentials live in OpenBao/Proton Pass, never in files or repos." "Never use the monsta RTX 3080." "Bun,
> not npm." `/tmp` on monsta is a small tmpfs, so do not install large deps into `/tmp`.
> Do not merge your own PR.

### M1 prompt — Stop the bleeding
```
<common header>  Branch: fix/fork-manual-and-small-fixes
Scope: DOC-01, DOC-02, DOC-03, DOC-04, OPS-02, SEC-08, BUG-04, BUG-05 (see docs/reviews/FABLE-REVIEW-2026-10-20.md).
1. OPS-02 FIRST: open a PR for the existing branch `fix/sessionstart-anchor` →
   `gh pr create --repo CyberBrown/gstack --base chris/remove-unused-hosts --head fix/sessionstart-anchor
   --title "Preserve live fork fixes (LiteLLM lane, SessionStart anchor)" --body "<explain: this is what
   ~/.claude/skills/gstack runs; based on upstream v1.91.1; will be reconciled in the upstream-sync PR>"`.
   Do NOT merge it (it carries 125 upstream commits; M2 reconciles).
2. DOC-01/02: prepend the "Fork operating manual" block from report §Phase 1 to CLAUDE.md; rewrite
   CLAUDE.md "Deploying to the active skill" (around line 782) to the fork-aware procedure; label sections
   "Checking out PRs from garrytan-agents", "CHANGELOG + VERSION style", "Publishing native OpenClaw skills"
   as UPSTREAM-ONLY. Add a 5-line fork pointer to AGENTS.md.
3. DOC-03: README fork banner + docs/FORK.md (delta inventory, remotes, sync procedure, lane config, installs).
4. DOC-04: bin/gstack-hermes-probe header — add `kanban` to the disable list and an expected `tools list` output.
5. SEC-08: in bin/gstack-hermes-probe `_gstack_hermes_auth_probe`, after extracting `_var`, add
   `[[ "$_var" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || { echo AUTH_FAILED; return 1; }` before `${!_var}`; use
   `grep -Eq "^${_var}=.+"` only after validation. Add a test in test/hermes-hardening.test.ts proving
   `api_key: ${a[$(touch $TMP/pwned)]}` → AUTH_FAILED and no file created.
6. BUG-04: in all 4 Hermes blocks of autoplan/SKILL.md.tmpl use
   `_HERMES_USAGE=$(mktemp "${TMPDIR:-/tmp}/gstack-hermes-usage.XXXXXX.json")` and remove it after the
   success check (`rm -f "$_HERMES_USAGE"`). Regenerate: `bun run gen:skill-docs`.
7. BUG-05: in bin/gstack-codex-probe, when GSTACK_LLM_API_KEY is the only auth signal, require
   "${CODEX_HOME:-$HOME/.codex}/gstack.config.toml" to exist; add a test case.
Out of scope: rebasing onto upstream, changing installs, telemetry settings, CI workflows.
Acceptance: CLAUDE.md contains no instruction to reset to `origin/main` in an install dir; the fix-branch PR exists;
tests pass.
Verify: bun install --frozen-lockfile (in a non-/tmp clone); bun test test/hermes-hardening.test.ts
test/codex-hardening.test.ts test/host-config.test.ts test/gen-skill-docs.test.ts test/skill-collision-sentinel.test.ts;
bun run gen:skill-docs && git diff --exit-code -- '*.md' (after commit); grep -n "reset --hard origin/main" CLAUDE.md → none.
```

### M2 prompt — Consolidate onto current upstream
```
<common header>  Branch: sync/upstream-2026-10
⚠ DECISION REQUIRED: Chris confirms (a) the new default branch name (recommend `main`, replacing the stale one),
and (b) that Muse should run from an install dir rather than ~/projects/gstack.
Scope: OPS-01, SEC-03, QUAL-01, QUAL-02, BUG-02, SEC-04, OPS-04, TOOL-02.
1. git fetch upstream (https://github.com/garrytan/gstack.git, fetch-only) && git checkout -b sync/upstream-2026-10 upstream/main.
2. Re-apply the fork delta as minimal commits, in this order: (a) host pruning (4fb3339) + Muse host (cbbd17f) — adapt
   to upstream's current hosts/ + setup; (b) fix-branch commits 7e294e6, b9cabb3, ea7286a, 927cded, 57973f0
   (cherry-pick; resolve against upstream); (c) LiteLLM lane — make `-p gstack` CONDITIONAL (BUG-02): emit the
   profile flag only when "${CODEX_HOME:-$HOME/.codex}/gstack.config.toml" exists, else default lane;
   (d) Hermes outside voice as a resolver (QUAL-01) reusing upstream's prompt-file plumbing in
   autoplan/sections/*.md — the prompt MUST be written to a private mktemp file and passed as "$(cat "$f")";
   NEVER interpolate model-authored text into shell source (SEC-03); (e) gstack-config outside_voice/hermes_profile keys.
3. SEC-04: after each Hermes call, `git -C "$_REPO_ROOT" status --porcelain` must be unchanged vs before the call,
   else tag the voice [hermes-unavailable: wrote to tree] and `git stash`-free restore is NOT attempted — just report.
4. Port test/hermes-hardening.test.ts and add a test asserting no `<insert` placeholder sits inside a double-quoted
   shell argument in any generated SKILL.md/section (grep-based tripwire).
5. Do not bump upstream VERSION semantics; record the fork delta in docs/FORK.md changelog.
6. OPS-04 (after Chris merges): change default branch, delete `fix/sessionstart-anchor`, `chris/autoplan-hermes-voice`,
   and the stale `main` per the decision — via gh api, read the current state first.
7. TOOL-02: in ~/.claude/skills/gstack only AFTER M3 reinstall — skip here.
Out of scope: reinstalling hosts (M3), CI workflow changes (M4), telemetry (M5).
Acceptance: `git rev-list --count HEAD..upstream/main` = 0; fork delta ≤ ~15 commits; all upstream free tests + fork tests pass;
generated docs fresh.
Verify: bun install --frozen-lockfile; bun test (free suite per upstream CLAUDE.md "Testing"); bun run gen:skill-docs --dry-run
(or upstream's freshness check); grep -rn '<insert' autoplan/ | grep -n '"' → reviewed manually: none inside shell strings.
```

### M3 prompt — Reinstall from a reviewed tag + state hygiene
```
<common header>  Runs ON monsta-mash, touching install dirs (allowed for this milestone only).
Prereq: M2 merged and tagged `fork-v<upstream-version>-1` on CyberBrown/gstack.
Scope: SEC-02, BUG-01, BUG-03, OPS-03, TOOL-02.
1. For each of ~/.claude/skills/gstack, ~/.agents/skills/gstack, ~/.hermes/skills/gstack: record `git status --porcelain`,
   `git log -1`, `cat VERSION` to a notes file; ASK Chris before discarding any dirty file listed.
   Then: git remote rename origin upstream; git remote add origin git@github.com:CyberBrown/gstack.git (or set-url);
   git remote set-url --push upstream DISABLED; git fetch origin --tags; git checkout <tag>; ./setup --host <claude|codex|hermes>.
2. Muse: rm the symlinked ~/.config/muse/skills/gstack only after confirming it points into ~/projects/gstack; re-run
   `./setup --host muse` from the ~/.claude install (or a dedicated install dir) so Muse no longer depends on the dev checkout.
3. TOOL-02: `git clean -n` in each install, review with Chris, then remove confirmed leftovers (e.g. bin/*.bak-*).
4. BUG-03: stop the stale daemons (browse server/terminal-agent started from ~/.agents v1.79) via the skill's own stop
   command (`$B stop` equivalent), then confirm `cat VERSION` is identical across all installs.
5. OPS-03: hooks — cross-repo with CyberBrown/claude-config: move gstack hook entries from ~/.claude/settings.json to
   /etc/claude-code/managed-settings.json (root; ask Chris to apply) OR rewrite them as
   `sh -c '[ -x "$HOME/.claude/skills/gstack/hosts/claude/hooks/<h>" ] || exit 0; exec "$HOME/…/<h>"'`; PR to claude-config.
6. BUG-01: run `~/.claude/skills/gstack/bin/gstack-config get outside_voice` → must print `hermes` and autoplan
   preflight must print `OUTSIDE_VOICE: hermes`.
Out of scope: code changes to gstack (M2), telemetry decisions (M5).
Acceptance: 4 installs report the same VERSION + same commit; node_modules/basic-ftp ≥5.3.1 in each; `ss -ltnp` shows no
daemon from a stale path; settings.json hook entries are guarded/machine-agnostic.
Verify: for d in ~/.claude/skills/gstack ~/.agents/skills/gstack ~/.hermes/skills/gstack; do git -C $d describe --tags; cat $d/VERSION; done;
readlink -f ~/.config/muse/skills/gstack/bin; grep -m1 '"version"' <install>/node_modules/basic-ftp/package.json.
```

### M4 prompt — Supply-chain governance + CI
```
<common header>  Branch: ci/fork-ci-and-governance
Scope: SEC-01, TOOL-01, TOOL-03.
1. TOOL-01: add .github/workflows/fork-ci.yml: on pull_request (all branches) + push to default; ubuntu-latest;
   setup bun (pinned action SHA); `bun install --frozen-lockfile`; run the free test suite. Guard upstream-only workflows
   (evals.yml, evals-periodic.yml, ci-image.yml, make-pdf-gate.yml, version-gate.yml, pr-title-sync.yml) with
   `if: github.repository == 'garrytan/gstack'` so they never queue on ubicloud in the fork.
2. SEC-01 (repo settings — ⚠ DECISION REQUIRED: Chris approves): via gh api, enable branch protection on the default
   branch (require PR, require fork-ci status check, no force-push); set actions permissions to `selected` + require SHA
   pinning; pin all `uses:` to commit SHAs. Read current settings first (GET) and record them in the PR body.
3. SEC-01 (setup): replace `npm install --no-save playwright` / `@ngrok/ngrok` (setup ~1341) with a Bun-based,
   lockfile-pinned path or a hard failure with instructions.
4. TOOL-03: add skill `gstack-fork-sync/SKILL.md.tmpl` (outline in report §Phase 2): remotes, rebase branch naming,
   test commands, upstream-diff supply-chain checklist (new egress hosts in bin/ lib/ browse/, new hooks, package.json
   scripts/overrides, setup installers, telemetry fields), PR to default, tagging, install verification.
Out of scope: telemetry/lane decisions (M5), reinstall (M3).
Acceptance: a test PR shows fork-ci running and green; no workflow queues on ubicloud; the protection GET returns 200.
Verify: actionlint; gh run list --repo CyberBrown/gstack --limit 5; gh api repos/CyberBrown/gstack/branches/<default>/protection.
```

### M5 prompt — Egress decisions (human-gated)
```
<common header>
⚠ DECISION REQUIRED (Chris): (1) telemetry to upstream Supabase: off | anonymous; (2) which repos/data classes may be
sent to the LiteLLM `pro` lane (Kimi) and to api.openai.com; (3) GitHub-only hosting accepted or Forgejo mirror wanted.
Scope: SEC-05, SEC-06, SEC-07, SEC-09, OPS-05.
1. SEC-05: if "off": `~/.claude/skills/gstack/bin/gstack-config set telemetry off` on every host; in the fork, change
   lookup_default telemetry → off. Confirm no new telemetry-sync lines in ~/.gstack/security/egress.jsonl after a skill run.
2. SEC-06: add gstack-config key `outside_voice_trust` (path-glob deny list, e.g. ~/projects/52L/*, client repos) checked
   in the outside-voice preflight; deny ⇒ [outside-voice-skipped: repo trust policy]. Tests required.
3. SEC-07: move the OpenAI key from ~/.gstack/openai.json to OpenBao (`claude-bao`), read at runtime; delete the file;
   `setfacl -x u:metis ~/.gstack/openai.json` before deletion. Never print the value.
4. SEC-09: add a note to docs/FORK.md: no estate hostnames/IPs in public commits or comments.
5. OPS-05: record the decision in docs/FORK.md (and the wiki via write-to-notes if a mirror is created).
Acceptance: egress.jsonl shows only approved sinks after a week; no plaintext keys under ~/.gstack.
Verify: python3 -I summary of egress.jsonl sinks; ls -la ~/.gstack/openai.json → absent.
```

## 6. UNVERIFIED appendix (ordered by gated severity)

| # | Gates | Check |
|---|---|---|
| U-1 | OPS-01 / SEC-02 (High) | gstack state on **prometheus**: `ssh prometheus 'for d in ~/.claude/skills/gstack ~/.agents/skills/gstack; do git -C $d rev-parse --abbrev-ref HEAD; cat $d/VERSION; git -C $d remote -v; done; ls ~/.codex/gstack.config.toml'` (ssh was forbidden for this review). |
| U-2 | SEC-04 (Medium) | Whether the Hermes `file` toolset includes write/patch tools: `hermes --profile gstack-reviewer tools list --summary`, or inspect hermes-agent's toolset registry (`pipx runpip hermes-agent show -f hermes-agent \| grep toolset`). Then run a canary: ask the voice to create a file in a scratch repo and check `git status`. |
| U-3 | SEC-06 (Medium) | Which provider and model the LiteLLM `pro` lane actually resolves to today, and the gateway's data-retention terms: check the gateway config on Helsinki CT 121 (`runtime/llmgw` spec), read-only. |
| U-4 | BUG-03 (Medium) | Which harness launched the v1.79 browse/terminal-agent daemons at 2026-10-20 00:12: `ps -o ppid= -p <pid>` up the tree while they run, and check Codex's skill resolution order. |
| U-5 | OPS-05 (Low) | Whether a Forgejo mirror exists: `git ls-remote https://chris@git.voltagelabs.net/chris/gstack.git` (with credentials). |
| U-6 | SEC-01 (High) | Upstream's current governance (required reviews on garrytan main, signed commits): `gh api repos/garrytan/gstack/branches/main/protection` (a GET; 404 is expected without admin rights, so check the rulesets endpoint `gh api repos/garrytan/gstack/rulesets`). |

## 7. OpenProject plan (Parent/Child WP tree)

Suggested parent: **Estate [115]**. New project: *gstack — Fable Review Remediation (2026-10-20)*.

```
M1 — Stop the bleeding: fork manual + preserve live fixes
  ├─ M1 · OPS-02 — Open PR preserving fix/sessionstart-anchor (High)
  ├─ M1 · DOC-01 — Remove destructive reset-to-origin instruction from CLAUDE.md (High)
  ├─ M1 · DOC-02/03/04 — Fork operating manual, README banner, docs/FORK.md, Hermes recipe (Medium)
  └─ M1 · SEC-08/BUG-04/BUG-05 — Probe hardening + temp-file cleanup (Low)
  validation: CLAUDE.md fork-safe; fix-branch PR exists; fork tests green
M2 — Consolidate onto current upstream (one trunk)   ⚠ DECISION (default branch name, Muse install dir)
  ├─ M2 · OPS-01 — Rebase fork delta onto upstream/main as sync/upstream-2026-10 (High)
  ├─ M2 · SEC-03 — Prompt-file plumbing for Hermes/Codex voices; no shell interpolation (High)
  ├─ M2 · QUAL-01/02 — Hermes as resolver; converge codex-probe (Low)
  ├─ M2 · BUG-02 — Conditional `-p gstack` profile flag (Medium)
  ├─ M2 · SEC-04 — Enforce read-only Hermes voice; disable kanban (Medium)
  └─ M2 · OPS-04 — Retire stale main/merged branches (Low)
  validation: 0 behind upstream; tests + freshness green
M3 — Reinstall every host from a reviewed tag
  ├─ M3 · SEC-02 — Retire v1.35 runtimes (Muse, Hermes) (Medium)
  ├─ M3 · BUG-01/BUG-03 — Single build everywhere; Hermes voice honoured; stale daemons stopped (Medium)
  ├─ M3 · OPS-03 — Guarded/machine-agnostic gstack hooks (cross-repo claude-config) (Medium)
  └─ M3 · TOOL-02 — Clean untracked leftovers in installs (Low)
  validation: identical VERSION/commit in 4 installs; basic-ftp ≥5.3.1
M4 — Supply-chain governance + CI
  ├─ M4 · SEC-01 — Branch protection, SHA-pinned Actions, pinned setup installs, reviewed-tag-only upgrades (High) ⚠ DECISION
  ├─ M4 · TOOL-01 — fork-ci.yml; gate upstream-only workflows (Medium)
  └─ M4 · TOOL-03 — gstack-fork-sync skill (Low)
  validation: CI runs on every PR; no ubicloud queueing; protection on
M5 — Egress decisions (human-gated)   ⚠ DECISION
  ├─ M5 · SEC-05 — Telemetry to upstream Supabase off/approved (Medium)
  ├─ M5 · SEC-06 — Repo trust gate for outside-voice egress (Medium)
  ├─ M5 · SEC-07 — Move OpenAI key to OpenBao (Low)
  └─ M5 · SEC-09/OPS-05 — Public-repo hygiene + hosting decision (Low/Polish)
Final validation — gstack remediation complete (re-run the review prompt in re-review mode)
```
