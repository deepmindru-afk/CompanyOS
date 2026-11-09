import { beforeEach, describe, expect, mock, test } from 'bun:test';

// Same harness as `./use-admin-activity-analytics.test.ts`: react-query is
// mocked so the hook can be exercised as a plain function — no React render
// tree — while still asserting the exact `queryKey`, the `enabled` guard, the
// freshness contract, and the fail-closed read.

// The fields the hooks' useQuery config carries that these pins read, kept as
// a test-local type so the mock stays type-checked.
interface CapturedQueryConfig {
  queryKey: unknown;
  enabled?: boolean;
  refetchOnWindowFocus?: boolean;
  queryFn: () => Promise<unknown>;
}

let lastConfig: CapturedQueryConfig | null = null;
let configs: CapturedQueryConfig[] = [];
let nextResult: Record<string, unknown> = { data: undefined, isLoading: false };

mock.module('@tanstack/react-query', () => ({
  useQuery: (config: CapturedQueryConfig) => {
    configs.push(config);
    lastConfig = config;
    return nextResult;
  },
}));

let rowCalls: string[] = [];
let detailCalls: string[] = [];
// The real barrel underneath: `FEATURE_FLAG_KEYS` is a VALUE import from the
// same barrel now, and `export *` hides the mock's missing names otherwise.
import * as projectsClient from '../core/rest/projects-client';
mock.module('../core/rest/projects-client', () => ({
  ...projectsClient,
  getProject: async (projectId: string) => {
    rowCalls.push(projectId);
    return { project_id: projectId };
  },
  getWorkspaceDetail: async (projectId: string) => {
    detailCalls.push(projectId);
    return { project: { project_id: projectId } };
  },
}));

const { useFeatureFlag, resolveFeatureFlag, useFeatureFlags } = await import('./use-feature-flag');
const { qk } = await import('./query-keys');

beforeEach(() => {
  lastConfig = null;
  configs = [];
  rowCalls = [];
  detailCalls = [];
  nextResult = { data: undefined, isLoading: false };
});

function withDetail(experimental: Record<string, unknown> | undefined) {
  nextResult = { data: { experimental }, isLoading: false };
}

