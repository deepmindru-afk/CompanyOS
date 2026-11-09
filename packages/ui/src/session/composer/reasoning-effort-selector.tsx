'use client';

/**
 * Thinking-effort control for the session chat composer — the ONE effort knob.
 *
 * It sets the session's model **variant** (`local.model.variant`, sent as
 * `variant` on every prompt), never a project setting. The sandbox publishes
 * the variant ids on the `kortix` provider and the harness sends
 * `reasoning_effort` in the body; the gateway forwards it per upstream family
 * and REFUSES it (400) for a family it cannot map, instead of stripping it.
 *
 * The list is `Object.keys(model.variants)` from the picker source the
 * composer already holds — the runtime's own list once the sandbox is up, the
 * ids derived from the API's live `reasoning_options` before that (see
 * `nativeProviderListFromCatalog` / `projectLlmCatalogToProviderList` in the
 * SDK). Never a hardcoded ladder, never the web's baked catalog seed.
 *
 * "Auto" clears the variant: the model's own default applies, and the
 * project's Generation defaults (Customize → Gateway → Routing) fill the
 * field the request left unset.
 *
 * History: this used to write the project-level routing policy
 * (`model_generation_config`) from the composer, was hidden off-gateway
 * (#6872), and read its values from a hand-regenerated catalog seed that sat
 * 38 days stale (#6879). Two knobs by mode, three catalog copies. Now one.
 */

import { useTranslations } from '../../i18n';
import { useCallback, useState } from 'react';

import { Button } from '../../primitives/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '../../primitives/dropdown-menu';
import { cn } from '../../lib/utils';
import { SolidCheckIcon } from '../../internal/icons/solid-check-icon';
import {
  CaretDownIcon,
  CellSignalFullIcon,
  CellSignalHighIcon,
  CellSignalLowIcon,
  CellSignalMediumIcon,
  CellSignalNoneIcon,
  GaugeIcon,
} from '@phosphor-icons/react';

/**
 * The value `onVariantChange(null)` means: no variant, let the model decide.
 * A sentinel is needed because Radix's radio group addresses items by string
 * and cannot carry `null`.
 */
const AUTO = '__auto__';

/**
 * Show/hide + the choices, as a pure function so the rule is testable without
 * React: the control renders only when the selected model publishes at least
 * one variant AND the composer can apply one. Order and ids are the model's
 * own; duplicates (a runtime + catalog merge slip) collapse to one entry.
 */
export function reasoningEffortChoices(
  variants: readonly string[] | undefined,
  canApply: boolean,
): string[] {
  if (!canApply || !variants?.length) return [];
  return Array.from(new Set(variants.filter((v) => typeof v === 'string' && v.length > 0)));
}

/** `medium` → `Medium`. The catalog ships lowercase ids; the trigger and the
 *  menu should not. */
