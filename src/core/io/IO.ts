import { IoEventDispatch } from "../entity/IoEvents";
import { clamp } from "../util/MathUtil";
import { V, V2d } from "../Vector";
import { ControllerAxis, ControllerButton, ControllerType } from "./Gamepad";
import { GamepadManager } from "./GamepadManager";
import { KeyboardManager } from "./KeyboardManager";
import { KeyCode } from "./Keys";
import { MouseManager } from "./MouseManager";

/**
 * Manages all input sources (keyboard, mouse, gamepad) and dispatches events to handlers.
 * Acts as a facade over the individual input managers.
 */
export class IOManager {
  private keyboard: KeyboardManager;
  private mouse: MouseManager;
  private gamepad: GamepadManager;

  constructor(
    view: HTMLElement,
    private dispatch: IoEventDispatch,
  ) {
    this.keyboard = new KeyboardManager(this.dispatch, () =>
      this.gamepad.setUsingGamepad(false),
    );
    this.mouse = new MouseManager(view, this.dispatch, () =>
      this.gamepad.setUsingGamepad(false),
    );
    this.gamepad = new GamepadManager(
      this.dispatch,
      () => {}, // Device change is handled internally by GamepadManager
    );
  }

  destroy(): void {
    this.keyboard.destroy();
    this.mouse.destroy();
    this.gamepad.destroy();
  }

  // --- Keyboard ---

  /** True if the given key is currently pressed down. */
  isKeyDown(key: KeyCode): boolean {
    return this.keyboard.isKeyDown(key);
  }

  // --- Mouse ---

  /** Current mouse position in screen coordinates. */
  get mousePosition(): V2d {
    return this.mouse.position;
  }

  /** True if the left mouse button is down. */
  get lmb(): boolean {
    return this.mouse.lmb;
  }

  /** True if the middle mouse button is down. */
  get mmb(): boolean {
    return this.mouse.mmb;
  }

  /** True if the right mouse button is down. */
  get rmb(): boolean {
    return this.mouse.rmb;
  }

  // --- Gamepad ---

  /** True if the gamepad is the main input device. */
  get usingGamepad(): boolean {
    return this.gamepad.usingGamepad;
  }

  /**
   * Gets the current value of a gamepad axis (stick position).
   * @returns Axis value normalized to range [-1, 1], or 0 if no gamepad connected
   */
  getAxis(axis: ControllerAxis): number {
    return this.gamepad.getAxis(axis);
  }

  /**
   * Gets the position of a gamepad stick with dead zone normalization.
   */
  getStick(stick: "left" | "right"): V2d {
    return this.gamepad.getStick(stick);
  }

  /** Returns the value of a gamepad button. */
  getButton(button: ControllerButton): number {
    return this.gamepad.getButton(button);
  }

  /**
   * Returns the detected controller type based on the gamepad ID string.
   * @returns The controller type, or null if no gamepad is connected
   */
  getControllerType(): ControllerType | null {
    return this.gamepad.getControllerType();
  }

  // --- Combined Input ---

  /**
   * Check if an input element (input, textarea, select, contenteditable) is focused.
   * Used to prevent keyboard shortcuts from triggering when typing.
   */
  private isInputFocused(): boolean {
    const active = document.activeElement;
    if (!active) return false;
    const tagName = active.tagName.toLowerCase();
    return (
      tagName === "input" ||
      tagName === "textarea" ||
      tagName === "select" ||
      (active as HTMLElement).isContentEditable
    );
  }

  /**
   * Gets standardized movement input from WASD keys, arrow keys, or gamepad left stick.
   * Combines keyboard and gamepad input with proper priority handling.
   * Returns zero vector if an input element is focused.
   * WASD keys are ignored if Cmd/Ctrl modifier is held (to allow shortcuts like Cmd+S).
   * @returns Movement vector with components clamped to [-1, 1] range
   */
  getMovementVector(): V2d {
    const result = V(0, 0);

    // Don't respond to keyboard when typing in input fields
    if (this.isInputFocused()) return result;

    if (this.usingGamepad) {
      result.iadd(this.getStick("left"));
    }

    // Check if modifier key is held (for shortcuts like Cmd+S)
    const hasModifier =
      this.isKeyDown("MetaLeft") ||
      this.isKeyDown("MetaRight") ||
      this.isKeyDown("ControlLeft") ||
      this.isKeyDown("ControlRight");

    // Arrow keys always work
    if (this.isKeyDown("ArrowUp")) {
      result[1] -= 1;
    }
    if (this.isKeyDown("ArrowRight")) {
      result[0] += 1;
    }
    if (this.isKeyDown("ArrowDown")) {
      result[1] += 1;
    }
    if (this.isKeyDown("ArrowLeft")) {
      result[0] -= 1;
    }

    // WASD only works without modifier (to allow Cmd+S, Ctrl+A, etc.)
    if (!hasModifier) {
      if (this.isKeyDown("KeyW")) {
        result[1] -= 1;
      }
      if (this.isKeyDown("KeyD")) {
        result[0] += 1;
      }
      if (this.isKeyDown("KeyS")) {
        result[1] += 1;
      }
      if (this.isKeyDown("KeyA")) {
        result[0] -= 1;
      }
    }

    result[0] = clamp(result[0], -1, 1);
    result[1] = clamp(result[1], -1, 1);

    return result;
  }
}
