/**
 * outside-voice-runner — the pluggable outside voice (plan B3). The rendered
 * skills still shell to Codex for the interactive path; this module is the
 * runtime choice behind `bin/gstack-outside-voice run --runner <r>` so an
 * unattended run (bin/gstack-autoplan) picks a runner per run, not per render.
 * Every runner implements one adapter: declared capabilities (repository
 * access or supplied input only), the input digest, the actual model metadata,
 * cancellation, a terminal result and usage. Runners: `codex-cli` (today's
 * path through gstack-codex-probe and `codex exec`), `api` (a direct call via
 * lib/outside-voice-api.ts, labeled `supplied-input review`), and
 * `host-subagent` (the host ran a cross-family subagent from the prompt file
 * and hands back its output file; spend is `unknown`). Verdicts still go
 * through lib/outside-review-result.ts. The same-family rule is enforced by
 * `familyConflict`: an outside model in the native reviewer's family is not an
 * outside voice. A missing Codex CLI is "unavailable; using <runner>" only when
 * another runner is configured; with none it is missing coverage.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { classifyOutsideReview, type OutsideGate, type OutsideReviewClassification } from './outside-review-result';
import { resolveLane } from './llm-lane';
import { readConfigKey } from './state-root';

export type RunnerId = 'codex-cli' | 'api' | 'host-subagent' | 'hermes' | 'claude-code';
export const RUNNER_IDS: readonly RunnerId[] = ['codex-cli', 'api', 'host-subagent', 'hermes', 'claude-code'];
export type ModelFamily = 'anthropic' | 'openai' | 'google' | 'xai' | 'deepseek' | 'qwen' | 'zai' | 'moonshot' | 'meta' | 'mistral' | 'minimax' | 'unknown';

export interface RunnerCapabilities {
  /** `read-only`: the reviewer can read the repository; `none`: it sees the prompt bytes only; `host`: whatever the host gave its subagent. */
  repository_access: 'read-only' | 'none' | 'host';
  /** Whether this process starts and can cancel the reviewer. */
  executes_here: boolean;
  /** The label the record carries; `supplied-input review` is never silently equal to a repo-reading review. */
  label: 'repository review' | 'supplied-input review' | 'host-dispatched review';
}
export interface RunnerRequest {
  promptFile: string; outFile: string; model?: string; timeoutMs: number; cwd: string; gate: OutsideGate;
  /** host-subagent: the file the host's subagent wrote. */
  resultFile?: string;
  env?: Record<string, string | undefined>;
  /** Directory of the gstack bins (gstack-codex-probe); defaults to this module's sibling bin/. */
  binDir?: string;
}
export type RunnerStatus = 'completed' | 'unverified' | 'unavailable' | 'failed' | 'timeout' | 'cancelled';
export interface RunnerUsage { input_tokens?: number; output_tokens?: number; usd: number | 'unknown' }
export interface RunnerResult {
  schema_version: 1; runner: RunnerId; status: RunnerStatus; model: string | null; family: ModelFamily;
  capabilities: RunnerCapabilities; input_sha256: string; output_sha256: string | null; output: string | null;
  usage: RunnerUsage; started_at: string; ended_at: string; wall_s: number; exit: number;
  verdict?: OutsideReviewClassification; reason?: string; detail?: string;
}
export interface OutsideRunner {
  id: RunnerId;
  capabilities: RunnerCapabilities;
  available(req: Pick<RunnerRequest, 'env' | 'resultFile' | 'model' | 'binDir'>): { ok: true } | { ok: false; reason: string };
  run(req: RunnerRequest): Promise<RunnerResult>;
  cancel(): void;
}