export function effortLabel(value: string): string {
  if (value === 'xhigh') return 'Extra high';
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * Cell-signal bars for effort — none → full ladder. Extra ladder steps
 * (`xhigh`, `max`) share Full; unknown ids fall back to Medium so a future
 * catalog value never renders without an icon.
 *
 * `null` (model decides, no variant) gets a Gauge icon instead of a
 * cell-signal step — it isn't a fixed point on the none→full ladder, it's the
 * dial that finds its own reading per turn.
 *
 * A switch that returns JSX (not a component reference) — assigning
 * `const Icon = map[value]` and then `<Icon />` trips the React Compiler's
 * "Cannot create components during render" rule.
 */
export function EffortIcon({ value, className }: { value: string | null; className?: string }) {
  switch (value) {
    case null:
    case 'auto':
      return <GaugeIcon className={className} />;
    case 'none':
      return <CellSignalNoneIcon className={className} weight="fill" />;
    case 'minimal':
    case 'low':
      return <CellSignalLowIcon className={className} weight="fill" />;
    case 'medium':
      return <CellSignalMediumIcon className={className} weight="fill" />;
    case 'high':
      return <CellSignalHighIcon className={className} weight="fill" />;
    case 'xhigh':
    case 'max':
    case 'full':
      return <CellSignalFullIcon className={className} weight="fill" />;
    default:
      return <CellSignalMediumIcon className={className} weight="fill" />;
  }
}

interface ReasoningEffortSelectorProps {
  /** The selected model's variant ids (`Object.keys(model.variants)`). */
  variants: readonly string[] | undefined;
  /** The session's current variant, or null = model default. */
  selectedVariant: string | null | undefined;
  /** Applies a variant to the session; absent = the composer cannot apply one
   *  (no runtime model store), which hides the control entirely. */
  onVariantChange?: (variant: string | null) => void;
  /**
   * Controlled open state — omit and the trigger owns it. Supplied by
   * `composer.tsx` so the `/` palette's "Set reasoning effort" row can open
   * this directly. Same controlled/uncontrolled rule as `ModelSelector`.
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/**
 * Thinking effort as its own composer-toolbar control, a peer of the model
 * pill, stating its value at rest. Renders NOTHING when the model publishes no
 * variants or the composer cannot apply one — a model without a knob never
 * grows dead chrome.
 *
 * A `DropdownMenu` rather than the `CommandPopover` the model and agent
 * pickers use: this is a fixed list of a handful of values with no search, no
 * grouping and no empty state, and `DropdownMenuRadioGroup` gives the
 * single-select semantics — roving focus, typeahead, `aria-checked` — for
 * free, where the command palette would need them re-implemented.
 */
export function ReasoningEffortSelector({
  variants,
  selectedVariant,
  onVariantChange,
  open: openProp,
  onOpenChange,
}: ReasoningEffortSelectorProps) {
  const t = useTranslations('threads');
  const choices = reasoningEffortChoices(variants, !!onVariantChange);

  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const isControlled = openProp !== undefined;
  const open = isControlled ? openProp : uncontrolledOpen;
  const setOpen = useCallback(
    (next: boolean) => {
      if (!isControlled) setUncontrolledOpen(next);
      onOpenChange?.(next);
    },
    [isControlled, onOpenChange],
  );

  const onValueChange = useCallback(
    (next: string) => onVariantChange?.(next === AUTO ? null : next),
    [onVariantChange],
  );

  if (choices.length === 0) return null;

  // A stale per-model pick (a variant the current list no longer carries)
  // reads as Auto rather than an unlabeled value; the next explicit choice
  // replaces it.
  const current = selectedVariant && choices.includes(selectedVariant) ? selectedVariant : null;

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={t('thinkingEffort')}
          className="text-muted-foreground gap-1.5 rounded-lg hit-area-y-3"
        >
          <EffortIcon value={current} className="size-4 shrink-0" />
          <span className="max-w-[7rem] truncate">{current ? effortLabel(current) : t('auto')}</span>
          <CaretDownIcon
            className={cn(
              'size-3 opacity-50 transition-transform duration-moderate ease-out',
              open && 'rotate-180',
            )}
          />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent side="top" align="start" className="min-w-[10rem]">
        <DropdownMenuRadioGroup value={current ?? AUTO} onValueChange={onValueChange}>
          {/* Auto is first and always present: it is the only way BACK to the
              model's own default once a variant is set, and without it the
              control would be a one-way door. */}
          <DropdownMenuRadioItem value={AUTO}>
            <EffortIcon value={null} className="size-4 shrink-0" />
            {t('auto')}
          </DropdownMenuRadioItem>
          {choices.map((value) => (
            <DropdownMenuRadioItem key={value} value={value}>
              <EffortIcon value={value} className="size-4 shrink-0" />
              {effortLabel(value)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface ReasoningEffortPaneProps {
  /** `reasoningEffortChoices(...)` for the selected model. Empty = render nothing. */
  choices: readonly string[];
  /** The session's current variant, or null = model default. */
  selectedVariant: string | null | undefined;
  onVariantChange: (variant: string | null) => void;
  /** The pane's heading. Defaults to "Thinking effort". */
  title?: string;
  className?: string;
}

/**
 * Thinking effort as the right-hand pane of the model popover: the merged
 * model + effort picker (`ModelSelector`'s `reasoning` prop). Same values,
 * same Auto-first rule and same stale-pick rule as the dropdown above.
 *
 * It sits inside cmdk's `Command` root, which handles Arrow keys and Enter on
 * every keydown that bubbles to it. The pane stops those keys so Enter on a
 * level never also selects the model row cmdk has highlighted; Escape still
 * bubbles so the popover closes.
 */
export function ReasoningEffortPane({
  choices,
  selectedVariant,
  onVariantChange,
  title,
  className,
}: ReasoningEffortPaneProps) {
  const t = useTranslations('threads');
  if (choices.length === 0) return null;

  const current = selectedVariant && choices.includes(selectedVariant) ? selectedVariant : null;
  const items: Array<{ value: string | null; label: string }> = [
    { value: null, label: t('auto') },
    ...choices.map((value) => ({ value, label: effortLabel(value) })),
  ];

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    // Escape closes the popover, Tab leaves the pane, and a modifier
    // combination (Mod+1..9 picks a model) belongs to the panel around it.
    if (event.key === 'Escape' || event.key === 'Tab') return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    event.stopPropagation();
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const radios = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
    );
    const index = radios.indexOf(document.activeElement as HTMLButtonElement);
    const step = event.key === 'ArrowDown' ? 1 : -1;
    radios[(index + step + radios.length) % radios.length]?.focus();
  };

  return (
    // The heading names the knob only: the model is the checked row beside it.
    <div className={cn('flex min-w-0 flex-col', className)}>
      <div className="text-muted-foreground flex h-9 shrink-0 items-center border-b px-3 text-sm">
        {title ?? t('thinkingEffort')}
      </div>
      <div
        role="radiogroup"
        aria-label={t('thinkingEffort')}
        onKeyDown={onKeyDown}
        className="flex flex-col gap-px p-1.5"
      >
        {items.map(({ value, label }) => {
          const checked = value === current;
          return (
            <button
              key={value ?? AUTO}
              type="button"
              role="radio"
              aria-checked={checked}
              tabIndex={checked ? 0 : -1}
              onClick={() => onVariantChange(value)}
              className={cn(
                'text-foreground flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-left text-sm outline-none',
                'hover:bg-hover focus-visible:bg-hover focus-visible:ring-kortix-base focus-visible:ring-2',
                checked && 'bg-active hover:bg-active',
              )}
            >
              <span className="min-w-0 flex-1 truncate">{label}</span>
              {checked ? <SolidCheckIcon className="text-ring size-4 shrink-0" /> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
