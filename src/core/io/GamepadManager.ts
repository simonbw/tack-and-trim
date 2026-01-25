import { IoEventDispatch } from "../entity/IoEvents";
import { clamp, clampUp } from "../util/MathUtil";
import { V, V2d } from "../Vector";
import {
  ControllerAxis,
  ControllerButton,
  ControllerType,
  detectControllerType,
} from "./Gamepad";

/** Configuration options for GamepadManager. */
export interface GamepadConfig {
  /** Polling frequency in Hz. Default: 250 */
  pollingFrequency?: number;
  /** Minimum stick magnitude to register input (dead zone inner). Default: 0.2 */
  deadzoneMin?: number;
  /** Maximum stick magnitude (dead zone outer). Default: 0.95 */
  deadzoneMax?: number;
}

const DEFAULT_CONFIG: Required<GamepadConfig> = {
  pollingFrequency: 250,
  deadzoneMin: 0.2,
  deadzoneMax: 0.95,
};

/**
 * Manages gamepad input state and events.
 * Polls connected gamepads, applies dead zone normalization, and dispatches button events.
 */
export class GamepadManager {
  private lastButtons: boolean[] = [];
  private intervalId: number;
  private _usingGamepad = false;
  private wasConnected = false;

  private _pollingFrequency: number;
  private _deadzoneMin: number;
  private _deadzoneMax: number;

  constructor(
    private dispatch: IoEventDispatch,
    private onDeviceChange: (usingGamepad: boolean) => void,
    config: GamepadConfig = {},
  ) {
    this._pollingFrequency =
      config.pollingFrequency ?? DEFAULT_CONFIG.pollingFrequency;
    this._deadzoneMin = config.deadzoneMin ?? DEFAULT_CONFIG.deadzoneMin;
    this._deadzoneMax = config.deadzoneMax ?? DEFAULT_CONFIG.deadzoneMax;

    this.intervalId = this.startPolling();
  }

  private startPolling(): number {
    return window.setInterval(() => this.poll(), 1000 / this._pollingFrequency);
  }

  // --- Configuration getters/setters ---

  /** Polling frequency in Hz. Changing this restarts the polling interval. */
  get pollingFrequency(): number {
    return this._pollingFrequency;
  }

  set pollingFrequency(value: number) {
    if (value !== this._pollingFrequency && value > 0) {
      this._pollingFrequency = value;
      window.clearInterval(this.intervalId);
      this.intervalId = this.startPolling();
    }
  }

  /** Minimum stick magnitude to register input (inner dead zone). */
  get deadzoneMin(): number {
    return this._deadzoneMin;
  }

  set deadzoneMin(value: number) {
    this._deadzoneMin = clamp(value, 0, this._deadzoneMax);
  }

  /** Maximum stick magnitude before clamping (outer dead zone). */
  get deadzoneMax(): number {
    return this._deadzoneMax;
  }

  set deadzoneMax(value: number) {
    this._deadzoneMax = clamp(value, this._deadzoneMin, 1);
  }

  // --- State ---

  /** True if the gamepad is currently the active input device. */
  get usingGamepad(): boolean {
    return this._usingGamepad;
  }

  /** Sets the gamepad as active/inactive and fires device change event. */
  setUsingGamepad(value: boolean): void {
    if (this._usingGamepad !== value) {
      this._usingGamepad = value;
      this.onDeviceChange(this._usingGamepad);
      this.dispatch("inputDeviceChange", { usingGamepad: this._usingGamepad });
    }
  }

  /**
   * Polls connected gamepads and fires button events for state changes.
   */
  private poll(): void {
    const gamepad = navigator.getGamepads()[0];
    if (gamepad) {
      const buttons = gamepad.buttons.map((button) => button.pressed);

      for (const [button, isDown] of buttons.entries()) {
        if (isDown && !this.lastButtons[button]) {
          this.setUsingGamepad(true);
          this.dispatch("buttonDown", { button });
        } else if (!isDown && this.lastButtons[button]) {
          this.dispatch("buttonUp", { button });
        }
      }
      this.lastButtons = buttons;
      this.wasConnected = true;
    } else {
      if (this.wasConnected && this._usingGamepad) {
        this.setUsingGamepad(false);
      }
      this.lastButtons = [];
      this.wasConnected = false;
    }
  }

  /**
   * Returns the detected controller type based on the gamepad ID string.
   * @returns The controller type, or null if no gamepad is connected
   */
  getControllerType(): ControllerType | null {
    const gamepad = navigator.getGamepads()[0];
    if (!gamepad) return null;
    return detectControllerType(gamepad.id);
  }

  /**
   * Gets the current value of a gamepad axis (stick position).
   * @returns Axis value normalized to range [-1, 1], or 0 if no gamepad connected
   */
  getAxis(axis: ControllerAxis): number {
    switch (axis) {
      case ControllerAxis.LEFT_X:
        return this.getStick("left").x;
      case ControllerAxis.LEFT_Y:
        return this.getStick("left").y;
      case ControllerAxis.RIGHT_X:
        return this.getStick("right").x;
      case ControllerAxis.RIGHT_Y:
        return this.getStick("right").y;
      default:
        throw new Error("unknown axis");
    }
  }

  /**
   * Gets the position of a gamepad stick with dead zone normalization applied.
   * @param stick Which stick to read ("left" or "right")
   * @returns Vector with x,y in range [-1, 1], accounting for dead zones
   */
  getStick(stick: "left" | "right"): V2d {
    const axes = V(0, 0);
    const gamepad = navigator.getGamepads()[0];
    if (gamepad) {
      if (stick === "left") {
        axes.x = gamepad.axes[ControllerAxis.LEFT_X];
        axes.y = gamepad.axes[ControllerAxis.LEFT_Y];
      } else {
        axes.x = gamepad.axes[ControllerAxis.RIGHT_X];
        axes.y = gamepad.axes[ControllerAxis.RIGHT_Y];
      }
      const deadzoneRange = this._deadzoneMax - this._deadzoneMin;
      axes.magnitude = clampUp(
        (axes.magnitude - this._deadzoneMin) / deadzoneRange,
      );
      axes.x = clamp(axes.x, -1, 1);
      axes.y = clamp(axes.y, -1, 1);
    }
    return axes;
  }

  /**
   * Returns the value of a gamepad button (0-1 for analog triggers, 0 or 1 for digital).
   */
  getButton(button: ControllerButton): number {
    const gamepad = navigator.getGamepads()[0];
    return gamepad?.buttons[button]?.value ?? 0;
  }

  destroy(): void {
    window.clearInterval(this.intervalId);
  }
}
