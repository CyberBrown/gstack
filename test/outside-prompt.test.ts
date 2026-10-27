import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

// SEC-03 / SEC-04 (docs/reviews/FABLE-REVIEW-2026-10-20.md): /autoplan's
// outside-voice prompts carry model-written text, so they must travel through
// a private file and never be pasted into shell source. Hermes must not be
// able to change the working tree unnoticed.

const ROOT = path.resolve(import.meta.dir, '..');
const LIB = path.join(ROOT, 'bin/gstack-outside-prompt');
const HERMES_PROBE = path.join(ROOT, 'bin/gstack-hermes-probe');

function run(snippet: string, env: Record<string, string> = {}, cwd?: string) {
  const script = `set +e\nsource "${LIB}"\nsource "${HERMES_PROBE}"\n${snippet}\n`;
  const r = spawnSync('bash', ['-c', script], {
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', _TEL: 'off', ...env },
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 10000,
  });
  return { stdout: (r.stdout ?? '').toString(), stderr: (r.stderr ?? '').toString(), status: r.status ?? -1 };
}

function tmpBase(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-outside-test-'));
}

function newPromptFile(base: string): string {
  const r = run('_gstack_outside_prompt_new', { TMPDIR: base });
  expect(r.status).toBe(0);
  const m = r.stdout.match(/^OUTSIDE_PROMPT_FILE: (.+)$/m);
  expect(m).not.toBeNull();
  return m![1];
}

