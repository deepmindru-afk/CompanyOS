import type { CreditAccount } from '@kortix/db';
import { getFreeAccountsDueForRotation, updateCreditAccount } from '../repositories/credit-accounts';
import { calculateNextCreditGrant } from './credit-grant-schedule';
import { rotateDueAccounts } from './rotation-batch';
import { wallet } from '../wallet';
import { formatUsdAsCredits } from '@kortix/shared';
import { getTier } from './tiers';

const FREE_TIER_MONTHLY_CREDITS_USD = getTier('free').monthlyCredits;

export async function processFreeTierCreditRotation(now = new Date()): Promise<{
  processed: number;
  skipped: number;
  errors: string[];
}> {
  return rotateDueAccounts(
    {
      select: getFreeAccountsDueForRotation,
      keyPrefix: 'free_tier_rotation',
      logPrefix: 'FreeTierRotation',
      errorLabel: 'free-tier',
      due: isFreeTierAccountDueForRotation,
      grant: async (account, now, key) => {
        const expiresAt = calculateNextCreditGrant(now).toISOString();
        await wallet.reset({
          accountId: account.accountId,
          amount: FREE_TIER_MONTHLY_CREDITS_USD,
          expiresAt,
          description: `Free tier monthly credit reset: ${formatUsdAsCredits(FREE_TIER_MONTHLY_CREDITS_USD)} credits`,
          key: { event: key },
        });

        await updateCreditAccount(account.accountId, {
          nextCreditGrant: expiresAt,
          lastGrantDate: now.toISOString(),
        });
      },
    },
    now,
  );
}

/**
 * STORED TIER ON PURPOSE — not the effective plan.
 *
 * This is a GRANT path. It must select the same rows the SQL query selects
 * (`getFreeAccountsDueForRotation` filters `tier = 'free'` in the database),
 * and it must key on what Stripe says the account pays for. An account on an
 * active admin trial of a paid plan still has `tier = 'free'` and still gets
 * its free-tier reset — the trial lifts entitlements, it does not buy credits.
 * Resolving the effective plan here would silently stop rotating exactly those
 * accounts and diverge from the query that fetched them.
 */
function isFreeTierAccountDueForRotation(
  account: Pick<CreditAccount, 'tier' | 'nextCreditGrant'>,
  now = new Date(),
): boolean {
  if (account.tier !== 'free') return false;
  if (!account.nextCreditGrant) return true;

  const nextGrant = new Date(account.nextCreditGrant);
  return nextGrant <= now;
}
