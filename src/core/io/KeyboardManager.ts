import IOEventHandler from "../entity/IoEvents";
import IOHandlerList from "./IOHandlerList";
import { KeyCode } from "./Keys";

/**
 * Manages keyboard input state and events.
 * Tracks which keys are currently pressed and dispatches events to handlers.
 */
export class KeyboardManager {
  private keys: Map<KeyCode, boolean> = new Map();
  private boundOnKeyDown: (e: KeyboardEvent) => void;
  private boundOnKeyUp: (e: KeyboardEvent) => void;
  private boundOnVisibilityChange: () => void;

  constructor(
    private handlers: IOHandlerList,
    private onInputActivity: () => void
  ) {
    this.boundOnKeyDown = (e) => this.onKeyDown(e);
    this.boundOnKeyUp = (e) => this.onKeyUp(e);
    this.boundOnVisibilityChange = () => this.clearAllKeys();

    document.addEventListener("keydown", this.boundOnKeyDown);
    document.addEventListener("keyup", this.boundOnKeyUp);
    document.addEventListener("visibilitychange", this.boundOnVisibilityChange);
  }

  /**
   * Returns true if the given key is currently pressed down.
   */
  isKeyDown(key: KeyCode): boolean {
    return Boolean(this.keys.get(key));
  }

  /**
   * Clears all key states and fires onKeyUp for each.
   * Called when the page loses visibility to prevent stuck keys.
   */
  private clearAllKeys(): void {
    for (const keyCode of this.keys.keys()) {
      this.keys.set(keyCode, false);
      for (const handler of this.handlers.filtered.onKeyUp) {
        handler.onKeyUp({ key: keyCode });
      }
    }
  }

  /**
   * Determines whether to prevent the default browser action for a key press.
   */
  private shouldPreventDefault(event: KeyboardEvent): boolean {
    if (event.key === "Tab") {
      return true;
    }
    if (event.key.toLowerCase() === "s") {
      // s for save
      return true;
    }
    return false;
  }

  private onKeyDown(event: KeyboardEvent): void {
    this.onInputActivity();
    const code = event.code as KeyCode;
    const wasPressed = this.keys.get(code); // for filtering out auto-repeat stuff
    this.keys.set(code, true);
    if (!wasPressed) {
      for (const handler of this.handlers.filtered.onKeyDown) {
        handler.onKeyDown({ key: code, event });
      }
    }
    if (this.shouldPreventDefault(event)) {
      event.preventDefault();
    }
  }

  private onKeyUp(event: KeyboardEvent): void {
    const code = event.code as KeyCode;
    this.keys.set(code, false);
    for (const handler of this.handlers.filtered.onKeyUp) {
      handler.onKeyUp({ key: code, event });
    }
    if (this.shouldPreventDefault(event)) {
      event.preventDefault();
    }
  }

  destroy(): void {
    document.removeEventListener("keydown", this.boundOnKeyDown);
    document.removeEventListener("keyup", this.boundOnKeyUp);
    document.removeEventListener("visibilitychange", this.boundOnVisibilityChange);
  }
}
