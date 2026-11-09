import type { FlatModel } from '@kortix/sdk/react';

const FREE_TOKEN = /(^|[\s/_-])free($|[\s/_-])/i;

export function shouldShowFreeTag(
  model: Pick<FlatModel, 'free' | 'modelID' | 'modelName'>,
): boolean {
  if (model.free === true) return true;
  return FREE_TOKEN.test(model.modelName) || FREE_TOKEN.test(model.modelID);
}

/**
 * The gateway's subscription route: a model billed to a connected ChatGPT
 * Plus/Pro account rather than metered per token. Wire ids are `codex/<model>`
 * and the explicit provider field is `codex`; both are checked because a stale
 * baked catalog can predate the field (same fallback `pickerGroupId` uses).
 */
export function isSubscriptionModel(
  model: Pick<FlatModel, 'modelID'> & { provider?: string | null },
): boolean {
  return model.provider === 'codex' || model.modelID.startsWith('codex/');
}

/**
 * A model that runs through Claude Code on the caller's own Claude Pro or Max
 * plan (`claude-agent/<id>`, `@kortix/api-contract/claude-agent`). It never
 * reaches the LLM gateway.
 */
export function isClaudeSubscriptionModel(model: { provider?: string | null; providerID?: string }): boolean {
  return model.providerID === 'claude-agent' || model.provider === 'claude-agent';
}

/**
 * A trailing parenthetical that names how a model is billed, not what it is:
 * "(ChatGPT)", "(Claude subscription)", "(Anthropic plan)". The gateway and
 * the plan catalogs append these so ungrouped surfaces (the CLI, `/v1/models`)
 * can tell a plan model from its metered twin. `[^()]*` keeps the match
 * linear (CodeQL js/polynomial-redos) and inside one pair of parentheses.
 */
const PLAN_SUFFIX = /\((?:ChatGPT|Claude|Anthropic)(?: [^()]*)?\)$/i;
/** A suffix that says it is a plan, on any model. */
const EXPLICIT_PLAN_SUFFIX = /\([^()]*\b(?:subscription|plan)\)$/i;

/**
 * What the picker prints for a model: its name without the plan suffix. The
 * picker shows the plan another way (the ChatGPT tab, the provider's tab), so
 * the suffix only pushed the real name off the trigger and out of the column.
 *
 * Display only. Search, aria labels and every stored id keep the full name, so
 * typing "chatgpt" still finds these rows.
 */
export function pickerModelName(
  model: Pick<FlatModel, 'modelID' | 'modelName'> & {
    provider?: string | null;
    providerID?: string;
  },
): string {
  const name = model.modelName.trim();
  // A bare "(ChatGPT)" on a model that is NOT on a plan is part of its name.
  const onPlan = isSubscriptionModel(model) || isClaudeSubscriptionModel(model);
  let stripped = name.replace(EXPLICIT_PLAN_SUFFIX, '');
  if (onPlan) stripped = stripped.replace(PLAN_SUFFIX, '');
  return stripped.trim() || model.modelName;
}
