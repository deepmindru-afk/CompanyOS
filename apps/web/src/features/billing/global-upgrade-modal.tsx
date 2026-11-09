'use client';

import { FreeGrantNotice } from '@/features/billing/free-grant-notice';
import { PlanChanger } from '@/features/billing/plan-card';
import { PricingPlanCard } from '@/features/billing/pricing-plan-card';
import type { PricingPlan } from '@/features/billing/pricing-plans';
import { TopupControls } from '@/features/billing/topup-controls';
import { useChangeCreditPlan } from '@/features/billing/use-change-credit-plan';
import { useTalkToSales } from '@/features/billing/use-enterprise-sales';
import { useUpgradePlans } from '@/features/billing/use-pricing-plans';
import { useUpgradeModalHost } from '@/features/billing/use-upgrade-modal-host';
import { MarketingButton } from '@/features/marketing/kit/marketing-button';
import { CreditLadder } from '@/features/marketing/pricing/credit-ladder';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import { type AccountState, type BillingState, canManageBilling, canOfferTopup } from '@kortix/sdk';
import { formatUsdAsCredits } from '@kortix/shared';
import { cn } from '@kortix/ui';
import { Button } from '@kortix/ui/button';
import Hint from '@kortix/ui/hint';
import { Copy } from '@kortix/ui/icons';
import { useAccountMembers } from '@kortix/ui/internal/account-hub/use-account-members';
import {
  DEFAULT_TIER_USD,
  formatWholeUsd,
  tierForMonthlyUsd,
} from '@kortix/ui/internal/billing/compute-pricing';
import {
  invalidateAccountState,
  useAccountState,
  useCreatePortalSession,
} from '@kortix/ui/internal/billing/index';
import {
  accountHasLiveSubscription,
  billingModalCopy,
  billingModalNeedsTopUp,
  resolveBillingState,
} from '@kortix/ui/internal/lib/billing/billing-gate-state';
import { accountPanelUrl, hubTarget } from '@kortix/ui/internal/stores/account-panel-store';
import {
  BillingAccountProvider,
  useBillingAccountId,
} from '@kortix/ui/internal/stores/billing-account-context';
import { useUpgradeDialogStore } from '@kortix/ui/internal/stores/upgrade-dialog-store';
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from '@kortix/ui/item';
import Loading from '@kortix/ui/loading';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalHeader,
  ModalTitle,
} from '@kortix/ui/modal';
import { AskOwnerForCreditsButton } from '@kortix/ui/session/models/ask-owner-for-credits-button';
import { Skeleton } from '@kortix/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@kortix/ui/tabs';
import { errorToast } from '@kortix/ui/toast';
import { UserAvatar } from '@kortix/ui/user-avatar';
import {
  ArrowRightIcon as ArrowRight,
  CheckIcon,
  UserPlusIcon as UserPlus,
} from '@phosphor-icons/react';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

export interface UpgradePlansModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountState?: AccountState;
  /** From the 402: distinguishes "wallet drained → top up" (credit view)
   *  from "no plan → pick a plan" (plans view). Fall back to accountState. */
  reason?: string;
  hasSubscription?: boolean;
  /** The resolved state from whichever surface opened the modal. Preferred over
   *  `reason` (the lossy 402 code) so the modal and the gate that opened it can
   *  never disagree about the same account. */
  billingState?: BillingState;
  balance?: number;
  /** True while account state is doing its first load — the credit view shows a
   *  balance skeleton instead of a misleading 0 until the real value lands. */
  accountLoading?: boolean;
}

/**
 * Which view the billing modal opens on:
 *
 * - `plans`: Free against Credits, for an account with no subscription. One-off
 *   top-ups are off below Enterprise (Marko, 2026-11-09), so a Free workspace
 *   that runs out is shown the subscription, not a top-up;
 * - `topup-first`: a subscriber (or an account granted top-ups) that is out of
 *   credits or whose payment failed. The fix leads;
 * - `plan-first`: a subscriber that is not blocked. The monthly plan leads.
 *
 * Inside the credit view, the One-time tab exists only when the account may
 * buy one-off credits (`canOfferTopup`); otherwise the monthly plan is the
 * whole view.
 */
