# Core

These files make up the game "engine". They are a collection of useful patterns that I have developed over many years and many games. I tend to just copy/paste this folder from project to project as I go, rather than actually publishing this as a library because I tend to make lots of upgrades to it,
but sometimes I also make some game-specific changes to it.

## Game

The `Game` class is the top level data structure that is in charge of making everything happen.
There will be exactly

Some things that `Game` does:

- Initializes the physics, rendering, and input handling systems
- Keeps track of entities
- Runs the game loop
- Runs the event system, dispatching events and calling the appropriate handlers on entities

## Entities

Just about anything you want in the game will be implemented as an `Entity`.
This `Entity` is roughly equivalent to Unity's `GameObject`, or Unreal's `Actor`.

Every entity should extend the `BaseEntity` class and implement the `Entity` interface.

```TypeScript
class Ball extends BaseEntity implements Entity  {
  constructor() {
    super()
    // initialize stuff...
  }
}
```

### Body

If you want an entity to be included in the physics simulation, you can give it a `body`.

```TypeScript
const shape = new Circle({ radius: 1 /** in meters, generally */ });
this.body.addShape(shape);
```

If you want to give an entity multiple bodies, you can use the `bodies` field instead.

### Events

Entities respond to game events by implementing handler methods decorated with `@on`.
The three most important events are probably `add`, `tick`, and `render`.

```TypeScript
import { on } from "./entity/handler";
```

#### `@on("add")`

Called when added to the game, before dealing with the body, handlers, or anything else.
Useful for initializing stuff that you need access to the `game` for.

#### `@on("tick")`

If you want an entity to do something every frame, put that logic in the `onTick()` method.

```TypeScript
  @on("tick")
  onTick(dt: number) {
    if (this.game!.io.keyIsDown("Space")) {
      // Accelerate upwards
      this.body.applyForce([-10, 0]);
    }
  }
```

#### `@on("render")`

Called on every frame right before the screen is redrawn.
Useful for drawing visual representations of entities.

```TypeScript
  @on("render")
  onRender({ dt, draw }: GameEventMap["render"]) {
    draw.at({ pos: this.body.position, angle: this.body.angle }, () => {
      draw.fillCircle(0, 0, this.radius, { color: 0xff4422 });
    });
  }
```

### Less important events

`@on("afterAdded")` — Called when added to the game, _after_ the body, sprite, handlers, and everything else is dealt with.
Most of the time you probably want to use `onAdd`, but there are some times when this comes in handy.

`@on("pause")` — Called when the game is paused

`@on("unpause")` — Called when the game is unpaused

`@on("destroy")` — Called after being destroyed.

`@on("resize")` — Called when the renderer is resized or recreated for some reason.
You shouldn't need to deal with this often.

### Custom Events

You can define and handle custom events using the `@on` decorator.

First, define your event type in `src/config/CustomEvent.ts`:

```TypeScript
export type CustomEvents = {
  levelStarted: { level: number };
};
```

Then dispatch events using `game.dispatch()`:

```TypeScript
class LevelManager extends BaseEntity implements Entity {
  @on("tick")
  onTick() {
    //...level management stuff
    this.game.dispatch('levelStarted', { level: 1 });
  }
}
```

And handle them in other entities with the `@on` decorator:

```TypeScript
class Ball extends BaseEntity implements Entity {
  @on("levelStarted")
  onLevelStarted({ level }: GameEventMap["levelStarted"]) {
    this.body.velocity = [0, 0];
    console.log(`Starting level ${level}`);
  }
}
```

The `@on` decorator provides compile-time type checking for handler parameters.

## Finding Entities

Entities have a `tags` property you can add to them to make them easy to find.
You can use `game.entities.getTagged("yourTagName")` to get a list of all the entities that have `yourTagName` in their `tags` list.
You can also use `game.entities.getTaggedAll` and `game.entities.getTaggedAny` to find entities that match all of a given list of tags, or any of them, respectively.

If you know there is only ever going to be 1 instance of an entity, you can give it an `id`.
This lets you use `game.entities.getById('entityId')` to easily retrieve your entity.
If you try to add an entity to the game with the same `id` as one that is already in the game, it will throw an error, so be cautious with this.

