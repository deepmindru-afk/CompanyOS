import { describe, expect, test } from 'bun:test';
import { followUpRoute, threadCreateClaim } from './threads';

// A reply runs in the session its thread maps to, in that session's project.

describe('followUpRoute', () => {
  test('a new thread, or a thread of the resolved project, runs here', () => {
    expect(followUpRoute(null, 'proj-1')).toEqual({ kind: 'here' });
    expect(followUpRoute('proj-1', 'proj-1', { ownThreadsOnly: true })).toEqual({ kind: 'here' });
  });

  test("a thread of another project runs in that project's session", () => {
    expect(followUpRoute('proj-0', 'proj-1')).toEqual({ kind: 'thread_project', projectId: 'proj-0' });
  });

  test('a per-project app refuses a thread of another project', () => {
    expect(followUpRoute('proj-0', 'proj-1', { ownThreadsOnly: true })).toEqual({ kind: 'refused' });
  });
});

describe('threadCreateClaim', () => {
  // The string is the lifecycle's idempotency state: one byte different, and a
  // chat that already holds a session starts a second one.
  test('the written key keeps its exact format for both platforms', () => {
    expect(threadCreateClaim('telegram', 'proj-1', 'bot-1', 'chat-1')).toBe('telegram:threadcreate:proj-1:bot-1:chat-1');
    expect(threadCreateClaim('discord', 'proj-1', 'guild-1', 'thread-1')).toBe('discord:threadcreate:proj-1:guild-1:thread-1');
  });
});
