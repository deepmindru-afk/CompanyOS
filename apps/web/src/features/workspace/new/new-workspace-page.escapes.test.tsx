import { expect, mock, test } from 'bun:test';
import { configureKortix } from '@kortix/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { UiProvider, defaultUiNavigation } from '@kortix/ui/providers/ui-provider';
import { createElement, forwardRef, type ReactNode } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

/**
 * `/workspaces/new`: the escapes are withheld while the create is in flight.
 *
 * A customer who left mid-create (the back pill, or the desktop close button)
 * landed on a list without the workspace and could resubmit — the dogfood run
 * that filed KRTX-4551 watched exactly that happen during a slow managed
 * create. The page now omits both controls while `status === 'creating'` and
 * brings them back the moment the create resolves or fails; Log out stays
 * reachable in the account menu, so the page is never fully trapped.
 *
 * The top bar is a contract stub: it renders the back pill as a link when the
 * page passes `back`, and the trailing node when it passes `trailing` — the
 * same contract the real `AccountTopBar` renders. What is under test is the
 * PAGE's decision to pass or withhold them, not the bar's markup. Creation
 * runs the real hook, orchestration and SDK transport; only the configured
 * HTTP fetch returns synthetic provision responses.
 */

/** When true the provision request never answers, holding the page in `creating`. */
let hangCreate = false;
let failCreate = false;
let creates = 0;
const destinations: string[] = [];

configureKortix({
  backendUrl: 'https://pairing.example.test/v1',
  getToken: async () => 'synthetic-token',
  fetch: async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === '/v1/workspaces' && init?.method === 'POST') {
      creates += 1;
      if (hangCreate) return new Promise<never>(() => {});
      if (failCreate) return Response.json({ error: 'Temporary outage' }, { status: 502 });
      return new Response('data: {"type":"done","project":{"project_id":"created-project","account_id":"user-1"}}\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
    }
    throw new Error(`Unexpected request: ${path}`);
  },
});

mock.module('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: (path: string) => { destinations.push(path); }, back: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  usePathname: () => '/workspaces/new',
}));
mock.module('@/features/providers/auth-provider', () => ({
  useAuth: () => ({
    user: { id: 'user-1', email: 'pr-demo@example.test', user_metadata: { name: 'Demo' } },
    isLoading: false,
  }),
}));
mock.module('@/lib/auth/use-signed-out-redirect', () => ({ useSignedOutRedirect: () => {} }));
mock.module('@kortix/ui/internal/hooks/account/use-accounts-list', () => ({
  useAccountsList: () => ({
    data: [
      { account_id: 'user-1', name: 'Personal', account_role: 'owner', is_primary_owner: true },
    ],
    isLoading: false,
  }),
}));
mock.module('@kortix/ui/workspace/sidebar/use-workspace-directory', () => ({
  useWorkspaceDirectory: () => ({
    accounts: [{ account_id: 'user-1', name: 'Personal', account_role: 'owner' }],
    workspaces: [],
    loading: false,
    failedAccountIds: [],
    reusableAccount: null,
    githubSourceAccount: { account_id: 'user-1', name: 'Personal', account_role: 'owner' },
    retryFailed: () => {},
  }),
}));
mock.module('@kortix/ui/internal/hooks/admin/use-admin-role', () => ({ useAdminRole: () => ({ data: null }) }));
mock.module('@/features/billing/global-upgrade-modal', () => ({
  GlobalUpgradeModal: () => createElement('div', { 'data-testid': 'upgrade-modal-stub' }),
}));
// The contract stub of the real bar: `back` present renders the pill link,
// `trailing` present renders the trailing node.
mock.module('@/features/workspace/account-top-bar', () => ({
  AccountTopBar: (props: {
    back?: { href: string; label: string };
    trailing?: ReactNode;
  }) =>
    createElement(
      'header',
      { 'data-testid': 'top-bar-stub' },
      props.back
        ? createElement('a', { href: props.back.href, 'data-testid': 'back-pill' }, props.back.label)
        : null,
      props.trailing ?? null,
    ),
}));
// The real button needs the desktop bridge; the page's decision to render or
// withhold it is what this file asserts.
mock.module('@/components/desktop/desktop-close-button', () => ({
  DesktopCloseButton: () => createElement('button', { 'data-testid': 'desktop-close-stub', type: 'button' }),
}));
mock.module('@kortix/ui/workspace/new/advanced-fields', () => ({
  AdvancedFields: () => createElement('div', { 'data-testid': 'advanced-stub' }),
}));

