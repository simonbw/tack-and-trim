# Config

This folder is where you put code that is mostly for configuring the way the engine works.
The engine expects the files in here to be in place that they are.
You are meant to modify the contents of the files in this folder, but not to add, delete, or move any files.

## Layers

Layers (`layers.ts`) control the rendering order of entities. Layers are rendered in the order they are defined in the `LAYERS` object—the first layer is rendered first (at the bottom), and the last layer is rendered last (on top).

### Defining Layers

```typescript
export const LAYERS = {
  background: new LayerInfo(),
  main: new LayerInfo(),
  hud: new LayerInfo({ parallax: V(0, 0) }),
} satisfies { [key: string]: LayerInfo };
```

### LayerInfo Options

Each layer is a `LayerInfo` instance with the following options:

- `parallax` - A `V2d` controlling how the layer moves relative to the camera. `V(1, 1)` (default) moves with the camera, `V(0, 0)` stays fixed on screen (useful for HUD elements).
- `anchor` - Anchor point for parallax transformations.
- `alpha` - Layer transparency from 0 to 1. Default is 1 (fully opaque). Set to 0 to hide the layer.

### Assigning Entities to Layers

Entities specify their render layer via the `layer` property:

```typescript
class MyEntity extends BaseEntity implements Entity {
  layer = "main"; // Single layer
}
```

For entities that need to render on multiple layers, use the `layers` property instead:

```typescript
class ComplexEntity extends BaseEntity implements Entity {
  layers = ["water", "main", "hud"] as const; // Renders on multiple layers
}
```

When using `layers`, the `onRender` callback is called once for each layer, and you can check which layer is being rendered via the `layer` parameter:

```typescript
onRender({ dt, layer, draw }: RenderEventData) {
  if (layer === "water") {
    // Draw water effects
  } else if (layer === "main") {
    // Draw main sprite
  }
}
```

The default layer is `"main"` if neither `layer` nor `layers` is specified.

## Tick Layers

Tick layers (`tickLayers.ts`) control the order in which entities are updated each tick. This is useful when certain systems need to run before others.

### Defining Tick Layers

```typescript
export const TICK_LAYERS = [
  "input",       // Player input handling - processed earliest
  "environment", // Wind/water systems
  "main",        // Default layer for most entities
  "effects",     // Particle effects
  "camera",      // Camera follows final positions
] as const;
```

### Assigning Entities to Tick Layers

Entities specify their tick layer via the `tickLayer` property:

```typescript
class CameraController extends BaseEntity implements Entity {
  tickLayer = "camera"; // Updates after everything else
}
```

For entities that need to tick on multiple layers, use `tickLayers`:

```typescript
class WindSystem extends BaseEntity implements Entity {
  tickLayers = ["environment", "effects"] as const;
}
```

The default tick layer is `"main"` if neither `tickLayer` nor `tickLayers` is specified.

## Custom Events

You can define custom events in `CustomEvent.ts` that will then be available for dispatch via `game.dispatch()` or handling via `entity.onX` methods. For example, defining an example event

```typescript
export type CustomEvents = {
  // ...
  exampleEvent: { level: number; message: string };
};
```

You can dispatch this event with

```typescript
game.dispatch("exampleEvent", { level: 1, message: "example message" });
```

and react to this event by defining a handler on an entity with

```typescript
class ExampleEntity extends BaseEntity implements Entity {
  onExampleEvent({ level, message }: { level: number; message: string }) {
    console.log("ExampleEntity event received");
  }
}
```

## Persistence Levels

Persistence levels (`constants.ts`) determine at what lifecycle stages an entity is cleaned up. This is useful for keeping certain entities around across level transitions or game restarts.

```typescript
export enum Persistence {
  Level = 0,     // DEFAULT - cleared at the end of each level
  Game = 1,      // Cleared at the end of each game
  Permanent = 2, // Never cleared automatically
}
```

### Using Persistence Levels

Set the `persistenceLevel` property on your entity:

```typescript
class HUDElement extends BaseEntity implements Entity {
  persistenceLevel = Persistence.Game; // Survives level transitions
}

class AudioManager extends BaseEntity implements Entity {
  persistenceLevel = Persistence.Permanent; // Never automatically cleared
}
```

### Clearing Entities

Use `game.clearScene(threshold)` to remove all entities with `persistenceLevel <= threshold`:

```typescript
// Clear all Level entities (threshold defaults to 0)
game.clearScene();

// Clear Level and Game entities
game.clearScene(Persistence.Game);
```

Entities with `persistenceLevel = 0` (the default) are cleared when calling `game.clearScene()` with no arguments, which is typically done at the end of each level.

## Collision Groups

Collision groups (`CollisionGroups.ts`) control which physics shapes can collide with each other using bit masks. This allows you to create categories of objects that only interact with specific other categories.

### Defining Collision Groups

```typescript
export const CollisionGroups = makeCollisionGroups([
  "Environment",
  "Boat",
  "Projectile",
] as const);
```

The `makeCollisionGroups` helper automatically:
- Assigns a unique bit value to each group
- Creates `All` (all groups combined) and `None` (no groups) entries

### Using Collision Groups

When creating a shape, specify its `collisionGroup` (what group it belongs to) and `collisionMask` (what groups it can collide with):

```typescript
const boatShape = new Circle({
  radius: 10,
  collisionGroup: CollisionGroups.Boat,
  collisionMask: CollisionGroups.Environment | CollisionGroups.Boat,
});
```

Two shapes will only collide if **both** of these conditions are true:
- `(shapeA.collisionGroup & shapeB.collisionMask) !== 0`
- `(shapeB.collisionGroup & shapeA.collisionMask) !== 0`

### Common Patterns

```typescript
// Collides with everything
collisionMask: CollisionGroups.All

// Collides with nothing (sensor-only)
collisionMask: CollisionGroups.None

// Collides with specific groups
collisionMask: CollisionGroups.Environment | CollisionGroups.Boat
```

## Collision Materials

Collision materials (`CollisionMaterials.ts`) define physical properties like friction and restitution (bounciness) for different material combinations.

### Defining Materials

```typescript
export const Materials = {
  Boat: new Material(),
  Ice: new Material(),
} as const;
```

### Defining Contact Materials

Contact materials specify how two materials interact when they collide:

```typescript
export const ContactMaterials: ReadonlyArray<ContactMaterial> = [
  new ContactMaterial(Materials.Boat, Materials.Boat, { restitution: 0.8 }),
  new ContactMaterial(Materials.Boat, Materials.Ice, { friction: 0.1 }),
];
```

### Assigning Materials to Shapes

```typescript
const boatShape = new Circle({
  radius: 10,
  material: Materials.Boat,
});
```

When two shapes with materials collide, the physics engine looks up the corresponding `ContactMaterial` to determine the friction and restitution values for that collision.
