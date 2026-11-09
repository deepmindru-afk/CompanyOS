'use client';

import { ArrowLeftIcon, MagnifyingGlassIcon, type Icon } from '@phosphor-icons/react';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

import { useTranslations } from '../../i18n';
import { useIsMobile } from '../../internal/hooks';
import { uiRoutes } from '../../lib/routes';
import { cn } from '../../lib/utils';
import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '../../primitives/input-group';
import { Skeleton } from '../../primitives/skeleton';
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '../../primitives/sidebar';
import {
  UiLink as Link,
  useUiPathname,
  useUiSearchParams,
  useUiShallowNavigate,
} from '../../providers/ui-provider';
import { parseProjectAdminSection } from '../../customize/project-settings/project-admin-sections';
import {
  useWorkspaceSettingsRailStore,
  type WorkspaceSettingsRail,
  type WorkspaceSettingsRailGroup,
} from '../../internal/stores/workspace-settings-rail-store';
import {
  groupSettingsResults,
  searchSettings,
  settingsSearchHref,
  type SettingsSearchResult,
  type SettingsSearchSection,
} from '../admin/settings-search';

/**
 * The project sidebar, drilled into Workspace settings. Back takes the slot of
 * New session and returns to the page the person came from. Under it, a
 * search field over every section and the tabs, cards and rows inside them
 * (`settings-search.ts`), then the settings groups that
 * `ProjectAdminDashboard` publishes. The page decides who sees which row;
 * this view draws them, and the search only finds what the rows offer.
 */
