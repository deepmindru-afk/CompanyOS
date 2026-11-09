'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';

import { Button } from '@kortix/ui/button';
import { Alert as BannerAlert, AlertDescription as BannerAlertDescription} from '@kortix/ui/alert';
import Loading from '@kortix/ui/loading';
import { errorToast } from '@kortix/ui/toast';
import { useBillingReturnUrl } from '@/features/billing/billing-return';
import { topUpBonusCredits } from '@kortix/ui/internal/billing/compute-pricing';
import { spring, cn } from '@kortix/ui';
import { useBillingAccountId } from '@kortix/ui/internal/stores/billing-account-context';
import { purchaseCredits } from '@kortix/sdk';
import { dollarsToCredits, formatCredits } from '@kortix/shared';
import { m } from 'motion/react';
import { useLocale, useTranslations } from '@/i18n/use-translations';

/**
 * One-time credit purchase.
 *
 * **Restyle (2026-08-13).** This was a 3×2 grid of six large amount tiles, a
 * separate bordered "Custom" input row under it, two conditional validation
 * lines, and a full-width button — five stacked blocks, roughly 240px tall,
 * for one decision ("how much?") and one action. Jay's brief: the buy-credits
 * control is the thing people come to this pane to use, and it took the most
 * space to say the least.
 *
 * It is now one line: a segmented amount control with a sliding selection
 * indicator, the action beside it, and a single muted line underneath that
 * carries the credit equivalent — or the validation message, in the same slot,
 * so nothing appears or disappears and shoves the button around.
 *
 * Four presets, not six. The backend maps these exact dollar amounts to fixed
 * Stripe prices and falls back to a dynamic `price_data` line item for any
 * other amount (`payments.ts`), so $250 and $500 lost nothing but a tile —
 * they are reachable through Custom, which every larger buyer uses anyway.
 *
 * Renders no chrome of its own (no border, no padding, no heading): the host
 * owns the panel. Three hosts rely on that — the Billing tab, the
 * out-of-credits modal, and `/accounts/[id]`.
 */

/** Preset one-time credit amounts, in dollars. $1 = 100 credits
 *  (CREDITS_PER_DOLLAR). The last three sit on the top-up bonus ladder, so the
 *  presets show the bonus growing. Anything else goes through Custom. */
const CREDIT_PRESETS = [25, 100, 250, 1000] as const;

/** Minimum custom top-up. Stripe rejects sub-$0.50 charges; $5 keeps the
 *  checkout worthwhile and matches the smallest amount worth a card round-trip. */
const CUSTOM_MIN_USD = 5;
const CUSTOM_MAX_USD = 50_000;

/**
 * Everything the control says about the amount currently chosen, in one place:
 * whether it can be bought, the one muted line under the row, and the action
 * label.
 *
 * Pure and exported so it can be tested without a `QueryClientProvider` — the
 * component itself reads `useBillingAccountId` and `useBillingReturnUrl` and
 * cannot render under `renderToStaticMarkup`.
 *
 * The hint is never empty. It is the same slot in every state — credits when
 * the amount is valid, the reason when it is not — so the row's height never
 * changes and the button never moves under the cursor mid-click.
 */
export function describeTopup(
  amount: number | null,
  isPurchasing = false,
  copy: TopupCopy = DEFAULT_TOPUP_COPY,
): { canBuy: boolean; hint: string; actionLabel: string } {
  const tooLow = amount !== null && amount < CUSTOM_MIN_USD;
  const tooHigh = amount !== null && amount > CUSTOM_MAX_USD;
  const canBuy = amount !== null && !tooLow && !tooHigh && !isPurchasing;

  const hint = tooLow
    ? copy.minimum(formatWholeUsd(CUSTOM_MIN_USD, copy.locale))
    : tooHigh
      ? copy.contactSales(formatWholeUsd(CUSTOM_MAX_USD, copy.locale))
      : amount !== null
        ? topUpBonusCredits(amount) > 0
          ? copy.creditHintBonus(
              formatCredits(dollarsToCredits(Math.round(amount)), { locale: copy.locale }),
              formatCredits(topUpBonusCredits(amount), { locale: copy.locale }),
            )
          : copy.creditHint(
              formatCredits(dollarsToCredits(Math.round(amount)), { locale: copy.locale }),
            )
        : copy.noExpiry;

  const actionLabel = isPurchasing
    ? copy.processing
    : canBuy && amount !== null
      ? copy.addAmount(formatWholeUsd(Math.round(amount), copy.locale))
      : copy.addCredits;

  return { canBuy, hint, actionLabel };
}