const FAMILY_RULES: Array<[ModelFamily, RegExp]> = [
  ['anthropic', /^(anthropic\/|claude)/],
  ['openai', /^(openai\/|gpt-|o[0-9](?:-|$)|codex|chatgpt|text-davinci)/],
  ['google', /^(google\/|gemini|gemma)/],
  ['xai', /^(xai\/|grok)/],
  ['deepseek', /^(deepseek\/|deepseek)/],
  ['qwen', /^(qwen\/|qwen|alibaba\/)/],
  ['zai', /^(zai\/|glm)/],
  ['moonshot', /^(moonshotai\/|moonshot\/|kimi)/],
  ['meta', /^(meta\/|meta-llama\/|llama|muse-)/],
  ['mistral', /^(mistral(ai)?\/|mistral|mixtral|codestral)/],
  ['minimax', /^(minimax\/|minimax)/],
];
/** Family from a model id (`openai/gpt-6-astra`, `claude-opus-4-7`, `gpt-5.4`); `unknown` when no rule matches. */
export function modelFamily(model: string | undefined | null): ModelFamily {
  const id = (model ?? '').trim().toLowerCase();
  if (!id) return 'unknown';
  for (const [family, re] of FAMILY_RULES) if (re.test(id)) return family;
  return 'unknown';
}
/** The same-family rule: two voices from one family are one voice. Returns the refusal detail or undefined. */
export function familyConflict(outsideModel: string | undefined, nativeModel: string | undefined): string | undefined {
  const outside = modelFamily(outsideModel);
  if (outside === 'unknown') return `outside model ${JSON.stringify(outsideModel ?? '')} has no recognized family`;
  if (!nativeModel) return undefined;
  const native = modelFamily(nativeModel);
  if (native === 'unknown') return `native model ${JSON.stringify(nativeModel)} has no recognized family`;
  return native === outside ? `outside ${outsideModel} and native ${nativeModel} are both ${native}` : undefined;
}

export const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const DEFAULT_BIN = path.resolve(import.meta.dir, '..', 'bin');

function finish(base: Omit<RunnerResult, 'ended_at' | 'wall_s' | 'output_sha256' | 'schema_version'>, startedMs: number, outFile?: string): RunnerResult {
  const ended = Date.now();
  const outputExists = outFile !== undefined && fs.existsSync(outFile) && fs.statSync(outFile).size > 0;
  return { schema_version: 1, ...base, output: outputExists ? outFile : null, output_sha256: outputExists ? sha256(fs.readFileSync(outFile)) : null, ended_at: new Date(ended).toISOString(), wall_s: Math.round((ended - startedMs) / 1000) };
}

function classify(text: string, gate: OutsideGate, extra: { stderr?: string; exit?: number; events?: string }): { status: RunnerStatus; verdict: OutsideReviewClassification } {
  const verdict = classifyOutsideReview({ text, gate, ...extra });
  const status: RunnerStatus = verdict.verdict === 'unavailable' ? 'unavailable' : verdict.verdict === 'unverified' ? 'unverified' : 'completed';
  return { status, verdict };
}

/** Token usage from `codex exec --json` events, read loosely: any object carrying usage counters. */
export function usageFromEvents(events: string): RunnerUsage {
  let input: number | undefined; let output: number | undefined;
  for (const line of events.split('\n')) {
    if (!line.trim()) continue;
    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }
    const usage = obj?.usage ?? obj?.info?.total_token_usage ?? obj?.payload?.info?.total_token_usage ?? obj?.msg?.info?.total_token_usage;
    if (!usage || typeof usage !== 'object') continue;
    if (typeof usage.input_tokens === 'number') input = usage.input_tokens;
    if (typeof usage.output_tokens === 'number') output = usage.output_tokens;
  }
  return { ...(input !== undefined ? { input_tokens: input } : {}), ...(output !== undefined ? { output_tokens: output } : {}), usd: 'unknown' };
}

// ---------------------------------------------------------------------------
// codex-cli: today's path, as one process this module can cancel
// ---------------------------------------------------------------------------
class CodexCliRunner implements OutsideRunner {
  id: RunnerId = 'codex-cli';
  capabilities: RunnerCapabilities = { repository_access: 'read-only', executes_here: true, label: 'repository review' };
  private child: ReturnType<typeof Bun.spawn> | undefined;
  private cancelled = false;

  available(req: Pick<RunnerRequest, 'env'>): { ok: true } | { ok: false; reason: string } {
    const env = req.env ?? process.env;
    const found = Bun.which('codex', { PATH: env.PATH ?? '' });
    if (!found) return { ok: false, reason: 'codex CLI not on PATH' };
    const lane = resolveLane(env);
    return lane.ready ? { ok: true } : { ok: false, reason: `LiteLLM lane unavailable: ${lane.problem}` };
  }

  cancel(): void { this.cancelled = true; this.child?.kill('SIGTERM'); }

