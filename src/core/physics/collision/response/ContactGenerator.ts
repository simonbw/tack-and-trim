import ContactEquation from "../../equations/ContactEquation";
import ContactMaterial from "../../material/ContactMaterial";
import { Collision } from "../pipeline/getContactsFromCollisionPairs";

/**
 * Parameters for contact equation generation
 */
export interface ContactParams {
  /** Restitution (bounciness) coefficient (0 = no bounce, 1 = max bounce) */
  restitution: number;
  /** Contact stiffness */
  stiffness: number;
  /** Contact relaxation */
  relaxation: number;
  /** Whether equations should be enabled */
  enabled: boolean;
  /** Contact skin size (offset) */
  contactSkinSize: number;
}

/**
 * Generate contact equations from a collision result
 */
export function generateContactEquationsForCollision(
  { bodyA, shapeA, bodyB, shapeB, contacts }: Collision,
  contactMaterial: ContactMaterial,
  isFirstImpact: boolean
): ContactEquation[] {
  // Only enable equations if all parties have collisionResponse enabled
  const enabled =
    bodyA.collisionResponse &&
    bodyB.collisionResponse &&
    shapeA.collisionResponse &&
    shapeB.collisionResponse;

  return contacts.map((contact) => {
    const eq = new ContactEquation(bodyA, bodyB);
    eq.shapeA = shapeA;
    eq.shapeB = shapeB;

    eq.restitution = contactMaterial.restitution;
    eq.stiffness = contactMaterial.stiffness;
    eq.relaxation = contactMaterial.relaxation;
    eq.offset = contactMaterial.contactSkinSize;

    eq.normalA.set(contact.normal);
    eq.contactPointA.set(contact.worldContactA);
    eq.contactPointB.set(contact.worldContactB);

    eq.needsUpdate = true;
    eq.enabled = enabled;
    eq.firstImpact = isFirstImpact;

    return eq;
  });
}
