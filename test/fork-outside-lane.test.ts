/**
 * Fork (CyberBrown/gstack): LiteLLM lane, run-time provider swap and the repo
 * trust gate. Free; no provider is called (fake CLIs on PATH where a spawn
 * is needed). The preload pins GSTACK_LLM_LANE=direct; each test here sets
 * its own lane.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { claudeLaneEnv, claudeLaneSettingsEnv, resolveLane } from '../lib/llm-lane';
import { trustDecision } from '../lib/outside-trust';
import { selectOutsideProvider } from '../lib/outside-voice-runner';
import { resolveCodexRuntimeModel } from '../scripts/resolve-codex-generation-model';

const ROOT = path.resolve(import.meta.dir, '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-fork-lane-'));

/** A HOME with a gstack Codex profile, a Hermes reviewer profile and fake CLIs. */
function laneHome(opts: { url?: string; hermesUrl?: string; clis?: string[] } = {}) {
  const home = tmp();
  const url = opts.url ?? 'https://gateway.example/v1';
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'gstack.config.toml'),
    `model = "pro"\nmodel_provider = "gw"\n[model_providers.gw]\nbase_url = "${url}"\nenv_key = "GSTACK_LLM_API_KEY"\n`);
  const prof = path.join(home, '.hermes', 'profiles', 'gstack-reviewer');
  fs.mkdirSync(prof, { recursive: true });
  fs.writeFileSync(path.join(prof, 'config.yaml'), `model:\n  default: pro\n  base_url: ${opts.hermesUrl ?? url}\n`);
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  for (const cli of opts.clis ?? ['codex', 'hermes', 'claude']) {
    fs.writeFileSync(path.join(bin, cli), `#!/bin/sh\nprintf '%s\\n' "$@" > "${home}/${cli}.argv"\necho OK\n`, { mode: 0o755 });
  }
  const gstackHome = path.join(home, '.gstack');
  fs.mkdirSync(gstackHome);
  const env: Record<string, string> = {
    HOME: home, GSTACK_HOME: gstackHome, PATH: `${bin}:/usr/bin:/bin:${path.dirname(process.execPath)}`,
    GSTACK_LLM_LANE: 'litellm', GSTACK_LLM_API_KEY: 'test-key', GSTACK_OUTSIDE_VOICE: 'auto', GSTACK_OUTSIDE_FALLBACK: 'auto',
    GSTACK_OUTSIDE_TRUST_DENY: '',
  };
  return { home, bin, env };
}