// motion/react with no DOM: render the same tag with the animation-only props
// stripped, and always claim reduced motion so no animation timing runs.
const MOTION_ONLY_PROPS = new Set([
  'initial',
  'animate',
  'exit',
  'transition',
  'variants',
  'whileHover',
  'whileTap',
  'whileInView',
  'viewport',
  'layout',
  'layoutId',
]);
const motionComponents = new Proxy(
  {},
  {
    get: (_target, tag: string) =>
      forwardRef(function MotionStub(motionProps: Record<string, unknown>, ref) {
        const domProps = Object.fromEntries(
          Object.entries(motionProps).filter(([key]) => !MOTION_ONLY_PROPS.has(key)),
        );
        return createElement(tag, { ...domProps, ref });
      }),
  },
);
const motionValue = (initial: number) => ({
  get: () => initial,
  set: () => {},
  on: () => () => {},
  addEventListener: () => () => {},
  hasListeners: () => false,
  remove: () => {},
  destroy: () => {},
});
const realMotion = await import('motion/react');
mock.module('motion/react', () => ({
  ...realMotion,
  AnimatePresence: ({ children }: { children: ReactNode }) => <>{children}</>,
  // @kortix/ui's UiProvider wraps its tree in LazyMotion.
  LazyMotion: ({ children }: { children: ReactNode }) => <>{children}</>,
  m: motionComponents,
  animate: () => Promise.resolve(),
  useMotionValue: (initial: number) => motionValue(initial),
  useReducedMotion: () => true,
}));

const { NewWorkspacePage } = await import('./new-workspace-page');

function findBackPill(renderer: ReactTestRenderer): ReactTestInstance | null {
  return (
    renderer.root.findAll((node) => node.type === 'a' && node.props['data-testid'] === 'back-pill')[0] ??
    null
  );
}

function findCloseButton(renderer: ReactTestRenderer): ReactTestInstance | null {
  return renderer.root.findAll((node) => node.props['data-testid'] === 'desktop-close-stub')[0] ?? null;
}

function findForm(renderer: ReactTestRenderer): ReactTestInstance {
  const form = renderer.root.findAll((node) => node.type === 'form')[0];
  if (!form) throw new Error('create form not rendered');
  return form;
}

function findInput(renderer: ReactTestRenderer): ReactTestInstance {
  const input = renderer.root.findAll(
    (node) => node.type === 'input' && node.props.id === 'workspace-name',
  )[0];
  if (!input) throw new Error('workspace-name input not rendered');
  return input;
}

/** Every string leaf of a subtree, in render order. */
function textOf(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : textOf(child)))
    .join('');
}

/** The handoff's status region text, present only while the create is in flight. */
function handoffText(renderer: ReactTestRenderer): string | null {
  const status = renderer.root.findAll((node) => node.props.role === 'status')[0] ?? null;
  return status ? textOf(status) : null;
}

/** The form-level error alert, present only when the create has failed. */
function errorAlert(renderer: ReactTestRenderer): string | null {
  const alert = renderer.root.findAll((node) => node.props.role === 'alert')[0] ?? null;
  return alert ? textOf(alert) : null;
}

async function renderPage(): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    renderer = create(
      <QueryClientProvider client={client}>
        <UiProvider useViewerId={() => 'user-1'} navigation={{ ...defaultUiNavigation, useRouter: () => ({ push: () => {}, replace: (path: string) => { destinations.push(path); }, back: () => {}, prefetch: () => {} }) }}>
          <NewWorkspacePage />
        </UiProvider>
      </QueryClientProvider>,
    );
  });
  if (!renderer) throw new Error('page did not render');
  return renderer;
}

async function submit(renderer: ReactTestRenderer, name = 'Alpha workspace'): Promise<void> {
  await act(async () => {
    findInput(renderer).props.onChange({ target: { value: name } });
  });
  await act(async () => {
    findForm(renderer).props.onSubmit({ preventDefault: () => {} });
  });
}

async function unmount(renderer: ReactTestRenderer): Promise<void> {
  await act(async () => {
    renderer.unmount();
  });
}

test('an idle page offers both escapes: the back pill and the desktop close', async () => {
  const renderer = await renderPage();
  expect(findBackPill(renderer)?.props.href).toBe('/workspaces');
  expect(findCloseButton(renderer)).not.toBeNull();
  await unmount(renderer);
});

test('while the create is in flight the escapes are withheld and the handoff shows', async () => {
  hangCreate = true;
  const renderer = await renderPage();
  await submit(renderer);
  expect(creates).toBe(1);
  expect(findBackPill(renderer)).toBeNull();
  expect(findCloseButton(renderer)).toBeNull();
  expect(handoffText(renderer)).toContain('Creating Alpha workspace');
  await unmount(renderer);
  hangCreate = false;
});

test('a failed create brings the escapes back with the error', async () => {
  failCreate = true;
  const renderer = await renderPage();
  await submit(renderer);
  // The stubbed AnimatePresence keeps both swap branches mounted (no exit
  // animation to remove the handoff), so the error block — rendered only by
  // the form branch — is the proof the form returned.
  expect(errorAlert(renderer)).toContain('Temporary outage');
  expect(findBackPill(renderer)?.props.href).toBe('/workspaces');
  expect(findCloseButton(renderer)).not.toBeNull();
  await unmount(renderer);
  failCreate = false;
});
