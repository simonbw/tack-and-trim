# Config

This folder is where you put code that is mostly for configuring the way the engine works.
The engine expects the files in here to be in place that they are.
You are meant to modify the contents of the files in this folder, but not to add, delete, or move any failes.

## Layers

TODO: Layers documentation

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

Persistence levels determine at what lifecycle stages an entity is cleaned up.

## Collision Groups

TODO: Collision Groups documentation

```

```