  async run(req: RunnerRequest): Promise<RunnerResult> {
    const env = { ...(req.env ?? process.env) } as Record<string, string>;
    const started = Date.now();
    const prompt = fs.readFileSync(req.promptFile);
    const base = { runner: this.id, capabilities: this.capabilities, input_sha256: sha256(prompt), started_at: new Date(started).toISOString(), usage: { usd: 'unknown' } as RunnerUsage, model: req.model ?? null, family: modelFamily(req.model), output: null } as const;
    const avail = this.available(req);
    if (!avail.ok) return finish({ ...base, status: 'unavailable', exit: 1, reason: 'cli_missing', detail: avail.reason }, started);
    const probe = path.join(req.binDir ?? DEFAULT_BIN, 'gstack-codex-probe');
    if (req.model) env.GSTACK_CODEX_MODEL = req.model;
    const select = Bun.spawnSync([probe, 'select-model', 'exec', ...(req.model ? ['--model', req.model] : [])], { cwd: req.cwd, env, stdout: 'pipe', stderr: 'pipe', timeout: 60_000 });
    const selOut = new TextDecoder().decode(select.stdout);
    const selected = /^CODEX_SEL: (.+)$/m.exec(selOut)?.[1]?.trim();
    const sandbox = /^CODEX_SANDBOX: (.+)$/m.exec(selOut)?.[1]?.trim();
    if (select.exitCode !== 0 || !selected || !sandbox) {
      return finish({ ...base, status: 'unavailable', exit: select.exitCode ?? 1, reason: 'model_unselected', detail: new TextDecoder().decode(select.stderr).trim() || 'select-model printed no CODEX_SEL/CODEX_SANDBOX' }, started);
    }
    const eventsFile = `${req.outFile}.events.jsonl`;
    const stderrFile = `${req.outFile}.stderr`;
    fs.mkdirSync(path.dirname(req.outFile), { recursive: true });
    fs.rmSync(req.outFile, { force: true });
    // Fork: select-model already refused an unusable lane; a usable one adds its profile.
    const lane = resolveLane(env);
    const argv = ['codex', ...(lane.mode === 'litellm' ? ['-p', lane.codexProfile] : []), 'exec', '-', '-C', req.cwd, '-s', sandbox, '-c', `model="${selected}"`, '-c', 'skills.include_instructions=false',
      '-c', 'model_reasoning_effort="high"', '-c', 'web_search="cached"', '--json', '-o', req.outFile];
    this.child = Bun.spawn(argv, { cwd: req.cwd, env, stdin: new Blob([prompt]), stdout: Bun.file(eventsFile), stderr: Bun.file(stderrFile) });
    const timer = setTimeout(() => { this.child?.kill('SIGTERM'); setTimeout(() => this.child?.kill('SIGKILL'), 10_000).unref(); }, req.timeoutMs);
    const exit = await this.child.exited;
    clearTimeout(timer);
    const timedOut = Date.now() - started >= req.timeoutMs && exit !== 0;
    const text = fs.existsSync(req.outFile) ? fs.readFileSync(req.outFile, 'utf8') : '';
    const events = fs.existsSync(eventsFile) ? fs.readFileSync(eventsFile, 'utf8') : '';
    const stderr = fs.existsSync(stderrFile) ? fs.readFileSync(stderrFile, 'utf8') : '';
    const usage = usageFromEvents(events);
    if (this.cancelled) return finish({ ...base, model: selected, family: modelFamily(selected), status: 'cancelled', exit: exit || 1, usage, reason: 'cancelled' }, started, req.outFile);
    if (timedOut) return finish({ ...base, model: selected, family: modelFamily(selected), status: 'timeout', exit: 124, usage, reason: 'timeout', detail: `after ${req.timeoutMs} ms` }, started, req.outFile);
    const { status, verdict } = classify(text, req.gate, { stderr, exit, events });
    return finish({ ...base, model: selected, family: modelFamily(selected), status, exit, usage, verdict, ...(verdict.reason ? { reason: verdict.reason } : {}), ...(verdict.detail ? { detail: verdict.detail } : {}) }, started, req.outFile);
  }
}

// ---------------------------------------------------------------------------
// api: a direct call, labeled supplied-input review
// ---------------------------------------------------------------------------
class ApiRunner implements OutsideRunner {
  id: RunnerId = 'api';
  capabilities: RunnerCapabilities = { repository_access: 'none', executes_here: true, label: 'supplied-input review' };
  private controller = new AbortController();

