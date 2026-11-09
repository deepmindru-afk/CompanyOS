'use client';

import { uiRoutes } from '../../lib/routes';
import { useUiViewerId } from '../../providers/ui-provider';
import { useNotificationInbox } from '@kortix/sdk/react';
import { useReviewNeedsYouCount } from '../hooks/use-review-session-summary';
import { tabUnreadCount } from './notification-rows';

/**
 * The Inbox entry point (KRTX-1742) in the workspace menu: the Inbox page's
 * href, its count, and whether something waits on the person ("needs you").
 * The Inbox holds Review too (2026-11-08), so the count is the unread
 * notifications (99+ at most) plus what waits in this workspace's Review,
 * and "needs you" is an unread question, permission request or failure, or
 * any Review item that waits. The notifications are the inbox
 * `NotificationHost` polls; the Review number reads the review summary and
 * asks the session list already polls. `href` is null when the host serves
 * no Inbox page.
 */
export function useInboxSummary(projectId: string): {
  href: string | null;
  count: number;
  needsYou: boolean;
} {
  const viewerId = useUiViewerId();
  const inbox = useNotificationInbox({ userId: viewerId });
  const review = useReviewNeedsYouCount(projectId);
  const href = uiRoutes().inbox?.(projectId) ?? null;
  return {
    href,
    count: href ? inbox.unreadCount + review : 0,
    needsYou: !!href && (review > 0 || tabUnreadCount(inbox.data?.notifications ?? [], 'needs') > 0),
  };
}