export interface TopupCopy {
  minimum: (amount: string) => string;
  contactSales: (amount: string) => string;
  creditHint: (credits: string) => string;
  /** The hint when the amount earns a top-up bonus. */
  creditHintBonus: (credits: string, bonus: string) => string;
  noExpiry: string;
  processing: string;
  addAmount: (amount: string) => string;
  addCredits: string;
  locale: string;
}

const DEFAULT_TOPUP_COPY: TopupCopy = {
  minimum: (amount) => `Minimum top-up is ${amount}.`,
  contactSales: (amount) => `For more than ${amount}, contact sales.`,
  creditHint: (credits) => `${credits} credits · added as soon as you pay.`,
  creditHintBonus: (credits, bonus) => `${credits} credits + ${bonus} bonus · added as soon as you pay.`,
  noExpiry: 'Credits never expire. $1 = 100 credits, plus a bonus from $50.',
  processing: 'Processing',
  addAmount: (amount) => `Add ${amount}`,
  addCredits: 'Add credits',
  locale: 'en-US',
};

function formatWholeUsd(amount: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

interface CreditTopupSectionProps {
  /** Where Stripe returns on success. Defaults to /dashboard?credit_purchase=success. */
  successUrl?: string;
  /** Where Stripe returns on cancel. Defaults to the current URL. */
  cancelUrl?: string;
  className?: string;
  /**
   * `row` (default): the segmented amount control with the action beside it,
   * for the Billing tab and `/accounts/[id]`.
   * `hero`: one large editable amount, preset chips under it and a full-width
   * action, for the out-of-credits modal where buying is the only question.
   */
  variant?: 'row' | 'hero';
}

export function CreditTopupSection({ variant = 'row', ...props }: CreditTopupSectionProps) {
  return variant === 'hero' ? <HeroTopup {...props} /> : <RowTopup {...props} />;
}

/** The Stripe checkout round-trip both layouts share. */
function useCreditPurchase({ successUrl, cancelUrl }: { successUrl?: string; cancelUrl?: string }) {
  const t = useTranslations('billing.topup');
  const billingAccountId = useBillingAccountId();
  const billingReturnUrl = useBillingReturnUrl();
  const [isPurchasing, setIsPurchasing] = useState(false);
  const purchasingRef = useRef(false);
  const [purchaseError, setPurchaseError] = useState<string | null>(null);
  // Back from Stripe restores this page from the back/forward cache with the
  // button still "processing": open it again.
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      purchasingRef.current = false;
      setIsPurchasing(false);
    };
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
  }, []);

  const purchase = async (amount: number) => {
    // Synchronous guard: a second click before the re-render made a second
    // Stripe Checkout Session.
    if (purchasingRef.current) return;
    purchasingRef.current = true;
    setIsPurchasing(true);
    setPurchaseError(null);
    try {
      const response = await purchaseCredits({
        accountId: billingAccountId ?? undefined,
        // Whole-dollar amounts only — custom prices are per-dollar on the
        // backend and the ledger displays cleanly. Round to be safe.
        amount: Math.round(amount),
        successUrl: successUrl ?? billingReturnUrl('credit_purchase'),
        cancelUrl: cancelUrl ?? window.location.href,
      });
      if (response.checkout_url) {
        // The page is leaving for Stripe: the button stays in "processing".
        window.location.href = response.checkout_url;
        return;
      }
      throw new Error(t('noCheckoutUrl'));
    } catch (err: unknown) {
      const error = err as { details?: { detail?: string }; message?: string };
      const msg = error?.details?.detail || error?.message || t('checkoutFailed');
      setPurchaseError(msg);
      errorToast(msg);
      purchasingRef.current = false;
      setIsPurchasing(false);
    }
  };

  return { isPurchasing, purchaseError, setPurchaseError, purchase };
}

function useTopupCopy(): TopupCopy {
  const t = useTranslations('billing.topup');
  const locale = useLocale();
  return {
    minimum: (value) => t('minimum', { amount: value }),
    contactSales: (value) => t('contactSales', { amount: value }),
    creditHint: (credits) => t('creditHint', { credits }),
    creditHintBonus: (credits, bonus) => t('creditHintBonus', { credits, bonus }),
    noExpiry: t('noExpiry'),
    processing: t('processing'),
    addAmount: (value) => t('addAmount', { amount: value }),
    addCredits: t('addCredits'),
    locale,
  };
}

