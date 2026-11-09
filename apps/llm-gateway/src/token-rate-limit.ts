import { createHash } from 'node:crypto';
import { gatewayErrorResponse } from '@kortix/llm-gateway';
import { TokenBucketRateLimiter } from '@kortix/shared/rate-limit';

/**
 * The limit the gateway applies on every route whose handler can reach the API
 * with a caller-supplied credential (model routes, and the `/health` probe
 * that forwards a caller bearer to `authenticate`). `source` is the caller's
 * address as the trusted hop reported it (`clientIp` in the Hono env, set from
 * the socket peer in `main.ts`) — null when there is none.
 */
export type TokenRateLimit = {
  (request: Request, headers?: Headers, source?: string | null): Response | null;
  /** The API answered this credential with a principal; it keeps its own bucket from now on. */
  validated: (credential: string) => void;
  /** The live bucket keys; KRTX-4528 proves a flood of fakes leaves only the shared one. */
  buckets: () => string[];
  /** The credentials waiting for a shared-slot refund; KRTX-4528 proves a flood cannot grow it without bound. */
  chargedCount: () => number;
};

/**
 * The per-credential request limit on every model route of this service. It
 * runs before the body is read and before the admit call to the API.
 *
 * Sandboxes can call this service directly (`LLM_GATEWAY_BASE_URL` on the
 * API). Their requests then skip the API's `/v1/llm` limit. This applies the
 * same limit under the same setting, `KORTIX_LLM_GATEWAY_REQS_PER_MIN`
 * (default 600 per minute per credential).
 *
 * The limit runs before `authenticate()`, so it cannot tell a real credential
 * from a fabricated one. A credential the API has answered with a principal is
 * real and keeps its own bucket, keyed on the credential's SHA-256 so no raw
 * secret stays in memory. Every other credential is charged to ONE shared
 * bucket, given by `unvalidatedPerMinute` (order of magnitude above one
 * credential's own budget), whatever its value: a caller that sends a fresh
 * made-up bearer per request cannot buy a private bucket each time, so the
 * shared allowance bounds how many requests reach the API unverified (CWE-770)
 * and the bucket map cannot grow one entry per request. One source can spend
 * only a small fraction of that allowance (its own bucket, keyed on the
 * address the Cloudflare edge overwrites), so a single caller cannot pin the
 * shared bucket and deny every not-yet-validated credential its first
 * admission. `validated(credential)` moves a real credential onto its own
 * budget and gives back the shared slot it took, once, so real traffic does
 * not drain the allowance every new credential shares; the set of charged
 * credentials that makes the refund one-time is capped, so neither it nor the
 * bucket map grows with the flood. A request without a credential is not
 * counted: the pipeline refuses it with 401 before it calls the API. The cost
 * this accepts: a credential's first request spends a shared slot, refunded
 * when the API validates it, so a flood large enough to spend the whole shared
 * allowance can refuse a real credential still waiting on that first
 * validation until the window refills. That is the trade for a bounded,
 * unauthenticated allowance.
 *
 * Each gateway task counts alone, so the fleet allows limit × tasks. This
 * stops a runaway loop or a flood on one credential. It is not a quota.
 *
 * Returns the 429 response, or null when the request may continue.
 */
