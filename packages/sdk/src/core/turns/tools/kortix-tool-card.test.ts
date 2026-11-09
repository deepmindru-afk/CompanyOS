import { describe, expect, test } from 'bun:test';
import {
  inAppHref,
  isReadAction,
  KORTIX_PLATFORM_TOOLS,
  kortixCardTool,
  kortixPlatformTool,
  MULTI_AGENT_TOOLS,
  multiAgentTool,
  parseKortixToolResult,
} from './kortix-tool-card';

// Synthetic values only: every name, id and path below is invented.

const DENIED = {
  ok: false,
  tool: 'kortix_people',
  action: 'invite',
  card: {
    title: 'Could not invite the person',
    subtitle: 'Sam, Alex can grant it.',
    status: 'denied',
    links: [{ label: 'Members', href: '/workspaces/p-1/members' }],
  },
  error: {
    kind: 'denied',
    message: 'Kortix refused this: it needs a permission the person does not have (members.invite).',
    grantors: [
      { name: 'Sam', role: 'admin' },
      { name: 'Alex', role: 'owner' },
    ],
  },
};

describe('tool names', () => {
  test('every platform and multi-agent tool is a card tool, under any spelling; other tools are not', () => {
    expect(KORTIX_PLATFORM_TOOLS).toHaveLength(9);
    for (const name of KORTIX_PLATFORM_TOOLS) expect(kortixCardTool(name)).toBe(name);
    for (const name of MULTI_AGENT_TOOLS) expect(kortixCardTool(name)).toBe(name);
    expect(kortixPlatformTool('oc-kortix-agents')).toBe('kortix_agents');
    expect(multiAgentTool('send-message')).toBe('send_message');
    expect(multiAgentTool('kortix_agents')).toBeUndefined();
    expect(kortixCardTool('bash')).toBeUndefined();
  });

  test('inAppHref keeps one leading slash only; isReadAction knows the read verbs', () => {
    expect(inAppHref('/workspaces/p-1')).toBe('/workspaces/p-1');
    expect(inAppHref('//evil.example.test')).toBeUndefined();
    expect(inAppHref('https://example.test')).toBeUndefined();
    expect(isReadAction('list')).toBe(true);
    expect(isReadAction(undefined)).toBe(true);
    expect(isReadAction('invite')).toBe(false);
  });
});

describe('parseKortixToolResult', () => {
  test('keeps in-app row paths and https links only', () => {
    const result = parseKortixToolResult(
      JSON.stringify({
        ok: true,
        tool: 'kortix_sessions',
        action: 'list',
        card: {
          title: '2 sessions',
          status: 'done',
          rows: [
            { title: 'A', href: '//evil.example.test/x' },
            { title: 'B', href: 'https://elsewhere.example.test' },
            { title: 'C', href: '/workspaces/p-1/sessions/s-1' },
          ],
          links: [
            { label: 'Open', href: '/workspaces/p-1/sessions' },
            { label: 'Out', href: 'https://example.test/a' },
            { label: 'Script', href: 'javascript:void(0)' },
            { label: '', href: '/workspaces/p-1' },
          ],
        },
      }),
    );
    expect(result?.card.rows.map((row) => row.href)).toEqual([undefined, undefined, '/workspaces/p-1/sessions/s-1']);
    expect(result?.card.links).toEqual([
      { label: 'Open', href: '/workspaces/p-1/sessions', external: false },
      { label: 'Out', href: 'https://example.test/a', external: true },
    ]);
  });

  test('a denied error is a denied card whatever status the card names', () => {
    const result = parseKortixToolResult(JSON.stringify({ ...DENIED, card: { ...DENIED.card, status: 'error' } }));
    expect(result?.card.status).toBe('denied');
    expect(result?.error?.grantors).toEqual([
      { name: 'Sam', role: 'admin' },
      { name: 'Alex', role: 'owner' },
    ]);
  });

  test('an unknown status falls back to ok: done, else error', () => {
    const base = { tool: 'kortix_usage', action: 'show', card: { title: 'Usage', status: 'weird' } };
    expect(parseKortixToolResult(JSON.stringify({ ...base, ok: true }))?.card.status).toBe('done');
    expect(parseKortixToolResult(JSON.stringify({ ...base, ok: false }))?.card.status).toBe('error');
  });

  test('a result without `tool` takes the call name', () => {
    const raw = JSON.stringify({ ok: true, card: { title: '2 agents', status: 'done' } });
    expect(parseKortixToolResult(raw)).toBeNull();
    expect(parseKortixToolResult(raw, 'list_agents')?.tool).toBe('list_agents');
  });

  test('null for anything that is not the result object', () => {
    for (const raw of [undefined, '', 'plain text', '{', 'null', '{"ok":true}', JSON.stringify({ ok: 'yes', tool: 'kortix_usage', card: { title: 'x' } })]) {
      expect(parseKortixToolResult(raw)).toBeNull();
    }
  });
});