describe('gstack-outside-prompt: private prompt files', () => {
  test('bash -n passes', () => {
    expect(spawnSync('bash', ['-n', LIB]).status).toBe(0);
  });

  test('_new creates an empty 0600 file in a 0700 dir under $TMPDIR', () => {
    const base = tmpBase();
    try {
      const f = newPromptFile(base);
      expect(f.startsWith(base + '/gstack-outside.')).toBe(true);
      expect(f.endsWith('/prompt')).toBe(true);
      expect(fs.statSync(path.dirname(f)).mode & 0o777).toBe(0o700);
      expect(fs.statSync(f).mode & 0o777).toBe(0o600);
      expect(fs.statSync(f).size).toBe(0);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  test('hostile prompt text round-trips literally and executes nothing', () => {
    const base = tmpBase();
    try {
      const f = newPromptFile(base);
      const pwned = path.join(base, 'pwned');
      const hostile = `summary with \`touch ${pwned}\` and $(touch ${pwned}) and "quotes" and $HOME`;
      fs.writeFileSync(f, hostile);
      const r = run(
        `_OUTSIDE_PROMPT=$(_gstack_outside_prompt_read '${f}') || exit 1\nprintf '%s' "$_OUTSIDE_PROMPT"`,
        { TMPDIR: base },
      );
      expect(r.status).toBe(0);
      expect(r.stdout).toBe(hostile);
      expect(fs.existsSync(pwned)).toBe(false);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  test('_read refuses an empty prompt file (Write step skipped)', () => {
    const base = tmpBase();
    try {
      const f = newPromptFile(base);
      const r = run(`_gstack_outside_prompt_read '${f}'`, { TMPDIR: base });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('empty');
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  test('_read refuses paths it did not create', () => {
    const base = tmpBase();
    try {
      const other = path.join(base, 'prompt');
      fs.writeFileSync(other, 'x');
      const fake = path.join(base, 'gstack-outside.short', 'prompt');
      fs.mkdirSync(path.dirname(fake));
      fs.writeFileSync(fake, 'x');
      for (const p of [other, fake, '/etc/passwd', `${base}/gstack-outside.AAAAAAAA/../prompt`]) {
        const r = run(`_gstack_outside_prompt_read '${p}'`, { TMPDIR: base });
        expect(r.status).toBe(1);
        expect(r.stdout).toBe('');
      }
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  test('_read refuses a symlinked prompt file', () => {
    const base = tmpBase();
    try {
      const f = newPromptFile(base);
      fs.rmSync(f);
      fs.symlinkSync('/etc/hostname', f);
      const r = run(`_gstack_outside_prompt_read '${f}'`, { TMPDIR: base });
      expect(r.status).toBe(1);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  test('_cleanup removes the private dir and ignores foreign paths', () => {
    const base = tmpBase();
    try {
      const f = newPromptFile(base);
      fs.writeFileSync(f, 'x');
      const keep = path.join(base, 'keep');
      fs.writeFileSync(keep, 'x');
      const r = run(`_gstack_outside_prompt_cleanup '${f}'; _gstack_outside_prompt_cleanup '${keep}'`, { TMPDIR: base });
      expect(r.status).toBe(0);
      expect(fs.existsSync(path.dirname(f))).toBe(false);
      expect(fs.existsSync(keep)).toBe(true);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  test('sourcing does not set errexit/trap/IFS in the caller', () => {
    const r = spawnSync('bash', ['-c', `source "${LIB}"; echo "$-"; trap -p; printf '%q' "$IFS"`]);
    const out = (r.stdout ?? '').toString();
    expect(out.split('\n')[0]).not.toContain('e');
    expect(out).not.toContain('trap --');
    expect(out).toContain("$' \\t\\n'");
  });
});

describe('gstack-hermes-probe: read-only tree guard (SEC-04)', () => {
  test('_gstack_hermes_tree_state changes on edits, new files and staged changes', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-tree-guard-'));
    try {
      const git = (...a: string[]) =>
        spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: repo });
      git('init', '-q');
      fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
      git('add', '.');
      git('commit', '-qm', 'init');
      const state = () => run(`_gstack_hermes_tree_state '${repo}'`).stdout;
      const s0 = state();
      expect(state()).toBe(s0);
      fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
      const s1 = state();
      expect(s1).not.toBe(s0);
      // A second edit to an already-modified file must still be visible.
      fs.writeFileSync(path.join(repo, 'a.txt'), 'three\n');
      expect(state()).not.toBe(s1);
      fs.writeFileSync(path.join(repo, 'new.txt'), 'x');
      expect(state()).not.toBe(s1);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('autoplan: no model-written text in shell source (SEC-03 tripwire)', () => {
  const files = [
    path.join(ROOT, 'autoplan', 'SKILL.md.tmpl'),
    path.join(ROOT, 'autoplan', 'SKILL.md'),
  ];

  // Collect the contents of ```bash fences.
  function bashBlocks(md: string): string[] {
    const blocks: string[] = [];
    const re = /```bash\n([\s\S]*?)```/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(md))) blocks.push(m[1]);
    return blocks;
  }

  for (const f of files) {
    test(`${path.relative(ROOT, f)}: no <insert ...> / <plan_path> placeholder inside a bash block`, () => {
      const offenders = bashBlocks(fs.readFileSync(f, 'utf-8')).filter(b => /<insert|<plan_path>/.test(b));
      expect(offenders).toEqual([]);
    });

    test(`${path.relative(ROOT, f)}: every codex exec / hermes -z prompt argument is "$_OUTSIDE_PROMPT"`, () => {
      const lines = bashBlocks(fs.readFileSync(f, 'utf-8')).join('\n').split('\n');
      const calls = lines.filter(l => /codex exec |hermes --profile /.test(l));
      expect(calls.length).toBeGreaterThanOrEqual(8);
      for (const l of calls) {
        if (l.includes('codex exec')) expect(l).toMatch(/codex exec \$_CODEX_PROFILE_ARGS "\$_OUTSIDE_PROMPT" /);
        else expect(l).toMatch(/ -z "\$_OUTSIDE_PROMPT" /);
      }
    });

    test(`${path.relative(ROOT, f)}: hermes usage file lives in the private prompt dir (no /tmp mktemp leak)`, () => {
      const md = fs.readFileSync(f, 'utf-8');
      expect(md).not.toContain('mktemp /tmp/gstack-hermes-usage');
      expect(md).toContain('_HERMES_USAGE="${_OUTSIDE_PROMPT_FILE%/prompt}/usage.json"');
    });
  }
});