  available(req: Pick<RunnerRequest, 'env' | 'model'>): { ok: true } | { ok: false; reason: string } {
    const env = req.env ?? process.env;
    const lane = resolveLane(env);
    if (lane.mode === 'litellm') return lane.ready ? { ok: true } : { ok: false, reason: `LiteLLM lane unavailable: ${lane.problem}` };
    if (!req.model) return { ok: false, reason: '--model <id> is required for the api runner' };
    const family = modelFamily(req.model);
    if (family === 'anthropic' && env.ANTHROPIC_API_KEY) return { ok: true };
    if (family === 'openai' && env.OPENAI_API_KEY) return { ok: true };
    return { ok: false, reason: family === 'anthropic' || family === 'openai' ? `${family.toUpperCase()}_API_KEY is not set` : `no API adapter for model family ${family}` };
  }

  cancel(): void { this.controller.abort(new Error('cancelled')); }

  async run(req: RunnerRequest): Promise<RunnerResult> {
    const started = Date.now();
    const prompt = fs.readFileSync(req.promptFile, 'utf8');
    const base = { runner: this.id, capabilities: this.capabilities, input_sha256: sha256(prompt), started_at: new Date(started).toISOString(), usage: { usd: 'unknown' } as RunnerUsage, model: req.model ?? null, family: modelFamily(req.model), output: null } as const;
    const avail = this.available(req);
    if (!avail.ok) return finish({ ...base, status: 'unavailable', exit: 1, reason: 'runner_unavailable', detail: avail.reason }, started);
    const { callModel } = await import('./outside-voice-api');
    try {
      const res = await callModel({ model: req.model ?? resolveLane(req.env ?? process.env).model!, prompt, timeoutMs: req.timeoutMs, env: req.env, signal: this.controller.signal });
      fs.mkdirSync(path.dirname(req.outFile), { recursive: true });
      fs.writeFileSync(req.outFile, res.text);
      const usage: RunnerUsage = { ...res.usage, usd: 'unknown' };
      const { status, verdict } = classify(res.text, req.gate, { exit: 0 });
      return finish({ ...base, model: res.model, family: modelFamily(res.model), status, exit: 0, usage, verdict, ...(verdict.reason ? { reason: verdict.reason } : {}), ...(verdict.detail ? { detail: verdict.detail } : {}) }, started, req.outFile);
    } catch (e: any) {
      const cancelled = this.controller.signal.aborted;
      const timeout = /timeout/i.test(String(e?.message ?? e)) || e?.name === 'TimeoutError';
      return finish({ ...base, status: cancelled ? 'cancelled' : timeout ? 'timeout' : 'failed', exit: timeout ? 124 : 1, reason: cancelled ? 'cancelled' : timeout ? 'timeout' : 'provider_error', detail: String(e?.message ?? e) }, started);
    }
  }
}

// ---------------------------------------------------------------------------
// host-subagent: the host ran a cross-family subagent; this binds its file
// ---------------------------------------------------------------------------
class HostSubagentRunner implements OutsideRunner {
  id: RunnerId = 'host-subagent';
  capabilities: RunnerCapabilities = { repository_access: 'host', executes_here: false, label: 'host-dispatched review' };
  available(req: Pick<RunnerRequest, 'resultFile' | 'model'>): { ok: true } | { ok: false; reason: string } {
    if (!req.resultFile) return { ok: false, reason: '--result <file> is required for host-subagent (the file the subagent wrote)' };
    if (!fs.existsSync(req.resultFile)) return { ok: false, reason: `result file not found: ${req.resultFile}` };
    if (!req.model) return { ok: false, reason: '--model <id> is required for host-subagent (the subagent’s model)' };
    return { ok: true };
  }
  cancel(): void { /* nothing runs here */ }
  async run(req: RunnerRequest): Promise<RunnerResult> {
    const started = Date.now();
    const prompt = fs.readFileSync(req.promptFile);
    const base = { runner: this.id, capabilities: this.capabilities, input_sha256: sha256(prompt), started_at: new Date(started).toISOString(), usage: { usd: 'unknown' } as RunnerUsage, model: req.model ?? null, family: modelFamily(req.model), output: null } as const;
    const avail = this.available(req);
    if (!avail.ok) return finish({ ...base, status: 'unavailable', exit: 1, reason: 'runner_unavailable', detail: avail.reason }, started);
    fs.mkdirSync(path.dirname(req.outFile), { recursive: true });
    if (path.resolve(req.resultFile!) !== path.resolve(req.outFile)) fs.copyFileSync(req.resultFile!, req.outFile);
    const text = fs.readFileSync(req.outFile, 'utf8');
    const { status, verdict } = classify(text, req.gate, { exit: 0 });
    return finish({ ...base, status, exit: 0, verdict, ...(verdict.reason ? { reason: verdict.reason } : {}), ...(verdict.detail ? { detail: verdict.detail } : {}) }, started, req.outFile);
  }
}

