'use client';

import { useNotificationInbox } from '@kortix/sdk/react';

import { ReviewView } from '../../customize/sections/view/review-view';
import { useTranslations } from '../../i18n';
import { useReviewNeedsYouCount } from '../../internal/hooks/use-review-session-summary';
import { ProjectPageHeader } from '../../internal/layout/project-page-header';
import { NotificationInbox } from '../../internal/notifications/notification-inbox';
import { CountBadge } from '../../primitives/count-badge';
import { Tabs, TabsList, TabsTrigger } from '../../primitives/tabs';
import { useUiPathname, useUiRouter, useUiSearchParams, useUiViewerId } from '../../providers/ui-provider';

export type WorkspaceInboxView = 'review' | 'notifications';

/**
 * The tab a visit opens: the one `?view=` names; else Review when it holds an
 * item (`?id=`) or something waits there; else Notifications.
 */
export function workspaceInboxView(
  view: string | null,
  itemId: string | null,
  reviewNeedsYou: number,
): WorkspaceInboxView {
  if (view === 'review' || view === 'notifications') return view;
  return itemId || reviewNeedsYou > 0 ? 'review' : 'notifications';
}

/**
 * /workspaces/[id]/inbox — the one place for what waits on the person
 * (2026-11-08: "REVIEW & INBOX should be merged in 1"). Two tabs under one
 * header:
 *
 *  - **Review** — this workspace's Review Center: approvals, questions and
 *    change requests to act on. `?id=` opens one item, as `/review?id=` did.
 *  - **Notifications** — the person's notifications from every workspace.
 *
 * `/workspaces/<id>/review` redirects to `?view=review`. The workspace menu's
 * Inbox row counts both tabs (`useInboxSummary`).
 */
export function WorkspaceInbox({ projectId }: { projectId: string }) {
  const t = useTranslations('notifications');
  const router = useUiRouter();
  const pathname = useUiPathname();
  const searchParams = useUiSearchParams();
  const reviewNeedsYou = useReviewNeedsYouCount(projectId);
  const unread = useNotificationInbox({ userId: useUiViewerId() }).unreadCount;
  const view = workspaceInboxView(searchParams?.get('view') ?? null, searchParams?.get('id') ?? null, reviewNeedsYou);

  const select = (next: string) => {
    const query = new URLSearchParams(searchParams?.toString() ?? '');
    query.set('view', next);
    // An open Review item belongs to the Review tab.
    if (next !== 'review') query.delete('id');
    router.replace(`${pathname ?? ''}?${query.toString()}`);
  };

  return (
    // `h-svh`: nothing above this box has a definite height (as the Apps page).
    <div className="flex h-svh min-h-0 flex-col overflow-hidden">
      {/* The two tabs sit in the title bar beside "Inbox": each tab brings its
          own filters (Review: Needs you · Waiting · Done; Notifications: All ·
          Needs you · Done), so a second row of tabs above them would stack
          three controls. */}
      <ProjectPageHeader
        title={t('inbox.title')}
        titleAccessory={
          <Tabs value={view} onValueChange={select} className="ml-2">
            <TabsList size="xs" aria-label={t('inbox.viewLabel')}>
              <TabsTrigger value="review" className="gap-1.5" data-testid="inbox-view-review">
                {t('inbox.viewReview')}
                {reviewNeedsYou > 0 ? <CountBadge count={reviewNeedsYou} tone="waiting" /> : null}
              </TabsTrigger>
              <TabsTrigger value="notifications" className="gap-1.5" data-testid="inbox-view-notifications">
                {t('inbox.viewNotifications')}
                {unread > 0 ? <CountBadge count={unread} /> : null}
              </TabsTrigger>
            </TabsList>
          </Tabs>
        }
      />
      {view === 'review' ? (
        <div className="mx-auto flex min-h-0 w-full max-w-4xl flex-1 flex-col">
          <ReviewView projectId={projectId} />
        </div>
      ) : (
        <NotificationInbox bare />
      )}
    </div>
  );
}