describe('LiteLLM lane resolution', () => {
  test('a configured lane is ready with the profile model and gateway', () => {
    const { env } = laneHome();
    const lane = resolveLane(env);
    expect(lane).toMatchObject({ mode: 'litellm', ready: true, model: 'pro', baseUrl: 'https://gateway.example/v1', anthropicBaseUrl: 'https://gateway.example' });
  });
  test('a missing key, profile or https URL refuses instead of going direct', () => {
    const a = laneHome();
    expect(resolveLane({ ...a.env, GSTACK_LLM_API_KEY: '  ' })).toMatchObject({ ready: false, problem: expect.stringContaining('GSTACK_LLM_API_KEY') });
    expect(resolveLane({ ...a.env, GSTACK_CODEX_PROFILE: 'absent' })).toMatchObject({ ready: false, problem: expect.stringContaining('does not exist') });
    const b = laneHome({ url: 'http://gateway.example/v1' });
    expect(resolveLane(b.env).ready).toBe(false);
    const c = laneHome({ url: 'http://127.0.0.1:4000/v1' });
    expect(resolveLane(c.env).ready).toBe(true);
  });
  test('direct is upstream behavior; an unknown lane value refuses', () => {
    const { env } = laneHome();
    expect(resolveLane({ ...env, GSTACK_LLM_LANE: 'direct' })).toMatchObject({ mode: 'direct', ready: true });
    expect(resolveLane({ ...env, GSTACK_LLM_LANE: 'off' })).toMatchObject({ ready: false, problem: expect.stringContaining('not auto, litellm or direct') });
  });
  test('auto is litellm when the lane key is set, direct when it is not', () => {
    const { env } = laneHome();
    expect(resolveLane({ ...env, GSTACK_LLM_LANE: 'auto' })).toMatchObject({ mode: 'litellm', ready: true });
    expect(resolveLane({ ...env, GSTACK_LLM_LANE: 'auto', GSTACK_LLM_API_KEY: '' })).toMatchObject({ mode: 'direct', ready: true });
    expect(resolveLane({ ...env, GSTACK_LLM_LANE: 'litellm', GSTACK_LLM_API_KEY: '' })).toMatchObject({ mode: 'litellm', ready: false });
  });
  test('the Codex runtime model is the lane model; an unusable lane throws', () => {
    const { env, home } = laneHome();
    expect(resolveCodexRuntimeModel({ kind: 'exec', env, home })).toMatchObject({ model: 'pro', source: expect.stringContaining('LiteLLM lane') });
    expect(resolveCodexRuntimeModel({ kind: 'exec', env: { ...env, GSTACK_CODEX_MODEL: 'other' }, home }).model).toBe('other');
    expect(() => resolveCodexRuntimeModel({ kind: 'exec', env: { ...env, GSTACK_LLM_API_KEY: '' }, home })).toThrow(/LiteLLM lane unavailable/);
  });
  test('a Claude Code child loses every direct route and gets the lane on all model slots', () => {
    const { env } = laneHome();
    const lane = resolveLane(env);
    const child = claudeLaneEnv(lane, { ...env, ANTHROPIC_API_KEY: 'direct', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_OAUTH_TOKEN: 'x', ANTHROPIC_MODEL: 'claude-x' });
    expect(child.ANTHROPIC_API_KEY).toBeUndefined();
    expect(child.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(child.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(child).toMatchObject({ ANTHROPIC_BASE_URL: 'https://gateway.example', ANTHROPIC_AUTH_TOKEN: 'test-key', ANTHROPIC_MODEL: 'pro', ANTHROPIC_SMALL_FAST_MODEL: 'pro' });
    const settings = claudeLaneSettingsEnv(lane, env)!;
    expect(JSON.stringify(settings)).not.toContain('test-key');
    expect(settings).toMatchObject({ ANTHROPIC_BASE_URL: 'https://gateway.example', CLAUDE_CODE_USE_BEDROCK: '' });
  });
});

describe('gstack-codex-probe on the lane', () => {
  test('every codex call carries -p <profile>; the direct lane adds nothing', () => {
    const { env, home } = laneHome();
    const probe = path.join(ROOT, 'bin', 'gstack-codex-probe');
    const run = (e: Record<string, string>) => spawnSync(probe, ['run-with-timeout', '20', 'codex', 'exec', '-'], { env: e, cwd: home, encoding: 'utf8', input: '', timeout: 30_000 });
    expect(run({ ...env, GSTACK_CONFIG_NO_NOTICE: '1' }).status).toBe(0);
    expect(fs.readFileSync(path.join(home, 'codex.argv'), 'utf8').split('\n').slice(0, 3)).toEqual(['-p', 'gstack', 'exec']);
    expect(run({ ...env, GSTACK_LLM_LANE: 'direct' }).status).toBe(0);
    expect(fs.readFileSync(path.join(home, 'codex.argv'), 'utf8').split('\n')[0]).toBe('exec');
  });
  test('an unusable lane starts no codex process', () => {
    const { env, home } = laneHome();
    const r = spawnSync(path.join(ROOT, 'bin', 'gstack-codex-probe'), ['run-with-timeout', '20', 'codex', 'exec', '-'], { env: { ...env, GSTACK_LLM_API_KEY: '' }, cwd: home, encoding: 'utf8', input: '', timeout: 30_000 });
    expect(r.status).not.toBe(0);
    expect(fs.existsSync(path.join(home, 'codex.argv'))).toBe(false);
  });
});

describe('run-time provider selection', () => {
  test('auto keeps the rendered default; a configured voice wins; the harness never reviews itself', () => {
    const { env } = laneHome();
    expect(selectOutsideProvider({ host: 'claude', defaultProvider: 'codex', env }).provider).toBe('codex');
    expect(selectOutsideProvider({ host: 'claude', defaultProvider: 'codex', env: { ...env, GSTACK_OUTSIDE_VOICE: 'hermes' } })).toMatchObject({ provider: 'hermes', fallback: 'codex' });
    const self = selectOutsideProvider({ host: 'claude', defaultProvider: 'codex', env: { ...env, GSTACK_OUTSIDE_VOICE: 'claude-code' } });
    expect(self.provider).toBe('codex');
    expect(self.notes.join(' ')).toContain('this harness');
  });
  test('an unavailable voice swaps to the next available one; fallback none disables the fallback', () => {
    const { env } = laneHome({ clis: ['hermes', 'claude'] });
    const sel = selectOutsideProvider({ host: 'claude', defaultProvider: 'codex', env });
    expect(sel.provider).toBe('hermes');
    expect(sel.notes.join(' ')).toContain('swapped to hermes');
    expect(selectOutsideProvider({ host: 'claude', defaultProvider: 'codex', env: { ...env, GSTACK_OUTSIDE_FALLBACK: 'none' } }).provider).toBe('codex');
  });
  test('a Hermes profile pointed off the gateway is not a lane provider', () => {
    const { env } = laneHome({ hermesUrl: 'https://elsewhere.example/v1' });
    expect(selectOutsideProvider({ host: 'claude', defaultProvider: 'codex', env: { ...env, GSTACK_OUTSIDE_VOICE: 'hermes' } }).provider).toBe('codex');
  });
});

describe('repo trust gate', () => {
  const repo = () => {
    const base = tmp();
    const r = path.join(base, 'clients', 'acme');
    fs.mkdirSync(path.join(r, 'sub'), { recursive: true });
    spawnSync('git', ['init', '-q', r], { timeout: 10_000 });
    spawnSync('git', ['-C', r, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x'], { timeout: 10_000 });
    return { base, r };
  };
  test('a repo, its subdirectories and its worktrees under a deny glob are refused', () => {
    const { base, r } = repo();
    const env = { HOME: base, GSTACK_HOME: path.join(base, 'gh'), GSTACK_OUTSIDE_TRUST_DENY: `${base}/clients/*` };
    expect(trustDecision(r, env).allowed).toBe(false);
    expect(trustDecision(path.join(r, 'sub'), env).allowed).toBe(false);
    const wt = path.join(base, 'elsewhere');
    spawnSync('git', ['-C', r, 'worktree', 'add', '-q', wt], { timeout: 10_000 });
    expect(trustDecision(wt, env).allowed).toBe(false);
    expect(trustDecision(base, env).allowed).toBe(true);
  });
  test('config quotes and comments still deny; the override lets one command through', () => {
    const { base, r } = repo();
    const gh = path.join(base, 'gh');
    fs.mkdirSync(gh);
    fs.writeFileSync(path.join(gh, 'config.yaml'), `outside_voice_trust_deny: "${base}/clients/*"   # client work\n`);
    const env = { HOME: base, GSTACK_HOME: gh, GSTACK_OUTSIDE_TRUST_DENY: '' };
    expect(trustDecision(r, env).allowed).toBe(false);
    expect(trustDecision(r, { ...env, GSTACK_OUTSIDE_TRUST_OVERRIDE: '1' }).allowed).toBe(true);
  });
  test('gstack-outside-voice select exits 3 with not_run in a denied repo', () => {
    const { base, r } = repo();
    const res = spawnSync(path.join(ROOT, 'bin', 'gstack-outside-voice'), ['select', '--host', 'claude', '--default', 'codex', '--cwd', r],
      { env: { ...process.env, HOME: base, GSTACK_HOME: path.join(base, 'gh'), GSTACK_OUTSIDE_TRUST_DENY: `${base}/clients/*` }, encoding: 'utf8', timeout: 30_000 });
    expect(res.status).toBe(3);
    expect(res.stdout).toContain('OUTSIDE_STATUS: not_run reason=trust_denied');
  });
});

describe('gstack-outside-voice swap', () => {
  function hermesHome(ok: boolean) {
    const h = laneHome();
    // A fake Hermes: writes a review and the usage file `hermes -z` leaves behind.
    fs.writeFileSync(path.join(h.bin, 'hermes'), `#!/bin/sh
while [ $# -gt 0 ]; do [ "$1" = --usage-file ] && u="$2"; shift; done
printf '{"failed": ${ok ? 'false' : 'true'}, "completed": ${ok ? 'true' : 'false'}}' > "$u"
printf '1. Low: a nit in lib/a.ts:1.\\nRecommendation: ship because the change is safe.\\n'
`, { mode: 0o755 });
    const tmpDir = tmp();
    fs.writeFileSync(path.join(tmpDir, 'prompt'), 'Review this.\n');
    const repo = tmp();
    spawnSync('git', ['init', '-q', repo], { timeout: 10_000 });
    return { ...h, tmpDir, repo };
  }
  const swap = (h: ReturnType<typeof hermesHome>, phase: string, extra: Record<string, string> = {}) =>
    spawnSync(path.join(ROOT, 'bin', 'gstack-outside-voice'), ['swap', phase, 'claude', 'codex', 'review', '20', h.tmpDir],
      { env: { ...h.env, ...extra }, cwd: h.repo, encoding: 'utf8', timeout: 60_000 });

  test('a swapped-in Hermes reviews and reports itself', () => {
    const h = hermesHome(true);
    const r = swap(h, 'pre', { GSTACK_OUTSIDE_VOICE: 'hermes' });
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(r.stdout).toContain('OUTSIDE_STATUS: completed provider=hermes host=claude');
  });
  test('the rendered default runs (exit 10) when no swap is configured, and post runs the fallback', () => {
    const h = hermesHome(true);
    expect(swap(h, 'pre').status).toBe(10);
    expect(fs.readFileSync(path.join(h.tmpDir, 'swap-fallback'), 'utf8').trim()).toBe('hermes');
    const post = swap(h, 'post');
    expect(post.status).toBe(0);
    expect(post.stdout).toContain('provider=hermes');
  });
  test('a failed swap with no other voice is missing coverage (exit 4), never a silent pass', () => {
    const h = hermesHome(false);
    expect(swap(h, 'pre', { GSTACK_OUTSIDE_VOICE: 'hermes', GSTACK_OUTSIDE_FALLBACK: 'none' }).status).toBe(4);
  });
});

describe('gstack-config fork keys', () => {
  test('typos are rejected; valid values round-trip', () => {
    const gh = tmp();
    const cfg = (...args: string[]) => spawnSync(path.join(ROOT, 'bin', 'gstack-config'), args, { env: { ...process.env, GSTACK_HOME: gh }, encoding: 'utf8', timeout: 30_000 });
    expect(cfg('set', 'outside_voice', 'hermez').status).toBe(1);
    expect(cfg('set', 'llm_lane', 'sideways').status).toBe(1);
    expect(cfg('set', 'outside_voice_trust_deny', '~/a b').status).toBe(1);
    expect(cfg('set', 'outside_voice_fallback', 'none').status).toBe(0);
    expect(cfg('get', 'outside_voice_fallback').stdout.trim()).toBe('none');
  });
});

describe('rendered outside-voice blocks', () => {
  test('every shared invocation selects a provider at run time and can fall back', () => {
    const rendered = fs.readFileSync(path.join(ROOT, 'review', 'sections', 'adversarial.md'), 'utf8');
    expect(rendered).toContain('gstack-outside-voice" swap pre claude codex review 540 "$_OUTSIDE_TMP"');
    expect(rendered).toContain('case "$_OUTSIDE_SWAP_RC" in 0) exit 0 ;; 3) exit 3 ;; 4) exit 1 ;; esac');
    expect(rendered).toContain('swap post claude codex structured 540 "$_OUTSIDE_TMP" \'<base>\' && exit 0 ;; esac');
  });
});