// ---------------------------------------------------------------------------
// hermes (fork): a Hermes reviewer profile, read-only by tree fingerprint
// ---------------------------------------------------------------------------
/** argv cap for the prompt: `hermes -z` takes it as one argument (Linux MAX_ARG_STRLEN is 128 KiB). */
export const HERMES_PROMPT_MAX_BYTES = 100 * 1024;

export function hermesProfile(env: Record<string, string | undefined> = process.env): string {
  return (env.GSTACK_HERMES_PROFILE || readConfigKey('hermes_profile', env) || 'gstack-reviewer').trim();
}

/** `git status` plus a hash of the diff against HEAD; any change means the voice wrote to the tree. */
export function treeFingerprint(cwd: string): string {
  const status = Bun.spawnSync(['git', '-C', cwd, 'status', '--porcelain=v1', '--untracked-files=all'], { stdout: 'pipe', stderr: 'ignore' });
  const diff = Bun.spawnSync(['git', '-C', cwd, 'diff', 'HEAD', '--binary'], { stdout: 'pipe', stderr: 'ignore' });
  return `${new TextDecoder().decode(status.stdout)}\n${sha256(Buffer.from(diff.stdout))}`;
}

/** The profile's model.base_url, read loosely from its config.yaml (`base_url:` under `model:`). */
function hermesBaseUrl(configYaml: string): string | undefined {
  let inModel = false;
  for (const line of configYaml.split('\n')) {
    if (/^\S/.test(line)) inModel = /^model:\s*$/.test(line);
    const m = inModel ? /^\s+base_url:\s*["']?([^"'\s#]+)/.exec(line) : null;
    if (m) return m[1]!.replace(/\/+$/, '');
  }
  return undefined;
}

class HermesRunner implements OutsideRunner {
  id: RunnerId = 'hermes';
  capabilities: RunnerCapabilities = { repository_access: 'read-only', executes_here: true, label: 'repository review' };
  private child: ReturnType<typeof Bun.spawn> | undefined;
  private cancelled = false;

  available(req: Pick<RunnerRequest, 'env'>): { ok: true } | { ok: false; reason: string } {
    const env = req.env ?? process.env;
    if (!Bun.which('hermes', { PATH: env.PATH ?? '' })) return { ok: false, reason: 'hermes CLI not on PATH' };
    const profile = hermesProfile(env);
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(profile)) return { ok: false, reason: `hermes profile '${profile.slice(0, 64)}' is not a plain name` };
    const dir = env.GSTACK_HERMES_PROFILES_DIR || path.join(env.HOME ?? '', '.hermes', 'profiles');
    const config = path.join(dir, profile, 'config.yaml');
    if (!fs.existsSync(config)) return { ok: false, reason: `hermes profile ${profile} not found (${config}); recipe in docs/FORK.md` };
    const lane = resolveLane(env);
    if (lane.mode === 'litellm') {
      if (!lane.ready) return { ok: false, reason: `LiteLLM lane unavailable: ${lane.problem}` };
      const url = hermesBaseUrl(fs.readFileSync(config, 'utf8'));
      if (url !== lane.baseUrl) return { ok: false, reason: `hermes profile ${profile} does not point model.base_url at the LiteLLM gateway, so it would leave the lane` };
    }
    return { ok: true };
  }

  cancel(): void { this.cancelled = true; this.child?.kill('SIGTERM'); }

  async run(req: RunnerRequest): Promise<RunnerResult> {
    const env = { ...(req.env ?? process.env) } as Record<string, string>;
    const started = Date.now();
    const prompt = fs.readFileSync(req.promptFile);
    const profile = hermesProfile(env);
    const lane = resolveLane(env);
    const model = lane.mode === 'litellm' ? lane.model ?? null : null;
    const base = { runner: this.id, capabilities: this.capabilities, input_sha256: sha256(prompt), started_at: new Date(started).toISOString(), usage: { usd: 'unknown' } as RunnerUsage, model, family: modelFamily(model), output: null } as const;
    const avail = this.available(req);
    if (!avail.ok) return finish({ ...base, status: 'unavailable', exit: 1, reason: 'runner_unavailable', detail: avail.reason }, started);
    if (prompt.length > HERMES_PROMPT_MAX_BYTES) return finish({ ...base, status: 'unavailable', exit: 1, reason: 'prompt_too_large', detail: `${prompt.length} bytes is over the ${HERMES_PROMPT_MAX_BYTES}-byte hermes -z limit` }, started);
    const usageFile = `${req.outFile}.usage.json`;
    const stderrFile = `${req.outFile}.stderr`;
    fs.mkdirSync(path.dirname(req.outFile), { recursive: true });
    for (const f of [req.outFile, usageFile]) fs.rmSync(f, { force: true });
    const before = treeFingerprint(req.cwd);
    // -t file only; the profile disables every other toolset (docs/FORK.md). The tree guard below backs it up.
    this.child = Bun.spawn(['hermes', '--profile', profile, '--ignore-rules', '--in', req.cwd, '-t', 'file', '-z', prompt.toString('utf8'), '--usage-file', usageFile],
      { cwd: req.cwd, env, stdin: 'ignore', stdout: Bun.file(req.outFile), stderr: Bun.file(stderrFile) });
    const timer = setTimeout(() => { this.child?.kill('SIGTERM'); setTimeout(() => this.child?.kill('SIGKILL'), 10_000).unref(); }, req.timeoutMs);
    const exit = await this.child.exited;
    clearTimeout(timer);
    const timedOut = Date.now() - started >= req.timeoutMs;
    const wrote = treeFingerprint(req.cwd) !== before;
    const text = fs.existsSync(req.outFile) ? fs.readFileSync(req.outFile, 'utf8') : '';
    const stderr = fs.existsSync(stderrFile) ? fs.readFileSync(stderrFile, 'utf8') : '';
    let usage: RunnerUsage = { usd: 'unknown' };
    let ok = false;
    try {
      const u = JSON.parse(fs.readFileSync(usageFile, 'utf8'));
      // `hermes -z` exits 0 and prints the error as the answer when the API refuses; the usage file is the truth.
      ok = u?.failed === false && u?.completed === true;
      usage = { ...(typeof u?.input_tokens === 'number' ? { input_tokens: u.input_tokens } : {}), ...(typeof u?.output_tokens === 'number' ? { output_tokens: u.output_tokens } : {}), usd: 'unknown' };
    } catch { /* missing or partial usage file: not a completed review */ }
    if (this.cancelled) return finish({ ...base, status: 'cancelled', exit: exit || 1, usage, reason: 'cancelled' }, started, req.outFile);
    if (wrote) return finish({ ...base, status: 'failed', exit: exit || 1, usage, reason: 'wrote_tree', detail: 'Hermes changed the working tree during a read-only review; its output is discarded and nothing was restored (inspect git status)' }, started);
    if (timedOut) return finish({ ...base, status: 'timeout', exit: 124, usage, reason: 'timeout', detail: `after ${req.timeoutMs} ms` }, started, req.outFile);
    if (exit !== 0 || !ok) return finish({ ...base, status: 'failed', exit: exit || 1, usage, reason: 'provider_error', detail: (stderr.trim() || text.trim()).slice(0, 500) || 'hermes reported a failed or incomplete run' }, started);
    const { status, verdict } = classify(text, req.gate, { stderr, exit });
    return finish({ ...base, status, exit, usage, verdict, ...(verdict.reason ? { reason: verdict.reason } : {}), ...(verdict.detail ? { detail: verdict.detail } : {}) }, started, req.outFile);
  }
}