export function billingModalLayout(opts: {
  needsTopUp: boolean;
  hasSubscription: boolean;
  canPurchaseCredits: boolean;
}): 'plans' | 'topup-first' | 'plan-first' {
  if (opts.hasSubscription) return opts.needsTopUp ? 'topup-first' : 'plan-first';
  return opts.canPurchaseCredits && opts.needsTopUp ? 'topup-first' : 'plans';
}

export function UpgradePlansModal({
  open,
  onOpenChange,
  accountState,
  reason,
  hasSubscription,
  billingState,
  balance,
  accountLoading,
}: UpgradePlansModalProps) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const t = useTranslations('billing.credits.modal');
  const plans = useUpgradePlans();
  const sales = useTalkToSales(useBillingAccountId());

  // Which view? Resolved from the ONE billing-state resolver. The caller's
  // `billingState` (from the 402 or the gate that opened this) wins because
  // accountState can still be loading; otherwise derive it from live state.
  const hasSub = hasSubscription ?? accountHasLiveSubscription(accountState);
  const canPurchaseCredits = accountState?.tier?.can_purchase_credits ?? hasSub;
  const resolvedState = billingState ?? resolveBillingState(accountState);
  const layout = billingModalLayout({
    needsTopUp:
      billingModalNeedsTopUp(accountState, resolvedState) || reason === 'insufficient_credits',
    hasSubscription: hasSub,
    canPurchaseCredits,
  });

  if (layout !== 'plans') {
    return (
      <CreditTopUpModal
        open={open}
        onOpenChange={onOpenChange}
        accountState={accountState}
        balance={balance}
        billingState={resolvedState}
        accountLoading={accountLoading}
        leadWithTopUp={layout === 'topup-first'}
      />
    );
  }

  // `false` until the account state loads (KRTX-1720): Subscribe stays
  // disabled for that window, and the "owner required" button and the "ask an
  // owner" note wait for the answer.
  const mayManageBilling = canManageBilling(accountState);
  const ownerRequired = !!accountState && !mayManageBilling;

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent variant="base" className="gap-0 space-y-0 p-0 lg:max-w-4xl">
        <ModalHeader className="space-y-2 px-6 pt-7 pb-6 md:px-8">
          <ModalTitle className="text-2xl font-medium tracking-tight text-balance">
            {t('title')}
          </ModalTitle>
          <ModalDescription className="max-w-xl text-sm text-pretty">
            {t('description')}
          </ModalDescription>
        </ModalHeader>

        {/* The /pricing plans band: hairlines top and bottom, one between the columns. */}
        <ModalBody className="p-0">
          <div className="divide-border grid grid-cols-1 divide-y border-y md:grid-cols-2 md:divide-x md:divide-y-0">
            {plans.map((plan) => (
              <UpgradePlanCard
                key={plan.id}
                plan={plan}
                onContinueFree={() => onOpenChange(false)}
                ownerRequired={ownerRequired}
                mayManageBilling={mayManageBilling}
              />
            ))}
          </div>
        </ModalBody>

        <div className="space-y-4 px-6 py-4 md:px-8">
          <p className="text-muted-foreground text-center text-xs">
            {tI18nHardcoded.raw('i18nComplete.textff2b8e88c520')}{' '}
            <button
              type="button"
              disabled={sales.isPending}
              onClick={sales.talk}
              className="text-foreground underline-offset-4 hover:underline"
            >
              {tI18nHardcoded.raw('i18nComplete.text604abea32b49')}
            </button>
          </p>

          {ownerRequired && (
            <Item variant="outline" size="sm" className="items-start bg-none">
              <Hint label={t('askOwnerHint')} side="top" className="max-w-xs text-xs">
                <ItemMedia variant="icon">
                  <UserPlus />
                </ItemMedia>
              </Hint>
              <ItemContent>
                <ItemTitle>{t('askOwnerTitle')}</ItemTitle>
                <ItemDescription className="text-xs leading-relaxed">
                  {t('askOwnerBody')}
                </ItemDescription>
              </ItemContent>
            </Item>
          )}
        </div>
      </ModalContent>
    </Modal>
  );
}

