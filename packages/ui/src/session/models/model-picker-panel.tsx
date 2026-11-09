'use client';

import type { FlatModel } from '@kortix/sdk/react';
import { StarIcon } from '@phosphor-icons/react';
import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

import { useTranslations } from '../../i18n';
import { MODEL_SELECTOR_PROVIDER_IDS, ProviderLogo } from '../../internal/lib/provider-branding';
import { cn } from '../../lib/utils';
import { SolidCheckIcon } from '../../internal/icons/solid-check-icon';
import { foreignDialogOpen } from '../../lib/z-stack';
import { Button } from '../../primitives/button';
import { CommandGroup, CommandInput, CommandItem, CommandList } from '../../primitives/command';
import Hint from '../../primitives/hint';
import { Kbd } from '../../primitives/kbd';
import Loading from '../../primitives/loading';
import { Tag } from '../../primitives/tag';
import { ReasoningEffortPane } from '../composer/reasoning-effort-selector';
import {
  initialPickerTab,
  modelItemValue,
  pickerGroupId,
  pickerGroupLabel,
  pickerTabOf,
  pickerTabs,
  splitModelLabel,
  type PickerTabId,
} from './model-grouping';
import { pickerModelName, shouldShowFreeTag } from './model-tags';

type ModelRef = { providerID: string; modelID: string };

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
const MOD = IS_MAC ? '⌘' : 'Ctrl';

/** Rows past the ninth have no digit to bind. */
const SHORTCUT_ROWS = 9;

const sameModel = (a: ModelRef | null | undefined, b: ModelRef) =>
  !!a && a.providerID === b.providerID && a.modelID === b.modelID;

export interface ModelPickerPanelProps {
  /** Every pickable model with no search applied: the rail and the tabs read these. */
  browseModels: FlatModel[];
  /**
   * Every model the member may pick, before the default-view curation. Favorites
   * read these: a model starred from a search stays in Favorites after the
   * search is cleared, though the default view would hide it.
   */
  pickableModels: FlatModel[];
  /** The models that match the search box. Used only while a search is typed. */
  searchModels: FlatModel[];
  search: string;
  onSearchChange: (value: string) => void;
  /** Controls at the right end of the search field (connect, manage). */
  searchRight?: ReactNode;
  selected: ModelRef | null;
  onPick: (model: FlatModel) => void;
  isFavorite: (model: ModelRef) => boolean;
  setFavorite: (model: ModelRef, on: boolean) => void;
  /** Models or entitlements still load. */
  loading: boolean;
  /** Nothing is pickable at all: the connect / upgrade empty state. */
  emptyState: ReactNode;
  /** The search matched nothing. */
  searchEmpty: ReactNode;
  /** Present when the member can connect a ChatGPT plan from here. */
  onConnectChatGpt?: () => void;
  /** Tag for a model whose provider is not connected. */
  connectLabel: string;
  /**
   * Another dialog opened (the command palette, a modal). The popover sits
   * above every top-level dialog, so it must close rather than float over it.
   */
  onForeignDialog?: () => void;
  /** Thinking effort for the selected model. Absent = no right pane. */
  effort?: {
    choices: readonly string[];
    selectedVariant: string | null | undefined;
    onChange: (variant: string | null) => void;
  };
}

/**
 * The composer's model popover: a rail on the left (Favorites, Kortix,
 * ChatGPT, then one tab per connected provider), the tab's models in the
 * middle, and the selected model's thinking effort on the right. Picking a
 * model or a level keeps it open; Escape or a click outside closes it.
 *
 * The star on a row is a FAVORITE (per browser, `useModelStore`), not the
 * workspace default: favorites collect in the first tab, the way a member
 * keeps the three models they switch between in one place. The workspace
 * default is set in Customize -> Models.
 *
 * Mod + 1..9 picks the visible row with that number while the popover is open.
 */
