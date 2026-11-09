'use client';

import type { FeatureFlagKey } from '../core/rest/projects-client';
import { FEATURE_FLAG_KEYS } from '../core/rest/projects-client';
import { useProjectRow } from './use-project-row';

/**
 * Keys that graduated out of the flag system. Their features are on for every
 * project and the API no longer serves them, so the fail-closed read below
 * would hide a surface that is meant to be visible. Deprecated members of
 * `FeatureFlagKey`; removed with them in the next major.
 */
const GRADUATED_FEATURE_FLAG_KEYS: ReadonlySet<FeatureFlagKey> = new Set([
  'review_center',
  'agent_tunnel',
  'session_transcript_history',
  'teams',
  'config_releases',
  'apps',
  'llm_gateway',
  'pi_harness',
  'genui',
  'agentmail_email',
  'connectors_v2',
  'connectors_api_discover',
  'notification_center',
]);

/** What {@link useFeatureFlag} tells a caller about one flag. */
export interface FeatureFlagState {
  /** The server said EXACTLY `true` for this project. Never optimistic. */
  enabled: boolean;
  /** The project row has not answered yet. Treat as "not enabled". */
  isLoading: boolean;
}

/**
 * The pure half of the {@link useFeatureFlag} gate: one flag's state resolved
 * from the bare project row a caller already holds, without a hook.
 */
export function resolveFeatureFlag(
  experimental: Readonly<Record<string, unknown>> | undefined,
  key: FeatureFlagKey,
): boolean {
  return GRADUATED_FEATURE_FLAG_KEYS.has(key) || experimental?.[key] === true;
}

/**
 * The keys {@link useFeatureFlags} carries. `FEATURE_FLAG_KEYS` — every flag a
 * surface can gate on — plus the graduated keys the API still resolves per
 * project: `volumes`, `drives` and `artifacts` each read whether the platform
 * stores Files (Platinum), and `session_log` the API sends `true`.
 */
const SERVED_FLAG_MAP_KEYS: readonly FeatureFlagKey[] = [
  ...FEATURE_FLAG_KEYS,
  'volumes',
  'drives',
  'artifacts',
  'session_log',
];

/**
 * Every feature flag for one project, in one object, out of the ONE row read.
 * This is the CALL SITE surface for the ones that must decide about an
 * ARBITRARY flag chosen at runtime (the command palette resolves the menu
 * registry's `requiresFlag` against this map) — and for every surface that
 * reads several flags of one project in one lockstep state, so they light up
 * and go dark together.
 *
 * One cache entry for every key: `qk.project.summary(projectId)`, the bare
 * row, never the git-backed detail that can take seconds (a flag gate on it
 * held the project page blank, 2026-11-03). The map is `Partial` because
 * `FeatureFlagKey` still carries deprecated non-served keys.
 *
 * Fail-closed: every member is `false` until the row answers.
 */
export function useFeatureFlags(projectId: string | null | undefined): {
  flags: Partial<Record<FeatureFlagKey, boolean>>;
  isLoading: boolean;
} {
  const row = useProjectRow(projectId, { refetchOnWindowFocus: false });
  const flags: Partial<Record<FeatureFlagKey, boolean>> = {};
  for (const key of SERVED_FLAG_MAP_KEYS) {
    flags[key] = resolveFeatureFlag(row.data?.experimental, key);
  }
  return { flags, isLoading: row.isLoading };
}

/**
 * The ONE client-side gate for a per-project feature flag.
 *
 * Every flag-gated surface — a nav entry, a command-palette action, a page,
 * a Customize section — reads this hook, so they light up and go dark
 * together. Reads the shared bare project row (`qk.project.summary(id)`,
 * `GET /projects/:id`, one database read), never the git-backed detail, so a
 * flag-gated page renders without waiting on the repository.
 *
 * **Fail-closed by construction.** `enabled` is `=== true`, so a missing
 * project id, an in-flight query, an error, an older server that does not
 * serve the flag map, and a non-boolean wire value all resolve to `false`.
 * A disabled feature's surface must be invisible, not merely inert.
 *
 * The one exception is a graduated key (`review_center`, `agent_tunnel`,
 * `session_transcript_history`, `teams`, `config_releases`, `apps`,
 * `llm_gateway`, `pi_harness`, `genui`, `agentmail_email`, `connectors_v2`, `connectors_api_discover`,
 * `notification_center`): it reports `enabled: true` for every project, because the
 * feature no longer has an off state.
 */
export function useFeatureFlag(
  projectId: string | null | undefined,
  key: FeatureFlagKey,
): FeatureFlagState {
  const query = useProjectRow(projectId, { refetchOnWindowFocus: false });

  return {
    enabled: resolveFeatureFlag(query.data?.experimental, key),
    isLoading: query.isLoading,
  };
}