export function createTokenRateLimit(
  limitPerMinute: number,
  unvalidatedPerMinute = limitPerMinute,
  options: { trustEdgeClientIp?: boolean } = {},
): TokenRateLimit {
  const limiter = new TokenBucketRateLimiter('gateway_token');
  // Per-source buckets live in their OWN limiter: source keys are caller-shaped
  // (one address per caller), so a flood of them in a shared map would evict
  // the shared bucket and every validated credential's bucket out from under
  // them — resetting the very allowances this limit promises (KRTX-4528).
  const sourceLimiter = new TokenBucketRateLimiter('gateway_source');
  // The credentials the API has answered with a principal. Only a real
  // credential gets in, so the set is bounded by the credential store, never by
  // what a caller sends.
  const validatedKeys = new Set<string>();
  // Credentials charged to the shared bucket while unvalidated; their slot is
  // refunded once, when the API validates them. The shared allowance bounds
  // how fast keys arrive, not how many accumulate — entries leave only through
  // `validated()`, which needs the API to answer a principal — so the oldest
  // key is dropped at the cap, as the bucket map drops its own oldest
  // (MAX_BUCKETS in packages/shared/src/rate-limit.ts). A credential whose
  // entry was evicted forfeits only its one-slot refund.
  const chargedShared = new Set<string>();
  const policy = { limit: limitPerMinute, windowMs: 60_000 };
  const sharedPolicy = { limit: Math.max(1, unvalidatedPerMinute), windowMs: 60_000 };
  // One source may spend only a small fraction of the shared allowance: a
  // request refused here never reaches the API, so a credential it refuses can
  // never validate and stays refused while a flood runs — one shared bucket
  // with no per-source bound is pinnable by a single caller. Per-source keys
  // live in their own limiter, whose bucket count is capped; the source is
  // charged only when the operator's edge vouches for it (`trustEdgeClientIp`,
  // default on: the shipped Kortix edge is a Cloudflare-locked ALB — see
  // server.ts — where the address is edge-set). A deployment without such an
  // edge sets it off: an untrusted header would let one caller rotate
  // addresses and buy a fresh source allowance each time.
  const sourcePolicy = {
    limit: Math.max(1, Math.floor(unvalidatedPerMinute / 100)),
    windowMs: 60_000,
  };
  const limit = (
    request: Request,
    headers = new Headers(),
    source?: string | null,
  ): Response | null => {
    const credential = credentialOf(request);
    if (!credential) return null;
    const key = hashOf(credential);
    const validated = validatedKeys.has(key);
    // A validated credential keeps its own budget; anything else shares one
    // bucket, so a rotating fake bearer spends the shared allowance, never its
    // own private one — after its source has spent its own small share.
    const fromSource =
      !validated && source && (options.trustEdgeClientIp ?? true)
        ? sourceLimiter.check(source, sourcePolicy)
        : null;
    const result =
      fromSource && !fromSource.allowed
        ? fromSource
        : limiter.check(validated ? key : UNVALIDATED, validated ? policy : sharedPolicy);
    if (!validated && result.allowed) {
      if (chargedShared.size >= MAX_CHARGED_SHARED) {
        const oldest = chargedShared.values().next().value;
        if (oldest !== undefined) chargedShared.delete(oldest);
      }
      chargedShared.add(key);
    }
    headers.set('RateLimit-Limit', String(result.limit));
    headers.set('RateLimit-Remaining', String(result.remaining));
    headers.set('RateLimit-Reset', String(Math.ceil(result.resetMs / 1000)));
    if (result.allowed) return null;
    // A refusal must also stop the upload: an unread body is still buffered.
    request.body?.cancel().catch(() => {});
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((result.retryAfterMs ?? result.resetMs) / 1000),
    );
    const response = rateLimitedResponse(new URL(request.url).pathname, retryAfterSeconds);
    headers.forEach((value, name) => response.headers.set(name, value));
    return response;
  };
  limit.validated = (credential: string) => {
    const key = hashOf(credential);
    validatedKeys.add(key);
    // Give back the shared slot this credential's pre-validation request took,
    // once: it now has its own budget to be counted against.
    if (chargedShared.delete(key)) limiter.refund(UNVALIDATED, sharedPolicy);
  };
  limit.buckets = () => limiter.keys();
  limit.chargedCount = () => chargedShared.size;
  return limit;
}

/** The bucket every credential this task has not validated shares. */
const UNVALIDATED = 'distinct_credentials';

/** The cap on the charged-shared set, as MAX_BUCKETS caps the bucket map. */
const MAX_CHARGED_SHARED = 50_000;

/**
 * The credential the pipeline will extract — the same grammar as `bearer()` in
 * `create-gateway.ts` (`/^Bearer\s+(\S.*)$/i`, trimmed) — or the `x-api-key`
 * that Anthropic SDKs send instead. Counting exactly the headers the pipeline
 * acts on leaves no header that reaches the API uncounted: a whitespace-bearing
 * bearer used to fall through here and flood the API under the limiter's feet.
 */
function credentialOf(request: Request): string | null {
  const bearer = /^Bearer\s+(\S.*)$/i.exec(request.headers.get('authorization') ?? '')?.[1];
  return bearer?.trim() || request.headers.get('x-api-key')?.trim() || null;
}

function hashOf(credential: string): string {
  return createHash('sha256').update(credential).digest('hex');
}

const MESSAGE = 'Too many requests for this credential. Retry shortly.';

/** A 429 in the envelope of the route's protocol: Anthropic for Messages and Claude Code, OpenAI otherwise. */
function rateLimitedResponse(path: string, retryAfterSeconds: number): Response {
  if (path.endsWith('/messages') || path.includes('/claude-code/')) {
    return new Response(
      JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: MESSAGE } }),
      {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': String(retryAfterSeconds) },
      },
    );
  }
  return gatewayErrorResponse(429, {
    message: MESSAGE,
    code: 'rate_limited',
    provider: '',
    requestedModel: '',
    resolvedModel: '',
    requestId: '',
    suggestion: 'Slow down. The limit is per credential per minute.',
    retryAfterSeconds,
  });
}
