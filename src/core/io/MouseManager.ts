import { IoEventDispatch } from "../entity/IoEvents";
import { V, V2d } from "../Vector";
import { MouseButtons } from "./MouseButtons";

/**
 * Manages mouse input state and events.
 * Tracks button states, cursor position, and dispatches events to handlers.
 */
export class MouseManager {
  private buttons = [false, false, false, false, false, false];
  private _position: V2d = V(0, 0);

  constructor(
    private view: HTMLElement,
    private dispatch: IoEventDispatch,
    private onInputActivity: () => void,
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

  private updatePosition(event: MouseEvent): void {
    // Note: offsetX/offsetY are relative to target element with Y=0 at top
    // This matches the screen coordinate system used by the camera
    const target = event.target as HTMLElement;
    const height = target.clientHeight;
    // Flip Y to match the coordinate system expected by the camera
    this._position = V(event.offsetX, height - event.offsetY);
  }

  private onMouseMove(event: MouseEvent): void {
    this.onInputActivity();
    this.updatePosition(event);
  }

  private onClick(event: MouseEvent): void {
    this.onInputActivity();
    this.updatePosition(event);
    switch (event.button) {
      case MouseButtons.LEFT:
        this.dispatch("click", undefined as void);
        break;
      case MouseButtons.MIDDLE:
        this.dispatch("middleClick", undefined as void);
        break;
      case MouseButtons.RIGHT:
        this.dispatch("rightClick", undefined as void);
        break;
    }
  }

  private onMouseDown(event: MouseEvent): void {
    this.onInputActivity();
    this.updatePosition(event);
    this.buttons[event.button] = true;
    switch (event.button) {
      case MouseButtons.LEFT:
        this.dispatch("mouseDown", undefined as void);
        break;
      case MouseButtons.MIDDLE:
        this.dispatch("middleDown", undefined as void);
        break;
      case MouseButtons.RIGHT:
        this.dispatch("rightDown", undefined as void);
        break;
    }
  }

  private onMouseUp(event: MouseEvent): void {
    this.onInputActivity();
    this.updatePosition(event);
    this.buttons[event.button] = false;
    switch (event.button) {
      case MouseButtons.LEFT:
        this.dispatch("mouseUp", undefined as void);
        break;
      case MouseButtons.MIDDLE:
        this.dispatch("middleUp", undefined as void);
        break;
      case MouseButtons.RIGHT:
        this.dispatch("rightUp", undefined as void);
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