// ---------------------------------------------------------------------------
// claude-code (fork): Claude Code as a swapped-in outside voice (read-only tools)
// ---------------------------------------------------------------------------
class ClaudeCodeRunner implements OutsideRunner {
  id: RunnerId = 'claude-code';
  capabilities: RunnerCapabilities = { repository_access: 'read-only', executes_here: true, label: 'repository review' };
  private controller = new AbortController();

  available(req: Pick<RunnerRequest, 'env'>): { ok: true } | { ok: false; reason: string } {
    const env = req.env ?? process.env;
    if (!Bun.which(env.GSTACK_CLAUDE_BIN || 'claude', { PATH: env.PATH ?? '' })) return { ok: false, reason: 'claude CLI not on PATH' };
    const lane = resolveLane(env);
    return lane.ready ? { ok: true } : { ok: false, reason: `LiteLLM lane unavailable: ${lane.problem}` };
  }

  cancel(): void { this.controller.abort(); }

  async run(req: RunnerRequest): Promise<RunnerResult> {
    const env = req.env ?? process.env;
    const started = Date.now();
    const prompt = fs.readFileSync(req.promptFile, 'utf8');
    const lane = resolveLane(env);
    const laneModel = lane.mode === 'litellm' ? lane.model ?? null : null;
    const base = { runner: this.id, capabilities: this.capabilities, input_sha256: sha256(prompt), started_at: new Date(started).toISOString(), usage: { usd: 'unknown' } as RunnerUsage, model: laneModel, family: modelFamily(laneModel), output: null } as const;
    const avail = this.available(req);
    if (!avail.ok) return finish({ ...base, status: 'unavailable', exit: 1, reason: 'runner_unavailable', detail: avail.reason }, started);
    const { runClaudeCode } = await import('./claude-code');
    const res = await runClaudeCode({ cwd: req.cwd, access: 'read-only', timeoutMs: req.timeoutMs, prompt, env: env as NodeJS.ProcessEnv });
    const model = res.model ?? (res.modelUsage ? Object.keys(res.modelUsage)[0] ?? laneModel : laneModel);
    if (res.status !== 'completed') {
      const timeout = res.error?.code === 'timeout';
      return finish({ ...base, model, family: modelFamily(model), status: timeout ? 'timeout' : res.status === 'unavailable' ? 'unavailable' : 'failed', exit: timeout ? 124 : 1, reason: res.error?.code ?? 'provider_error', detail: res.error?.message }, started);
    }
    fs.mkdirSync(path.dirname(req.outFile), { recursive: true });
    fs.writeFileSync(req.outFile, res.result);
    const { status, verdict } = classify(res.result, req.gate, { exit: 0, stderr: res.stderr });
    return finish({ ...base, model, family: modelFamily(model), status, exit: 0, verdict, ...(verdict.reason ? { reason: verdict.reason } : {}), ...(verdict.detail ? { detail: verdict.detail } : {}) }, started, req.outFile);
  }
}

