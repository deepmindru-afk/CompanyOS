import { type InflightBudget, upstreamBreakers } from '@kortix/llm-gateway';
import type { createApiClient } from './clients/api-client';
import type { TraceSink } from './observability/langfuse';
import type { GatewayApp } from './server';
import type { TokenRateLimit } from './token-rate-limit';
const STARTED_AT = Date.now();
const SERVICE_VERSION = process.env.KORTIX_VERSION ?? 'dev';
const SERVICE_COMMIT = process.env.KORTIX_COMMIT ?? 'unknown';
// Below this volume in the window, a high error rate is statistical noise.
const ERROR_RATE_MIN_VOLUME = 20;
const ERROR_RATE_ALERT = 0.5;
export function registerHealth(
  app: GatewayApp,
  api: ReturnType<typeof createApiClient>,
  inflight: InflightBudget,
  traces: TraceSink | null,
  trafficSnapshot: () => { window_s: number; requests: number; errors: number; error_rate: number },
  upstreamSignals: () => { incidents: string[]; warnings: string[] },
  rateLimit: TokenRateLimit,
) {
  // Shallow liveness: the process is up. The k8s livenessProbe should point here
  // so a dependency outage (which a restart can't fix) doesn't crash-loop the pod.
  // Includes version/commit so a rollout can be confirmed with one cheap probe
  // (no deep dependency checks) — `curl /health/live` shows which build is live.
  app.get('/health/live', (c) =>
    c.json({ ok: true, version: SERVICE_VERSION, commit: SERVICE_COMMIT }),
  );

  // Public readiness keeps its HTTP status. Operational details require a
  // gateway principal; never cache a credential-dependent health response.
  app.get('/health', async (c) => {
    c.header('Cache-Control', 'no-store');
    const apiCheck = await api.ping();
    const traffic = trafficSnapshot();
    const admission = {
      used_bytes: inflight.inflightBytes,
      capacity_bytes: inflight.capacityBytes,
      utilization: Number(inflight.utilisation.toFixed(4)),
    };
    const errorSpike =
      traffic.requests >= ERROR_RATE_MIN_VOLUME && traffic.error_rate >= ERROR_RATE_ALERT;

    // A sustained streak, not one blip: a single dropped POST during a
    // Langfuse hiccup is not an incident, and this must never page on it.
    const TRACE_FAILURE_STREAK_ALERT = 5;
    const tracesStatus = traces?.status() ?? null;
    const traceStreakAlert =
      tracesStatus !== null && tracesStatus.consecutiveFailures >= TRACE_FAILURE_STREAK_ALERT;

    // `incidents` are customer-facing failures and set `degraded`, which the
    // Better Stack monitor on the public body alerts on. `warnings` are
    // failures the gateway absorbs: they stay in the authenticated body only.
    const upstream = upstreamSignals();
    const incidents: string[] = [...upstream.incidents];
    const warnings: string[] = [...upstream.warnings];
    if (!apiCheck.ok)
      incidents.push(`kortix api unreachable (${apiCheck.error ?? `http ${apiCheck.status}`})`);
    if (errorSpike)
      incidents.push(
        `error rate ${(traffic.error_rate * 100).toFixed(0)}% over ${traffic.window_s}s`,
      );
    // Kortix-billed upstreams this task is skipping (circuit open). A caller's
    // own-key circuits stay out of this public endpoint.
    const circuits = upstreamBreakers.snapshot(true);
    for (const circuit of circuits) {
      warnings.push(
        `upstream circuit ${circuit.state}: ${circuit.provider} ${circuit.model} (${circuit.lastReason ?? 'failures'})`,
      );
    }
    if (traceStreakAlert)
      warnings.push(
        `langfuse trace recording failed ${tracesStatus.consecutiveFailures}x in a row (${tracesStatus.lastError ?? 'unknown error'})`,
      );

    const status = !apiCheck.ok ? 'unhealthy' : incidents.length ? 'degraded' : 'healthy';

    // A caller bearer is forwarded to the API's authenticate below, so the
    // probe draws from the same allowance as the model routes (KRTX-4528):
    // without this, rotating made-up bearers get that work unbounded here.
    const headers = new Headers();
    const refused = rateLimit(c.req.raw, headers, c.env?.clientIp ?? null);
    if (refused) {
      headers.forEach((value, name) => refused.headers.set(name, value));
      return refused;
    }
    const token = c.req
      .header('authorization')
      ?.match(/^Bearer\s+(\S.*)$/i)?.[1]
      .trim();
    const principal = token ? await api.authenticate(token).catch(() => null) : null;
    // The probe spent shared allowance before the API vouched for this
    // credential; give that slot back now it is proven real, exactly as the
    // model routes do (KRTX-4528). Without this one real probe drains the
    // unvalidated allowance for every made-up bearer until the window resets.
    if (!principal) return c.json({ status }, status === 'unhealthy' ? 503 : 200);
    if (token) rateLimit.validated(token);

    return c.json(
      {
        status,
        service: 'kortix-llm-gateway',
        version: SERVICE_VERSION,
        commit: SERVICE_COMMIT,
        uptime_s: Math.floor((Date.now() - STARTED_AT) / 1000),
        timestamp: new Date().toISOString(),
        incidents,
        warnings,
        checks: {
          api: {
            status: apiCheck.ok ? 'up' : 'down',
            latency_ms: apiCheck.latencyMs,
            ...(apiCheck.status ? { http_status: apiCheck.status } : {}),
            ...(apiCheck.error ? { error: apiCheck.error } : {}),
          },
          traces: {
            langfuse: traces ? 'enabled' : 'disabled',
            ...(tracesStatus
              ? {
                  last_queued_at: tracesStatus.lastQueuedAt
                    ? new Date(tracesStatus.lastQueuedAt).toISOString()
                    : null,
                  last_failure_at: tracesStatus.lastFailureAt
                    ? new Date(tracesStatus.lastFailureAt).toISOString()
                    : null,
                  consecutive_failures: tracesStatus.consecutiveFailures,
                  ...(tracesStatus.lastError ? { last_error: tracesStatus.lastError } : {}),
                }
              : {}),
          },
          admission,
          upstream_circuits: circuits,
        },
        traffic,
      },
      status === 'unhealthy' ? 503 : 200,
    );
  });
}
