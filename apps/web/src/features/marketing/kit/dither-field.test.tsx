// KRTX-4536: `DitherField` (and the `DitherIcon` prototype) treated any truthy
// `canvas.getContext('webgl')` return as a usable WebGL context. Some client
// environments (anti-fingerprinting extensions, automation browsers) return a
// truthy stub without WebGL methods, so `gl.createProgram()` threw a TypeError
// inside the effect and React captured it up to `app/[locale]/error.tsx` —
// the whole pricing page replaced by the error boundary for a decorative
// background (Better Stack pattern 929ef7b0…, transaction /pricing).
// The fix checks the API surface before using it: without a real WebGL
// context the canvas stays empty, the documented degradation.
//
// Harness pattern of `features/marketplace/add-to-project-dialog-guard.test.tsx`:
// happy-dom globals, then the components via dynamic import, then createRoot
// under `act`, with a boundary that stands in for `app/[locale]/error.tsx`.
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

const win = new Window({ width: 1440, height: 900 });
const globals = globalThis as Record<string, unknown>;
globals.window = win;
globals.document = win.document;
globals.navigator = win.navigator;
globals.location = win.location;
// `DitherIcon`'s paint loop and every remount path ride rAF; happy-dom has none.
globals.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
globals.cancelAnimationFrame = (id: number) => clearTimeout(id);
for (const key of Object.getOwnPropertyNames(win)) {
  if (/^[A-Z]/.test(key) && !(key in globals)) globals[key] = Reflect.get(win, key);
}

const { DitherField } = await import('./dither-field');
const { DitherIcon } = await import('@/features/marketing/landing-sections/dither-icon.prototype');
const { Users } = await import('@phosphor-icons/react');

/** Stands in for `app/[locale]/error.tsx`: when a child error reaches it, the
 * page content is replaced — exactly what prod logged as `[Kortix Home Error]`. */
class RouteBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state: { failed: boolean } = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? <div data-testid="route-error">error page</div> : this.props.children;
  }
}

let root: Root;
let host: HTMLElement;
const realGetContext = win.HTMLCanvasElement.prototype.getContext;
// happy-dom's getContext signature admits no WebGL return; the stub's RUNTIME
// shape is the point — truthy, without WebGL methods.
type HappyContext = NonNullable<ReturnType<typeof realGetContext>>;
const stubContext = {} as HappyContext;

async function mount(children: React.ReactNode) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root.render(<RouteBoundary>{children}</RouteBoundary>));
}

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  win.HTMLCanvasElement.prototype.getContext = realGetContext;
});

describe('DitherField degraded WebGL', () => {
  test('a truthy stub context without WebGL methods does not pop the route error boundary', async () => {
    // The prod environment: getContext('webgl') hands back an object with no
    // WebGL methods.
    win.HTMLCanvasElement.prototype.getContext = () => stubContext;

    await mount(<DitherField className="h-40 w-full" />);

    expect(document.querySelector('[data-testid="route-error"]')).toBeNull();
    expect(host.querySelector('canvas')).not.toBeNull();
  });

  test('a real no-WebGL browser (null context) still renders the empty canvas', async () => {
    win.HTMLCanvasElement.prototype.getContext = () => null;

    await mount(<DitherField className="h-40 w-full" />);

    expect(document.querySelector('[data-testid="route-error"]')).toBeNull();
    expect(host.querySelector('canvas')).not.toBeNull();
  });
});

describe('DitherIcon prototype degraded WebGL', () => {
  test('a truthy stub context without WebGL methods does not pop the route error boundary', async () => {
    win.HTMLCanvasElement.prototype.getContext = () => stubContext;

    await mount(
      <DitherIcon icon={Users} mode="users" palette={['#111', '#333', '#666', '#999']} active />,
    );

    expect(document.querySelector('[data-testid="route-error"]')).toBeNull();
    expect(host.querySelector('canvas')).not.toBeNull();
  });
});
