import Body from "../body/Body";
import ContactEquation from "../equations/ContactEquation";
import Pool, { PoolOptions } from "./Pool";

export default class ContactEquationPool extends Pool<ContactEquation> {
  constructor(options?: PoolOptions) {
    super(options);
  }

  create(): ContactEquation {
    // Create with dummy bodies - will be reassigned when used
    const dummyBody = new Body();
    return new ContactEquation(dummyBody, dummyBody);
  }

  destroy(_eq: ContactEquation): ContactEquationPool {
    return this;
  }
}