export function ModelPickerPanel({
  browseModels,
  pickableModels,
  searchModels,
  search,
  onSearchChange,
  searchRight,
  selected,
  onPick,
  isFavorite,
  setFavorite,
  loading,
  emptyState,
  searchEmpty,
  onConnectChatGpt,
  connectLabel,
  effort,
  onForeignDialog,
}: ModelPickerPanelProps) {
  const t = useTranslations('modelSelector');
  const tPooled = useTranslations('pooledSecrets');

  const favorites = useMemo(() => pickableModels.filter(isFavorite), [pickableModels, isFavorite]);
  const tabs = useMemo(
    () =>
      pickerTabs(browseModels, {
        canConnectChatGpt: !!onConnectChatGpt,
        providerOrder: MODEL_SELECTOR_PROVIDER_IDS,
      }),
    [browseModels, onConnectChatGpt],
  );
  const selectedModel = useMemo(
    () => (selected ? browseModels.find((m) => sameModel(selected, m)) : undefined),
    [browseModels, selected],
  );

  // The tab is fixed once the models are there, then moves only on a rail
  // click: picking or starring a model must not yank the rail elsewhere. The
  // popover unmounts this panel on close, so every open starts afresh.
  const [chosenTab, setChosenTab] = useState<PickerTabId | null>(null);
  const openingTab = initialPickerTab({
    tabs,
    selected: selectedModel ?? null,
    selectedIsFavorite: !!selectedModel && isFavorite(selectedModel),
    hasFavorites: favorites.length > 0,
  });
  // Set during render (React's "adjust state on a prop change" pattern): the
  // first render with models pins the tab, before anything can move it.
  if (chosenTab === null && !loading && browseModels.length > 0) setChosenTab(openingTab);
  const tab = chosenTab && tabs.includes(chosenTab) ? chosenTab : openingTab;
  const searching = search.trim().length > 0;

  // Mounted only while the popover is open, so this watches exactly then.
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!onForeignDialog) return;
    const check = () => {
      if (foreignDialogOpen(rootRef.current)) onForeignDialog();
    };
    const observer = new MutationObserver(check);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-state'],
    });
    return () => observer.disconnect();
  }, [onForeignDialog]);

  const rows = useMemo(() => {
    if (searching) return searchModels;
    if (tab === 'favorites') return favorites;
    return browseModels.filter((m) => pickerTabOf(m) === tab);
  }, [searching, searchModels, tab, favorites, browseModels]);

  const sections = useMemo(() => [{ id: searching ? 'search' : tab, models: rows }], [searching, tab, rows]);
  const ordered = useMemo(() => sections.flatMap((s) => s.models), [sections]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!(IS_MAC ? event.metaKey : event.ctrlKey) || event.altKey || event.shiftKey) return;
    if (!/^[1-9]$/.test(event.key)) return;
    const model = ordered[Number(event.key) - 1];
    if (!model) return;
    event.preventDefault();
    event.stopPropagation();
    onPick(model);
  };

  const tabLabel = (id: PickerTabId) => {
    if (id === 'favorites') return t('favorites');
    if (id === 'kortix') return 'Kortix';
    if (id === 'chatgpt') return 'ChatGPT';
    const sample = browseModels.find((m) => pickerTabOf(m) === id);
    return sample ? pickerGroupLabel(id, sample) : id;
  };

  const tabIcon = (id: PickerTabId) => {
    // One size for every rail glyph: the star, the Kortix mark, each provider.
    if (id === 'favorites') return <StarIcon weight="fill" className="text-kortix-orange size-4.5" />;
    return (
      <ProviderLogo
        providerID={id === 'chatgpt' ? 'codex' : id}
        name={tabLabel(id)}
        size="xs"
        className="size-4.5"
      />
    );
  };

  let body: ReactNode;
  if (loading) {
    body = (
      <div className="flex h-full items-center justify-center" role="status" aria-label={t('loading')}>
        <Loading className="text-muted-foreground size-4 shrink-0" />
      </div>
    );
  } else if (browseModels.length === 0 && !searching) {
    body = emptyState;
  } else if (searching && rows.length === 0) {
    body = searchEmpty;
  } else if (rows.length === 0 && tab === 'favorites') {
    body = <p className="text-muted-foreground px-3 py-6 text-center text-sm">{t('favoritesEmpty')}</p>;
  } else if (rows.length === 0 && tab === 'chatgpt' && onConnectChatGpt) {
    body = (
      <div className="flex justify-center px-3 py-6">
        <Button type="button" size="sm" variant="outline" onClick={onConnectChatGpt}>
          {tPooled('connectChatGpt')}
        </Button>
      </div>
    );
  } else {
    let index = 0;
    body = sections.map((section) => (
      <Fragment key={section.id}>
        <CommandGroup forceMount>
          {section.models.map((model) => {
            index += 1;
            return (
              <PickerRow
                key={`${model.providerID}:${model.modelID}`}
                model={model}
                isSelected={sameModel(selected, model)}
                favorite={isFavorite(model)}
                onToggleFavorite={(on) => setFavorite(model, on)}
                onSelect={() => onPick(model)}
                shortcut={index <= SHORTCUT_ROWS ? index : null}
                connectLabel={connectLabel}
              />
            );
          })}
        </CommandGroup>
      </Fragment>
    ));
  }

  return (
    // `bg-surface`: a hair below the white canvas (#fcfcfc light), so the
    // popover reads as a surface of its own; `card` (#f4f4f4) was too dark.
    // It covers the `Command` root's `bg-popover`, which matches the page.
    <div ref={rootRef} className="bg-surface flex min-h-0 flex-col sm:flex-row" onKeyDown={onKeyDown}>
      <div className="flex h-[min(22rem,55vh)] min-w-0 flex-1">
        <div
          role="tablist"
          aria-label={t('groups')}
          aria-orientation="vertical"
          className="flex w-12 shrink-0 flex-col items-center gap-1 overflow-y-auto border-r py-2"
        >
          {tabs.map((id) => {
            const active = !searching && id === tab;
            return (
              <Hint key={id} label={tabLabel(id)} side="left" className="z-50">
                <button
                  type="button"
                  role="tab"
                  aria-selected={active}
                  aria-label={tabLabel(id)}
                  onClick={() => {
                    setChosenTab(id);
                    if (searching) onSearchChange('');
                  }}
                  onKeyDown={keepKeyOnButton}
                  className={cn(
                    'text-muted-foreground flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-md outline-none',
                    'hover:bg-hover hover:text-foreground focus-visible:ring-kortix-base focus-visible:ring-2',
                    active && 'bg-active text-foreground',
                  )}
                >
                  {tabIcon(id)}
                </button>
              </Hint>
            );
          })}
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          <CommandInput
            compact
            placeholder={t('search')}
            value={search}
            onValueChange={onSearchChange}
            rightElement={searchRight}
          />
          <CommandList className="max-h-none min-h-0 flex-1">{body}</CommandList>
        </div>
      </div>

      {effort && effort.choices.length > 0 ? (
        <ReasoningEffortPane
          title={t('thinking')}
          choices={effort.choices}
          selectedVariant={effort.selectedVariant}
          onVariantChange={effort.onChange}
          className="border-t sm:w-44 sm:shrink-0 sm:border-t-0 sm:border-l"
        />
      ) : null}
    </div>
  );
}

