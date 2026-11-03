/**
 * outside-trust — the fork's repo trust gate for outside voices (SEC-06,
 * CyberBrown/gstack). `outside_voice_trust_deny` in config.yaml plus
 * GSTACK_OUTSIDE_TRUST_DENY is a colon-separated list of path globs, no
 * spaces, `~` allowed: `~/projects/52L/*:~/clients/*`. From a working
 * directory, repository root or shared git directory (a worktree's main repo)
 * that matches one of them, or sits below one, nothing is sent to any outside
 * voice (Codex, Claude Code, Hermes, api). Empty = allow all.
 *
 * The lists only add up: every state root's config and the environment are
 * combined, and a read or resolve error denies. GSTACK_OUTSIDE_TRUST_OVERRIDE=1
 * on one command lets that command through, with a notice.
 *
 * Every send path calls this: lib/outside-consent.ts (TS binaries) and
 * gstack-codex-probe's consent check (bash, via `bun lib/outside-trust.ts`).
 * Not handled: Windows drive paths (the separator is ':') and case-insensitive
 * filesystems (matching is case-sensitive).
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { mergedStateRoots, readKeyFromRoot, type StateRootEnv } from './state-root';

export type TrustDecision =
  | { allowed: true; root: string; overridden?: boolean }
  | { allowed: false; root: string; pattern: string; error?: string };

/** One config value: surrounding quotes and a trailing ` # comment` removed. */
function cleanValue(raw: string): string {
  const value = raw.replace(/\s+#.*$/, '').trim();
  return /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value;
}

function realOrSelf(p: string): string {
  try { return fs.realpathSync(p); } catch { return p; }
}

export function trustDenyPatterns(env: StateRootEnv = process.env): string[] {
  const home = env.HOME ?? os.homedir();
  const raw = [...mergedStateRoots(env).map(root => readKeyFromRoot(root, 'outside_voice_trust_deny') ?? ''), env.GSTACK_OUTSIDE_TRUST_DENY ?? ''];
  const patterns = raw.map(cleanValue).flatMap(v => v.split(':')).map(p => p.trim()).filter(Boolean)
    .map(p => (p === '~' ? home : p.startsWith('~/') ? path.join(home, p.slice(2)) : p))
    .map(p => p.replace(/\/+$/, '') || '/');
  // Match the symlink-resolved spelling too: resolve the fixed prefix before the first glob character.
  const resolved = patterns.map(p => {
    const cut = p.search(/[*?[{]/);
    const prefix = cut < 0 ? p : p.slice(0, p.lastIndexOf('/', cut) + 1 || 0);
    return prefix ? realOrSelf(prefix.replace(/\/+$/, '') || '/') + p.slice(prefix.replace(/\/+$/, '').length) : p;
  });
  return [...new Set([...patterns, ...resolved])];
}

function git(cwd: string, args: string[]): string | undefined {
  // Inherited GIT_DIR / GIT_WORK_TREE would point the check at another repository.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env, timeout: 5000 });
  if (r.error) throw r.error;
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : undefined;
}

function matches(dir: string, patterns: string[]): string | undefined {
  for (let d = dir; ; d = path.dirname(d)) {
    for (const pattern of patterns) if (d === pattern || new Bun.Glob(pattern).match(d)) return pattern;
    if (d === path.dirname(d)) return undefined;
  }
}

export function trustDecision(cwd: string, env: StateRootEnv = process.env): TrustDecision {
  const start = realOrSelf(path.resolve(cwd));
  let root = start;
  try {
    const patterns = trustDenyPatterns(env);
    if (!patterns.length) return { allowed: true, root };
    const top = git(start, ['rev-parse', '--show-toplevel']);
    const common = git(start, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    root = top ? realOrSelf(top) : start;
    // A worktree's common dir is <main repo>/.git: check the main repo too.
    const dirs = [start, root, ...(common ? [path.dirname(realOrSelf(common))] : [])];
    for (const dir of dirs) {
      const pattern = matches(dir, patterns);
      if (!pattern) continue;
      if (env.GSTACK_OUTSIDE_TRUST_OVERRIDE === '1') {
        process.stderr.write(`outside review: GSTACK_OUTSIDE_TRUST_OVERRIDE=1 lets this command past outside_voice_trust_deny '${pattern}' for ${root}\n`);
        return { allowed: true, root, overridden: true };
      }
      return { allowed: false, root, pattern };
    }
    return { allowed: true, root };
  } catch (error) {
    return { allowed: false, root, pattern: '(unresolved)', error: (error as Error).message };
  }
}

export function trustDeniedLine(d: Extract<TrustDecision, { allowed: false }>): string {
  if (d.error) return `outside review: not run (the outside_voice_trust_deny check for ${d.root} failed: ${d.error}; it fails closed, so nothing was sent to an outside model).`;
  return `outside review: not run (${d.root} matches outside_voice_trust_deny '${d.pattern}', so nothing was sent to an outside model). Fix: remove the pattern with gstack-config set outside_voice_trust_deny <globs>, or prefix one deliberate command with GSTACK_OUTSIDE_TRUST_OVERRIDE=1 (do not export it).`;
}

if (import.meta.main) {
  // `bun lib/outside-trust.ts [--cwd <dir>]`: exit 0 allowed, 3 denied (reason on stderr), 2 usage.
  const i = process.argv.indexOf('--cwd');
  if (i >= 0 && !process.argv[i + 1]) {
    process.stderr.write('usage: bun lib/outside-trust.ts [--cwd <dir>]\n');
    process.exit(2);
  }
  const d = trustDecision(i >= 0 ? process.argv[i + 1]! : process.cwd());
  if (!d.allowed) {
    process.stderr.write(`${trustDeniedLine(d)}\n`);
    process.exit(3);
  }
}
