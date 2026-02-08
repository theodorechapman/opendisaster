import type { DisasterContext, DisasterController, DisasterControl, DisasterKind } from "./types.ts";
import { cloneControls } from "./types.ts";
import { FloodDisaster, FLOOD_DEFAULT_CONTROLS } from "./flood/FloodDisaster.ts";
import { TsunamiSystem, TSUNAMI_DEFAULT_CONTROLS } from "./tsunami/TsunamiSystem.ts";

export function createDisaster(
  kind: DisasterKind,
  context: DisasterContext
): DisasterController {
  switch (kind) {
    case "flood":
      return new FloodDisaster(context);
    case "tsunami":
      return new TsunamiSystem(context);
    default:
      throw new Error(`Unsupported disaster kind: ${String(kind)}`);
  }
}

export function getDefaultDisasterControls(kind: DisasterKind): DisasterControl[] {
  switch (kind) {
    case "flood":
      return cloneControls(FLOOD_DEFAULT_CONTROLS);
    case "tsunami":
      return cloneControls(TSUNAMI_DEFAULT_CONTROLS);
    default:
      return [];
  }
}
