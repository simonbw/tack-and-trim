import { ControllerButton } from "../io/Gamepad";
import { KeyCode } from "../io/Keys";
import { EventHandler } from "./EventHandler";

export type IoEvents = {
  /** Called when the mouse is left clicked anywhere. */
  click: void;
  /** Called when the left mouse button is pressed anywhere. */
  mouseDown: void;
  /** Called when the left mouse button is released anywhere. */
  mouseUp: void;
  /** Called when the mouse is right clicked anywhere. */
  rightClick: void;
  /** Called when the right mouse button is pressed anywhere. */
  rightDown: void;
  /** Called when the right mouse button is released anywhere. */
  rightUp: void;
  /** Called when the mouse is middle clicked anywhere. */
  middleClick: void;
  /** Called when the middle mouse button is pressed anywhere. */
  middleDown: void;
  /** Called when the middle mouse button is released anywhere. */
  middleUp: void;
  /** called when a keyboard key is pressed. */
  keyDown: { key: KeyCode; event: KeyboardEvent };
  /** called when a keyboard key is released. */
  keyUp: { key: KeyCode; event?: KeyboardEvent };
  /** Called when a gamepad button is pressed. */
  buttonDown: { button: ControllerButton };
  /** Called when a gamepad button is released. */
  buttonUp: { button: ControllerButton };
  /** Called when a gamepad is started or stopped being used. */
  inputDeviceChange: { usingGamepad: boolean };
};

export default interface IOEventHandler extends EventHandler<IoEvents> {}

/** Function type for dispatching IO events. */
export type IoEventDispatch = <E extends keyof IoEvents>(
  event: E,
  data: IoEvents[E],
) => void;
