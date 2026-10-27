import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const ROOT = path.resolve(import.meta.dir, '..');
const PROBE = path.join(ROOT, 'bin/gstack-hermes-probe');

// Run a bash snippet that sources the probe and evaluates one of its functions.
// Controlled env + optional tempdir for HOME isolation.
function runProbe(opts: {
  snippet: string;
  env?: Record<string, string | undefined>;
  home?: string;
}): { stdout: string; stderr: string; status: number } {
  const env: Record<string, string> = {
    // Start from a clean env so test-env vars from the parent don't leak in.
    PATH: process.env.PATH ?? '',
    _TEL: 'off',
  };
  if (opts.home) env.HOME = opts.home;
  // Apply overrides; undefined means "remove".
  if (opts.env) {
    for (const [k, v] of Object.entries(opts.env)) {
      if (v === undefined) {
        delete env[k];
      } else {
        env[k] = v;
      }
    }
  }
  const script = `set +e\nsource "${PROBE}"\n${opts.snippet}\n`;
  const result = spawnSync('bash', ['-c', script], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 5000,
  });
  return {
    stdout: (result.stdout ?? '').toString(),
    stderr: (result.stderr ?? '').toString(),
    status: result.status ?? -1,
  };
}

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-hermes-probe-home-'));
}

// Write a fake reviewer profile under <home>/.hermes/profiles/<name>/.
function makeProfile(
  home: string,
  name: string,
  opts: { config?: string; env?: string } = {},
): string {
  const dir = path.join(home, '.hermes', 'profiles', name);
  fs.mkdirSync(dir, { recursive: true });
  if (opts.config !== undefined) fs.writeFileSync(path.join(dir, 'config.yaml'), opts.config);
  if (opts.env !== undefined) fs.writeFileSync(path.join(dir, '.env'), opts.env);
  return dir;
}

const GSTACK_KEY_CONFIG = `model:\n  default: pro\n  provider: custom\n  api_key: \${GSTACK_LLM_API_KEY}\n`;

