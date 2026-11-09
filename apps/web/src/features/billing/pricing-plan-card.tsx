'use client';

import type { PricingPlan } from '@/features/billing/pricing-plans';
import { useEnglishOnly } from '@/features/marketing/kit/english-only';
import { cn } from '@kortix/ui';
import { SolidCheckIcon } from '@kortix/ui/internal/icons/solid-check-icon';

interface PricingPlanCardProps {
  plan: PricingPlan;
  action: React.ReactNode;
  /** Replaces the price line. The credits column puts its credits ladder here. */
  priceSlot?: React.ReactNode;
  /** A muted label at the end of the name row, for example "Current plan". */
  badgeOverride?: string;
}

/**
 * One plan column of the upgrade modal, in the /pricing page's layout: name
 * and note, price, action, a dashed rule, then what the plan includes. The
 * highlighted plan sits on `bg-card`. Columns have no box of their own; the
 * parent band draws the hairlines between them.
 *
 * From `md` the column is a subgrid of seven rows (name, note, price,
 * action, rule, label, list), so every row lines up across the columns even
 * when the credits ladder is taller than a plain price.
 */
export function PricingPlanCard({ plan, action, priceSlot, badgeOverride }: PricingPlanCardProps) {
  // No catalog key yet: other locales show no label rather than the plan name twice.
  const includedLabel = useEnglishOnly()('What’s included');
  return (
    <div
      className={cn(
        'flex flex-col px-6 py-8 md:row-span-7 md:grid md:grid-cols-1 md:grid-rows-subgrid md:px-8',
        plan.highlight && 'bg-card',
      )}
    >
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-foreground text-lg font-medium tracking-tight">{plan.name}</h3>
        {badgeOverride ? (
          <span className="text-muted-foreground shrink-0 text-xs">{badgeOverride}</span>
        ) : null}
      </div>
      <p className="text-muted-foreground mt-1 text-sm text-pretty">{plan.note}</p>
      <div className="mt-10">
        {priceSlot ?? (
          <p className="flex items-baseline gap-2">
            <span className="text-2xl tabular-nums">{plan.price}</span>
            {plan.unit ? <span className="text-muted-foreground text-sm">{plan.unit}</span> : null}
          </p>
        )}
      </div>
      <div className="mt-6 w-full">{action}</div>
      <div aria-hidden className="mt-10 border-t border-dashed" />
      {includedLabel ? <p className="text-muted-foreground mt-8 text-sm">{includedLabel}</p> : null}
      <ul className="text-foreground mt-4 flex flex-col gap-3.5 text-sm">
        {plan.features.map((feature) => (
          <li key={feature} className="flex items-start gap-3">
            <SolidCheckIcon className="text-ring mt-0.5" />
            <span className="text-pretty">{feature}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