export function WorkspaceSettingsSidebarNav({
  projectId,
  shown,
  onNavigate,
}: {
  projectId: string;
  /**
   * The layer is on screen. Hidden, its links do not prefetch: under reduced
   * motion the hidden layer only fades, so it stays inside the viewport.
   */
  shown: boolean;
  /** Called after any row click (mobile closes the sheet). */
  onNavigate: () => void;
}) {
  const tCommon = useTranslations('common');
  const tSettings = useTranslations('workspaces.settings');
  const rail = useWorkspaceSettingsRailStore((s) => (s.rail?.projectId === projectId ? s.rail : null));
  const returnTo = useWorkspaceSettingsRailStore((s) => s.returnTo[projectId]);
  const backHref = returnTo ?? uiRoutes().project(projectId);
  // The section on screen is the URL's, parsed the way the page parses it,
  // so a rail kept from the last visit never highlights the section that
  // visit ended on. A segment the rail does not list (a legacy id, a link-out
  // row) falls back to the page's own pick.
  const pathname = useUiPathname();
  const fromUrl = shown ? parseProjectAdminSection(pathname?.match(/\/admin\/([^/?#]+)/)?.[1]) : null;
  const listed = !!fromUrl && !!rail?.groups.some((g) => g.rows.some((r) => r.key === fromUrl && !r.linkOut));
  const active = (listed ? fromUrl : undefined) ?? rail?.active;

  // The page's settings landmark moved here with the rail.
  return (
    <nav aria-label={tSettings('title')} className="flex h-full min-h-0 flex-col space-y-2">
      <SidebarGroup className="py-0">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild className="text-sidebar-foreground">
              <Link href={backHref} prefetch={shown} onClick={onNavigate}>
                <span className="shrink-0">
                  <ArrowLeftIcon className="cn-rtl-flip" />
                </span>
                <span>{tCommon('back')}</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroup>

      {rail ? (
        <SettingsSearch projectId={projectId} rail={rail} active={active} shown={shown} onNavigate={onNavigate} />
      ) : (
        <div className="min-h-0 flex-1">
          <RailSkeleton />
        </div>
      )}

      {rail?.footer ? (
        // Help sits under the groups, outside the scrolling list, behind the
        // page rail's hairline: it must not read as a row of the last group.
        <div className="border-sidebar-border shrink-0 border-t">
          <RailGroup group={rail.footer} active={active} prefetch={shown} onNavigate={onNavigate} />
        </div>
      ) : null}
    </nav>
  );
}

const LIST_SCROLL_CLASS =
  'min-h-0 flex-1 [scrollbar-width:none] overflow-y-auto [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden';

/**
 * The search field and what sits under it: the groups while the field is
 * empty, the ranked results while it holds a query. The field keeps focus;
 * ↑ ↓ move the selected result, Enter opens it, Escape clears the field.
 */
/**
 * The settings search query in the URL. Opening a result keeps the query: the
 * result's link carries it, so the page it opens shows the same results, and
 * a reload or a remount of the rail reads it back.
 */
const SEARCH_PARAM = 'settings_q';

/** `href` with the settings query set, or removed when `query` is empty. */
export function withSettingsQuery(href: string, query: string): string {
  const [rest, hash] = href.split('#');
  const [path, existing = ''] = rest.split('?');
  const params = new URLSearchParams(existing);
  if (query.trim()) params.set(SEARCH_PARAM, query);
  else params.delete(SEARCH_PARAM);
  const search = params.toString();
  return `${path}${search ? `?${search}` : ''}${hash !== undefined ? `#${hash}` : ''}`;
}

/**
 * Whether a debounced write may still land: only on the page (path and query)
 * it started from. Any move inside the debounce came from elsewhere (Back or
 * Forward, a result link carrying a newer query) and wins, so the write is
 * dropped. Comparing the query alone is not enough: Back can restore a page
 * that holds the same query on another path.
 */
export function settingsQueryWriteStillValid(current: string, startedFrom: string): boolean {
  return current === startedFrom;
}

/**
 * The query the field shows after a dropped write: the one in the URL now.
 * The page moved under the field (Back, Forward, a link), possibly to an entry
 * that differs only in another param, so the field follows the URL.
 */
export function settingsQueryAfterDroppedWrite(locationSearch: string): string {
  return new URLSearchParams(locationSearch).get(SEARCH_PARAM) ?? '';
}

function SettingsSearch({
  projectId,
  rail,
  active,
  shown,
  onNavigate,
}: {
  projectId: string;
  rail: WorkspaceSettingsRail;
  active: string | undefined;
  shown: boolean;
  onNavigate: () => void;
}) {
  const tSettings = useTranslations('workspaces.settings');
  const setPendingFind = useWorkspaceSettingsRailStore((s) => s.setPendingFind);
  const searchParams = useUiSearchParams();
  const pathname = useUiPathname();
  const shallowNavigate = useUiShallowNavigate();
  const [query, setQuery] = useState(() => searchParams.get(SEARCH_PARAM) ?? '');
  // `null`: no row picked by hand yet, so Enter opens the best match.
  const [cursor, setCursor] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const isMobile = useIsMobile();

  // Opening settings puts the cursor in the search field, so a person can type
  // where they want to go. Only on the way in (or a page load into settings),
  // never on a move between sections. Not on a phone: the keyboard would cover
  // the sheet. `preventScroll`: the layer is still sliding in.
  const wasShown = useRef(false);
  useEffect(() => {
    if (shown && !wasShown.current && !isMobile) inputRef.current?.focus({ preventScroll: true });
    wasShown.current = shown;
  }, [shown, isMobile]);
  const listId = useId();

  // The URL follows the field, debounced 250 ms after the last keystroke,
  // replacing the entry so typing adds no history. A location is its path and
  // query; `written` is the one the field last wrote. Any other location
  // change came from elsewhere (Back, Forward, a result link, a pasted link)
  // and puts its query in the field. Path matters: Back can restore a page
  // that holds the same query on another path.
  const urlQuery = searchParams.get(SEARCH_PARAM) ?? '';
  const location = `${pathname}|${urlQuery}`;
  const [written, setWritten] = useState(location);
  const [seenLocation, setSeenLocation] = useState(location);
  if (location !== seenLocation) {
    setSeenLocation(location);
    if (location !== written) {
      setWritten(location);
      setQuery(urlQuery);
      setCursor(null);
    }
  }
  const writeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(writeTimer.current), []);
  const writeQuery = (next: string, delayMs: number) => {
    clearTimeout(writeTimer.current);
    const value = next.trim() ? next : '';
    const here = () => `${window.location.pathname}${window.location.search}`;
    const startedFrom = here();
    const write = () => {
      if (!settingsQueryWriteStillValid(here(), startedFrom)) {
        const restored = settingsQueryAfterDroppedWrite(window.location.search);
        setWritten(`${window.location.pathname}|${restored}`);
        setQuery(restored);
        setCursor(null);
        return;
      }
      // The guard proved the page has not moved, so `pathname` is still it.
      setWritten(`${pathname}|${value}`);
      const { search, hash } = window.location;
      shallowNavigate(withSettingsQuery(`${window.location.pathname}${search}${hash}`, value), {
        replace: true,
      });
    };
    if (delayMs === 0) write();
    else writeTimer.current = setTimeout(write, delayMs);
  };

  // Every section the caller may open, in rail order, with its glyph.
  const { sections, icons } = useMemo(() => {
    const rows = [...rail.groups, ...(rail.footer ? [rail.footer] : [])]
      .flatMap((group) => group.rows)
      .filter((row) => !row.linkOut);
    return {
      sections: rows.map((row): SettingsSearchSection => ({
        key: row.key,
        label: row.label,
        href: row.href,
      })),
      icons: new Map<string, Icon>(rows.map((row) => [row.key, row.icon])),
    };
  }, [rail]);
  const results = useMemo(() => (query.trim() ? searchSettings(query, sections) : null), [query, sections]);
  // One keyboard order for every layout: each section, then its matches.
  const { groups, items } = useMemo(() => {
    const grouped = results ? groupSettingsResults(results) : [];
    const flat: SearchItem[] = grouped.flatMap((group) => [
      {
        key: `section:${group.section.key}`,
        href: withSettingsQuery(group.section.href, query),
        section: group.section,
      },
      ...group.children.map((result) => ({
        key: result.id,
        href: withSettingsQuery(settingsSearchHref(result), query),
        section: group.section,
        result,
      })),
    ]);
    return { groups: grouped, items: flat };
  }, [results, query]);
  const indexOf = useMemo(() => new Map(items.map((item, index) => [item.key, index])), [items]);
  // The best match leads, not the first row: a section that heads its group
  // only to hold a match (it did not match itself) is not what Enter opens.
  const best = results?.[0];
  const bestIndex = best ? (indexOf.get(best.entry ? best.id : `section:${best.section.key}`) ?? 0) : 0;
  const selected = items.length > 0 ? Math.min(cursor ?? bestIndex, items.length - 1) : 0;

  const reset = () => {
    setQuery('');
    setCursor(null);
    writeQuery('', 0);
  };

  const open = (item: SearchItem) => {
    const entry = item.result?.entry;
    const find = entry && entry.find !== null ? (entry.find ?? entry.label) : null;
    setPendingFind(find ? { projectId, section: item.section.key, text: find } : null);
    // The query stays: the next result is one click away.
    setCursor(null);
    onNavigate();
  };

  // The row on screen for an index (each picker layout renders its own copy).
  const rowAt = (index: number) =>
    [...(listRef.current?.querySelectorAll<HTMLElement>(`[data-index="${index}"]`) ?? [])].find(
      (element) => element.getClientRects().length > 0,
    );

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      if (!query) return;
      event.preventDefault();
      reset();
      return;
    }
    if (items.length === 0) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = (selected + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      setCursor(next);
      rowAt(next)?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter') {
      event.preventDefault();
      // The row's own link navigates, so the host router and the drill see one click.
      rowAt(selected)?.querySelector<HTMLAnchorElement>('a')?.click();
    }
  };

  const rowProps = (item: SearchItem) => {
    const index = indexOf.get(item.key) ?? 0;
    return {
      item,
      index,
      selected: index === selected,
      onOpen: open,
      onHover: () => setCursor(index),
    };
  };
  const glyph = (key: string): Icon => icons.get(key) ?? MagnifyingGlassIcon;

  return (
    <>
      <div className="shrink-0 px-2">
        <InputGroupSearch>
          <InputGroupSearchIcon>
            <MagnifyingGlassIcon />
          </InputGroupSearchIcon>
          <InputGroupSearchInput
            type="text"
            size="xs"
            className="pr-9 text-sm"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setCursor(null);
              writeQuery(event.target.value, 250);
            }}
            ref={inputRef}
            onKeyDown={onKeyDown}
            placeholder={tSettings('searchPlaceholder')}
            aria-label={tSettings('searchPlaceholder')}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={items.length > 0}
            aria-controls={results ? listId : undefined}
          />
          {query ? (
            <InputGroupSearchClear
              className="opacity-100"
              onClick={() => {
                reset();
                inputRef.current?.focus();
              }}
            />
          ) : null}
        </InputGroupSearch>
      </div>

      {results ? (
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={tSettings('searchPlaceholder')}
          className={LIST_SCROLL_CLASS}
        >
          {items.length === 0 ? (
            <p role="status" className="text-muted-foreground px-4 py-2 text-sm">
              {tSettings('searchNoResults')}
            </p>
          ) : (
            // Each section, its matches under it on the session list's trunk:
            // where a match lives reads from the tree, not from a label
            // repeated on every row.
            groups.map((group) => {
              const Glyph = glyph(group.section.key);
              const section = items[indexOf.get(`section:${group.section.key}`) ?? 0]!;
              return (
                <SidebarGroup key={group.section.key} className="py-1">
                  <SidebarMenu className="gap-0">
                    <ResultRow {...rowProps(section)}>
                      <span className="shrink-0">
                        <Glyph />
                      </span>
                      <span className="truncate">{group.section.label}</span>
                    </ResultRow>
                    {group.children.length > 0 ? (
                      <li role="none" style={{ marginLeft: TRUNK_X }}>
                        <ul role="group" className="flex flex-col">
                          {group.children.map((result, i) => (
                            <ResultRow
                              key={result.id}
                              {...rowProps(items[indexOf.get(result.id) ?? 0]!)}
                              branch={i < group.children.length - 1 ? 'continue' : 'end'}
                            >
                              <span className="truncate">{result.label}</span>
                            </ResultRow>
                          ))}
                        </ul>
                      </li>
                    ) : null}
                  </SidebarMenu>
                </SidebarGroup>
              );
            })
          )}
        </div>
      ) : (
        <div className={LIST_SCROLL_CLASS}>
          {rail.groups.map((group) => (
            <RailGroup key={group.id} group={group} active={active} prefetch={shown} onNavigate={onNavigate} />
          ))}
        </div>
      )}
    </>
  );
}