## Graphics

The rendering system is built on a **custom WebGPU renderer** with an immediate-mode `Draw` API and a layer-based architecture for controlling render order.

### Immediate-Mode Rendering

Unlike retained-mode systems (like Pixi.js) where you create sprite objects that persist, this engine uses **immediate-mode rendering**. You draw directly each frame using the `Draw` API in your `@on("render")` handler.

```TypeScript
@on("render")
onRender({ draw }: GameEventMap["render"]) {
  // Draw directly each frame - no sprite objects to manage
  draw.at({ pos: this.body.position, angle: this.body.angle }, () => {
    draw.fillCircle(0, 0, this.radius, { color: 0xff4422 });
    draw.strokePolygon(this.vertices, { color: 0x00ff00, width: 2 });
  });
}
```

### Draw API

The `Draw` class provides methods for rendering shapes, images, and paths:

#### Transform Context

```TypeScript
// Apply a transform for all drawing operations within the callback
draw.at({ pos: V(100, 200), angle: Math.PI / 4 }, () => {
  // All drawing here is relative to (100, 200) rotated 45 degrees
  draw.fillCircle(0, 0, 10);
});
```

#### Shapes

```TypeScript
// Circles
draw.fillCircle(x, y, radius, { color: 0xff0000, layerName: "main" });
draw.strokeCircle(x, y, radius, { color: 0x00ff00, width: 2 });

// Rectangles
draw.fillRect(x, y, width, height, { color: 0x0000ff });
draw.strokeRect(x, y, width, height, { color: 0xffff00, width: 1 });

// Polygons (array of V2d vertices)
draw.fillPolygon(vertices, { color: 0xff00ff });
draw.strokePolygon(vertices, { color: 0x00ffff, width: 2 });

// Lines
draw.line(start, end, { color: 0xffffff, width: 1 });
```

All draw methods accept an optional `layerName` parameter to control render order.

### Layers

Drawing operations can specify which **layer** they render in. Layers are defined in `src/config/layers.ts`:

```TypeScript
export const LAYERS = {
  water: new LayerInfo(),      // Rendered first (bottom)
  hull: new LayerInfo(),
  main: new LayerInfo(),       // Default layer
  sails: new LayerInfo(),
  hud: new LayerInfo({ paralax: V(0, 0) }),  // No camera parallax
  // ...
};
```

Earlier layers render behind later layers. Specify the layer in draw calls:

```TypeScript
draw.fillCircle(x, y, radius, { color: 0xff0000, layerName: "water" });
```

### Camera

The camera controls the viewport. Access it via `game.renderer.camera`:

```TypeScript
// Move camera to position
game.renderer.camera.position.set(100, 200);

// Get world coordinates from screen position
const worldPos = game.renderer.camera.toWorldCoords(screenPos);
```

Layers can have different parallax values. A parallax of `V(0, 0)` means the layer stays fixed to the screen (like a HUD), while `V(1, 1)` moves 1:1 with the camera.

## IO

The `IOManager` class (accessible via `game.io`) handles all input from keyboard, mouse, and gamepad.

### Keyboard

```TypeScript
// Check if a key is currently held down
if (this.game.io.isKeyDown("Space")) {
  this.jump();
}

// Handle key press/release events in an entity
class Player extends BaseEntity implements Entity {
  @on("keyDown")
  onKeyDown({ key }: { key: KeyCode }) {
    if (key === "KeyE") {
      this.interact();
    }
  }
}
```

Key codes use the browser's `event.code` format: `"KeyW"`, `"Space"`, `"ArrowUp"`, `"ShiftLeft"`, etc.

### Mouse

```TypeScript
// Check mouse button state
if (this.game.io.lmb) { /* left mouse button down */ }
if (this.game.io.rmb) { /* right mouse button down */ }

// Get mouse position (screen coordinates)
const mousePos = this.game.io.mousePosition;

// Handle click events in an entity
class Clicker extends BaseEntity implements Entity {
  @on("click")
  onClick() {
    console.log("Left clicked!");
  }

  @on("rightClick")
  onRightClick() {
    console.log("Right clicked!");
  }
}
```

### Gamepad