export function createRunner(id: RunnerId): OutsideRunner {
  if (id === 'codex-cli') return new CodexCliRunner();
  if (id === 'api') return new ApiRunner();
  if (id === 'host-subagent') return new HostSubagentRunner();
  if (id === 'hermes') return new HermesRunner();
  if (id === 'claude-code') return new ClaudeCodeRunner();
  throw new Error(`unknown runner ${id}`);
}

/** The runner table, once: id, capabilities and whether it can run here. */
export function runnerTable(req: Pick<RunnerRequest, 'env' | 'resultFile' | 'model' | 'binDir'> = {}): Array<{ id: RunnerId; capabilities: RunnerCapabilities; available: boolean; reason?: string }> {
  return RUNNER_IDS.map(id => {
    const r = createRunner(id);
    const a = r.available(req);
    return { id, capabilities: r.capabilities, available: a.ok, ...(a.ok ? {} : { reason: a.reason }) };
  });
}

/**
 * Pick the runner to use: the requested one when available; otherwise the
 * configured fallback (`--fallback` or GSTACK_OUTSIDE_RUNNER) with the line
 * `<requested> unavailable; using <fallback>`; with no fallback, unavailable.
 */
export function selectRunner(requested: RunnerId, req: Pick<RunnerRequest, 'env' | 'resultFile' | 'model' | 'binDir'>, fallback?: RunnerId): { runner: RunnerId; note?: string } | { runner: null; reason: string } {
  const first = createRunner(requested).available(req);
  if (first.ok) return { runner: requested };
  if (fallback && fallback !== requested) {
    const second = createRunner(fallback).available(req);
    if (second.ok) return { runner: fallback, note: `${requested} unavailable; using ${fallback}` };
    return { runner: null, reason: `${requested} unavailable (${first.reason}); ${fallback} unavailable (${second.reason})` };
  }
  return { runner: null, reason: `${requested} unavailable (${first.reason})` };
}

