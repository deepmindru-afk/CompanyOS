import { getPostHog } from './posthog-client';

/**
 * Display the active PostHog popover surveys now — but only once the person
 * has a workspace. Automatic display is off (`posthog-client.ts`): PostHog's
 * own display loop popped the acquisition survey over the
 * create-first-workspace landing of a zero-workspace account (dogfood
 * signature `dogfood:auth-signup-onboarding:survey-modal-blocks-first-landing`).
 * The chooser (`/workspaces`, the page the survey used to pop over) calls
 * this when its list resolves. PostHog keeps every other display rule:
 * targeting, the popup delay, the once-per-person frequency cap, and the
 * close control the widget renders.
 */
export function showWorkspaceSurveys(workspaceCount: number): void {
  if (workspaceCount < 1) return;
  void getPostHog().then((client) => {
    if (!client) return; // A host that does not report: there are no surveys.
    client.surveys.getActiveMatchingSurveys((surveys) => {
      for (const survey of surveys) {
        // Widget and api surveys render somewhere else (the widget tab, a
        // custom integration); the app owns only the popover.
        if (survey.type !== 'popover') continue;
        client.surveys.displaySurvey(survey.id, {
          displayType: 'popover',
          ignoreConditions: false,
          ignoreDelay: false,
        });
      }
    });
  });
}
