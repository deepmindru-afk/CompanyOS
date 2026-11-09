'use client';

import { createContext, useContext } from 'react';

/**
 * What the sidebar's Customize row needs beside its link. The row used to
 * open a disclosure here (`ProjectCapabilityNav`: pinned agents, Review,
 * Models, Workspace settings); since 2026-11-08 Customize IS Workspace
 * settings, so the row is one link and the panel's rail is the navigation.
 */

export const NewAgentContext = createContext<(() => void) | null>(null);

/** Opens the New agent modal mounted beside the sidebar; null outside `NewAgentModalProvider`. */
export function useOpenNewAgent(): (() => void) | null {
  return useContext(NewAgentContext);
}

/** Whether the pathname is a Project admin (Settings) page. The locale prefix
 *  the host may not strip is tolerated. */
export function isProjectAdminPath(pathname: string | null | undefined): boolean {
  return !!pathname && /\/(?:workspaces|projects)\/[^/]+\/admin(?:[/?#]|$)/.test(pathname);
}