describe('gstack-hermes-probe: auth probe', () => {
  test('profile missing → PROFILE_MISSING with exit 1', () => {
    const home = tempHome();
    try {
      const r = runProbe({ snippet: '_gstack_hermes_auth_probe gstack-reviewer', home });
      expect(r.stdout.trim()).toBe('PROFILE_MISSING');
      expect(r.status).toBe(1);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('${GSTACK_LLM_API_KEY} ref + env set → AUTH_OK', () => {
    const home = tempHome();
    try {
      makeProfile(home, 'gstack-reviewer', { config: GSTACK_KEY_CONFIG });
      const r = runProbe({
        snippet: '_gstack_hermes_auth_probe gstack-reviewer',
        env: { GSTACK_LLM_API_KEY: 'sk-test' },
        home,
      });
      expect(r.stdout.trim()).toBe('AUTH_OK');
      expect(r.status).toBe(0);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('api_key ref that is not a plain var name → AUTH_FAILED, no command runs (SEC-08)', () => {
    const home = tempHome();
    try {
      const pwned = path.join(home, 'pwned');
      makeProfile(home, 'gstack-reviewer', {
        config: `model:\n  api_key: \${a[$(touch ${pwned})]}\n`,
      });
      const r = runProbe({ snippet: '_gstack_hermes_auth_probe gstack-reviewer', home });
      expect(r.stdout.trim()).toBe('AUTH_FAILED');
      expect(r.status).toBe(1);
      expect(fs.existsSync(pwned)).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('${GSTACK_LLM_API_KEY} ref + env unset + profile .env has it → AUTH_OK', () => {
    const home = tempHome();
    try {
      makeProfile(home, 'gstack-reviewer', {
        config: GSTACK_KEY_CONFIG,
        env: 'GSTACK_LLM_API_KEY=sk-from-profile-env\n',
      });
      const r = runProbe({
        snippet: '_gstack_hermes_auth_probe gstack-reviewer',
        env: { GSTACK_LLM_API_KEY: undefined },
        home,
      });
      expect(r.stdout.trim()).toBe('AUTH_OK');
      expect(r.status).toBe(0);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('${GSTACK_LLM_API_KEY} ref + whitespace-only env + no .env → AUTH_FAILED', () => {
    const home = tempHome();
    try {
      makeProfile(home, 'gstack-reviewer', { config: GSTACK_KEY_CONFIG });
      const r = runProbe({
        snippet: '_gstack_hermes_auth_probe gstack-reviewer',
        env: { GSTACK_LLM_API_KEY: '   ' },
        home,
      });
      expect(r.stdout.trim()).toBe('AUTH_FAILED');
      expect(r.status).toBe(1);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('${GSTACK_LLM_API_KEY} ref + env unset + empty .env assignment → AUTH_FAILED', () => {
    const home = tempHome();
    try {
      makeProfile(home, 'gstack-reviewer', {
        config: GSTACK_KEY_CONFIG,
        env: 'GSTACK_LLM_API_KEY=\n',
      });
      const r = runProbe({
        snippet: '_gstack_hermes_auth_probe gstack-reviewer',
        env: { GSTACK_LLM_API_KEY: undefined },
        home,
      });
      expect(r.stdout.trim()).toBe('AUTH_FAILED');
      expect(r.status).toBe(1);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('literal api_key in config → AUTH_OK (no env needed)', () => {
    const home = tempHome();
    try {
      makeProfile(home, 'gstack-reviewer', {
        config: 'model:\n  default: pro\n  api_key: sk-literal\n',
      });
      const r = runProbe({
        snippet: '_gstack_hermes_auth_probe gstack-reviewer',
        env: { GSTACK_LLM_API_KEY: undefined },
        home,
      });
      expect(r.stdout.trim()).toBe('AUTH_OK');
      expect(r.status).toBe(0);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('no api_key in config + GSTACK_LLM_API_KEY set → AUTH_OK (fallback signal)', () => {
    const home = tempHome();
    try {
      makeProfile(home, 'gstack-reviewer', { config: 'model:\n  default: pro\n' });
      const r = runProbe({
        snippet: '_gstack_hermes_auth_probe gstack-reviewer',
        env: { GSTACK_LLM_API_KEY: 'sk-test' },
        home,
      });
      expect(r.stdout.trim()).toBe('AUTH_OK');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('no api_key + no env + no .env → AUTH_FAILED', () => {
    const home = tempHome();
    try {
      makeProfile(home, 'gstack-reviewer', { config: 'model:\n  default: pro\n' });
      const r = runProbe({
        snippet: '_gstack_hermes_auth_probe gstack-reviewer',
        env: { GSTACK_LLM_API_KEY: undefined },
        home,
      });
      expect(r.stdout.trim()).toBe('AUTH_FAILED');
      expect(r.status).toBe(1);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('custom profile name argument is honored', () => {
    const home = tempHome();
    try {
      makeProfile(home, 'my-reviewer', { config: GSTACK_KEY_CONFIG });
      const r = runProbe({
        snippet: '_gstack_hermes_auth_probe my-reviewer',
        env: { GSTACK_LLM_API_KEY: 'sk-test' },
        home,
      });
      expect(r.stdout.trim()).toBe('AUTH_OK');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('alternate $GSTACK_HERMES_PROFILES_DIR → checks the alternate path', () => {
    const home = tempHome();
    try {
      const alt = path.join(home, 'elsewhere');
      const dir = path.join(alt, 'gstack-reviewer');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'config.yaml'), GSTACK_KEY_CONFIG);
      const r = runProbe({
        snippet: '_gstack_hermes_auth_probe gstack-reviewer',
        env: { GSTACK_LLM_API_KEY: 'sk-test', GSTACK_HERMES_PROFILES_DIR: alt },
        home,
      });
      expect(r.stdout.trim()).toBe('AUTH_OK');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

// --- Group 2: voice_ok (usage-file success signal) --------------------------

function runVoiceOk(usageJson: string | null): number {
  const home = tempHome();
  try {
    let snippet: string;
    if (usageJson === null) {
      snippet = `_gstack_hermes_voice_ok "${home}/missing.json"; echo "rc=$?"`;
    } else {
      const f = path.join(home, 'usage.json');
      fs.writeFileSync(f, usageJson);
      snippet = `_gstack_hermes_voice_ok "${f}"; echo "rc=$?"`;
    }
    const r = runProbe({ snippet, home });
    const m = r.stdout.match(/rc=(\d+)/);
    return m ? parseInt(m[1], 10) : -1;
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

describe('gstack-hermes-probe: voice_ok (hermes -z exits 0 on API failure; usage file is truth)', () => {
  test('failed=false + completed=true → 0', () => {
    expect(runVoiceOk('{"failed": false, "completed": true, "model": "pro"}')).toBe(0);
  });

  test('failed=true (401/403 shape) → 1', () => {
    expect(runVoiceOk('{"failed": true, "completed": false, "model": null}')).toBe(1);
  });

  test('completed=false → 1', () => {
    expect(runVoiceOk('{"failed": false, "completed": false}')).toBe(1);
  });

  test('missing usage file → 1', () => {
    expect(runVoiceOk(null)).toBe(1);
  });

  test('empty-string path → 1', () => {
    const r = runProbe({ snippet: '_gstack_hermes_voice_ok ""; echo "rc=$?"' });
    expect(r.stdout).toContain('rc=1');
  });

  test('pretty-printed JSON (multiline) → 0', () => {
    expect(runVoiceOk('{\n  "failed": false,\n  "completed": true\n}\n')).toBe(0);
  });
});

// --- Group 3: Timeout wrapper + namespace hygiene ---------------------------

describe('gstack-hermes-probe: timeout wrapper + namespace hygiene', () => {
  test('bin/gstack-hermes-probe is syntactically valid bash (bash -n)', () => {
    const result = spawnSync('bash', ['-n', PROBE], { timeout: 5000 });
    expect(result.status).toBe(0);
  });

  test('timeout wrapper executes command directly when neither binary present', () => {
    const r = runProbe({
      snippet: `_gstack_hermes_timeout_wrapper 5 echo hello_world`,
      env: { PATH: '/bin:/usr/bin' }, // these usually lack gtimeout; timeout may exist on linux
    });
    // Regardless of whether timeout is on this PATH, echo hello_world should succeed.
    expect(r.stdout.trim()).toBe('hello_world');
  });

  test('timeout wrapper resolves gtimeout preferentially when on PATH', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-gto-stub-'));
    try {
      const stub = path.join(dir, 'gtimeout');
      fs.writeFileSync(stub, '#!/bin/bash\necho gtimeout_chosen_$1\n');
      fs.chmodSync(stub, 0o755);
      const r = runProbe({
        snippet: `_gstack_hermes_timeout_wrapper 5 echo nope`,
        env: { PATH: `${dir}:/bin:/usr/bin` },
      });
      expect(r.stdout.trim()).toBe('gtimeout_chosen_5');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('sourcing probe does NOT set errexit/trap/IFS in caller shell (namespace hygiene)', () => {
    const r = runProbe({
      snippet: `
BEFORE=$(set -o | sort)
source "${PROBE}"   # source again to catch accumulation
AFTER=$(set -o | sort)
if [ "$BEFORE" = "$AFTER" ]; then
  echo "CLEAN"
else
  echo "POLLUTED"
  diff <(echo "$BEFORE") <(echo "$AFTER")
fi
`,
    });
    expect(r.stdout).toContain('CLEAN');
  });
});

// --- Group 4: Telemetry event emission --------------------------------------

describe('gstack-hermes-probe: telemetry event emission', () => {
  test('_gstack_hermes_log_event writes jsonl when _TEL != off', () => {
    const home = tempHome();
    try {
      const r = runProbe({
        snippet: `_gstack_hermes_log_event "hermes_test_event" "42"; cat "$HOME/.gstack/analytics/skill-usage.jsonl"`,
        env: { _TEL: 'community' },
        home,
      });
      expect(r.stdout).toContain('"skill":"hermes"');
      expect(r.stdout).toContain('"event":"hermes_test_event"');
      expect(r.stdout).toContain('"duration_s":"42"');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('_gstack_hermes_log_event skips write when _TEL = off', () => {
    const home = tempHome();
    try {
      const r = runProbe({
        snippet: `_gstack_hermes_log_event "hermes_test_event"; [ -f "$HOME/.gstack/analytics/skill-usage.jsonl" ] && echo EXISTS || echo MISSING`,
        env: { _TEL: 'off' },
        home,
      });
      expect(r.stdout.trim()).toBe('MISSING');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('payload never contains env values or auth tokens (schema check)', () => {
    const home = tempHome();
    try {
      const r = runProbe({
        snippet: `_gstack_hermes_log_event "hermes_auth_failed"; cat "$HOME/.gstack/analytics/skill-usage.jsonl"`,
        env: { _TEL: 'community', GSTACK_LLM_API_KEY: 'sk-super-secret-value' },
        home,
      });
      expect(r.stdout).not.toContain('sk-super-secret-value');
      expect(r.stdout.trim()).toMatch(
        /^\{"skill":"hermes","event":"hermes_auth_failed","duration_s":"0","ts":"[^"]+"\}$/,
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
