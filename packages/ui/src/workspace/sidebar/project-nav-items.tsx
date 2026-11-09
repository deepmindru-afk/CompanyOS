'use client';

import { ProjectAppsNavItem } from './footer/project-apps-nav';
import { ProjectGoalsNavItem } from './footer/project-goals-nav';
import { ProjectArtifactsNavItem } from './footer/project-artifacts-nav';
import { ProjectFilesNavItem } from './footer/project-files-nav';
import {
  CustomizeGlyph,
  useCapabilityAccess,
} from '../../internal/layout/project-settings-nav';
import { isProjectAdminPath, useOpenNewAgent } from '../../internal/layout/project-capability-nav';
import { PROJECT_ACTIONS } from '../../internal/lib/project-actions';
import { useProjectCan } from '../../internal/lib/use-project-can';
import { Button } from '../../primitives/button';
import Hint from '../../primitives/hint';
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from '../../primitives/sidebar';
import { useIsMobile } from '../../internal/hooks';
import { useTranslations } from '../../i18n';
import { PlusIcon } from '@phosphor-icons/react';
import { UiLink as Link, useUiPathname } from '../../providers/ui-provider';
import { adminPath } from '../../lib/routes';

/**
 * The nav rows under New session, in one fixed order. Each row applies its
 * own flag and permission gate and renders nothing when the project does not
 * offer it. Spaces are the channel sidebar under the `chat` flag
 * (project-spaces-nav.tsx).
 */
const NAV_ROWS = ['customize', 'files', 'apps', 'goals', 'artifacts'] as const;
type NavRowId = (typeof NAV_ROWS)[number];

export function ProjectNavItems({ projectId }: { projectId: string }) {
  return (
    <>
      {NAV_ROWS.map((id) => (
        <NavItem key={id} id={id} projectId={projectId} />
      ))}
    </>
  );
}

/**
 * Customize, for the people who may configure the project: one link into
 * Workspace settings, on Agents when the caller may read them (Customize is
 * agent-centric). Since 2026-11-08 Customize IS that panel, so there is no
 * disclosure here: the panel's rail lists Agents, Models, Skills and the
 * rest, and Review is part of the Inbox. On hover, the row's right edge
 * holds + (New agent). Absent when the caller may open no capability page.
 */
function CustomizeNavEntry({ projectId }: { projectId: string }) {
  const t = useTranslations('sidebar');
  const tTabs = useTranslations('agentEditor.tabs');
  const pathname = useUiPathname();
  const access = useCapabilityAccess(projectId);
  const canCreate = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_AGENT_WRITE).allowed === true;
  const openNewAgent = useOpenNewAgent();
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();

  if (!access.settled || access.tabs.length === 0) return null;
  const hasAgents = access.tabs.includes('agent');
  const close = () => {
    if (isMobile) setOpenMobile(false);
  };

  return (
    <SidebarMenuItem className="group/customize">
      <SidebarMenuButton asChild isActive={isProjectAdminPath(pathname)} className="text-sidebar-foreground pr-8">
        {/* Prefetched: the sidebar swaps to the panel's rail on the click,
            and the page should be there when the swap lands. */}
        <Link href={hasAgents ? adminPath(projectId, 'agents') : adminPath(projectId)} prefetch onClick={close}>
          <span className="shrink-0">
            <CustomizeGlyph />
          </span>
          <span className="truncate">{t('customize')}</span>
        </Link>
      </SidebarMenuButton>
      {hasAgents && canCreate && openNewAgent ? (
        <Hint side="top" label={tTabs('newAgent')}>
          <Button
            variant="secondary"
            size="icon-xs"
            type="button"
            aria-label={tTabs('newAgent')}
            className="absolute top-1/2 right-1 -translate-y-1/2 opacity-100 transition-opacity group-focus-within/customize:opacity-100 group-hover/customize:opacity-100 md:opacity-0"
            onClick={() => {
              close();
              openNewAgent();
            }}
          >
            <PlusIcon className="size-4" />
          </Button>
        </Hint>
      ) : null}
    </SidebarMenuItem>
  );
}

function NavItem({ id, projectId }: { id: NavRowId; projectId: string }) {
  switch (id) {
    case 'customize':
      return <CustomizeNavEntry projectId={projectId} />;
    case 'apps':
      return <ProjectAppsNavItem projectId={projectId} />;
    case 'files':
      return <ProjectFilesNavItem projectId={projectId} />;
    case 'goals':
      return <ProjectGoalsNavItem projectId={projectId} />;
    case 'artifacts':
      return <ProjectArtifactsNavItem projectId={projectId} />;
  }
}