/**
 * One card of the plan view. Free closes the dialog. Credits carries the
 * credits ladder and starts the plan change; its own state, so the tier
 * survives re-renders of the modal.
 */
function UpgradePlanCard({
  plan,
  onContinueFree,
  ownerRequired,
  mayManageBilling,
}: {
  plan: PricingPlan;
  onContinueFree: () => void;
  ownerRequired: boolean;
  mayManageBilling: boolean;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const tAccess = useTranslations('billing.access');
  const tCard = useTranslations('billing.credits.planCard');
  const tPlan = useTranslations('billing.plan');
  const locale = useLocale();
  const [monthlyUsd, setMonthlyUsd] = useState<number>(DEFAULT_TIER_USD);
  const { change, isPending } = useChangeCreditPlan();

  if (plan.id !== 'credits') {
    return (
      <PricingPlanCard
        plan={plan}
        badgeOverride={tPlan('currentPlan')}
        action={
          <MarketingButton
            type="button"
            size="md"
            variant="secondary"
            className="hit-area-y-1 w-full"
            onClick={onContinueFree}
          >
            {tI18nHardcoded.raw('i18nComplete.text73a7da68c3bf')}
          </MarketingButton>
        }
      />
    );
  }

  const valid = !!tierForMonthlyUsd(monthlyUsd);
  return (
    <PricingPlanCard
      plan={plan}
      priceSlot={
        <CreditLadder
          value={monthlyUsd}
          onChange={setMonthlyUsd}
          disabled={isPending}
          stackBelowXl={false}
        />
      }
      action={
        ownerRequired ? (
          <MarketingButton
            type="button"
            size="md"
            variant="secondary"
            className="hit-area-y-1 w-full"
            disabled
          >
            {tAccess('managerRequired')}
          </MarketingButton>
        ) : (
          <MarketingButton
            type="button"
            size="md"
            variant="primary"
            className="group hit-area-y-1 w-full"
            disabled={isPending || !mayManageBilling || !valid}
            onClick={() => valid && change(monthlyUsd)}
          >
            {isPending ? (
              <>
                <Loading />
                {tI18nHardcoded.raw(
                  'autoFeaturesBillingTeamPlanCheckoutJsxTextStartingCheckout282edf7f',
                )}
              </>
            ) : (
              <>
                {valid
                  ? tCard('subscribeAction', { amount: formatWholeUsd(monthlyUsd, locale) })
                  : tCard('chooseAction')}
                <ArrowRight className="transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" />
              </>
            )}
          </MarketingButton>
        )
      }
    />
  );
}

interface CreditTopUpModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountState?: AccountState;
  balance?: number;
  billingState?: BillingState | null;
  accountLoading?: boolean;
  /** Out of credits or payment failed: the top-up leads, with the balance. */
  leadWithTopUp: boolean;
}

type CreditTab = 'one-time' | 'monthly';

/**
 * The plan and top-up view, for an account that can buy credits.
 *
 * One frame, three views, picked from who is looking and why:
 *
 * - a member, who may not change billing: who can fix it, and a link to send
 *   them. No purchase control renders for a member (KRTX-1720);
 * - payment failed: the card is the fix, so updating it leads, and a top-up is
 *   the other way out;
 * - otherwise: One-time | Monthly tabs. Only one primary action exists at a
 *   time. Out of credits opens on One-time, a voluntary visit on Monthly.
 */
