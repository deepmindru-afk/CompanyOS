'use client';

import { Button } from '@kortix/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@kortix/ui/popover';
import { errorToast } from '@kortix/ui/toast';
import { Tooltip, TooltipContent, TooltipTrigger } from '@kortix/ui/tooltip';
import { useDismissDriveConflict, useDriveConflicts } from '@kortix/ui/files';
import { useFormatter, useNow, useTranslations } from '@/i18n/use-translations';
import { FolderOpenIcon, XIcon } from '@phosphor-icons/react';
import { useRef, useState, type ReactNode } from 'react';

import { parentDrivePath } from './drive-explorer-source';

/** `/a/b/report (conflict …).txt` → name and the folder that holds it. */
function splitConflictPath(path: string): { name: string; folder: string } {
  const folder = parentDrivePath(path);
  const name = path.slice(path.lastIndexOf('/') + 1) || path;
  return { name, folder };
}

/** A row action: an icon button that names itself in a tooltip. */
function RowAction({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="text-muted-foreground"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Conflict copies in the folders the caller can see: two writers changed the
 * same file at once and both versions were kept. A small button sits at the
 * bottom right of Files; clicking it opens a popover listing each copy, with
 * "open folder" and "dismiss" (the copy stays; the API refuses a dismiss
 * without write access there). Renders nothing without conflicts.
 *
 * Must be placed inside a `relative` container: it positions itself at the
 * bottom right of it.
 */
export function DriveConflictsBar({
  driveId,
  onOpenFolder,
}: {
  driveId: string;
  onOpenFolder: (path: string) => void;
}) {
  const t = useTranslations('drives');
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const conflicts = useDriveConflicts(driveId);
  const dismiss = useDismissDriveConflict();
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const list = conflicts.data ?? [];
  if (list.length === 0) return null;

  return (
    <div className="absolute right-3 bottom-3 z-20">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger variant="outline" size="sm" className="text-xs">
          <span aria-hidden className="bg-kortix-orange size-1.5 shrink-0 rounded-full" />
          <span className="font-medium tabular-nums">{t('conflictCount', { count: list.length })}</span>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="end"
          sideOffset={8}
          ref={panelRef}
          tabIndex={-1}
          // Focus the panel, not its first row action: that would open the
          // action's tooltip on every open and spend the first Escape on it.
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            panelRef.current?.focus();
          }}
          aria-label={t('conflictsTitle', { count: list.length })}
          className="w-[min(22rem,calc(100vw-1.5rem))] p-0"
        >
          <div className="px-3 pt-3 pb-2">
            <p className="text-sm font-medium">{t('conflictsTitle', { count: list.length })}</p>
            <p className="text-muted-foreground mt-0.5 text-xs text-pretty">{t('conflictsDescription')}</p>
          </div>
          <ul className="max-h-64 overflow-y-auto px-1 pb-1">
            {list.map((conflict) => {
              const { name, folder } = splitConflictPath(conflict.path);
              return (
                <li
                  key={conflict.conflictId}
                  className="group hover:bg-foreground/5 focus-within:bg-foreground/5 flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5"
                >
                  <div className="min-w-0 flex-1" title={conflict.path}>
                    <p className="truncate text-xs font-medium">{name}</p>
                    <p className="text-muted-foreground truncate text-xs">
                      {folder}
                      <span aria-hidden> · </span>
                      {format.relativeTime(new Date(conflict.detectedAt), now)}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
                    <RowAction
                      label={t('conflictOpenFolder')}
                      onClick={() => {
                        setOpen(false);
                        onOpenFolder(parentDrivePath(conflict.path));
                      }}
                    >
                      <FolderOpenIcon className="size-3.5" />
                    </RowAction>
                    <RowAction
                      label={t('conflictDismiss')}
                      disabled={dismiss.isPending}
                      onClick={() =>
                        dismiss.mutate(
                          { driveId, conflictId: conflict.conflictId },
                          { onError: () => errorToast(t('conflictDismissFailed')) },
                        )
                      }
                    >
                      <XIcon className="size-3.5" />
                    </RowAction>
                  </div>
                </li>
              );
            })}
          </ul>
        </PopoverContent>
      </Popover>
    </div>
  );
}
