import StaticBody from "../body/StaticBody";
import FrictionEquation from "../equations/FrictionEquation";
import Pool, { PoolOptions } from "./Pool";

export default class FrictionEquationPool extends Pool<FrictionEquation> {
  constructor(options?: PoolOptions) {
    super(options);
  }

  create(): FrictionEquation {
    // Create with dummy bodies - will be reassigned when used
    const dummyBody = new StaticBody();
    return new FrictionEquation(dummyBody, dummyBody);
  }

  destroy(_eq: FrictionEquation): FrictionEquationPool {
    return this;
  }
}
