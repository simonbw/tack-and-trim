import { BaseEntity } from "../../core/entity/BaseEntity";
import { on } from "../../core/entity/handler";
import type { Draw } from "../../core/graphics/Draw";
import type { DynamicPointMass2D } from "../../core/physics/body/bodyInterfaces";
import type { UnifiedBody } from "../../core/physics/body/UnifiedBody";
import { createPointMass2D } from "../../core/physics/body/bodyFactories";
import { DistanceConstraint } from "../../core/physics/constraints/DistanceConstraint";
import { Particle } from "../../core/physics/shapes/Particle";
import { V, V2d } from "../../core/Vector";
import { findBowPoint, findSternPoints } from "../boat/Hull";
import type { Boat } from "../boat/Boat";
import type { Port } from "./Port";

type MooringState = "free" | "mooring" | "moored" | "casting-off";

// Mooring line visual properties
const MOORING_LINE_COLOR = 0x666644;
const MOORING_LINE_WIDTH = 0.3; // ft

// Cast-off impulse
const CAST_OFF_IMPULSE = 50; // lbs * ft/s

export class Mooring extends BaseEntity {
  layer = "boat" as const;

  private state: MooringState = "free";
  private currentPort: Port | null = null;

  // Physics anchors for mooring lines
  private bowAnchorBody: (UnifiedBody & DynamicPointMass2D) | null = null;
  private sternAnchorBody: (UnifiedBody & DynamicPointMass2D) | null = null;
  private bowConstraint: DistanceConstraint | null = null;
  private sternConstraint: DistanceConstraint | null = null;

  // Hull attach points (local coordinates)
  private bowAttachLocal: V2d;
  private sternAttachLocal: V2d;

  constructor(private boat: Boat) {
    super();

    // Compute bow and stern attach points from hull vertices
    const vertices = boat.config.hull.vertices;
    this.bowAttachLocal = findBowPoint(vertices);
    const sternPoints = findSternPoints(vertices);
    this.sternAttachLocal = sternPoints.port
      .add(sternPoints.starboard)
      .imul(0.5);
  }

  getState(): MooringState {
    return this.state;
  }

  isMoored(): boolean {
    return this.state === "moored" || this.state === "mooring";
  }

  getCurrentPort(): Port | null {
    return this.currentPort;
  }

  /** Moor the boat to a port */
  moorTo(port: Port): void {
    if (this.state !== "free") return;

    this.currentPort = port;

    // Get cleat positions from the port
    const bowCleatWorld = port.getBowCleatWorld();
    const sternCleatWorld = port.getSternCleatWorld();

    // Create static anchor bodies at cleat positions
    // (using tiny dynamic bodies with high mass to act as fixed points for constraints)
    this.bowAnchorBody = createPointMass2D({
      motion: "dynamic",
      mass: 1e6,
      position: [bowCleatWorld.x, bowCleatWorld.y],
      damping: 1.0,
    });
    this.bowAnchorBody.addShape(new Particle());
    this.game.world.bodies.add(this.bowAnchorBody);

    this.sternAnchorBody = createPointMass2D({
      motion: "dynamic",
      mass: 1e6,
      position: [sternCleatWorld.x, sternCleatWorld.y],
      damping: 1.0,
    });
    this.sternAnchorBody.addShape(new Particle());
    this.game.world.bodies.add(this.sternAnchorBody);

    // Create distance constraints from hull attach points to cleat anchor bodies
    this.bowConstraint = new DistanceConstraint(
      this.bowAnchorBody,
      this.boat.hull.body,
      {
        localAnchorA: [0, 0],
        localAnchorB: [this.bowAttachLocal.x, this.bowAttachLocal.y],
        collideConnected: false,
      },
    );
    this.bowConstraint.upperLimitEnabled = true;
    this.bowConstraint.upperLimit = this.bowConstraint.distance;
    this.bowConstraint.lowerLimitEnabled = false;
    this.game.world.constraints.add(this.bowConstraint);

    this.sternConstraint = new DistanceConstraint(
      this.sternAnchorBody,
      this.boat.hull.body,
      {
        localAnchorA: [0, 0],
        localAnchorB: [this.sternAttachLocal.x, this.sternAttachLocal.y],
        collideConnected: false,
      },
    );
    this.sternConstraint.upperLimitEnabled = true;
    this.sternConstraint.upperLimit = this.sternConstraint.distance;
    this.sternConstraint.lowerLimitEnabled = false;
    this.game.world.constraints.add(this.sternConstraint);

    this.state = "moored";

    this.dispatch("boatMoored", {
      portId: port.getId(),
      portName: port.getName(),
    });
  }

  /** Cast off from the current port */
  castOff(): void {
    if (this.state !== "moored" && this.state !== "mooring") return;

    const port = this.currentPort;

    // Remove constraints
    this.removeConstraints();

    // Apply a small impulse away from dock
    if (port) {
      // Push perpendicular to dock (away from it)
      const portPos = port.getPosition();
      const boatPos = this.boat.getPosition();
      const awayDir = V(boatPos).isub(portPos).inormalize();
      this.boat.hull.body.applyForce(awayDir.imul(CAST_OFF_IMPULSE));

      this.dispatch("boatUnmoored", { portId: port.getId() });
    }

    this.currentPort = null;
    this.state = "free";
  }

  /** Remove all physics objects for mooring */
  private removeConstraints(): void {
    if (this.bowConstraint) {
      this.game.world.constraints.remove(this.bowConstraint);
      this.bowConstraint = null;
    }
    if (this.sternConstraint) {
      this.game.world.constraints.remove(this.sternConstraint);
      this.sternConstraint = null;
    }
    if (this.bowAnchorBody) {
      this.game.world.bodies.remove(this.bowAnchorBody);
      this.bowAnchorBody = null;
    }
    if (this.sternAnchorBody) {
      this.game.world.bodies.remove(this.sternAnchorBody);
      this.sternAnchorBody = null;
    }
  }

  private getBowWorldPosition(): V2d {
    const [hx, hy] = this.boat.hull.body.position;
    return this.bowAttachLocal.rotate(this.boat.hull.body.angle).iadd([hx, hy]);
  }

  private getSternWorldPosition(): V2d {
    const [hx, hy] = this.boat.hull.body.position;
    return this.sternAttachLocal
      .rotate(this.boat.hull.body.angle)
      .iadd([hx, hy]);
  }

  @on("render")
  onRender({ draw }: { draw: Draw }): void {
    if (this.state === "free") return;
    if (!this.currentPort) return;

    const bowWorld = this.getBowWorldPosition();
    const sternWorld = this.getSternWorldPosition();
    const bowCleat = this.currentPort.getBowCleatWorld();
    const sternCleat = this.currentPort.getSternCleatWorld();

    // Draw mooring lines from hull to cleats
    draw.line(bowWorld.x, bowWorld.y, bowCleat.x, bowCleat.y, {
      color: MOORING_LINE_COLOR,
      width: MOORING_LINE_WIDTH,
    });
    draw.line(sternWorld.x, sternWorld.y, sternCleat.x, sternCleat.y, {
      color: MOORING_LINE_COLOR,
      width: MOORING_LINE_WIDTH,
    });
  }

  @on("destroy")
  onDestroy(): void {
    if (this.isAdded) {
      this.removeConstraints();
    }
  }
}
