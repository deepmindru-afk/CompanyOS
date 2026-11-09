'use client';

/**
 * The receipt for a one-time top-up, shown once when Stripe returns the
 * browser with `credit_purchase=success` (billing-return.tsx).
 *
 * A toast used to carry this. A toast leaves the loop open: the user paid to
 * get a session running again, and the toast neither shows the new balance
 * nor offers the way back to work. This dialog does both, then gets out of
 * the way with one button.
 *
 * Motion: a purchase is a rare event, so the check earns a short draw inside
 * the 300 ms ceiling: the ring draws over 200 ms, the tick from 150 to 300 ms,
 * ease-out with no overshoot. Only the strokes move; the modal's own enter is
 * the one scale. Reduced motion renders the finished mark.
 */
import { getAccountState } from '@kortix/sdk';
import { formatUsdAsCredits } from '@kortix/shared';
import { Button } from '@kortix/ui/button';
import { Modal, ModalContent, ModalDescription, ModalTitle } from '@kortix/ui/modal';
import { Skeleton } from '@kortix/ui/skeleton';
import { useQuery } from '@tanstack/react-query';
import { m, useReducedMotion } from 'motion/react';
import { create } from 'zustand';

import { useLocale, useTranslations } from '@/i18n/use-translations';

interface CreditsAddedState {
  open: boolean;
  accountId?: string;
  title: string;
  description: string;
  /** When the receipt opened: keys its own fresh balance read. */
  openedAt: number;
  show: (opts: { accountId?: string; title: string; description: string }) => void;
  close: () => void;
}

export const useCreditsAddedStore = create<CreditsAddedState>((set) => ({
  open: false,
  accountId: undefined,
  title: '',
  description: '',
  openedAt: 0,
  show: (opts) => set({ open: true, openedAt: Date.now(), ...opts }),
  close: () => set({ open: false }),
}));

const EASE_OUT = [0.23, 1, 0.32, 1] as const;

/** A ring that draws itself, then a tick that draws inside it. */
export function AnimatedCheck({ className }: { className?: string }) {
  const reduce = useReducedMotion();
  const draw = (delay: number, duration: number) =>
    reduce
      ? { initial: false as const }
      : {
          initial: { pathLength: 0, opacity: 0 },
          animate: { pathLength: 1, opacity: 1 },
          transition: {
            pathLength: { delay, duration, ease: EASE_OUT },
            opacity: { delay, duration: 0.01 },
          },
        };

  return (
    <m.svg viewBox="0 0 48 48" fill="none" aria-hidden className={className}>
      <circle cx="24" cy="24" r="22" className="fill-muted" />
      <m.circle
        cx="24"
        cy="24"
        r="22"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        // Start the ring at 12 o'clock, drawing clockwise.
        transform="rotate(-90 24 24)"
        {...draw(0, 0.2)}
      />
      <m.path
        d="M16 24.5l5.5 5.5L32.5 18.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        {...draw(0.15, 0.15)}
      />
    </m.svg>
  );
}

export function CreditsAddedDialog() {
  const { open, accountId, title, description, openedAt, close } = useCreditsAddedStore();
  return (
    <Modal open={open} onOpenChange={(next) => !next && close()}>
      <ModalContent className="gap-0 space-y-0 p-0 sm:max-w-sm" data-testid="credits-added-dialog">
        {/* Kept mounted after close, so the exit animation plays on the
            receipt, not on an empty shell. A new opening remounts it. */}
        {openedAt > 0 ? (
          <CreditsAddedBody
            key={openedAt}
            accountId={accountId}
            title={title}
            description={description}
            openedAt={openedAt}
            onDone={close}
          />
        ) : null}
      </ModalContent>
    </Modal>
  );
}

function CreditsAddedBody({
  accountId,
  title,
  description,
  openedAt,
  onDone,
}: {
  accountId?: string;
  title: string;
  description: string;
  openedAt: number;
  onDone: () => void;
}) {
  const t = useTranslations('billing.credits.modal');
  const tCredits = useTranslations('settings.credits');
  const locale = useLocale();
  // The shared account-state query can still hold, or immediately refetch,
  // the server-cached pre-purchase balance. The receipt makes its own
  // cache-bypassing read, once per opening, and shows nothing until it lands.
  const fresh = useQuery({
    queryKey: ['credits-added-balance', accountId ?? null, openedAt],
    queryFn: () => getAccountState({ skipCache: true, accountId }),
    staleTime: Infinity,
    gcTime: 0,
    retry: 2,
  });
  const total = fresh.data?.credits?.total;

  return (
    <div className="flex flex-col items-center gap-5 px-6 pt-8 pb-6 text-center">
      <AnimatedCheck className="text-foreground size-12" />
      <div className="space-y-1.5">
        <ModalTitle className="text-lg font-medium tracking-tight">{title}</ModalTitle>
        <ModalDescription className="text-sm text-pretty">{description}</ModalDescription>
      </div>
      <div className="bg-popover flex w-full items-center justify-between rounded-md border px-4 py-3">
        <span className="text-muted-foreground text-sm">{t('newBalance')}</span>
        {typeof total === 'number' ? (
          <span className="text-foreground text-sm font-medium tabular-nums">
            {formatUsdAsCredits(total, { locale })}{' '}
            {tCredits('unit', { count: Math.abs(total) * 100 })}
          </span>
        ) : fresh.isError && !fresh.isFetching ? (
          // The money already moved; only the read failed. Offer one retry,
          // and Continue still closes the loop.
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => void fresh.refetch()}
          >
            {t('balanceRetry')}
          </Button>
        ) : (
          <Skeleton className="h-4 w-20 rounded-sm" />
        )}
      </div>
      <Button
        size="lg"
        className="w-full motion-safe:active:scale-[0.96]"
        onClick={onDone}
        autoFocus
      >
        {t('continue')}
      </Button>
    </div>
  );
}
