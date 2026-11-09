import { z } from '@hono/zod-openapi';

// Opaque service/Stripe payloads — permissive on purpose.
export const OpaqueSchema = z.record(z.string(), z.any());

// Opaque request bodies: see routes/subscriptions.ts for why they are parsed manually.
export const OpaqueBody = OpaqueSchema;
