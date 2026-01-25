export const enum ControllerAxis {
  LEFT_X = 0,
  LEFT_Y = 1,
  RIGHT_X = 2,
  RIGHT_Y = 3,
}

export const enum ControllerButton {
  A = 0,
  B = 1,
  X = 2,
  Y = 3,
  LB = 4,
  RB = 5,
  LT = 6,
  RT = 7,
  BACK = 8,
  START = 9,
  L3 = 10,
  R3 = 11,
  D_UP = 12,
  D_DOWN = 13,
  D_LEFT = 14,
  D_RIGHT = 15,
  SPECIAL = 16,
}

export const enum ControllerType {
  XBOX = 0,
  PLAYSTATION = 1,
  NINTENDO = 2,
}

const BUTTON_NAMES: Record<ControllerType, string[]> = {
  [ControllerType.XBOX]: [
    "A",
    "B",
    "X",
    "Y",
    "LB",
    "RB",
    "LT",
    "RT",
    "Back",
    "Start",
    "L3",
    "R3",
    "D-Up",
    "D-Down",
    "D-Left",
    "D-Right",
    "Xbox",
  ],
  [ControllerType.PLAYSTATION]: [
    "Cross",
    "Circle",
    "Square",
    "Triangle",
    "L1",
    "R1",
    "L2",
    "R2",
    "Share",
    "Options",
    "L3",
    "R3",
    "D-Up",
    "D-Down",
    "D-Left",
    "D-Right",
    "PS",
  ],
  [ControllerType.NINTENDO]: [
    "B",
    "A",
    "Y",
    "X",
    "L",
    "R",
    "ZL",
    "ZR",
    "-",
    "+",
    "LS",
    "RS",
    "D-Up",
    "D-Down",
    "D-Left",
    "D-Right",
    "Home",
  ],
};

/**
 * Returns a human-readable name for a gamepad button.
 * @param button The controller button index
 * @param type The controller type (defaults to Xbox)
 * @returns The button name (e.g., "A", "Cross", "B" depending on controller type)
 */
export function getButtonName(
  button: ControllerButton,
  type: ControllerType = ControllerType.XBOX,
): string {
  return BUTTON_NAMES[type]?.[button] ?? `Button ${button}`;
}

/**
 * Detects the controller type from the gamepad ID string.
 * @param gamepadId The gamepad.id string from the Gamepad API
 * @returns The detected controller type
 */
export function detectControllerType(gamepadId: string): ControllerType {
  const id = gamepadId.toLowerCase();
  if (
    id.includes("playstation") ||
    id.includes("dualsense") ||
    id.includes("dualshock")
  ) {
    return ControllerType.PLAYSTATION;
  }
  if (
    id.includes("nintendo") ||
    id.includes("pro controller") ||
    id.includes("joy-con")
  ) {
    return ControllerType.NINTENDO;
  }
  return ControllerType.XBOX; // Default for Xbox and unknown controllers
}
