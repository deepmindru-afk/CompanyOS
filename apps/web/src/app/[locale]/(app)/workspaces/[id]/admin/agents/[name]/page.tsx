'use client';

import dynamic from 'next/dynamic';
import { useParams } from 'next/navigation';

import { AgentPage } from '@kortix/ui/customize/agents/agent-page';

import { decodeSegment, ProjectAdminRoute } from '@/features/workspace/project-admin/project-admin-route';

const AppsView = dynamic(() => import('@/features/apps/apps-view').then((m) => m.AppsView), {
  ssr: false,
});

/**
 * /workspaces/[id]/admin/agents/[name] — one agent, in the Workspace settings
 * pane under Agents. It moved here from `/customize/agents/<name>` on
 * 2026-11-08, when Customize became this panel; the old path redirects.
 */
export default function ProjectAdminAgentPage() {
  const { id: projectId, name } = useParams<{ id: string; name: string }>();
  const agentName = decodeSegment(name);
  return (
    <ProjectAdminRoute
      projectId={projectId}
      section="agents"
      content={
        <AgentPage
          key={agentName}
          projectId={projectId}
          agentName={agentName}
          renderApps={({ agentName: agent, grant, needsAppRead }) => (
            <AppsView projectId={projectId} surface={{ kind: 'agent', agentName: agent }} grant={grant} needsAppRead={needsAppRead} />
          )}
        />
      }
    />
  );
}
