import type { AgentConfig, AgentMemory, PerceptionPayload } from "./types.ts";
import { ActionType } from "../core/Components.ts";

const VALID_ACTIONS = [
  "IDLE", "MOVE_TO", "RUN_TO",
  "HELP_PERSON", "EVACUATE", "WAIT", "FLEE",
];

/** System prompt for the VLM (Featherless / gemma-3-12b-it) */
export const VLM_SYSTEM_PROMPT = `You are a perception system for a simulated person in a disaster scenario at Columbia University's campus. Describe what you see in 2-3 sentences. Focus on: immediate dangers (fire, debris, flooding, shaking), nearby people who may need help, potential shelter or sturdy structures, and escape routes. Be concise and factual.`;

/** Build the K2 Think system prompt with personality. */
export function buildK2SystemPrompt(config: AgentConfig): string {
  const p = config.personality;
  return `You are ${config.name}, ${p.description}. You are in a disaster simulation at Columbia University's campus.

Personality traits (0-1 scale):
- Bravery: ${p.bravery} (${p.bravery > 0.7 ? "very brave" : p.bravery > 0.4 ? "moderately brave" : "timid"})
- Altruism: ${p.altruism} (${p.altruism > 0.7 ? "very altruistic" : p.altruism > 0.4 ? "somewhat caring" : "self-focused"})
- Awareness: ${p.awareness} (${p.awareness > 0.7 ? "highly observant" : p.awareness > 0.4 ? "reasonably aware" : "easily distracted"})

You must decide your next action. Respond ONLY with valid JSON in this exact format:
{
  "reasoning": "brief explanation of your decision (1-2 sentences)",
  "action": "ACTION_NAME",
  "target_x": 0.0,
  "target_z": 0.0,
  "target_entity": 0
}

Valid actions: ${VALID_ACTIONS.join(", ")}

Rules:
- MOVE_TO/RUN_TO: set target_x and target_z to where you want to go
- HELP_PERSON: set target_entity to the ID of the person to help (if known), or move toward them
- EVACUATE: run toward the edge of campus to escape
- IDLE/WAIT: stay in place
- ENTER_BUILDING/EXIT_BUILDING: move toward/away from nearest building

Stay in character. Your decisions should reflect your personality.`;
}

/** Build the K2 Think user prompt for a single step. */
export function buildK2UserPrompt(
  observation: string,
  payload: PerceptionPayload,
): string {
  const s = payload.state;
  const m = payload.memory;

  let prompt = `CURRENT OBSERVATION: ${observation}

STATUS:
- Health: ${s.health.toFixed(0)}/100
- Stamina: ${s.stamina.toFixed(0)}/100
- Panic: ${(s.panicLevel * 100).toFixed(0)}%
- Injuries: ${describeInjuries(s.injured)}
- Position: (${s.positionX.toFixed(1)}, ${s.positionZ.toFixed(1)})`;

  if (m.recentEvents.length > 0) {
    prompt += `\n\nRECENT EVENTS:\n${m.recentEvents.slice(-5).map(e => `- ${e}`).join("\n")}`;
  }

  if (m.observations.length > 0) {
    prompt += `\n\nPREVIOUS OBSERVATIONS:\n${m.observations.slice(-3).map(o => `- ${o}`).join("\n")}`;
  }

  if (m.decisions.length > 0) {
    prompt += `\n\nPREVIOUS DECISIONS:\n${m.decisions.slice(-3).map(d => `- ${d}`).join("\n")}`;
  }

  prompt += `\n\nWhat do you do next?`;
  return prompt;
}

function describeInjuries(bitmask: number): string {
  if (bitmask === 0) return "none";
  const parts: string[] = [];
  if (bitmask & 1) parts.push("minor");
  if (bitmask & 2) parts.push("major");
  if (bitmask & 4) parts.push("critical");
  return parts.join(", ");
}

/** Map action string from LLM response to ActionType enum. */
export function parseActionType(action: string): ActionType {
  const map: Record<string, ActionType> = {
    IDLE: ActionType.IDLE,
    MOVE_TO: ActionType.MOVE_TO,
    RUN_TO: ActionType.RUN_TO,
    HELP_PERSON: ActionType.HELP_PERSON,
    EVACUATE: ActionType.EVACUATE,
    WAIT: ActionType.WAIT,
    FLEE: ActionType.RUN_TO,
  };
  return map[action.toUpperCase()] ?? ActionType.IDLE;
}
