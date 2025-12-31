import Material from "./Material";
import Equation from "../equations/Equation";

export interface ContactMaterialOptions {
  friction?: number;
  restitution?: number;
  stiffness?: number;
  relaxation?: number;
  frictionStiffness?: number;
  frictionRelaxation?: number;
  surfaceVelocity?: number;
}

/**
 * Defines what happens when two materials meet, such as what friction coefficient to use.
 */
export default class ContactMaterial {
  static idCounter = 0;

  id: number;
  materialA: Material;
  materialB: Material;
  friction: number;
  restitution: number;
  stiffness: number;
  relaxation: number;
  frictionStiffness: number;
  frictionRelaxation: number;
  surfaceVelocity: number;
  contactSkinSize: number;

  constructor(
    materialA: Material,
    materialB: Material,
    options: ContactMaterialOptions = {}
  ) {
    if (!(materialA instanceof Material) || !(materialB instanceof Material)) {
      throw new Error("First two arguments must be Material instances.");
    }

    this.id = ContactMaterial.idCounter++;
    this.materialA = materialA;
    this.materialB = materialB;

    this.friction =
      options.friction !== undefined ? Number(options.friction) : 0.3;

    this.restitution =
      options.restitution !== undefined ? Number(options.restitution) : 0;

    this.stiffness =
      options.stiffness !== undefined
        ? Number(options.stiffness)
        : Equation.DEFAULT_STIFFNESS;

    this.relaxation =
      options.relaxation !== undefined
        ? Number(options.relaxation)
        : Equation.DEFAULT_RELAXATION;

    this.frictionStiffness =
      options.frictionStiffness !== undefined
        ? Number(options.frictionStiffness)
        : Equation.DEFAULT_STIFFNESS;

    this.frictionRelaxation =
      options.frictionRelaxation !== undefined
        ? Number(options.frictionRelaxation)
        : Equation.DEFAULT_RELAXATION;

    this.surfaceVelocity =
      options.surfaceVelocity !== undefined
        ? Number(options.surfaceVelocity)
        : 0;

    this.contactSkinSize = 0.005;
  }
}