/** The hero layout's starting amount: the first preset on the bonus ladder. */
const HERO_DEFAULT_USD = 100;

/**
 * One large editable amount. The number IS the input: type any amount, or
 * pick a preset chip under it. The action is full width and names the charge.
 */
function HeroTopup({ successUrl, cancelUrl, className }: Omit<CreditTopupSectionProps, 'variant'>) {
  const t = useTranslations('billing.topup');
  const locale = useLocale();
  const copy = useTopupCopy();
  const { isPurchasing, purchaseError, setPurchaseError, purchase } = useCreditPurchase({
    successUrl,
    cancelUrl,
  });
  const [value, setValue] = useState(String(HERO_DEFAULT_USD));
  const parsed = Number.parseFloat(value);
  const amount = Number.isFinite(parsed) ? parsed : null;
  const { canBuy, hint, actionLabel } = describeTopup(amount, isPurchasing, copy);
  const inputId = useId();

  return (
    <div className={cn('flex flex-col items-center gap-4', className)}>
      <label htmlFor={inputId} className="sr-only">
        {t('customAmount')}
      </label>
      {/* Off the app-chrome ladder (text-2xl) on purpose: the amount is the one
          decision in this modal and Jay picked the large-number design
          (Paper "Out of credits" variant 02). */}
      <div className="text-foreground focus-within:ring-kortix-base flex items-baseline justify-center rounded-md px-2 text-5xl font-medium tracking-tight tabular-nums focus-within:ring-[0.6px]">
        <span aria-hidden>$</span>
        <input
          id={inputId}
          type="number"
          inputMode="numeric"
          min={CUSTOM_MIN_USD}
          max={CUSTOM_MAX_USD}
          step={1}
          value={value}
          disabled={isPurchasing}
          onChange={(e) => {
            setValue(e.target.value);
            setPurchaseError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && canBuy && amount !== null) void purchase(amount);
          }}
          // The field is as wide as its digits, so the number stays centred.
          // Capped at 7ch: a pasted long number scrolls inside the field
          // instead of pushing past the modal (validation still rejects it).
          style={{ width: `${Math.min(Math.max(value.length, 1), 7)}ch` }}
          className="placeholder:text-muted-foreground caret-kortix-base [appearance:textfield] bg-transparent text-left outline-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        />
      </div>

      {/* Shortcuts that fill the amount, not a choice group: toggle buttons. */}
      <div role="group" aria-label={t('amountGroup')} className="flex flex-wrap justify-center gap-1.5">
        {CREDIT_PRESETS.map((price) => {
          const selected = amount === price;
          return (
            <button
              key={price}
              type="button"
              aria-pressed={selected}
              disabled={isPurchasing}
              onClick={() => {
                setValue(String(price));
                setPurchaseError(null);
              }}
              className={cn(
                'h-7 cursor-pointer rounded-md border px-3 text-xs font-medium tabular-nums',
                'duration-fast transition-colors motion-safe:active:scale-[0.96] disabled:pointer-events-none disabled:opacity-50',
                'focus-visible:ring-kortix-base focus-visible:ring-[0.6px] focus-visible:outline-none',
                selected ? 'bg-active text-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-hover',
              )}
            >
              {formatWholeUsd(price, locale)}
            </button>
          );
        })}
      </div>

      <p className="text-muted-foreground text-center text-xs tabular-nums">{hint}</p>

      <Button
        onClick={() => canBuy && amount !== null && void purchase(amount)}
        disabled={!canBuy}
        size="lg"
        className="w-full gap-1.5 motion-safe:active:scale-[0.96]"
      >
        {isPurchasing ? <Loading className="size-3.5 shrink-0" /> : null}
        {actionLabel}
      </Button>

      {purchaseError && (
        <BannerAlert variant="destructive" className="w-full">
          <BannerAlertDescription>{purchaseError}</BannerAlertDescription>
        </BannerAlert>
      )}
    </div>
  );
}

