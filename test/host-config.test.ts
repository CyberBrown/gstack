/**
 * Host config system tests — 100% coverage of host-config.ts, hosts/index.ts,
 * host-config-export.ts, and golden-file regression checks.
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { validateHostConfig, validateAllConfigs, type HostConfig } from '../scripts/host-config';
import {
  ALL_HOST_CONFIGS,
  ALL_HOST_NAMES,
  HOST_CONFIG_MAP,
  getHostConfig,
  resolveHostArg,
  getExternalHosts,
  claude,
  muse,
  codex,
  openclaw,
} from '../hosts/index';
import { HOST_PATHS } from '../scripts/resolvers/types';

const ROOT = path.resolve(import.meta.dir, '..');

// ─── hosts/index.ts ─────────────────────────────────────────

describe('hosts/index.ts', () => {
  test('ALL_HOST_CONFIGS has 6 hosts', () => {
    expect(ALL_HOST_CONFIGS.length).toBe(6);
  });

  test('ALL_HOST_NAMES matches config names', () => {
    expect(ALL_HOST_NAMES).toEqual(ALL_HOST_CONFIGS.map(c => c.name));
  });

  test('HOST_CONFIG_MAP keys match names', () => {
    for (const config of ALL_HOST_CONFIGS) {
      expect(HOST_CONFIG_MAP[config.name]).toBe(config);
    }
  });

  test('individual config re-exports match registry', () => {
    expect(claude.name).toBe('claude');
    expect(muse.name).toBe('muse');
    expect(codex.name).toBe('codex');
    expect(openclaw.name).toBe('openclaw');
  });

  test('getHostConfig returns correct config', () => {
    const c = getHostConfig('codex');
    expect(c.name).toBe('codex');
    expect(c.displayName).toBe('OpenAI Codex CLI');
  });

  test('getHostConfig throws on unknown host', () => {
    expect(() => getHostConfig('nonexistent')).toThrow('Unknown host');
  });

  test('resolveHostArg resolves direct names', () => {
    for (const name of ALL_HOST_NAMES) {
      expect(resolveHostArg(name)).toBe(name);
    }
  });

  test('resolveHostArg resolves aliases', () => {
    expect(resolveHostArg('agents')).toBe('codex');
  });

  test('resolveHostArg throws on unknown alias', () => {
    expect(() => resolveHostArg('nonexistent')).toThrow('Unknown host');
  });

  test('getExternalHosts excludes claude', () => {
    const external = getExternalHosts();
    expect(external.find(c => c.name === 'claude')).toBeUndefined();
    expect(external.length).toBe(ALL_HOST_CONFIGS.length - 1);
  });

  test('every host has a unique name', () => {
    const names = new Set(ALL_HOST_NAMES);
    expect(names.size).toBe(ALL_HOST_NAMES.length);
  });

  test('every host has a unique hostSubdir (except codex/muse)', () => {
    // Codex and Muse share .agents/skills by design: Muse Code discovers
    // project skills there and nowhere else. One checkout holds one flavor;
    // setup --host selects the winner (last writer wins).
    const nonShared = ALL_HOST_CONFIGS.filter(c => c.name !== 'muse');
    const subdirs = new Set(nonShared.map(c => c.hostSubdir));
    expect(subdirs.size).toBe(nonShared.length);
    expect(muse.hostSubdir).toBe(codex.hostSubdir);
  });

  test('every host has a unique globalRoot', () => {
    const roots = new Set(ALL_HOST_CONFIGS.map(c => c.globalRoot));
    expect(roots.size).toBe(ALL_HOST_CONFIGS.length);
  });
});

// ─── validateHostConfig ─────────────────────────────────────

describe('validateHostConfig', () => {
  function makeValid(): HostConfig {
    return {
      name: 'test-host',
      displayName: 'Test Host',
      cliCommand: 'testcli',
      globalRoot: '.test/skills/gstack',
      localSkillRoot: '.test/skills/gstack',
      hostSubdir: '.test',
      usesEnvVars: true,
      frontmatter: { mode: 'allowlist', keepFields: ['name', 'description'] },
      generation: { generateMetadata: false },
      pathRewrites: [],
      runtimeRoot: { globalSymlinks: ['bin'] },
      install: { prefixable: false, linkingStrategy: 'symlink-generated' },
    };
  }

  test('valid config passes', () => {
    expect(validateHostConfig(makeValid())).toEqual([]);
  });

  test('invalid name is caught', () => {
    const c = makeValid();
    c.name = 'UPPER_CASE';
    const errors = validateHostConfig(c);
    expect(errors.some(e => e.includes('name'))).toBe(true);
  });

  test('name with special chars is caught', () => {
    const c = makeValid();
    c.name = 'has spaces';
    expect(validateHostConfig(c).length).toBeGreaterThan(0);
  });

  test('empty displayName is caught', () => {
    const c = makeValid();
    c.displayName = '';
    expect(validateHostConfig(c).some(e => e.includes('displayName'))).toBe(true);
  });

  test('invalid cliCommand is caught', () => {
    const c = makeValid();
    c.cliCommand = 'has spaces';
    expect(validateHostConfig(c).some(e => e.includes('cliCommand'))).toBe(true);
  });

  test('invalid cliAlias is caught', () => {
    const c = makeValid();
    c.cliAliases = ['good', 'BAD!'];
    expect(validateHostConfig(c).some(e => e.includes('cliAlias'))).toBe(true);
  });

  test('valid cliAliases pass', () => {
    const c = makeValid();
    c.cliAliases = ['alias-one', 'alias-two'];
    expect(validateHostConfig(c)).toEqual([]);
  });

  test('invalid globalRoot is caught', () => {
    const c = makeValid();
    c.globalRoot = 'path with spaces';
    expect(validateHostConfig(c).some(e => e.includes('globalRoot'))).toBe(true);
  });

  test('invalid localSkillRoot is caught', () => {
    const c = makeValid();
    c.localSkillRoot = 'invalid<path>';
    expect(validateHostConfig(c).some(e => e.includes('localSkillRoot'))).toBe(true);
  });

  test('invalid hostSubdir is caught', () => {
    const c = makeValid();
    c.hostSubdir = 'no spaces allowed';
    expect(validateHostConfig(c).some(e => e.includes('hostSubdir'))).toBe(true);
  });

  test('invalid frontmatter.mode is caught', () => {
    const c = makeValid();
    (c.frontmatter as any).mode = 'invalid';
    expect(validateHostConfig(c).some(e => e.includes('frontmatter.mode'))).toBe(true);
  });

  test('invalid linkingStrategy is caught', () => {
    const c = makeValid();
    (c.install as any).linkingStrategy = 'invalid';
    expect(validateHostConfig(c).some(e => e.includes('linkingStrategy'))).toBe(true);
  });

  test('paths with $ and ~ are valid', () => {
    const c = makeValid();
    c.globalRoot = '$HOME/.test/skills/gstack';
    c.localSkillRoot = '~/.test/skills/gstack';
    expect(validateHostConfig(c)).toEqual([]);
  });

  test('shell injection attempt in cliCommand is caught', () => {
    const c = makeValid();
    c.cliCommand = 'opencode;rm -rf /';
    expect(validateHostConfig(c).some(e => e.includes('cliCommand'))).toBe(true);
  });
});

// ─── validateAllConfigs ─────────────────────────────────────

describe('validateAllConfigs', () => {
  test('real configs all pass validation', () => {
    const errors = validateAllConfigs(ALL_HOST_CONFIGS);
    expect(errors).toEqual([]);
  });

  test('duplicate name detected', () => {
    const dup = { ...codex, name: 'claude' } as HostConfig;
    const errors = validateAllConfigs([claude, dup]);
    expect(errors.some(e => e.includes('Duplicate name'))).toBe(true);
  });

  test('duplicate hostSubdir detected', () => {
    const dup = { ...codex, name: 'dup-host', hostSubdir: '.claude', globalRoot: '.dup/skills/gstack' } as HostConfig;
    const errors = validateAllConfigs([claude, dup]);
    expect(errors.some(e => e.includes('Duplicate hostSubdir'))).toBe(true);
  });

  test('duplicate globalRoot detected', () => {
    const dup = { ...codex, name: 'dup-host', hostSubdir: '.dup', globalRoot: '.claude/skills/gstack' } as HostConfig;
    const errors = validateAllConfigs([claude, dup]);
    expect(errors.some(e => e.includes('Duplicate globalRoot'))).toBe(true);
  });

  test('per-config validation errors are prefixed with host name', () => {
    const bad = { ...codex, name: 'BAD', cliCommand: 'also bad' } as HostConfig;
    const errors = validateAllConfigs([bad]);
    expect(errors.every(e => e.startsWith('[BAD]'))).toBe(true);
  });
});

// ─── HOST_PATHS derivation ──────────────────────────────────

describe('HOST_PATHS derivation from configs', () => {
  test('Claude uses literal home paths (no env vars)', () => {
    expect(HOST_PATHS.claude.skillRoot).toBe('~/.claude/skills/gstack');
    expect(HOST_PATHS.claude.binDir).toBe('~/.claude/skills/gstack/bin');
    expect(HOST_PATHS.claude.browseDir).toBe('~/.claude/skills/gstack/browse/dist');
    expect(HOST_PATHS.claude.designDir).toBe('~/.claude/skills/gstack/design/dist');
  });

  test('Codex uses $GSTACK_ROOT env vars', () => {
    expect(HOST_PATHS.codex.skillRoot).toBe('$GSTACK_ROOT');
    expect(HOST_PATHS.codex.binDir).toBe('$GSTACK_BIN');
    expect(HOST_PATHS.codex.browseDir).toBe('$GSTACK_BROWSE');
    expect(HOST_PATHS.codex.designDir).toBe('$GSTACK_DESIGN');
  });

  test('every host with usesEnvVars=true gets env var paths', () => {
    for (const config of ALL_HOST_CONFIGS) {
      if (config.usesEnvVars) {
        expect(HOST_PATHS[config.name].skillRoot).toBe('$GSTACK_ROOT');
        expect(HOST_PATHS[config.name].binDir).toBe('$GSTACK_BIN');
      }
    }
  });

  test('every host with usesEnvVars=false gets literal paths', () => {
    for (const config of ALL_HOST_CONFIGS) {
      if (!config.usesEnvVars) {
        expect(HOST_PATHS[config.name].skillRoot).toContain('~/');
        expect(HOST_PATHS[config.name].binDir).toContain('/bin');
      }
    }
  });

  test('localSkillRoot matches config for every host', () => {
    for (const config of ALL_HOST_CONFIGS) {
      expect(HOST_PATHS[config.name].localSkillRoot).toBe(config.localSkillRoot);
    }
  });

  test('HOST_PATHS has entry for every registered host', () => {
    for (const name of ALL_HOST_NAMES) {
      expect(HOST_PATHS[name]).toBeDefined();
    }
  });
});

// ─── host-config-export.ts CLI ──────────────────────────────

describe('host-config-export.ts CLI', () => {
  const EXPORT_SCRIPT = path.join(ROOT, 'scripts', 'host-config-export.ts');

  function run(...args: string[]): { stdout: string; stderr: string; exitCode: number } {
    const result = Bun.spawnSync(['bun', 'run', EXPORT_SCRIPT, ...args], {
      cwd: ROOT, stdout: 'pipe', stderr: 'pipe',
    });
    return {
      stdout: result.stdout.toString().trim(),
      stderr: result.stderr.toString().trim(),
      exitCode: result.exitCode,
    };
  }

  test('list prints all host names', () => {
    const { stdout, exitCode } = run('list');
    expect(exitCode).toBe(0);
    const names = stdout.split('\n');
    expect(names).toEqual(ALL_HOST_NAMES);
  });

  test('get returns string field', () => {
    const { stdout, exitCode } = run('get', 'codex', 'globalRoot');
    expect(exitCode).toBe(0);
    expect(stdout).toBe('.codex/skills/gstack');
  });

  test('get returns boolean as 1/0', () => {
    const { stdout: t } = run('get', 'claude', 'usesEnvVars');
    expect(t).toBe('0');
    const { stdout: f } = run('get', 'codex', 'usesEnvVars');
    expect(f).toBe('1');
  });

  test('get with missing args exits 1', () => {
    const { exitCode } = run('get', 'codex');
    expect(exitCode).toBe(1);
  });

  test('get with unknown field exits 1', () => {
    const { exitCode } = run('get', 'codex', 'nonexistent');
    expect(exitCode).toBe(1);
  });

  test('get with unknown host exits 1', () => {
    const { exitCode } = run('get', 'nonexistent', 'name');
    expect(exitCode).not.toBe(0);
  });

  test('validate passes for real configs', () => {
    const { stdout, exitCode } = run('validate');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('configs valid');
  });

  test('symlinks returns asset list', () => {
    const { stdout, exitCode } = run('symlinks', 'codex');
    expect(exitCode).toBe(0);
    const lines = stdout.split('\n');
    expect(lines).toContain('bin');
    expect(lines).toContain('ETHOS.md');
    expect(lines).toContain('review/checklist.md');
  });

  test('symlinks with missing host exits 1', () => {
    const { exitCode } = run('symlinks');
    expect(exitCode).toBe(1);
  });

  test('detect finds claude (since we are running in claude)', () => {
    const { stdout, exitCode } = run('detect');
    expect(exitCode).toBe(0);
    // claude binary should be on PATH in this environment
    expect(stdout).toContain('claude');
  });

  test('unknown command exits 1', () => {
    const { exitCode } = run('badcommand');
    expect(exitCode).toBe(1);
  });
});

// ─── Golden-file regression ─────────────────────────────────

describe('golden-file regression', () => {
  const GOLDEN_DIR = path.join(ROOT, 'test', 'fixtures', 'golden');

  // .agents/skills is shared between the codex and muse flavors (Muse Code
  // discovers project skills there and nowhere else). Regenerate codex flavor
  // first so this comparison is deterministic no matter which flavor another
  // suite left on disk.
  Bun.spawnSync(['bun', 'run', 'scripts/gen-skill-docs.ts', '--host', 'codex'], {
    cwd: ROOT, stdout: 'pipe', stderr: 'pipe',
  });

  test('Claude ship skill matches golden baseline', () => {
    const golden = fs.readFileSync(path.join(GOLDEN_DIR, 'claude-ship-SKILL.md'), 'utf-8');
    const current = fs.readFileSync(path.join(ROOT, 'ship', 'SKILL.md'), 'utf-8');
    expect(current).toBe(golden);
  });

  test('Codex ship skill matches golden baseline', () => {
    const golden = fs.readFileSync(path.join(GOLDEN_DIR, 'codex-ship-SKILL.md'), 'utf-8');
    const current = fs.readFileSync(path.join(ROOT, '.agents', 'skills', 'gstack-ship', 'SKILL.md'), 'utf-8');
    expect(current).toBe(golden);
  });

});

// ─── Individual host config correctness ─────────────────────

describe('host config correctness', () => {
  test('claude is the only prefixable host', () => {
    for (const config of ALL_HOST_CONFIGS) {
      if (config.name === 'claude') {
        expect(config.install.prefixable).toBe(true);
      } else {
        expect(config.install.prefixable).toBe(false);
      }
    }
  });

  test('claude is the only host with real-dir-symlink strategy', () => {
    for (const config of ALL_HOST_CONFIGS) {
      if (config.name === 'claude') {
        expect(config.install.linkingStrategy).toBe('real-dir-symlink');
      } else {
        expect(config.install.linkingStrategy).toBe('symlink-generated');
      }
    }
  });

  test('claude does not use env vars', () => {
    expect(claude.usesEnvVars).toBe(false);
  });

  test('all external hosts use env vars', () => {
    for (const config of getExternalHosts()) {
      expect(config.usesEnvVars).toBe(true);
    }
  });

  test('codex has 1024-char description limit with error behavior', () => {
    expect(codex.frontmatter.descriptionLimit).toBe(1024);
    expect(codex.frontmatter.descriptionLimitBehavior).toBe('error');
  });

  test('codex generates openai.yaml metadata', () => {
    expect(codex.generation.generateMetadata).toBe(true);
    expect(codex.generation.metadataFormat).toBe('openai.yaml');
  });

  test('codex has sidecar config', () => {
    expect(codex.sidecar).toBeDefined();
    expect(codex.sidecar!.path).toBe('.agents/skills/gstack');
  });

  test('codex has suppressedResolvers for self-invocation prevention', () => {
    expect(codex.suppressedResolvers).toBeDefined();
    expect(codex.suppressedResolvers).toContain('CODEX_SECOND_OPINION');
    expect(codex.suppressedResolvers).toContain('ADVERSARIAL_STEP');
    expect(codex.suppressedResolvers).toContain('REVIEW_ARMY');
  });

  test('codex has boundary instruction', () => {
    expect(codex.boundaryInstruction).toBeDefined();
    expect(codex.boundaryInstruction).toContain('Do NOT read');
  });

  test('muse installs to the Muse user skill dir', () => {
    expect(muse.globalRoot).toBe('.config/muse/skills/gstack');
    expect(muse.localSkillRoot).toBe('.agents/skills/gstack');
    expect(muse.cliCommand).toBe('muse');
    expect(muse.usesEnvVars).toBe(true);
  });

  test('muse has neutral tool rewrites', () => {
    expect(muse.toolRewrites).toBeDefined();
    expect(muse.toolRewrites!['use the Bash tool']).toBe('run this command');
    expect(muse.toolRewrites!['use the Agent tool']).toBe('dispatch a subagent');
  });

  test('muse keeps outside-voice resolvers enabled', () => {
    expect(muse.suppressedResolvers ?? []).not.toContain('CODEX_SECOND_OPINION');
    expect(muse.suppressedResolvers ?? []).not.toContain('REVIEW_ARMY');
    expect(muse.suppressedResolvers ?? []).not.toContain('ADVERSARIAL_STEP');
  });

  test('muse shares the codex sidecar path', () => {
    expect(muse.sidecar).toBeDefined();
    expect(muse.sidecar!.path).toBe(codex.sidecar!.path);
  });

  test('openclaw has tool rewrites for exec/read/write', () => {
    expect(openclaw.toolRewrites).toBeDefined();
    expect(openclaw.toolRewrites!['use the Bash tool']).toBe('use the exec tool');
    expect(openclaw.toolRewrites!['use the Read tool']).toBe('use the read tool');
  });

  test('openclaw has CLAUDE.md→AGENTS.md path rewrite', () => {
    expect(openclaw.pathRewrites.some(r => r.from === 'CLAUDE.md' && r.to === 'AGENTS.md')).toBe(true);
  });

  test('openclaw has no adapter (dead code removed)', () => {
    expect(openclaw.adapter).toBeUndefined();
  });

  test('openclaw has no staticFiles (SOUL.md removed)', () => {
    expect(openclaw.staticFiles).toBeUndefined();
  });

  test('openclaw includeSkills is empty (native skills replaced generated ones)', () => {
    expect(openclaw.generation.includeSkills).toBeDefined();
    expect(openclaw.generation.includeSkills!.length).toBe(0);
  });

  test('every host has coAuthorTrailer or undefined', () => {
    // Claude, Codex, OpenClaw have explicit trailers
    expect(claude.coAuthorTrailer).toContain('Claude');
    expect(codex.coAuthorTrailer).toContain('Codex');
    expect(openclaw.coAuthorTrailer).toContain('OpenClaw');
  });

  test('every external host skips the codex skill (except muse)', () => {
    // Muse keeps the codex + claude outside-voice skills: from Muse, neither
    // is self-invocation, so the cross-model second-opinion loop stays on.
    for (const config of getExternalHosts()) {
      if (config.name === 'muse') {
        expect(config.generation.skipSkills ?? []).not.toContain('codex');
        expect(config.generation.skipSkills ?? []).not.toContain('claude');
      } else {
        expect(config.generation.skipSkills).toContain('codex');
      }
    }
  });

  test('every host has at least one pathRewrite (except claude)', () => {
    for (const config of getExternalHosts()) {
      expect(config.pathRewrites.length).toBeGreaterThan(0);
    }
    expect(claude.pathRewrites.length).toBe(0);
  });

  test('every host has runtimeRoot.globalSymlinks', () => {
    for (const config of ALL_HOST_CONFIGS) {
      expect(config.runtimeRoot.globalSymlinks.length).toBeGreaterThan(0);
      expect(config.runtimeRoot.globalSymlinks).toContain('bin');
      expect(config.runtimeRoot.globalSymlinks).toContain('ETHOS.md');
    }
  });
});
