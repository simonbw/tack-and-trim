import IOHandlerList from "./IOHandlerList";
import { MouseButtons } from "./MouseButtons";
import { V, V2d } from "../Vector";

/**
 * Manages mouse input state and events.
 * Tracks button states, cursor position, and dispatches events to handlers.
 */
export class MouseManager {
  private buttons = [false, false, false, false, false, false];
  private _position: V2d = V(0, 0);

  constructor(
    private view: HTMLElement,
    private handlers: IOHandlerList,
    private onInputActivity: () => void
  ) {
    this.view.onclick = (e) => this.onClick(e);
    this.view.onmousedown = (e) => this.onMouseDown(e);
    this.view.onmouseup = (e) => this.onMouseUp(e);
    this.view.onmousemove = (e) => this.onMouseMove(e);
    this.view.oncontextmenu = (e) => {
      e.preventDefault();
      this.onClick(e);
      return false;
    };
  }

  /** Current mouse position in screen coordinates. */
  get position(): V2d {
    return this._position;
  }

  /** True if the left mouse button is down. */
  get lmb(): boolean {
    return this.buttons[MouseButtons.LEFT];
  }

  /** True if the middle mouse button is down. */
  get mmb(): boolean {
    return this.buttons[MouseButtons.MIDDLE];
  }

  /** True if the right mouse button is down. */
  get rmb(): boolean {
    return this.buttons[MouseButtons.RIGHT];
  }

  /** Returns the state of a specific mouse button. */
  isButtonDown(button: number): boolean {
    return this.buttons[button];
  }

  private onMouseMove(event: MouseEvent): void {
    this.onInputActivity();
    this._position = V(event.clientX, event.clientY);
  }

  private onClick(event: MouseEvent): void {
    this.onInputActivity();
    this._position = V(event.clientX, event.clientY);
    switch (event.button) {
      case MouseButtons.LEFT:
        for (const handler of this.handlers.filtered.onClick) {
          handler.onClick();
        }
        break;
      case MouseButtons.RIGHT:
        for (const handler of this.handlers.filtered.onRightClick) {
          handler.onRightClick();
        }
        break;
    }
  }

  private onMouseDown(event: MouseEvent): void {
    this.onInputActivity();
    this._position = V(event.clientX, event.clientY);
    this.buttons[event.button] = true;
    switch (event.button) {
      case MouseButtons.LEFT:
        for (const handler of this.handlers.filtered.onMouseDown) {
          handler.onMouseDown();
        }
        break;
      case MouseButtons.RIGHT:
        for (const handler of this.handlers.filtered.onRightDown) {
          handler.onRightDown();
        }
        break;
    }
  }

  private onMouseUp(event: MouseEvent): void {
    this.onInputActivity();
    this._position = V(event.clientX, event.clientY);
    this.buttons[event.button] = false;
    switch (event.button) {
      case MouseButtons.LEFT:
        for (const handler of this.handlers.filtered.onMouseUp) {
          handler.onMouseUp();
        }
        break;
      case MouseButtons.RIGHT:
        for (const handler of this.handlers.filtered.onRightUp) {
          handler.onRightUp();
        }
        break;
    }
  }

  destroy(): void {
    this.view.onclick = null;
    this.view.onmousedown = null;
    this.view.onmouseup = null;
    this.view.onmousemove = null;
    this.view.oncontextmenu = null;
  }
}
