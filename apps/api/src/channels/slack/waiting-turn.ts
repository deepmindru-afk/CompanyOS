// The shared shell of the two "waiting for a human" posters — questions.ts
// (`postQuestion`) and review.ts (`postReviewCard`): close out the in-flight
// plan, then ask below it. teams/waiting-turn.ts is the mirrored owner of this
// shape on Teams. Each poster keeps its own blocks and plain-text fallback.
import { deleteTurn, finalizeTurn, loadTurn } from './turn';
import type { LiveTurn } from './types';

// NOT "Task complete", which is what the default title said for as long as
// this has existed: the agent did not finish, it asked (or waits for a
// decision). The step in flight gets the neutral glyph for the same reason.
// Teams had the identical bug; both are fixed together because it is one
// mistake in two copies.
export async function closeWaitingTurn(handle: LiveTurn, title: string): Promise<void> {
  await finalizeTurn(handle, { title, unfinished: true });
  await deleteTurn(handle.sessionId);
}

/** Returns the live turn it closed, or null when none is open (e.g. a second
 * question after the first finalized). */
export async function prepareWaitingTurn(sessionId: string, title: string): Promise<LiveTurn | null> {
  const handle = await loadTurn(sessionId);
  if (!handle) return null;
  await closeWaitingTurn(handle, title);
  return handle;
}