function CreditTopUpModal({
  open,
  onOpenChange,
  accountState,
  balance,
  billingState,
  accountLoading,
  leadWithTopUp,
}: CreditTopUpModalProps) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const t = useTranslations('billing.credits.modal');
  const createPortal = useCreatePortalSession();
  const [tab, setTab] = useState<CreditTab>(leadWithTopUp ? 'one-time' : 'monthly');
  const [topUpInstead, setTopUpInstead] = useState(false);
  // Out-of-credits copy is DERIVED from the billing state, never written here:
  // a hardcoded "Out of credits" title once announced an emergency to every
  // account that opened this modal.
  // A Free workspace that leads with the top-up is out of credits, whatever
  // `no_subscription` says: it has a plan (Free), its wallet is empty.
  const copy = leadWithTopUp
    ? billingModalCopy(
        billingState === 'no_subscription' ? 'out_of_credits' : (billingState ?? null),
        tI18nComplete,
      )
    : { title: t('planTitle'), description: t('planDescription') };

  // A fresh open starts on the view its reason asks for. Reset during render,
  // not in an effect, so the first painted frame is already the right tab.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setTab(leadWithTopUp ? 'one-time' : 'monthly');
      setTopUpInstead(false);
    }
  }

  const isMember = !!accountState && !canManageBilling(accountState);
  // One-off top-ups exist only for Enterprise and accounts granted them. For
  // everyone else the monthly plan is the whole view: no tabs.
  const canTopUp = canOfferTopup(accountState);
  const paymentFailed = leadWithTopUp && billingState === 'payment_failed' && !topUpInstead;
  const openPortal = () => createPortal.mutate({ return_url: window.location.href });

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent className="gap-0 space-y-0 p-0 sm:max-w-md">
        <ModalHeader className="gap-1.5 px-6 pt-6 pb-5">
          <div className="flex items-baseline justify-between gap-3 pr-8">
            <ModalTitle className="text-lg font-medium tracking-tight">{copy.title}</ModalTitle>
            {leadWithTopUp ? (
              <WalletBalance
                accountState={accountState}
                balance={balance}
                accountLoading={accountLoading}
              />
            ) : null}
          </div>
          <ModalDescription className="text-sm text-pretty">
            {isMember ? t('memberBody') : copy.description}
          </ModalDescription>
        </ModalHeader>

        {!accountState && accountLoading ? (
          // Who is looking decides the view (member, payment failed, tabs).
          // Hold one neutral block until the account state says.
          <div className="px-6 pb-6">
            <Skeleton className="h-56 w-full rounded-md" />
          </div>
        ) : isMember ? (
          <MemberBlockedView />
        ) : paymentFailed ? (
          <PaymentFailedView
            portalPending={createPortal.isPending}
            onUpdateCard={openPortal}
            onTopUpInstead={
              canTopUp
                ? () => {
                    setTopUpInstead(true);
                    setTab('one-time');
                  }
                : undefined
            }
          />
        ) : !canTopUp ? (
          <div className="px-6 pb-6">
            {accountState ? (
              <PlanChanger state={accountState} className="bg-popover rounded-md border" />
            ) : (
              <Skeleton className="h-48 w-full rounded-md" />
            )}
          </div>
        ) : (
          <Tabs value={tab} onValueChange={(value) => setTab(value as CreditTab)} className="gap-0">
            <div className="px-6 pb-4">
              <TabsList variant="segmented" className="w-full">
                <TabsTrigger value="one-time" className="flex-1">
                  {t('tabOneTime')}
                </TabsTrigger>
                <TabsTrigger value="monthly" className="flex-1">
                  {t('tabMonthly')}
                </TabsTrigger>
              </TabsList>
            </div>
            <TabsContent value="one-time" className="mt-0">
              <TopupControls state={accountState} variant="hero" />
            </TabsContent>
            <TabsContent value="monthly" className="mt-0 px-6 pb-6">
              {accountState ? (
                <PlanChanger state={accountState} className="bg-popover rounded-md border" />
              ) : (
                <Skeleton className="h-48 w-full rounded-md" />
              )}
            </TabsContent>
          </Tabs>
        )}

        {!isMember && !paymentFailed ? (
          <div className="border-t">
            <FreeGrantNotice state={accountState} className="px-6 pt-3" />
            <div className="flex items-center px-3 py-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:text-foreground gap-1.5"
                disabled={createPortal.isPending}
                onClick={openPortal}
              >
                {createPortal.isPending ? <Loading className="size-4 shrink-0" /> : null}
                {tI18nComplete.raw('text7ea27c63aff1')}
              </Button>
            </div>
          </div>
        ) : null}
      </ModalContent>
    </Modal>
  );
}

