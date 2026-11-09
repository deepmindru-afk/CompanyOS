/** Accounts per rotation read. A loop walks the rest by `accountId`, so one read never holds every due row. */
export const ROTATION_BATCH_SIZE = 500;

/** The spec one credit rotation fills in; `rotateDueAccounts` owns everything else. */
export interface RotateDueAccountsSpec<T extends { accountId: string }> {
  /** One paging read: the due rows after `after`, at most ROTATION_BATCH_SIZE of them. */
  select: (after?: string) => Promise<T[]>;
  keyPrefix: string;
  logPrefix: string;
  errorLabel: string;
  /** Accounts the read may return that get no grant; counted as skipped. */
  due?: (account: T, now: Date) => boolean;
  /** Grant one account: its wallet reset and anchor update. Throws to count an error. */
  grant: (account: T, now: Date, key: string) => Promise<void>;
}

/**
 * The loop the free-tier and yearly credit rotations share: page `select` by
 * `accountId` (one read never holds every due row), grant each account under
 * its `keyPrefix_<accountId>_<UTC year-month>` idempotency key, and collect
 * errors instead of failing the pass.
 */
export async function rotateDueAccounts<T extends { accountId: string }>(
  spec: RotateDueAccountsSpec<T>,
  /** The fixed clock; without one, every account reads the clock at its own turn. */
  now?: Date,
): Promise<{ processed: number; skipped: number; errors: string[] }> {
  let processed = 0;
  let skipped = 0;
  const errors: string[] = [];

  let after: string | undefined;
  for (;;) {
    const accounts = await spec.select(after);
    for (const account of accounts) {
      const accountNow = now ?? new Date();
      if (spec.due && !spec.due(account, accountNow)) {
        skipped++;
        continue;
      }

      try {
        await spec.grant(account, accountNow, `${spec.keyPrefix}_${account.accountId}_${rotationMonth(accountNow)}`);
        processed++;
      } catch (err) {
        const msg = `Error processing ${spec.errorLabel} rotation for ${account.accountId}: ${(err as Error).message}`;
        console.error(`[${spec.logPrefix}] ${msg}`);
        errors.push(msg);
      }
    }
    if (accounts.length < ROTATION_BATCH_SIZE) break;
    after = accounts[accounts.length - 1]!.accountId;
  }

  console.log(`[${spec.logPrefix}] Processed: ${processed}, Skipped: ${skipped}, Errors: ${errors.length}`);
  return { processed, skipped, errors };
}

// UTC, like the free-tier key: a replica in another time zone must not mint a second key at a month edge.
function rotationMonth(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}
