/**
 * llm-lane — the one place the fork decides where outside-model calls go
 * (CyberBrown/gstack). Every outside voice (Codex, Claude Code, Hermes, the
 * api runner) reads this before it starts a provider.
 *
 * Mode, first non-empty wins: GSTACK_LLM_LANE, then `llm_lane` in config.yaml,
 * then `auto`.
 *   auto     litellm when GSTACK_LLM_API_KEY is set, else direct. Machines that
 *            must never go direct set GSTACK_LLM_LANE=litellm in the login
 *            environment (test sandboxes never inherit it), so a missing key
 *            refuses instead of falling back.
 *   litellm  every call goes through the LiteLLM gateway with
 *            GSTACK_LLM_API_KEY. A lane that is not configured refuses the
 *            call (missing coverage) rather than going direct.
 *   direct   upstream behavior: each provider uses its own auth and endpoint.
 * Any other value refuses, so a typo never silently picks a lane.
 *
 * The gateway is described by the Codex profile file
 * `${CODEX_HOME:-~/.codex}/<profile>.config.toml` (profile: GSTACK_CODEX_PROFILE,
 * default `gstack`): its `model` is the lane model and its provider table's
 * `base_url` is the gateway, unless GSTACK_LLM_BASE_URL is set. Claude Code
 * uses that URL without its trailing /v1 unless GSTACK_LLM_ANTHROPIC_BASE_URL
 * names its Anthropic root. Nothing about the gateway lives in this
 * repository (it is public).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readConfigKey, type StateRootEnv } from './state-root';

export type LaneMode = 'litellm' | 'direct';
export const LANE_KEY_VAR = 'GSTACK_LLM_API_KEY';

export interface LaneState {
  mode: LaneMode;
  /** litellm only: the gateway can be called. Always true for direct. */
  ready: boolean;
  /** Why a litellm lane cannot be used, and how to fix it. */
  problem?: string;
  repair?: string;
  codexProfile: string;
  codexProfileFile: string;
  /** The profile's `model`: the logical lane model the gateway serves. */
  model?: string;
  /** OpenAI-compatible base URL, ending in /v1 when the profile's does. */
  baseUrl?: string;
  /** The gateway's Anthropic-compatible root, for Claude Code. */
  anthropicBaseUrl?: string;
}

const REPAIR = `export ${LANE_KEY_VAR}, create the Codex profile file with model, model_provider and its base_url (see docs/FORK.md "Lane configuration"), or opt out with: gstack-config set llm_lane direct`;

/** Lane key, trimmed; empty when unset. */
export function laneKey(env: StateRootEnv = process.env): string {
  return (env[LANE_KEY_VAR] ?? '').trim();
}

function rawMode(env: StateRootEnv): string {
  return (env.GSTACK_LLM_LANE?.trim() || readConfigKey('llm_lane', env)?.trim() || 'auto').toLowerCase();
}

function profileFile(env: StateRootEnv): string {
  const codexHome = env.CODEX_HOME || path.join(env.HOME || os.homedir(), '.codex');
  return path.join(codexHome, `${env.GSTACK_CODEX_PROFILE?.trim() || 'gstack'}.config.toml`);
}

export function laneMode(env: StateRootEnv = process.env): LaneMode {
  const raw = rawMode(env);
  if (raw === 'auto') return laneKey(env) ? 'litellm' : 'direct';
  return raw === 'direct' ? 'direct' : 'litellm';
}

/** https, or http only to this machine; never a bearer key over plain HTTP. */
function checkedUrl(raw: string): string | undefined {
  let url: URL;
  try { url = new URL(raw); } catch { return undefined; }
  const local = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
  if (!url.hostname || !(url.protocol === 'https:' || (url.protocol === 'http:' && local))) return undefined;
  return raw.replace(/\/+$/, '');
}

