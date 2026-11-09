import { getYearlyAccountsDueForRotation, updateCreditAccount } from '../repositories/credit-accounts';
import { canonicalTier, getTier, planMonthlyUsd } from './tiers';
import { rotateDueAccounts } from './rotation-batch';
import { wallet } from '../wallet';
import { calculateNextCreditGrant } from './credit-grant-schedule';

// STORED TIER ON PURPOSE — do not route this file through the effective-plan
// resolver (billing/services/resolve-billing.ts).
//
// This is a GRANT path: it mints the credits a customer PAID for. The stored
// `credit_accounts.tier` is Stripe's, written by the subscription webhook
// reconciliation, and it is the only column that says what was actually
// charged. The resolver's overlays are entitlement overlays: an admin-issued
// trial lifts what an account may DO for a window without any money changing
// hands. Granting against it would hand out credits nobody paid for, every
// rotation, forever.

export async function processYearlyCreditRotation(): Promise<{
  processed: number;
  skipped: number;
  errors: string[];
}> {
  return rotateDueAccounts({
    select: getYearlyAccountsDueForRotation,
    keyPrefix: 'yearly_rotation',
    logPrefix: 'YearlyRotation',
    errorLabel: 'yearly',
    grant: async (account, now, key) => {
      // A paid plan carries its monthly amount on the row; anything else
      // grants its fixed allowance.
      const plan = canonicalTier(account.tier);
      const credits = plan === 'credits' ? planMonthlyUsd(account) : getTier(account.tier ?? 'free').monthlyCredits;

      if (credits > 0) {
        await wallet.reset({
          accountId: account.accountId,
          amount: credits,
          description: `Yearly plan monthly credits: ${Math.round(credits * 100)} credits`,
          key: { event: key },
        });
      }

      const nextGrant = calculateNextCreditGrant(now);
      await updateCreditAccount(account.accountId, {
        nextCreditGrant: nextGrant.toISOString(),
        lastGrantDate: now.toISOString(),
      });
    },
  });
}
