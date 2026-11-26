/**
 * Agent Flow truth layer.
 *
 * The diagram stays an authored explanation of the system, but every volatile
 * label comes from the same fleet configuration the executors read. Atlas's
 * check is deterministic and local: once per local day (or immediately when
 * the config fingerprint changes) it validates the required diagram actors and
 * records a durable, visible stamp. No model call and no invented "live" clock.
 */
import {
  BILLING_LABEL,
  FLEET_AGENTS,
  getFleetSelection,
  type BillingSource,
  type FleetAgentDef,
  type WireClass,
} from '@/command/fleetStore';
import { mirrorSet } from '@/shared/persist';
import type { PlanNames } from '../api';

export const AGENT_FLOW_CHECK_KEY = 'praxis.agentFlow.atlasCheck.v1';

/** Major sections carried over from the original Flight Deck design package. */
export const AGENT_FLOW_PACKAGE_PORTS = [
  'operator-entry',
  'atlas-fast-lane',
  'self-firing-work',
  'praxis-orchestrator',
  'configured-hands',
  'provider-rails',
  'worktree-lanes',
  'lens-proof-gate',
  'trust-gate',
  'quartz-memory-loop',
  'ambient-staff',
  'operator-inbox',
] as const;

export const AGENT_FLOW_REQUIRED_KEYS = [
  'forge',
  'vega',
  'quill',
  'atlas',
  'lens',
  'sage',
  'scribe',
] as const;

export type AgentFlowKey = (typeof AGENT_FLOW_REQUIRED_KEYS)[number];

export interface AgentFlowFact {
  key: AgentFlowKey;
  name: string;
  role: string;
  model: string;
  billing: BillingSource | null;
  rail: string;
  wire: WireClass | 'missing';
}

export interface AgentFlowManifest {
  facts: Record<AgentFlowKey, AgentFlowFact>;
  fingerprint: string;
  issues: string[];
}

export interface AtlasFlowCheck {
  checkedAt: number;
  nextCheckAt: number;
  fingerprint: string;
  ok: boolean;
  issues: string[];
  factCount: number;
  packagePortCount: number;
}

function localDayKey(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

function nextLocalDay(at: number): number {
  const date = new Date(at);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
}

function planTier(source: BillingSource, plans: PlanNames): string | null {
  if (source === 'claude-max') return plans.claude;
  if (source === 'chatgpt') return plans.codex;
  if (source === 'cursor-sub') return plans.cursor;
  return null;
}

function railLabel(source: BillingSource | null, plans: PlanNames): string {
  if (!source) return 'CONFIG UNAVAILABLE';
  const tier = planTier(source, plans)?.trim();
  if (source === 'claude-max') return tier ? `CLAUDE · ${tier}` : 'CLAUDE';
  if (source === 'chatgpt') return tier ? `CODEX · ${tier}` : 'CODEX';
  if (source === 'cursor-sub') return tier ? `CURSOR · ${tier}` : 'CURSOR';
  return BILLING_LABEL[source].toUpperCase();
}

function missingFact(key: AgentFlowKey): AgentFlowFact {
  return {
    key,
    name: key.toUpperCase(),
    role: 'configuration missing',
    model: 'UNCONFIGURED',
    billing: null,
    rail: 'CONFIG UNAVAILABLE',
    wire: 'missing',
  };
}

function factFor(def: FleetAgentDef | undefined, key: AgentFlowKey, plans: PlanNames): AgentFlowFact {
  if (!def) return missingFact(key);
  const selected = getFleetSelection(key);
  return {
    key,
    name: def.name,
    role: def.role,
    model: selected?.label ?? 'UNCONFIGURED',
    billing: selected?.billing ?? null,
    rail: railLabel(selected?.billing ?? null, plans),
    wire: def.wire,
  };
}

export function buildAgentFlowManifest(plans: PlanNames): AgentFlowManifest {
  const catalog = new Map(FLEET_AGENTS.map((agent) => [agent.key, agent]));
  const facts = {} as Record<AgentFlowKey, AgentFlowFact>;
  const issues: string[] = [];

  for (const key of AGENT_FLOW_REQUIRED_KEYS) {
    const fact = factFor(catalog.get(key), key, plans);
    facts[key] = fact;
    if (fact.wire === 'missing') issues.push(`${key}: fleet definition missing`);
    if (!fact.billing) issues.push(`${key}: model selection unavailable`);
  }

  const fingerprint = JSON.stringify({
    facts: AGENT_FLOW_REQUIRED_KEYS.map((key) => facts[key]),
    packagePorts: AGENT_FLOW_PACKAGE_PORTS,
  });
  return { facts, fingerprint, issues };
}

function parseSaved(raw: string | null): AtlasFlowCheck | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<AtlasFlowCheck>;
    if (
      typeof value.checkedAt !== 'number' ||
      typeof value.nextCheckAt !== 'number' ||
      typeof value.fingerprint !== 'string' ||
      typeof value.ok !== 'boolean' ||
      !Array.isArray(value.issues)
    ) return null;
    return {
      checkedAt: value.checkedAt,
      nextCheckAt: value.nextCheckAt,
      fingerprint: value.fingerprint,
      ok: value.ok,
      issues: value.issues.filter((item): item is string => typeof item === 'string'),
      factCount: typeof value.factCount === 'number' ? value.factCount : 0,
      packagePortCount: typeof value.packagePortCount === 'number' ? value.packagePortCount : 0,
    };
  } catch {
    return null;
  }
}

/** Run/reuse Atlas's local diagram check. Config changes bypass the daily cache. */
export function recordAtlasFlowCheck(
  manifest: AgentFlowManifest,
  now = Date.now(),
  force = false,
): AtlasFlowCheck {
  let saved: AtlasFlowCheck | null = null;
  try {
    saved = parseSaved(localStorage.getItem(AGENT_FLOW_CHECK_KEY));
  } catch {
    /* Storage unavailable: still return a truthful in-memory check below. */
  }

  if (
    !force &&
    saved &&
    saved.fingerprint === manifest.fingerprint &&
    saved.nextCheckAt > now &&
    localDayKey(saved.checkedAt) === localDayKey(now)
  ) return saved;

  const next: AtlasFlowCheck = {
    checkedAt: now,
    nextCheckAt: nextLocalDay(now),
    fingerprint: manifest.fingerprint,
    ok: manifest.issues.length === 0,
    issues: manifest.issues,
    factCount: AGENT_FLOW_REQUIRED_KEYS.length,
    packagePortCount: AGENT_FLOW_PACKAGE_PORTS.length,
  };
  try {
    const body = JSON.stringify(next);
    localStorage.setItem(AGENT_FLOW_CHECK_KEY, body);
    mirrorSet(AGENT_FLOW_CHECK_KEY, body);
  } catch {
    /* The visible stamp remains valid for this render even without persistence. */
  }
  return next;
}

export function formatAtlasCheckTime(at: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(at)).toUpperCase();
}