export function resolveLane(env: StateRootEnv = process.env): LaneState {
  const mode = laneMode(env);
  const codexProfile = env.GSTACK_CODEX_PROFILE?.trim() || 'gstack';
  const codexProfileFile = profileFile(env);
  const base: LaneState = { mode, ready: mode === 'direct', codexProfile, codexProfileFile };
  const refuse = (problem: string): LaneState => ({ ...base, ready: false, problem, repair: REPAIR });
  const raw = rawMode(env);
  if (!['auto', 'litellm', 'direct'].includes(raw)) return refuse(`llm_lane '${raw.slice(0, 32)}' is not auto, litellm or direct`);
  if (mode === 'direct') return base;

  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(codexProfile)) return refuse(`GSTACK_CODEX_PROFILE '${codexProfile.slice(0, 64)}' is not a plain profile name`);
  if (!laneKey(env)) return refuse(`${LANE_KEY_VAR} is not set`);
  let parsed: Record<string, any>;
  try {
    parsed = Bun.TOML.parse(fs.readFileSync(codexProfileFile, 'utf8')) as Record<string, any>;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return refuse(code === 'ENOENT' ? `the LiteLLM profile file ${codexProfileFile} does not exist` : `the LiteLLM profile file ${codexProfileFile} could not be read or parsed`);
  }
  const model = typeof parsed.model === 'string' ? parsed.model.trim() : '';
  if (!model) return refuse(`${codexProfileFile} sets no model`);
  const providerId = typeof parsed.model_provider === 'string' ? parsed.model_provider : '';
  const fileUrl = providerId ? parsed.model_providers?.[providerId]?.base_url : undefined;
  const baseUrl = checkedUrl(env.GSTACK_LLM_BASE_URL?.trim() || (typeof fileUrl === 'string' ? fileUrl.trim() : ''));
  if (!baseUrl) return refuse(`no usable gateway base_url (https, or http to localhost): set GSTACK_LLM_BASE_URL or [model_providers.${providerId || '<id>'}].base_url in ${codexProfileFile}`);
  const anthropicBaseUrl = env.GSTACK_LLM_ANTHROPIC_BASE_URL?.trim() ? checkedUrl(env.GSTACK_LLM_ANTHROPIC_BASE_URL.trim()) : baseUrl.replace(/\/v1$/, '');
  if (!anthropicBaseUrl) return refuse('GSTACK_LLM_ANTHROPIC_BASE_URL is not an https URL (or http to localhost)');
  return { ...base, ready: true, model, baseUrl, anthropicBaseUrl };
}

/** One line for status output; never includes the key or the gateway URL. */
export function laneSummary(lane: LaneState): string {
  if (lane.mode === 'direct') return 'LLM_LANE: direct';
  return lane.ready ? `LLM_LANE: litellm model=${lane.model} profile=${lane.codexProfile}` : `LLM_LANE: litellm unavailable (${lane.problem})`;
}

/** Variables that would route a Claude Code child around the gateway or carry a direct credential. */
const CLAUDE_DIRECT_ROUTES = [
  'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BEDROCK_BASE_URL', 'ANTHROPIC_VERTEX_BASE_URL',
  'ANTHROPIC_FOUNDRY_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
];
/** Every model slot Claude Code may fill on its own (background, subagent tiers); the gateway serves only the lane model. */
const CLAUDE_MODEL_SLOTS = ['ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL'];

/** The model a lane Claude Code child asks for: an explicit GSTACK_CLAUDE_MODEL, else the lane model. */
function claudeLaneModel(lane: LaneState, env: NodeJS.ProcessEnv): string {
  return env.GSTACK_CLAUDE_MODEL?.trim() || lane.model!;
}

/**
 * Environment for a Claude Code child process on the lane: the gateway root,
 * the lane key as a bearer token, every model slot on the lane model, and no
 * direct route or credential left behind.
 */
export function claudeLaneEnv(lane: LaneState, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (lane.mode !== 'litellm') return env;
  const key = laneKey(env);
  if (!lane.ready || !key) throw new Error(`LiteLLM lane unavailable: ${lane.problem ?? `${LANE_KEY_VAR} is not set`}`);
  const next: NodeJS.ProcessEnv = { ...env };
  for (const name of CLAUDE_DIRECT_ROUTES) delete next[name];
  const model = claudeLaneModel(lane, env);
  for (const name of CLAUDE_MODEL_SLOTS) next[name] = model;
  next.ANTHROPIC_BASE_URL = lane.anthropicBaseUrl;
  next.ANTHROPIC_AUTH_TOKEN = key;
  return next;
}

/**
 * The non-secret part of the lane for Claude Code's flag settings (`--settings`
 * outranks user and project settings.json, whose env block could otherwise
 * repoint the CLI). The key stays in the process environment, never argv.
 */
export function claudeLaneSettingsEnv(lane: LaneState, env: NodeJS.ProcessEnv): Record<string, string> | undefined {
  if (lane.mode !== 'litellm' || !lane.ready) return undefined;
  const model = claudeLaneModel(lane, env);
  return {
    ANTHROPIC_BASE_URL: lane.anthropicBaseUrl!,
    ...Object.fromEntries(CLAUDE_MODEL_SLOTS.map(name => [name, model])),
    CLAUDE_CODE_USE_BEDROCK: '', CLAUDE_CODE_USE_VERTEX: '', CLAUDE_CODE_USE_FOUNDRY: '',
  };
}

if (import.meta.main) {
  // `bun lib/llm-lane.ts` prints the summary; `--codex-profile` prints the
  // profile codex calls must carry (empty on the direct lane). Both exit 1
  // when a litellm lane is unusable.
  const lane = resolveLane();
  if (!lane.ready) {
    process.stderr.write(`${laneSummary(lane)}\nRepair: ${lane.repair}\n`);
    process.exit(1);
  }
  process.stdout.write(process.argv.includes('--codex-profile') ? `${lane.mode === 'litellm' ? lane.codexProfile : ''}\n` : `${laneSummary(lane)}\n`);
}