// ---------------------------------------------------------------------------
// Provider selection (fork): swap outside voices as needed, at run time
// ---------------------------------------------------------------------------
export type OutsideProvider = 'codex' | 'claude-code' | 'hermes';
export const OUTSIDE_PROVIDERS: readonly OutsideProvider[] = ['codex', 'claude-code', 'hermes'];
export const PROVIDER_RUNNER: Record<OutsideProvider, RunnerId> = { codex: 'codex-cli', 'claude-code': 'claude-code', hermes: 'hermes' };
/** Fallback order when outside_voice_fallback is auto. */
const AUTO_FALLBACK: readonly OutsideProvider[] = ['hermes', 'codex', 'claude-code'];

export interface ProviderSelection { provider: OutsideProvider; fallback: OutsideProvider | null; notes: string[] }

/**
 * The outside voice for this call. `outside_voice` (GSTACK_OUTSIDE_VOICE) is
 * auto | codex | claude-code | hermes; auto keeps the rendered default (the
 * upstream harness rule). A provider that is the current harness is never its
 * own outside voice. When the chosen provider cannot run here, the first
 * available fallback takes its place; `outside_voice_fallback`
 * (GSTACK_OUTSIDE_FALLBACK) is auto | none | a provider, and the next
 * available one becomes the fallback for a failed call.
 */
export function selectOutsideProvider(opts: { host: string; defaultProvider: OutsideProvider; env?: Record<string, string | undefined> }): ProviderSelection {
  const env = opts.env ?? process.env;
  const notes: string[] = [];
  const self: OutsideProvider | undefined = opts.host === 'codex' || env.CODEX_THREAD_ID || env.CODEX_SANDBOX ? 'codex'
    : opts.host === 'claude' || env.CLAUDECODE ? 'claude-code' : undefined;
  const isProvider = (v: string): v is OutsideProvider => (OUTSIDE_PROVIDERS as readonly string[]).includes(v);
  const configured = (env.GSTACK_OUTSIDE_VOICE || readConfigKey('outside_voice', env) || 'auto').trim();
  let primary: OutsideProvider = opts.defaultProvider;
  if (configured !== 'auto') {
    if (!isProvider(configured)) notes.push(`outside_voice '${configured}' is not auto, ${OUTSIDE_PROVIDERS.join(', ')}; using ${primary}`);
    else if (configured === self) notes.push(`outside_voice ${configured} is this harness, so it cannot be the outside voice; using ${primary}`);
    else primary = configured;
  }
  const fallbackCfg = (env.GSTACK_OUTSIDE_FALLBACK || readConfigKey('outside_voice_fallback', env) || 'auto').trim();
  const pool = fallbackCfg === 'none' ? [] : fallbackCfg === 'auto' ? [...AUTO_FALLBACK] : isProvider(fallbackCfg) ? [fallbackCfg] : [...AUTO_FALLBACK];
  if (fallbackCfg !== 'none' && fallbackCfg !== 'auto' && !isProvider(fallbackCfg)) notes.push(`outside_voice_fallback '${fallbackCfg}' is not auto, none, ${OUTSIDE_PROVIDERS.join(', ')}; using auto`);
  const ready = (p: OutsideProvider) => createRunner(PROVIDER_RUNNER[p]).available({ env });
  const candidates = pool.filter(p => p !== self);
  const first = ready(primary);
  if (!first.ok) {
    const swap = candidates.find(p => p !== primary && ready(p).ok);
    if (swap) { notes.push(`${primary} unavailable (${first.reason}); swapped to ${swap}`); primary = swap; }
  }
  const fallback = candidates.find(p => p !== primary && ready(p).ok) ?? null;
  return { provider: primary, fallback, notes };
}

export function outsideStatusLine(result: RunnerResult): string {
  const label = result.capabilities.label === 'supplied-input review' ? ' label=supplied-input-review' : '';
  return `OUTSIDE_STATUS: ${result.status} provider=${result.runner} model=${result.model ?? 'unknown'} family=${result.family}${label}`;
}
