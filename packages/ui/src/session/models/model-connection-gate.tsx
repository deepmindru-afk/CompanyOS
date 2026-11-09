'use client';

import { ImageBrokenIcon } from '@phosphor-icons/react';
import { AnimatePresence, m, useReducedMotion } from 'motion/react';
import { useState, type ReactNode } from 'react';
import { useTranslations } from '../../i18n';

import { ConnectPlanRows } from './subscription-offer';

// Enter waits a beat (delay) so the composer paints first, then the bar slides
// out from under it — height opens the space while the strip translates down,
// same spring on both so they move as one surface. Exit runs faster than enter
// and slides back under.
const BAR_ENTER = { type: 'spring', duration: 0.5, bounce: 0, delay: 0.15 } as const;
const BAR_EXIT = { type: 'spring', duration: 0.35, bounce: 0 } as const;

/**
 * No model can run: the composer shows the same "Connect ChatGPT" and "Connect
 * Claude" rows the project home offers (`ConnectPlanRows`), a gap below the
 * composer, not dismissible. Sending is already disabled by `modelUnavailable`.
 *
 * It used to be a heading ("Connect a model to start"), two bordered tiles,
 * "Use an API key" and "Upgrade". On the project home it stacked on top of the
 * optional offer and read as a block. Other providers and API keys stay one
 * click away in the model picker and the provider dialog.
 *
 * `show` must only flip on settled data (see `entitlementsPending`).
 */
export function ModelConnectionBar({ show }: { show: boolean }) {
  return show ? <ConnectPlanRows dismissible={false} className="mt-4" /> : null;
}

/**
 * One line under the card when the selected model cannot read an attached image
 * (`modelRejectingAttachedImages`). Send is refused with the same words. The
 * composer never shows it beside `ModelConnectionBar`.
 */
export function ImagesUnsupportedBar({ modelName }: { modelName: string | null }) {
  const t = useTranslations('sessionUi.modelGate');
  // Keeps the last name through the exit animation, which runs after `modelName` clears.
  const [shownName, setShownName] = useState(modelName);
  if (modelName && modelName !== shownName) setShownName(modelName);

  return (
    <ComposerTray show={modelName !== null} trayKey="images-unsupported-bar">
      <div className="text-muted-foreground flex min-w-0 items-center gap-2 text-xs">
        <ImageBrokenIcon className="size-3.5 shrink-0" />
        <span className="truncate">
          {t('imagesUnsupported', { model: shownName ?? '' })}
          <span className="hidden sm:inline"> — {t('imagesUnsupportedHint')}</span>
        </span>
      </div>
    </ComposerTray>
  );
}

/**
 * A strip that hangs behind the card's bottom edge: rendered as the card's next
 * sibling, pulled up under it (`-mt-4` on the clipper, cancelled by `pt-4` on
 * the strip), so the card — `isolate z-10`, opaque — paints over the overlap.
 * `-mt-4` lives on the clipper, never on the strip: the clipper is
 * `overflow-hidden` for the height animation and would clip a negative margin
 * on its child.
 */
function ComposerTray({
  show,
  trayKey,
  children,
}: {
  show: boolean;
  trayKey: string;
  children: ReactNode;
}) {
  const reduceMotion = useReducedMotion();

  return (
    <AnimatePresence initial={false}>
      {show && (
        <m.div
          key={trayKey}
          initial={reduceMotion ? { opacity: 0 } : { height: 0 }}
          animate={
            reduceMotion
              ? { opacity: 1, transition: { duration: 0.2 } }
              : { height: 'auto', transition: BAR_ENTER }
          }
          exit={
            reduceMotion
              ? { opacity: 0, transition: { duration: 0.15 } }
              : { height: 0, transition: BAR_EXIT }
          }
          className="relative z-0 -mt-4 overflow-hidden"
        >
          <m.div
            initial={reduceMotion ? false : { y: '-100%' }}
            animate={reduceMotion ? undefined : { y: '0%', transition: BAR_ENTER }}
            exit={reduceMotion ? undefined : { y: '-100%', transition: BAR_EXIT }}
            // `border-t-0`: the card's own bottom border is the seam. Drawing
            // one here too would put a second hairline under a card that
            // already has one. `rounded-b-xl` matches the card's radius so
            // the two share one silhouette; the top corners are square
            // because they live behind the card and are never seen.
            className="border-border bg-muted rounded-b-xl border border-t-0 pt-4"
          >
            <div className="flex items-center justify-between gap-3 px-3 py-1.5">{children}</div>
          </m.div>
        </m.div>
      )}
    </AnimatePresence>
  );
}
