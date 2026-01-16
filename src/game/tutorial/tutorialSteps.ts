import { normalizeAngle } from "../../core/util/MathUtil";
import type { TutorialContext, TutorialStep } from "./TutorialStep";

/** Distance in feet required to complete the "get moving" step */
const SAIL_DISTANCE_REQUIRED = 50;

/** Angle change in radians required to complete the "steering" step */
const TURN_ANGLE_REQUIRED = Math.PI / 2; // 90 degrees

/** Mainsheet position change required for the "trim" step */
const TRIM_CHANGE_REQUIRED = 0.15;

/** Distance from start required to complete the "return" step */
const RETURN_DISTANCE = 30;

/**
 * Check if the boat is pointing generally upwind (within 60 degrees of wind).
 */
function isPointingUpwind(ctx: TutorialContext): boolean {
  const windAngle = ctx.windInfo.getAngle();
  const boatHeading = ctx.boat.hull.body.angle;
  // Boat pointing into wind means boat heading is opposite to wind direction
  const angleDiff = Math.abs(normalizeAngle(boatHeading - windAngle - Math.PI));
  return angleDiff < Math.PI / 3; // Within 60 degrees of directly into wind
}

/**
 * Determine which tack the boat is on based on wind direction.
 * Port tack = wind coming from port (left) side
 * Starboard tack = wind coming from starboard (right) side
 */
function getCurrentTack(ctx: TutorialContext): "port" | "starboard" {
  const windAngle = ctx.windInfo.getAngle();
  const boatHeading = ctx.boat.hull.body.angle;
  // Wind angle relative to boat heading
  const relativeWind = normalizeAngle(windAngle - boatHeading);
  // If wind is coming from the right (positive relative angle), we're on starboard tack
  return relativeWind > 0 ? "starboard" : "port";
}

export const tutorialSteps: TutorialStep[] = [
  {
    title: "Raise Your Anchor",
    description: "Your boat is anchored in place. Let's get moving!",
    objective: "Press F to raise the anchor",
    keyHint: "F",
    checkComplete: (ctx) => ctx.boat.anchor.getState() === "stowed",
  },
  {
    title: "Raise Your Sails",
    description:
      "With the anchor up, you'll need wind power to move. Raise your sails to catch the breeze.",
    objective: "Press R to raise your sails",
    keyHint: "R",
    checkComplete: (ctx) => ctx.boat.rig.sail.getHoistAmount() > 0.9,
  },
  {
    title: "Get Moving",
    description:
      "Your sails will catch the wind and propel you forward. Let the boat sail!",
    objective: `Sail ${SAIL_DISTANCE_REQUIRED} feet from your starting position`,
    checkComplete: (ctx) => {
      const currentPos = ctx.boat.getPosition();
      const distance = currentPos.distanceTo(ctx.stepStartPosition);
      return distance > SAIL_DISTANCE_REQUIRED;
    },
  },
  {
    title: "Steering",
    description:
      "Use the tiller to steer. The tiller works opposite to a steering wheel - push left to turn right!",
    objective: "Turn at least 90 degrees",
    keyHint: "A / D",
    checkComplete: (ctx) => {
      const currentHeading = ctx.boat.hull.body.angle;
      const headingChange = Math.abs(
        normalizeAngle(currentHeading - ctx.stepStartHeading),
      );
      return headingChange > TURN_ANGLE_REQUIRED;
    },
  },
  {
    title: "Trim Your Sails",
    description:
      "Trimming adjusts how tight your sail is to the wind. Trim in when sailing upwind, ease out when sailing downwind.",
    objective: "Adjust the mainsheet while pointing upwind",
    keyHint: "W / S",
    checkComplete: (ctx) => {
      const upwind = isPointingUpwind(ctx);
      const currentTrim = ctx.boat.mainsheet.getSheetPosition();
      const trimChange = Math.abs(currentTrim - ctx.stepStartMainsheetPosition);
      return upwind && trimChange > TRIM_CHANGE_REQUIRED;
    },
  },
  {
    title: "Tacking",
    description:
      "Tacking turns the bow through the wind to change which side the wind hits. This lets you sail upwind in a zigzag pattern.",
    objective: "Tack (turn through the wind) and sail back toward your start",
    keyHint: "A / D",
    onStart: (ctx) => {
      // Record which tack we're on when this step starts
      ctx.stepStartTack = getCurrentTack(ctx);
    },
    checkComplete: (ctx) => {
      const currentTack = getCurrentTack(ctx);
      const tackChanged = currentTack !== ctx.stepStartTack;
      const currentPos = ctx.boat.getPosition();
      const nearStart =
        currentPos.distanceTo(ctx.tutorialStartPosition) < RETURN_DISTANCE;
      return tackChanged && nearStart;
    },
  },
];
