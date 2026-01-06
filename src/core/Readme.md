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

### Sprite

If you want an entity to have a visual representation in the world, you can give it a `sprite`.

```TypeScript
this.sprite = Sprite.from(imageName("favicon"));
```

_Note: `imageName` is a helper function that limits the string type to only names of images found in our `resources/` folder. It's really handy for autocomplete_

### Events

Entities can run code at certain times in the game loop.
The three most important events are probably `onAdd`, `onTick`, and `onRender`.

#### `onAdd?(game: Game)`

Called when added to the game, before dealing with the body, sprite, handlers, or anything else.
Useful for initializing stuff that you need access to the `game` for.

#### `onTick()`

If you want an entity to do something every frame, put that logic in the `onTick()` method.

```TypeScript
  onTick(dt: number) {
    if (this.game!.io.keyIsDown("Space")) {
      // Accelerate upwards
      this.body.applyForce([-10, 0]);
    }
  }
```

#### `onRender?(dt: number)`

Called on every frame right before the screen is redrawn.
Useful for logic like updating the position of the sprite.

```TypeScript
  onRender(dt: number): void {
    this.sprite?.position.set(...this.body.position);
  }
```

### Less important events

`afterAdded?(game: Game)` — Called when added to the game, _after_ the body, sprite, handlers, and everything else is dealt with.
Most of the time you probably want to use `onAdd`, but there are some times when this comes in handy.

`beforeTick?()` — Sometimes you want to make sure stuff happens at the beginning of the tick, before any `onTick()` handlers are called.
That's when this is useful.

`onLateRender?(dt: number)` — Called _right_ before rendering. This is for special cases only

`onPause?()` — Called when the game is paused

`onUnpause?()` — Called when the game is unpaused

`onDestroy?(game: Game)` — Called after being destroyed.

`onResize?(size: [number, number])` — Called when the renderer is resized or recreated for some reason.
You shouldn't need to deal with this often.

### Custom Events

You can define handlers for any type of custom event you want using the `handlers` field.

For example, say we have a `LevelManager` class somewhere that determines when we start a level.
It can dispatch a `levelStarted` event using `Game#dispatch`...

```TypeScript
class LevelManager extends BaseEntity implements Entity {
  //...
  onTick() {
    //...level management stuff
    this.game.dispatch({ type: 'levelStarted', level: 1 });
  }
}
```

and then we can listen for that event in our `Ball` class to do something at the start of a level.

```TypeScript
class Ball extends BaseEntity implements Entity
  handlers = {
    levelStarted: () => {
      this.body.velocity = [0, 0];
    },
  };
```

## Finding Entities

Entities have a `tags` property you can add to them to make them easy to find.
You can use `game.entities.getTagged("yourTagName")` to get a list of all the entities that have `yourTagName` in their `tags` list.
You can also use `game.entities.getTaggedAll` and `game.entities.getTaggedAny` to find entities that match all of a given list of tags, or any of them, respectively.

If you know there is only ever going to be 1 instance of an entity, you can give it an `id`.
This lets you use `game.entities.getById('entityId')` to easily retrieve your entity.
If you try to add an entity to the game with the same `id` as one that is already in the game, it will throw an error, so be cautious with this.

## Graphics

The rendering system is built on [Pixi.js](https://pixijs.com/) with a layer-based architecture for controlling render order.

### Layers

Sprites are organized into **layers** that determine their render order. Layers are defined in `src/config/layers.ts`:

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

Sprites in earlier layers render behind sprites in later layers.

### GameSprite

`GameSprite` extends Pixi's Container with a `layerName` property to specify which layer it renders in:

```TypeScript
import { loadGameSprite, createGraphics } from "core/entity/GameSprite";

// Load an image as a sprite
this.sprite = loadGameSprite("boat", "hull", {
  anchor: [0.5, 0.5],
  size: [100, 50]
});

// Create a graphics object for drawing
this.debugGraphics = createGraphics("debugHud");
```

When an entity with a `sprite` property is added to the game, the sprite is automatically added to the renderer. When the entity is destroyed, the sprite is automatically removed.

### Camera

The camera controls the viewport. Access it via `game.renderer.camera`:

```TypeScript
// Move camera to position
game.renderer.camera.position.set(100, 200);

// Get world coordinates from screen position
const worldPos = game.renderer.camera.toWorldCoords(screenPos);
```

Layers can have different parallax values. A parallax of `V(0, 0)` means the layer stays fixed to the screen (like a HUD), while `V(1, 1)` moves 1:1 with the camera.

### Helper Functions

```TypeScript
import { loadGameSprite, createGraphics, createEmptySprite } from "core/entity/GameSprite";

loadGameSprite(imageName, layerName, options)  // Load image as sprite
createGraphics(layerName)                       // Create Graphics object
createEmptySprite(layerName)                    // Create empty Container
```

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
  onClick() {
    console.log("Left clicked!");
  }
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

<!-- TODO: Write tutorial-style documentation in physics/docs/ -->

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
