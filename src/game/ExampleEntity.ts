import BaseEntity from "../core/entity/BaseEntity";
import Entity from "../core/entity/Entity";

/**
 * An example entity demonstrating basic entity creation and custom event handling.
 * Shows how to extend BaseEntity and implement custom game event responses.
 * Used for testing and as a reference implementation.
 */
export default class ExampleEntity extends BaseEntity implements Entity {
  onExampleEvent({ level, message }: { level: number; message: string }) {
    console.log("ExampleEntity event received", message);
  }
}
