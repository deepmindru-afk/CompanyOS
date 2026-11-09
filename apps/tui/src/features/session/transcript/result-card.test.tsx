import { describe, expect, test } from 'bun:test';
import { parseKortixToolResult } from '@kortix/sdk';
import { testRender } from '@opentui/react/test-utils';

import { ResultCard } from './result-card.tsx';

// Synthetic values only.
const LINK = 'https://app.example.test/secret-intake/ksl_abc123';

describe('<ResultCard/>', () => {
  test('a card shows its title, note and sign-in link; the model message never prints', async () => {
    const result = parseKortixToolResult(
      JSON.stringify({
        ok: false,
        tool: 'kortix_schedules',
        action: 'automate',
        card: { title: 'FORM_SECRET needs saving for webhooks', subtitle: 'Save the value on the linked page.', status: 'error', links: [{ label: 'Save secret', href: LINK }, { label: 'Triggers', href: '/workspaces/p-1/admin/triggers' }] },
        error: { kind: 'invalid', message: 'Give the person this link, then call automate again: send this call from codemode', note: 'Save the value on the linked page.' },
      }),
    )!;
    const { captureCharFrame, renderOnce, renderer } = await testRender(<ResultCard result={result} width={100} />, { width: 100, height: 6 });
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain('FORM_SECRET needs saving for webhooks');
    expect(frame).toContain('Save the value on the linked page.');
    expect(frame).toContain(`Save secret: ${LINK}`);
    expect(frame).not.toContain('codemode');
    expect(frame).not.toContain('/workspaces/p-1');
    renderer.destroy();
  });
});
