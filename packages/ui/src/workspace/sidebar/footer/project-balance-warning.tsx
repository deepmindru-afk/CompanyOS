'use client';

import { canManageBilling, platformConfig } from '@kortix/sdk';

import {
  SidebarAlertRow,
  type SidebarAlertTone,
} from './sidebar-alert';
import { useAccountState } from '../../../internal/billing';
import type { UiTranslator } from '../../../i18n';
import {
  billingDialogArgs,
  resolveBillingState,
  walletAlertCopy,
  walletSeverity,
} from '../../../internal/lib/billing/billing-gate-state';
import { useUpgradeDialogStore } from '../../../internal/stores/upgrade-dialog-store';
import { WarningIcon as AlertTriangle, CreditCardIcon as CreditCard } from '@phosphor-icons/react';
import { useTranslations } from '../../../i18n';
import { useCallback } from 'react';

function useBalanceWarning(accountId: string | undefined, tI18nComplete: UiTranslator) {
  const { data: accountState } = useAccountState({ accountId });
  const openUpgradeDialog = useUpgradeDialogStore((s) => s.openUpgradeDialog);

  // The row is a door into the billing dialog, so it shows only where that
  // dialog has a way out: one-off top-ups, or (since 2026-11-09, when top-ups
  // went Enterprise-only) a live subscription whose monthly tier can be raised.
  // A free account keeps the "Upgrade Plan" button instead. A caller without
  // `billing.write` cannot act either; the session error banner tells them to
  // ask an owner when the wallet actually blocks a run.
  const canTopUp =
    ((accountState?.tier?.can_purchase_credits ?? false) ||
      (accountState?.has_active_subscription ?? false)) &&
    canManageBilling(accountState);

  const handleClick = useCallback(
    () =>
      openUpgradeDialog(
        billingDialogArgs(
          resolveBillingState(accountState),
          accountState,
          accountId,
          tI18nComplete,
        ),
      ),
    [openUpgradeDialog, accountId, accountState, tI18nComplete],
  );

  if (!platformConfig().billingEnabled || !accountState || !canTopUp) {
    return { severity: null as ReturnType<typeof walletSeverity>, handleClick };
  }

  // Severity comes from `walletSeverity`, never from the raw balance. This
  // component used to compute `balance <= 0 ? 'empty' : balance < 5 ? 'low'`
  // itself, which is how a fully-running account got a permanent red
  // "Out of credits" row while the project page beside it started sessions
  // without complaint.
  return { severity: walletSeverity(accountState), handleClick };
}

/**
 * This row used to be the loudest thing in the footer: a tinted fill *and* a
 * coloured border at `h-9`, next to two `h-8` alerts that were transparent. It
 * now wears the shared footer dialect, so an empty wallet reads as urgent
 * through its colour rather than through extra chrome — and the row lines up
 * with every other row in the sidebar.
 */
export function SidebarBalanceWarning({ accountId }: { accountId?: string }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const { severity, handleClick } = useBalanceWarning(accountId, tI18nComplete);
  if (!severity) return null;

  const isBlocked = severity === 'blocked';
  const tone: SidebarAlertTone = isBlocked ? 'critical' : 'warning';
  const copy = walletAlertCopy(severity, tI18nComplete);

  return (
    <SidebarAlertRow
      tone={tone}
      icon={isBlocked ? <AlertTriangle className="size-4" /> : <CreditCard className="size-4" />}
      label={copy.label}
      trailing={copy.action}
      onClick={handleClick}
    />
  );
}
