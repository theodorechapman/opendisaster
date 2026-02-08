import { ActionType } from "../core/Components.ts";

/** System prompt for the VLM (Featherless / gemma-3-12b-it) */
export const VLM_SYSTEM_PROMPT = `You are a perception system for a simulated person in a disaster scenario at Columbia University's campus. Describe what you see in 2-3 sentences. Focus on: immediate dangers (fire, debris, flooding, shaking), nearby people who may need help, potential shelter or sturdy structures, and escape routes. Be concise and factual.`;

/** Map action string from LLM response to ActionType enum. */
export function parseActionType(action: string): ActionType {
  const map: Record<string, ActionType> = {
    IDLE: ActionType.IDLE,
    WALK_TO: ActionType.WALK_TO,
    MOVE_TO: ActionType.WALK_TO,
    RUN_TO: ActionType.RUN_TO,
    FLEE: ActionType.RUN_TO,
    WANDER: ActionType.IDLE,
  };
  return map[action.toUpperCase()] ?? ActionType.IDLE;
}