describe('useFeatureFlag', () => {
  test('reads the shared bare project row (qk.project.summary), not the git-backed detail', () => {
    useFeatureFlag('proj-1', 'reminders');

    // Built through the factory on purpose: the guard in
    // `query-key-literals.test.ts` forbids hand-typed key literals here, and
    // the point of the assertion is that the hook shares the SAME cache entry
    // every other project-row reader uses. The detail reads git and can take
    // seconds; a flag gate on it held the project page blank (2026-11-03).
    expect(lastConfig?.queryKey).toEqual(qk.project.summary('proj-1'));
    expect(lastConfig?.enabled).toBe(true);
  });

  test('is disabled and fail-closed with no project id', () => {
    const flag = useFeatureFlag(null, 'reminders');

    expect(lastConfig?.enabled).toBe(false);
    expect(flag.enabled).toBe(false);
  });

  test('queryFn fetches the bare project row for the given id, never the detail', async () => {
    useFeatureFlag('proj-9', 'reminders');
    await lastConfig?.queryFn();

    expect(rowCalls).toEqual(['proj-9']);
    expect(detailCalls).toEqual([]);
  });

  test('enabled only when the server says exactly true', () => {
    withDetail({ reminders: true });
    expect(useFeatureFlag('p', 'reminders').enabled).toBe(true);

    withDetail({ reminders: false });
    expect(useFeatureFlag('p', 'reminders').enabled).toBe(false);

    // Fail-closed on every non-`true` shape the wire could produce.
    withDetail({ reminders: 'true' as unknown as boolean });
    expect(useFeatureFlag('p', 'reminders').enabled).toBe(false);

    withDetail({});
    expect(useFeatureFlag('p', 'reminders').enabled).toBe(false);

    withDetail(undefined);
    expect(useFeatureFlag('p', 'reminders').enabled).toBe(false);
  });

  test('reports the loading state so callers can gate on it', () => {
    nextResult = { data: undefined, isLoading: true };
    const flag = useFeatureFlag('p', 'reminders');

    expect(flag.isLoading).toBe(true);
    // Loading is NOT enabled — the surface stays dark until the server answers.
    expect(flag.enabled).toBe(false);
  });

  test('one flag never reads another flag`s slot', () => {
    withDetail({ marketplace: true, reminders: false });

    expect(useFeatureFlag('p', 'marketplace').enabled).toBe(true);
    expect(useFeatureFlag('p', 'reminders').enabled).toBe(false);
  });

  test('a graduated flag is enabled for every project, whatever the map says', () => {
    // `review_center` graduated: Review Center is on for every project and the
    // API no longer serves the key. A host still gating on it must see the
    // surface, not lose it to the fail-closed `=== true` read.
    withDetail({ review_center: false });
    expect(useFeatureFlag('p', 'review_center').enabled).toBe(true);

    withDetail({});
    expect(useFeatureFlag('p', 'review_center').enabled).toBe(true);

    withDetail(undefined);
    expect(useFeatureFlag('p', 'review_center').enabled).toBe(true);

    nextResult = { data: undefined, isLoading: true };
    expect(useFeatureFlag('p', 'review_center').enabled).toBe(true);

    expect(useFeatureFlag(null, 'review_center').enabled).toBe(true);
  });

  test('agent_tunnel graduated: computers are on for every project', () => {
    withDetail({ agent_tunnel: false });
    expect(useFeatureFlag('p', 'agent_tunnel').enabled).toBe(true);

    withDetail(undefined);
    expect(useFeatureFlag('p', 'agent_tunnel').enabled).toBe(true);

    expect(useFeatureFlag(null, 'agent_tunnel').enabled).toBe(true);
  });

  test('session_transcript_history graduated: saved history is on for every project', () => {
    withDetail({ session_transcript_history: false });
    expect(useFeatureFlag('p', 'session_transcript_history').enabled).toBe(true);

    withDetail(undefined);
    expect(useFeatureFlag('p', 'session_transcript_history').enabled).toBe(true);

    expect(useFeatureFlag(null, 'session_transcript_history').enabled).toBe(true);
  });

  test('teams graduated: Microsoft Teams is on for every project', () => {
    // A `false` a project stored while Teams was a flag is inert.
    withDetail({ teams: false });
    expect(useFeatureFlag('p', 'teams').enabled).toBe(true);

    withDetail(undefined);
    expect(useFeatureFlag('p', 'teams').enabled).toBe(true);

    expect(useFeatureFlag(null, 'teams').enabled).toBe(true);
  });

  test('apps graduated: Apps is on for every project', () => {
    // Apps went generally available (2026-10-14): every project can create and
    // deploy Apps and the API no longer serves the key. A host still gating on
    // it — or a project whose stored `apps: false` predates the graduation —
    // must see the surface, not lose it to the fail-closed `=== true` read.
    withDetail({ apps: false });
    expect(useFeatureFlag('p', 'apps').enabled).toBe(true);

    withDetail(undefined);
    expect(useFeatureFlag('p', 'apps').enabled).toBe(true);

    expect(useFeatureFlag(null, 'apps').enabled).toBe(true);
  });

  test('llm_gateway graduated: the gateway is on for every project', () => {
    // The gateway is the only model path (2026-10-20). A stored
    // `llm_gateway: false` from the native-mode era is inert.
    withDetail({ llm_gateway: false });
    expect(useFeatureFlag('p', 'llm_gateway').enabled).toBe(true);

    withDetail(undefined);
    expect(useFeatureFlag('p', 'llm_gateway').enabled).toBe(true);

    expect(useFeatureFlag(null, 'llm_gateway').enabled).toBe(true);
  });

  test('pi_harness graduated: every new session runs pi', () => {
    // pi is the only harness for new sessions (2026-10-23). A stored
    // `pi_harness: false` from the flag era is inert.
    withDetail({ pi_harness: false });
    expect(useFeatureFlag('p', 'pi_harness').enabled).toBe(true);

    withDetail(undefined);
    expect(useFeatureFlag('p', 'pi_harness').enabled).toBe(true);

    expect(useFeatureFlag(null, 'pi_harness').enabled).toBe(true);
  });

  test('genui graduated: generative UI is on for every project', () => {
    // No flag since 2026-10-24. A stored `genui: false` from the flag era is inert.
    withDetail({ genui: false });
    expect(useFeatureFlag('p', 'genui').enabled).toBe(true);

    withDetail(undefined);
    expect(useFeatureFlag('p', 'genui').enabled).toBe(true);

    expect(useFeatureFlag(null, 'genui').enabled).toBe(true);
  });

  test('connectors_v2 and connectors_api_discover graduated: one catalog for every project', () => {
    // 2026-10-24. A stored `false` from the flag era is inert.
    withDetail({ connectors_v2: false, connectors_api_discover: false });
    expect(useFeatureFlag('p', 'connectors_v2').enabled).toBe(true);
    expect(useFeatureFlag('p', 'connectors_api_discover').enabled).toBe(true);

    withDetail(undefined);
    expect(useFeatureFlag('p', 'connectors_v2').enabled).toBe(true);
  });

  test('agentmail_email graduated: every project can connect an email inbox', () => {
    // 2026-10-24. A stored `agentmail_email: false` from the flag era is inert.
    withDetail({ agentmail_email: false });
    expect(useFeatureFlag('p', 'agentmail_email').enabled).toBe(true);

    withDetail(undefined);
    expect(useFeatureFlag('p', 'agentmail_email').enabled).toBe(true);
  });

  test('notification_center graduated: notifications are on for every project', () => {
    // 2026-11-06. A stored `notification_center: false` from the flag era is inert.
    withDetail({ notification_center: false });
    expect(useFeatureFlag('p', 'notification_center').enabled).toBe(true);

    withDetail(undefined);
    expect(useFeatureFlag('p', 'notification_center').enabled).toBe(true);

    expect(useFeatureFlag(null, 'notification_center').enabled).toBe(true);
  });

  test('config_releases graduated: every session runs the base branch config release', () => {
    // A `false` a project stored while config releases were a flag is inert.
    withDetail({ config_releases: false });
    expect(useFeatureFlag('p', 'config_releases').enabled).toBe(true);

    withDetail(undefined);
    expect(useFeatureFlag('p', 'config_releases').enabled).toBe(true);

    expect(useFeatureFlag(null, 'config_releases').enabled).toBe(true);
  });
});