describe('parseKortixToolResult: a failure card never shows text written for the model', () => {
  // The exact result an older kortixd wrote for a follow_up call with no `text`.
  const MODEL_TEXT =
    'Missing `text`: what the woken turn reads (what was done, what to check, what to do on each outcome, an end date). If you did send it, it did not arrive: send this call from codemode. Call again with it, e.g. {"action":"follow_up","in":"4d","text":"Check replies."}';
  const legacy = (title: string, kind: string, message = MODEL_TEXT) =>
    JSON.stringify({ ok: false, tool: 'kortix_schedules', action: 'follow_up', card: { title, subtitle: message, status: 'error' }, error: { kind, message } });

  test('an argument check reads as an incomplete call, with no subtitle', () => {
    const result = parseKortixToolResult(legacy('What should the follow-up check?', 'invalid'))!;
    expect(result.card.title).toBe('The agent left out a required detail');
    expect(result.card.subtitle).toBeUndefined();
    // The model's text stays on the error for whoever reads it as the model.
    expect(result.error?.message).toBe(MODEL_TEXT);
    expect(parseKortixToolResult(legacy('Unknown action', 'invalid'))!.card.title).toBe('The agent left out a required detail');
  });

  test('a failure keeps its own title, and drops a subtitle that repeats the model message', () => {
    const result = parseKortixToolResult(legacy('Could not set the follow-up', 'failed', 'kortix exited 1'))!;
    expect(result.card).toMatchObject({ title: 'Could not set the follow-up', status: 'error' });
    expect(result.card.subtitle).toBeUndefined();
  });

  test('a subtitle written for the person stays', () => {
    const raw = JSON.stringify({ ok: false, tool: 'kortix_memory', action: 'list', card: { title: 'Memory is off in this workspace', subtitle: 'Files is off.', status: 'error' }, error: { kind: 'failed', message: 'model text', note: 'Files is off.' } });
    expect(parseKortixToolResult(raw)!.card.subtitle).toBe('Files is off.');
  });

  test('a note equal to the model message still shows: the tool wrote it for the person', () => {
    const FILES_OFF = 'Memory lives in Files, and Files is off in this workspace. Ask a workspace admin to turn Files on.';
    const raw = JSON.stringify({ ok: false, tool: 'kortix_memory', action: 'list', card: { title: 'Memory is off in this workspace', subtitle: FILES_OFF, status: 'error' }, error: { kind: 'failed', message: FILES_OFF, note: FILES_OFF } });
    expect(parseKortixToolResult(raw)!.card.subtitle).toBe(FILES_OFF);
  });

  test('a question title with trailing space still reads as an incomplete call', () => {
    expect(parseKortixToolResult(legacy('Which agent?  ', 'invalid'))!.card.title).toBe('The agent left out a required detail');
  });

  test('two legacy success subtitles lose their model text', () => {
    const models = JSON.stringify({ ok: true, tool: 'kortix_agents', action: 'models', card: { title: '2 models', subtitle: 'Pass an id as `model` to a hand-off, a workflow agent or an agent setting.', status: 'done' } });
    expect(parseKortixToolResult(models)!.card.subtitle).toBeUndefined();
    const list = JSON.stringify({ ok: true, tool: 'kortix_schedules', action: 'list', card: { title: '1 schedule', subtitle: "This session's follow-ups could not be read: kortix exited 2 (send this call from codemode)", status: 'done' } });
    expect(parseKortixToolResult(list)!.card.subtitle).toBe("This session's follow-ups could not be read.");
    const projectList = JSON.stringify({ ok: true, tool: 'kortix_schedules', action: 'list', card: { title: '1 follow-up', subtitle: 'The project schedules could not be read: boom', status: 'done' } });
    expect(parseKortixToolResult(projectList)!.card.subtitle).toBe('The project schedules could not be read.');
  });

  test('legacy schedules argument-check titles read as an incomplete call; a server refusal keeps its title', () => {
    for (const title of ['Name the automation', 'An App or an agent', 'Check the filter', 'Check the sample', 'Check the event name']) {
      expect(parseKortixToolResult(legacy(title, 'invalid'))!.card.title).toBe('The agent left out a required detail');
    }
    expect(parseKortixToolResult(legacy('Could not test triage', 'invalid'))!.card.title).toBe('Could not test triage');
  });
});