function RowTopup({ successUrl, cancelUrl, className }: Omit<CreditTopupSectionProps, 'variant'>) {
  const t = useTranslations('billing.topup');
  const locale = useLocale();
  // The sliding indicator is a shared layout animation. Two of these can be
  // mounted at once (the Billing tab behind the out-of-credits modal), and a
  // duplicate `layoutId` would make one instance's indicator fly across the
  // screen to the other's cell.
  const indicatorId = `credit-topup-${useId()}`;
  const [selectedPrice, setSelectedPrice] = useState<number | null>(null);
  const [customValue, setCustomValue] = useState('');
  const [isCustom, setIsCustom] = useState(false);
  const copy = useTopupCopy();
  const { isPurchasing, purchaseError, setPurchaseError, purchase } = useCreditPurchase({
    successUrl,
    cancelUrl,
  });

  // The dollar amount that would actually be charged. Custom wins when the
  // custom cell is active; otherwise the selected preset.
  const amount = useMemo(() => {
    if (isCustom) {
      const parsed = Number.parseFloat(customValue);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return selectedPrice;
  }, [isCustom, customValue, selectedPrice]);

  const { canBuy, hint, actionLabel } = describeTopup(amount, isPurchasing, copy);

  const select = (price: number) => {
    setSelectedPrice(price);
    setIsCustom(false);
    setPurchaseError(null);
  };

  const handlePurchase = async () => {
    if (amount === null || !canBuy) return;
    await purchase(amount);
  };
  return (
    <div className={cn('space-y-2.5', className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div
          role="radiogroup"
          aria-label={t('amountGroup')}
          className="bg-muted/60 flex items-center gap-0.5 rounded-md border p-0.5"
        >
          {CREDIT_PRESETS.map((price) => {
            const isSelected = !isCustom && selectedPrice === price;
            return (
              <AmountCell
                key={price}
                selected={isSelected}
                indicatorId={indicatorId}
                disabled={isPurchasing}
                onClick={() => select(price)}
              >
                {formatWholeUsd(price, locale)}
              </AmountCell>
            );
          })}

          {/* The Custom cell IS the input once it is chosen — the amount stays
              in the same control instead of opening a second row below it. */}
          {isCustom ? (
            <div className="relative">
              <m.span
                layoutId={indicatorId}
                transition={spring.moderate}
                className="bg-background absolute inset-0 rounded-sm shadow-2xs"
              />
              <span className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 z-10 -translate-y-1/2 text-xs">
                $
              </span>
              <input
                type="number"
                autoFocus
                min={CUSTOM_MIN_USD}
                max={CUSTOM_MAX_USD}
                step={1}
                inputMode="numeric"
                aria-label={t('customAmount')}
                value={customValue}
                placeholder={String(CUSTOM_MIN_USD)}
                disabled={isPurchasing}
                onChange={(e) => {
                  setCustomValue(e.target.value);
                  setPurchaseError(null);
                }}
                className="text-foreground placeholder:text-muted-foreground relative z-10 h-7 w-[4.5rem] [appearance:textfield] bg-transparent pr-2 pl-5 text-xs font-medium tabular-nums outline-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
              />
            </div>
          ) : (
            <AmountCell
              selected={false}
              indicatorId={indicatorId}
              disabled={isPurchasing}
              onClick={() => {
                setIsCustom(true);
                setPurchaseError(null);
              }}
            >
              {t('custom')}
            </AmountCell>
          )}
        </div>

        <Button
          onClick={handlePurchase}
          disabled={!canBuy}
          size="sm"
          className="min-w-[7rem] gap-1.5 transition-transform active:scale-[0.96]"
        >
          {isPurchasing ? <Loading className="size-3.5 shrink-0" /> : null}
          {actionLabel}
        </Button>
      </div>

      <p className="text-muted-foreground text-xs tabular-nums">{hint}</p>

      {purchaseError && <BannerAlert variant="destructive" ><BannerAlertDescription>{purchaseError}</BannerAlertDescription></BannerAlert>}
    </div>
  );
}

/** One cell of the segmented amount control. The selected cell carries the
 *  shared-layout indicator, so choosing another amount slides the fill across
 *  rather than blinking it off and on. */
function AmountCell({
  selected,
  indicatorId,
  disabled,
  onClick,
  children,
}: {
  selected: boolean;
  indicatorId: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'relative h-7 cursor-pointer rounded-sm px-2.5 text-xs font-medium tabular-nums',
        'duration-normal transition-[color,transform] active:scale-[0.96] disabled:pointer-events-none disabled:opacity-50 motion-reduce:transform-none',
        'focus-visible:ring-kortix-base focus-visible:ring-[0.6px] focus-visible:outline-none',
        selected ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {selected ? (
        <m.span
          layoutId={indicatorId}
          transition={spring.moderate}
          className="bg-background absolute inset-0 rounded-sm shadow-2xs"
        />
      ) : null}
      <span className="relative z-10">{children}</span>
    </button>
  );
}