/**
 * The last charge failed. The card is the fix: updating it in the Stripe
 * portal retries the charge. A one-time top-up with another card is the
 * other way out. Red marks the state once, on the dot.
 */
function PaymentFailedView({
  portalPending,
  onUpdateCard,
  onTopUpInstead,
}: {
  portalPending: boolean;
  onUpdateCard: () => void;
  /** Absent when the account may not buy one-off credits. */
  onTopUpInstead?: () => void;
}) {
  const t = useTranslations('billing.credits.modal');
  return (
    <div className="space-y-4 px-6 pb-6" data-testid="billing-payment-failed">
      <div className="bg-popover flex items-start gap-3 rounded-md border px-4 py-3">
        <span aria-hidden className="bg-kortix-red mt-2 size-1.5 shrink-0 rounded-full" />
        <p className="text-foreground text-sm">{t('paymentFailedHint')}</p>
      </div>
      <div className="flex flex-col gap-2">
        <Button
          type="button"
          size="lg"
          className="w-full gap-1.5 motion-safe:active:scale-[0.96]"
          disabled={portalPending}
          aria-busy={portalPending}
          onClick={onUpdateCard}
        >
          {portalPending ? <Loading className="size-4 shrink-0" /> : null}
          {t('updatePaymentMethod')}
        </Button>
        {onTopUpInstead ? (
          <Button
            type="button"
            size="lg"
            variant="secondary"
            className="w-full motion-safe:active:scale-[0.96]"
            onClick={onTopUpInstead}
          >
            {t('topUpInstead')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * A member may not buy credits: the purchase routes answer 403 (KRTX-1720).
 * Name who can, and hand over a link that opens this workspace's billing for
 * them. The directory read answers only the caller for a member without
 * `member.read`; then the list hides and the sentence stands alone.
 */
function MemberBlockedView() {
  const t = useTranslations('billing.credits.modal');
  const accountId = useBillingAccountId();
  const members = useAccountMembers(accountId ?? undefined);
  const owners = (members.data ?? []).filter((member) => {
    const role = member.role ?? member.account_role;
    return (role === 'owner' || role === 'admin') && !!member.email;
  });
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(resetTimer.current), []);

  const copyLink = async () => {
    if (!accountId) return;
    // Open billing over the workspace home, not over the member's own page
    // (often a session): keep the locale and `/workspaces/<id>`, drop the rest.
    const base =
      window.location.pathname.match(/^(?:\/[a-z]{2})?\/workspaces\/[^/]+/)?.[0] ?? '/workspaces';
    const path = accountPanelUrl(base, hubTarget(accountId, { tab: 'billing' }));
    try {
      await navigator.clipboard.writeText(new URL(path, window.location.origin).toString());
      // The label says "Link copied", so no toast repeats it. Back to idle in 2 s.
      setCopied(true);
      clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      errorToast(t('memberLinkCopyFailed'));
    }
  };

  return (
    <div className="space-y-4 px-6 pb-6" data-testid="topup-ask-owner">
      {members.isPending && accountId ? (
        <div className="space-y-1.5" aria-hidden>
          <Skeleton className="h-10 w-full rounded-md" />
        </div>
      ) : owners.length > 0 ? (
        <ul className="bg-popover divide-y rounded-md border">
          {owners.slice(0, 3).map((owner) => (
            <li key={owner.user_id} className="flex items-center gap-2.5 px-3 py-2">
              <UserAvatar email={owner.email!} size="sm" colorKey={owner.user_id} />
              <span className="text-foreground min-w-0 flex-1 truncate text-sm">{owner.email}</span>
              <span className="text-muted-foreground text-xs">
                {(owner.role ?? owner.account_role) === 'owner' ? t('roleOwner') : t('roleAdmin')}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-col gap-2">
        {/* Emails every owner (TOPUP-1, POST /accounts/:id/top-up-requests),
            once per member a day; the button carries its own 429 state. */}
        {accountId ? (
          <AskOwnerForCreditsButton
            accountId={accountId}
            variant="default"
            size="lg"
            className="w-full gap-1.5"
          />
        ) : null}
        <Button
          type="button"
          size="lg"
          variant="secondary"
          className="w-full gap-1.5 motion-safe:active:scale-[0.96]"
          disabled={!accountId}
          onClick={() => void copyLink()}
        >
          {copied ? <CheckIcon aria-hidden className="size-4" /> : <Copy className="size-4" />}
          {copied ? t('memberLinkCopied') : t('memberCopyLink')}
        </Button>
      </div>
    </div>
  );
}

/**
 * The available balance, in credits: the concrete "why" behind an
 * out-of-credits block, set beside the title.
 *
 * The LIVE account state is the source of truth (the field the Plan page
 * reads); the 402's `balance` is only a pre-load hint. A real 0 shows as 0,
 * and an unloaded value shows a skeleton, never a misleading 0. A negative
 * balance keeps its minus and turns red: the account owes those credits.
 */
function WalletBalance({
  accountState,
  balance,
  accountLoading,
}: {
  accountState?: AccountState;
  balance?: number;
  accountLoading?: boolean;
}) {
  const tCredits = useTranslations('settings.credits');
  const locale = useLocale();
  const liveBalance = accountState?.credits?.total;
  const hasLiveBalance = typeof liveBalance === 'number';
  const walletUsd = hasLiveBalance ? liveBalance : (balance ?? 0);
  const isNegative = walletUsd < 0;

  if (!hasLiveBalance && accountLoading)
    return <Skeleton className="h-4 w-16 shrink-0 rounded-sm" />;
  return (
    <span
      className={cn(
        'shrink-0 text-xs tabular-nums',
        isNegative ? 'text-kortix-red' : 'text-muted-foreground',
      )}
      data-testid="wallet-balance"
    >
      {formatUsdAsCredits(walletUsd, { locale })}{' '}
      {tCredits('unit', { count: Math.abs(walletUsd) * 100 })}
    </span>
  );
}

export function GlobalUpgradeModal() {
  const selected = useUpgradeModalHost();
  return selected ? <GlobalUpgradeModalContent /> : null;
}

function GlobalUpgradeModalContent() {
  const { isOpen, closeUpgradeDialog, accountId, reason, hasSubscription, billingState, balance } =
    useUpgradeDialogStore();
  const { data: accountState, isLoading: accountLoading } = useAccountState({ accountId });
  const queryClient = useQueryClient();

  // Pull the freshest wallet balance every time the modal opens (skip the
  // server cache) so it always matches the Plan page — never a stale/zero value
  // left over from an earlier read, and it reflects a top-up the moment it lands.
  useEffect(() => {
    if (isOpen) invalidateAccountState(queryClient, true, true, accountId);
  }, [isOpen, queryClient, accountId]);

  return (
    <BillingAccountProvider accountId={accountId ?? null}>
      <UpgradePlansModal
        open={isOpen}
        onOpenChange={(open) => !open && closeUpgradeDialog()}
        accountState={accountState}
        reason={reason}
        hasSubscription={hasSubscription}
        billingState={billingState}
        balance={balance}
        accountLoading={accountLoading}
      />
    </BillingAccountProvider>
  );
}
