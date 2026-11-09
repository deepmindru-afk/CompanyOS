import { WorkspaceInbox } from '@kortix/ui/workspace/inbox/workspace-inbox';

/**
 * /workspaces/[id]/inbox — the Inbox beside the workspace sidebar, with two
 * tabs: Review (this workspace's approvals, questions and change requests)
 * and Notifications (the signed-in person's notifications from every
 * workspace). `/workspaces/[id]/review` redirects to `?view=review`. The
 * workspace menu's Inbox row opens it.
 */
export default async function WorkspaceInboxPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <WorkspaceInbox projectId={id} />;
}