/**
 * Enter and Space activate the focused button. cmdk handles both on its root
 * and would select the highlighted model row instead, so they stop here; the
 * browser's own activation still runs. Escape and Mod+digit still bubble.
 */
function keepKeyOnButton(event: KeyboardEvent<HTMLButtonElement>) {
  if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
}

function PickerRow({
  model,
  isSelected,
  favorite,
  onToggleFavorite,
  onSelect,
  shortcut,
  connectLabel,
}: {
  model: FlatModel;
  isSelected: boolean;
  favorite: boolean;
  onToggleFavorite: (on: boolean) => void;
  onSelect: () => void;
  shortcut: number | null;
  connectLabel: string;
}) {
  const t = useTranslations('modelSelector');
  const unavailable = model.available === false;
  const groupID = pickerGroupId(model);
  const { lead, trail } = splitModelLabel(pickerModelName(model));

  return (
    <CommandItem
      value={modelItemValue('model', model)}
      title={model.modelID}
      onSelect={onSelect}
      className={cn(
        'group h-9 gap-2',
        // `--accent` equals the popover surface in dark mode; see ModelRow.
        'hover:bg-hover [&:not([data-nav=pointer]_*)]:data-[selected=true]:bg-hover',
        isSelected && 'bg-active [&:not([data-nav=pointer]_*)]:data-[selected=true]:bg-active',
      )}
    >
      <ProviderLogo
        providerID={groupID}
        name={pickerGroupLabel(groupID, model)}
        size="xs"
        className="size-4.5"
      />
      <span className={cn('min-w-0 truncate leading-tight', unavailable && 'opacity-60')}>
        <span className="text-foreground font-medium">{lead}</span>
        {trail ? <span className="text-muted-foreground font-normal"> {trail}</span> : null}
      </span>
      {isSelected ? <SolidCheckIcon className="text-ring size-3.5 shrink-0" /> : null}
      <span className="flex-1" />

      {unavailable ? (
        <Tag>{connectLabel}</Tag>
      ) : shouldShowFreeTag(model) ? (
        <Tag variant="free">{t('free')}</Tag>
      ) : null}

      <button
        type="button"
        aria-label={
          favorite
            ? t('removeFavorite', { model: model.modelName })
            : t('addFavorite', { model: model.modelName })
        }
        aria-pressed={favorite}
        // cmdk selects on the item's click: a star must not also switch models.
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={keepKeyOnButton}
        onClick={(e) => {
          e.stopPropagation();
          onToggleFavorite(!favorite);
        }}
        className={cn(
          'flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md',
          'text-muted-foreground hover:text-kortix-orange hover:bg-foreground/10',
          'duration-normal transition-[color,background-color,transform] ease-out motion-safe:active:scale-[0.96]',
          'focus-visible:ring-kortix-base focus-visible:ring-2 focus-visible:outline-none',
          // Hidden means unclickable too; a favorite keeps its star at rest.
          favorite
            ? 'text-kortix-orange hover:text-kortix-orange'
            : 'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-data-[selected=true]:pointer-events-auto group-data-[selected=true]:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100',
        )}
      >
        {/* The colour sits on the svg: CommandItem paints every svg that has no
            `text-*` class of its own muted, over the button's colour. */}
        <StarIcon
          weight={favorite ? 'fill' : 'regular'}
          className={cn('size-3.5', favorite ? 'text-kortix-orange' : 'text-current')}
        />
      </button>

      {shortcut ? (
        <Kbd className="bg-muted h-5 w-auto min-w-7 shrink-0 tabular-nums">
          {MOD}
          {shortcut}
        </Kbd>
      ) : (
        <span className="w-7 shrink-0" />
      )}
    </CommandItem>
  );
}