/** One selectable search row: a section, or a match inside one. */
interface SearchItem {
  key: string;
  href: string;
  section: SettingsSearchSection;
  /** Absent: the row is the section itself. */
  result?: SettingsSearchResult;
}

interface ResultRowProps {
  item: SearchItem;
  index: number;
  selected: boolean;
  onOpen: (item: SearchItem) => void;
  onHover: () => void;
}

// The trunk sits under the section glyph's centre: the row's `pl-2` plus half
// the `size-4` glyph, less half the 2px line.
const TRUNK_X = 'calc(var(--spacing) * 4 - 1px)';
// The elbow's reach, the session list's `SUB_AGENT_CONNECTOR_RUN`.
const BRANCH_RUN = 'calc(var(--spacing) * 3.5)';

function ResultRow({
  item,
  index,
  selected,
  onOpen,
  onHover,
  branch,
  className,
  children,
}: ResultRowProps & {
  branch?: 'continue' | 'end';
  className?: string;
  children: ReactNode;
}) {
  return (
    <SidebarMenuItem
      role="option"
      aria-selected={selected}
      data-index={index}
      className={cn(branch && 'relative')}
      style={branch ? { paddingLeft: BRANCH_RUN } : undefined}
    >
      {branch === 'continue' ? (
        <span aria-hidden className="border-border pointer-events-none absolute top-0 -bottom-px left-0 border-l-2" />
      ) : null}
      {branch ? (
        <span
          aria-hidden
          className="border-border pointer-events-none absolute top-0 left-0 h-4 rounded-bl-md border-b-2 border-l-2"
          style={{ width: BRANCH_RUN }}
        />
      ) : null}
      <SidebarMenuButton
        asChild
        // The selected result reads like a hovered row: one light fill.
        className={cn('text-sidebar-foreground', selected && 'bg-sidebar-accent', className)}
      >
        <Link href={item.href} prefetch={false} tabIndex={-1} onClick={() => onOpen(item)} onMouseMove={onHover}>
          {children}
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function RailGroup({
  group,
  active,
  prefetch,
  onNavigate,
}: {
  group: WorkspaceSettingsRailGroup;
  active: string | undefined;
  prefetch: boolean;
  onNavigate: () => void;
}) {
  return (
    <SidebarGroup className="py-1">
      {group.label ? <SidebarGroupLabel>{group.label}</SidebarGroupLabel> : null}
      <SidebarMenu>
        {group.rows.map((row) => {
          const Glyph = row.icon;
          return (
            <SidebarMenuItem key={row.key}>
              <SidebarMenuButton asChild isActive={row.key === active} className="text-sidebar-foreground">
                <Link
                  href={row.href}
                  prefetch={prefetch}
                  onClick={onNavigate}
                  aria-current={row.key === active ? 'page' : undefined}
                >
                  <span className="shrink-0">
                    <Glyph />
                  </span>
                  <span className="truncate">{row.label}</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          );
        })}
      </SidebarMenu>
    </SidebarGroup>
  );
}

/** Three labelled groups of icon + label rows, the loaded rail's shape. */
const SKELETON_GROUPS = [
  ['w-16', 'w-16', 'w-20', 'w-14'],
  ['w-14', 'w-20', 'w-12', 'w-16', 'w-12'],
  ['w-16', 'w-14', 'w-12'],
];

function RailSkeleton() {
  return (
    <div className="space-y-2" aria-hidden>
      {SKELETON_GROUPS.map((group, g) => (
        <div key={g} className="px-2 py-1">
          <Skeleton className="mx-2 my-2.5 h-3 w-20 rounded-sm py-0" />
          {group.map((width, i) => (
            <div key={i} className="flex h-8 items-center gap-2 px-2">
              <Skeleton className="size-4 shrink-0 rounded-sm py-0" />
              <Skeleton className={cn('h-3.5 rounded-sm py-0', width)} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
