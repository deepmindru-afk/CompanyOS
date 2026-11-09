'use client';

import { useWorkspaceModels } from '@kortix/sdk/react';
import { useState } from 'react';

import { useTranslations } from '../../i18n';
import { Close } from '../../icons/close';
import { SolidRightArrow } from '../../icons/solid-right-arrow';
import { ClaudeCode } from '../../internal/icons/claude-code';
import { ProviderLogo } from '../../internal/lib/provider-branding';
import { cn } from '../../internal/lib/utils';
import { hasRunnableSubscriptionModel, isRunnableModel } from './model-availability';
import { useModelConnectionGate } from './use-model-connection-gate';

const PLANS = [
  { providerId: 'openai', name: 'ChatGPT', labelKey: 'connectChatGpt', planKey: 'chatGptPlan' },
  { providerId: 'anthropic', name: 'Claude', labelKey: 'connectClaude', planKey: 'claudePlan' },
] as const;

type PlanId = (typeof PLANS)[number]['providerId'];

const dismissedKey = (projectId: string) => `kortix:subscription-offer-dismissed:${projectId}`;

/** The rows this browser hid for this project. Empty when storage is blocked. */
function readDismissed(projectId: string | undefined): PlanId[] {
  if (!projectId || typeof window === 'undefined') return [];
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(dismissedKey(projectId)) ?? '[]');
    return Array.isArray(parsed)
      ? parsed.filter((id): id is PlanId => PLANS.some((plan) => plan.providerId === id))
      : [];
  } catch {
    return [];
  }
}

function writeDismissed(projectId: string, ids: PlanId[]) {
  try {
    window.localStorage.setItem(dismissedKey(projectId), JSON.stringify(ids));
  } catch {
    // Storage blocked (private mode): the row stays hidden until reload.
  }
}

/**
 * The one "connect a model" surface: two rows, "Connect ChatGPT · Plus or Pro
 * plan →" and "Connect Claude · Pro or Max plan →". Each opens the provider
 * dialog with that provider already expanded, so the next click is the sign-in.
 *
 * The rows read like starter suggestions: no box, no fill until hover. Inside
 * each row the logo centres under the composer's paperclip (`pl-2.5`) and the
 * arrow under its send button (`pr-3.5`), so the host must place the rows at
 * the composer card's width.
 *
 * `dismissible`: hovering a row swaps its arrow for a ✕ in the same slot. The ✕
 * hides that row for this project in this browser (`localStorage`). Only the
 * optional offer is dismissible; with no model at all there is nothing else to
 * send with, so the rows stay.
 *
 * `projectId` omitted: the gate reads the `[id]` route segment.
 */
export function ConnectPlanRows({
  projectId,
  dismissible,
  className,
}: {
  projectId?: string;
  dismissible: boolean;
  className?: string;
}) {
  const t = useTranslations('sessionUi.modelGate');
  const { canConnectProvider, openConnectProvider, modal } = useModelConnectionGate(
    undefined,
    projectId === undefined ? undefined : { projectId },
  );
  const [dismissed, setDismissed] = useState<PlanId[]>(() =>
    dismissible ? readDismissed(projectId) : [],
  );
  const plans = PLANS.filter((plan) => !dismissed.includes(plan.providerId));

  const dismiss = (id: PlanId) => {
    const next = [...dismissed, id];
    setDismissed(next);
    if (projectId) writeDismissed(projectId, next);
  };

  return (
    <>
      {modal}
      {canConnectProvider && plans.length > 0 ? (
        <div role="group" aria-label={t('offerTitle')} className={cn('flex flex-col', className)}>
          {plans.map((plan) => (
            <div key={plan.providerId} className="group relative">
              <button
                type="button"
                onClick={() => openConnectProvider('providers', plan.providerId)}
                className="hover:bg-muted/60 focus-visible:ring-kortix-base flex w-full min-w-0 items-center gap-3 rounded-lg py-2 pr-3.5 pl-2.5 text-left transition-colors outline-none focus-visible:ring-[0.6px]"
              >
                {plan.providerId === 'anthropic' ? (
                  // Claude plans run through Claude Code, so the row shows its mark.
                  <ClaudeCode className="size-5 shrink-0" />
                ) : (
                  <ProviderLogo providerID={plan.providerId} size="xs" className="size-5 [&_img]:size-5" />
                )}
                <span className="text-foreground shrink-0 text-sm">{t(plan.labelKey)}</span>
                <span className="text-muted-foreground truncate text-sm">{t(plan.planKey)}</span>
                <SolidRightArrow
                  className={cn(
                    'text-muted-foreground ml-auto size-4 shrink-0 transition-opacity',
                    dismissible && 'group-focus-within:opacity-0 group-hover:opacity-0',
                  )}
                />
              </button>
              {dismissible ? (
                // A sibling, not a child: a button cannot hold a button. It sits
                // over the arrow's slot — `w-11` is `pr-3.5` + the arrow +
                // `pr-3.5` — so the ✕ centres where the arrow was.
                <button
                  type="button"
                  aria-label={t('hidePlan', { name: plan.name })}
                  onClick={() => dismiss(plan.providerId)}
                  className="text-muted-foreground hover:text-foreground focus-visible:ring-kortix-base absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-lg opacity-0 transition-opacity outline-none group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:ring-[0.6px]"
                >
                  <Close />
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}

/**
 * The project home's optional offer: the rows, dismissible, under the hero
 * composer. New projects run on Kortix models, and most people already pay
 * for ChatGPT or Claude.
 *
 * Shown only when a model already runs (with none, the composer's own
 * `ModelConnectionBar` shows the same rows, undismissible), no ChatGPT or
 * Claude plan serves one yet, and the viewer may change the project's models.
 * `px-4` is the composer shell's gutter, so the rows span the card's width.
 */
export function SubscriptionOffer({ projectId }: { projectId: string }) {
  const models = useWorkspaceModels(projectId);
  const { canWriteProviders } = useModelConnectionGate(undefined, { projectId });
  const show =
    canWriteProviders && models.some(isRunnableModel) && !hasRunnableSubscriptionModel(models);
  return show ? <ConnectPlanRows projectId={projectId} dismissible className="px-4" /> : null;
}