/**
 * The pure half of the same gate: the row-holding caller (the `@kortix/ui`
 * project flag map reads the cache entry itself, one hook call for all serving
 * keys) resolves one flag from the row it already has, with the exact
 * `useFeatureFlag` semantics.
 */
describe('resolveFeatureFlag', () => {
  test('matches useFeatureFlag on served keys: only exactly true', () => {
    expect(resolveFeatureFlag({ reminders: true }, 'reminders')).toBe(true);
    expect(resolveFeatureFlag({ reminders: 'true' as unknown }, 'reminders')).toBe(false);
    expect(resolveFeatureFlag({ reminders: false }, 'reminders')).toBe(false);
    expect(resolveFeatureFlag({}, 'reminders')).toBe(false);
    expect(resolveFeatureFlag(undefined, 'reminders')).toBe(false);
  });

  test('graduated keys are on for every project, even against a contrary row', () => {
    expect(resolveFeatureFlag({ review_center: false }, 'review_center')).toBe(true);
    expect(resolveFeatureFlag({ agent_tunnel: false }, 'agent_tunnel')).toBe(true);
    expect(resolveFeatureFlag(undefined, 'review_center')).toBe(true);
  });
});

/**
 * The multi-flag read for the surfaces that cannot name a flag at author time
 * (the command palette resolves the menu registry's `requiresFlag` against it):
 * EVERY served flag of one project, out of the ONE row, resolved through the
 * same fail-closed resolver as `useFeatureFlag`.
 */
describe('useFeatureFlags', () => {
  /** The keys the map carries: FEATURE_FLAG_KEYS plus the graduated keys the API still resolves per project. */
  const SERVED_MAP_KEYS = [
    'marketplace',
    'reminders',
    'secrets_egress',
    'pooled_provider_secrets',
    'us_region',
    'event_triggers',
    'chat',
    'shared_drives',
    'goals',
    'workspace_volume',
    'email_channel',
    'session_groups',
    'chrome',
    'agent_teams',
    'voice_call',
    'chat_input',
    'chat_front',
    'spaces_proactive',
    'volumes',
    'drives',
    'artifacts',
    'session_log',
  ] as const;

  test('reads the ONE bare project row, never the detail', () => {
    useFeatureFlags('proj-1');

    expect(configs.length).toBe(1);
    expect(lastConfig?.queryKey).toEqual(qk.project.summary('proj-1'));
    expect(lastConfig?.enabled).toBe(true);
    expect(lastConfig?.refetchOnWindowFocus).toBe(false);
  });

  test('reads a disabled row with no project id', () => {
    useFeatureFlags(null);

    expect(configs.length).toBe(1);
    expect(lastConfig?.queryKey).toEqual(qk.project.summary(''));
    expect(lastConfig?.enabled).toBe(false);
  });

  test('serves exactly the served keys — a new flag cannot be silently un-gated', () => {
    withDetail({});
    const { flags } = useFeatureFlags('p');

    expect(Object.keys(flags).sort()).toEqual([...SERVED_MAP_KEYS].sort());
  });

  test('resolves each served key fail-closed from the row', () => {
    // Only `=== true` may resolve, identical to `useFeatureFlag`.
    withDetail({
      marketplace: true,
      event_triggers: 'true' as unknown as boolean,
      artifacts: true,
      session_log: true,
      volumes: false,
    });
    const { flags } = useFeatureFlags('p');

    expect(flags.marketplace).toBe(true);
    expect(flags.event_triggers).toBe(false);
    expect(flags.artifacts).toBe(true);
    expect(flags.session_log).toBe(true);
    expect(flags.volumes).toBe(false);
    for (const key of SERVED_MAP_KEYS) {
      if (['marketplace', 'event_triggers', 'artifacts', 'session_log', 'volumes'].includes(key)) continue;
      expect(flags[key]).toBe(false);
    }
  });

  test('every member is false until the row answers', () => {
    withDetail(undefined);
    const { flags } = useFeatureFlags('p');

    for (const key of SERVED_MAP_KEYS) {
      expect(flags[key]).toBe(false);
    }
  });

  test('passes the loading state through so callers can gate on it', () => {
    nextResult = { data: undefined, isLoading: true };
    const loading = useFeatureFlags('p');
    expect(loading.isLoading).toBe(true);
    expect(loading.flags.marketplace).toBe(false);

    nextResult = { data: { experimental: { marketplace: true } }, isLoading: false };
    const ready = useFeatureFlags('p');
    expect(ready.isLoading).toBe(false);
    expect(ready.flags.marketplace).toBe(true);
  });
});
