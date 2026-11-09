/**
 * The app-side survey gate: a survey may display only once the person has a
 * workspace, and only the active popover surveys, exactly as PostHog's own
 * display loop would have shown them (same eligibility, same delay, same
 * dismissal). Before the gate, PostHog's automatic display popped the
 * acquisition survey over the create-first-workspace landing
 * (`dogfood:auth-signup-onboarding:survey-modal-blocks-first-landing`).
 */
import { describe, expect, mock, test } from 'bun:test';

interface FakeSurvey {
  id: string;
  type: string;
}
interface DisplayCall {
  id: string;
  options: { displayType?: string; ignoreConditions?: boolean; ignoreDelay?: boolean };
}
/** The slice of the PostHog client the gate talks to. */
interface FakeSurveys {
  surveys: {
    getActiveMatchingSurveys: (callback: (surveys: FakeSurvey[]) => void) => void;
    displaySurvey: (id: string, options: { displayType: string; ignoreConditions?: boolean }) => void;
  };
}

const requested: FakeSurvey[][] = [];
const displays: DisplayCall[] = [];

let client: FakeSurveys | null;

mock.module('@/lib/analytics/posthog-client', () => ({
  getPostHog: () => Promise.resolve(client),
}));

function surveysOf(matching: FakeSurvey[]): void {
  client = {
    surveys: {
      getActiveMatchingSurveys: (callback) => {
        requested.push(matching);
        callback(matching);
      },
      displaySurvey: (id, options) => {
        displays.push({ id, options });
      },
    },
  };
}

const noClient = (): void => {
  client = null;
};

const drain = () => new Promise((resolve) => setTimeout(resolve, 0));

const { showWorkspaceSurveys } = await import('./survey-gate');

describe('showWorkspaceSurveys', () => {
  test('0 workspaces: PostHog is not even asked, nothing displays', async () => {
    requested.length = 0;
    displays.length = 0;
    surveysOf([{ id: 'acquisition', type: 'popover' }]);
    showWorkspaceSurveys(0);
    await drain();
    expect(requested).toHaveLength(0);
    expect(displays).toHaveLength(0);
  });

  test('1 workspace: the matching popover survey displays under PostHog eligibility', async () => {
    requested.length = 0;
    displays.length = 0;
    surveysOf([{ id: 'acquisition', type: 'popover' }]);
    showWorkspaceSurveys(1);
    await drain();
    expect(requested).toHaveLength(1);
    expect(displays).toEqual([
      {
        id: 'acquisition',
        options: { displayType: 'popover', ignoreConditions: false, ignoreDelay: false },
      },
    ]);
  });

  test('widget and api surveys stay out of the popover path', async () => {
    requested.length = 0;
    displays.length = 0;
    surveysOf([
      { id: 'w', type: 'widget' },
      { id: 'api', type: 'api' },
      { id: 'external', type: 'external_survey' },
    ]);
    showWorkspaceSurveys(1);
    await drain();
    expect(requested).toHaveLength(1);
    expect(displays).toHaveLength(0);
  });

  test('no PostHog client (a host that does not report): a no-op', async () => {
    requested.length = 0;
    displays.length = 0;
    noClient();
    showWorkspaceSurveys(1);
    await drain();
  });
});
