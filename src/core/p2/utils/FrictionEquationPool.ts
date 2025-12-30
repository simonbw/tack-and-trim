import Pool, { PoolOptions } from "./Pool";
import FrictionEquation from "../equations/FrictionEquation";
import Body from "../objects/Body";

export default class FrictionEquationPool extends Pool<FrictionEquation> {
  constructor(options?: PoolOptions) {
    super(options);
  }

  create(): FrictionEquation {
    // Create with dummy bodies - will be reassigned when used
    const dummyBody = new Body();
    return new FrictionEquation(dummyBody, dummyBody);
  }

  destroy(_eq: FrictionEquation): FrictionEquationPool {
    return this;
  }
}