```TypeScript
// Get analog stick input (returns V2d with values -1 to 1)
const leftStick = this.game.io.getStick("left");
const rightStick = this.game.io.getStick("right");

// Get button value (0 to 1 for analog triggers)
const triggerValue = this.game.io.getButton(ControllerButton.RIGHT_TRIGGER);

// Unified movement input (combines WASD/arrows with left stick)
const movement = this.game.io.getMovementVector();
```

### Input Device Detection

```TypeScript
// Check if player is using gamepad (vs keyboard/mouse)
if (this.game.io.usingGamepad) {
  this.showGamepadPrompts();
}

// React to input device changes
class HUD extends BaseEntity implements Entity {
  @on("inputDeviceChange")
  onInputDeviceChange({ usingGamepad }: { usingGamepad: boolean }) {
    this.updateButtonPrompts(usingGamepad);
  }
}
```

## Physics

The physics system is a custom 2D rigid body engine. See [physics/README.md](./physics/README.md) for comprehensive documentation.

Key concepts:

- **World** — The simulation container that manages bodies, constraints, and collision
- **Bodies** — `DynamicBody` (responds to forces), `StaticBody` (immovable), `KinematicBody` (scripted motion)
- **Shapes** — Collision geometry: `Circle`, `Box`, `Convex`, `Capsule`, `Line`, `Plane`, `Particle`, `Heightfield`
- **Constraints** — Maintain relationships between bodies: `DistanceConstraint`, `RevoluteConstraint`, `LockConstraint`
- **Springs** — Soft connections: `LinearSpring`, `RotationalSpring`, `RopeSpring`, and more

## Sound

Playing sounds in the game is done by creating instances of the `SoundInstance` entity and adding them to the game.

### Audio Effects

It is possible to add audio effects to Sound Instances by overriding the `makeChain` method.

## Util

There are a lot of random utilities I've written over the years. In particular, make sure you check out:

- [MathUtil.ts](./util/MathUtil.ts) — Various math stuff like polar/cartesian conversions, interpolations, clamping, etc.
- [Random.ts](./util/Random.ts) — Useful for all sorts of random number stuff. I particularly like `choose(...options)`
- [ColorUtils.ts](./util/ColorUtils.ts) — For dealing with converting colors between different formats, blending/lerping colors, etc.

## Vector

The `V2d` class is a 2D vector that extends Array, so it can be used as `[x, y]` tuples.

### Creating Vectors

Use the `V()` factory function to create vectors:

```TypeScript
import { V } from "core/Vector";

const a = V(3, 4);        // Create from x, y
const b = V([1, 2]);      // Create from array
const c = V(a);           // Clone another vector
const d = V();            // Zero vector (0, 0)
```

### Accessing Components

```TypeScript
const v = V(3, 4);
v.x;           // 3
v.y;           // 4
v[0];          // 3 (same as x)
v[1];          // 4 (same as y)
v.magnitude;   // 5 (length)
v.angle;       // angle in radians from east
```

### Immutable vs. In-Place Operations

Most operations come in two forms:

- **Immutable** (e.g., `add`) — returns a new vector, leaves original unchanged
- **In-place** (e.g., `iadd`) — modifies the vector, prefixed with `i`

```TypeScript
const a = V(1, 2);
const b = V(3, 4);

const c = a.add(b);  // c is [4, 6], a is still [1, 2]
a.iadd(b);           // a is now [4, 6]
```

### Common Operations

```TypeScript
v.add(other)       // Vector addition
v.sub(other)       // Vector subtraction
v.mul(scalar)      // Scalar multiplication
v.div(scalar)      // Scalar division
v.normalize()      // Unit vector (length 1)
v.rotate(angle)    // Rotate by angle (radians)
v.dot(other)       // Dot product
v.crossLength(other) // 2D cross product (z component)
v.distanceTo(other)  // Distance between points
v.lerp(other, t)   // Linear interpolation
v.reflect(normal)  // Reflect across a normal
v.limit(max)       // Clamp magnitude
```

### Coordinate Frame Conversion

Useful for converting between world and local coordinates:

```TypeScript
worldPoint.toLocalFrame(bodyPosition, bodyAngle)
localPoint.toGlobalFrame(bodyPosition, bodyAngle)
```
