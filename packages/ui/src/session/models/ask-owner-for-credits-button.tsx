'use client';

import { useState, type ComponentProps } from 'react';
import { Button } from '../../primitives/button';
import { cn } from '../../lib/utils';
import Loading from '../../primitives/loading';
import { useTranslations } from '../../i18n';
import { requestTopUp } from '@kortix/sdk';

/**
 * KRTX-1718: the member's way to tell an owner, from where they are blocked.
 * Emails every owner; the API takes one request per member a day (429 after).
 */
export function AskOwnerForCreditsButton({
  accountId,
  variant = 'outline',
  size = 'sm',
  className,
}: {
  accountId: string;
  /** Defaults to the banner's outline `sm`; the out-of-credits modal makes it its primary action. */
  variant?: ComponentProps<typeof Button>['variant'];
  size?: ComponentProps<typeof Button>['size'];
  className?: string;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [state, setState] = useState<'idle' | 'asking' | 'asked' | 'already' | 'failed'>('idle');
  const label =
    state === 'asked'
      ? 'ownersNotified'
      : state === 'already'
        ? 'alreadyAskedToday'
        : state === 'failed'
          ? 'askOwnerFailed'
          : 'askOwnerForCredits';
  const ask = async () => {
    setState('asking');
    try {
      await requestTopUp(accountId);
      setState('asked');
    } catch (err) {
      setState((err as { status?: number })?.status === 429 ? 'already' : 'failed');
    }
  };
  return (
    <Button
      variant={variant}
      size={size}
      className={cn('active:scale-[0.96]', className)}
      disabled={state === 'asking' || state === 'asked' || state === 'already'}
      onClick={() => void ask()}
    >
      {state === 'asking' ? <Loading className="size-3.5 shrink-0" /> : null}
      {tHardcodedUi.raw(`componentsSessionSessionErrorBanner.${label}`)}
    </Button>
  );
}
