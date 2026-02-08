import type {
  Camera,
  DirectionalLight,
  Group,
  Scene,
} from "three";
import type { LayerData } from "../src/tiles.ts";

export type DisasterKind = "flood" | "tsunami";

export type DisasterControl =
  | {
      id: string;
      type: "range";
      label: string;
      min: number;
      max: number;
      step: number;
      value: number;
      unit?: string;
      precision?: number;
    }
  | {
      id: string;
      type: "checkbox";
      label: string;
      value: boolean;
    };

export interface DisasterContext {
  scene: Scene;
  parent: Group;
  camera: Camera;
  layers: LayerData;
  centerLat: number;
  centerLon: number;
  sunLight?: DirectionalLight;
}

export interface DisasterController {
  readonly kind: DisasterKind;

  start(): void;
  pause(): void;
  reset(): void;
  update(dt: number): void;
  dispose(): void;

  isRunning(): boolean;
  getControls(): DisasterControl[];
  setControl(id: string, value: number | boolean): void;
  getStatsText(): string;
}

export function cloneControls(controls: DisasterControl[]): DisasterControl[] {
  return controls.map((control) => ({ ...control }));
}
