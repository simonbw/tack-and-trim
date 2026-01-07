# Gameplan: Replace Pixi.js with Custom WebGL 2D Renderer

## Current State

### Rendering Architecture
The game uses Pixi.js v8 for all 2D rendering. The current architecture has redundant state:

```
Entity.position  ←→  Body.position  ←→  Sprite.position
```

Every entity with graphics has to sync these manually in `onRender()`. Additionally, there are parallel hierarchies:
- Entity `children` managed by Game
- Pixi Container `children` managed by Pixi

### Current Files

- **`src/core/graphics/GameRenderer2d.ts`** - Pixi.Application wrapper, layer management
- **`src/core/graphics/Camera2d.ts`** - Uses Pixi.Matrix/Point for transforms
- **`src/core/graphics/LayerInfo.ts`** - Wraps Pixi.Container per layer
- **`src/core/entity/GameSprite.ts`** - Sprite factory functions
- **`src/config/layers.ts`** - 11 layers with parallax settings

### Pixi Usage (31 files)

**Graphics-heavy (procedural drawing):**
- `boat/Sail.ts` - Complex polygon with moveTo/lineTo/fill/stroke
- `WindIndicator.ts` - HUD circles, arrows
- `boat/Hull.ts` - roundShape polygon
- `water/Wake.ts` - Wake trails
- `rope/VerletRope.ts` - Bezier curves
- `boat/Rudder.ts`, `Keel.ts`, `Anchor.ts`, `Bowsprit.ts`, `TellTail.ts`, `Sheet.ts`
- `Buoy.ts`, `BoatSpray.ts`

**Sprite-based:**
- `WindParticles.ts` - Many sprites, uses generateTexture
- `wind-visualization/*.ts` - Sprites from generated textures

**Shader:**
- `water/WaterShader.ts` - Custom GLSL fragment shader
- `water/Water.ts` - Full-screen shader effect

## Desired Changes

Replace Pixi.js with a **custom immediate-mode WebGL renderer**:

1. **No persistent display objects** - Entities draw directly each frame
2. **No redundant state** - Draw at body.position, no sprite.position to sync
3. **Single hierarchy** - Entity tree only, no parallel Pixi scene graph
4. **Imperative API** - `draw.line()`, `draw.circle()`, `draw.sprite()`
5. **Tight V2d integration** - All methods accept V2d directly

**Target scope:** ~1,500-2,000 lines (simpler than retained mode)

## Files to Modify

### New Files to Create

**Core Renderer (~600 lines total):**
```
src/core/graphics/
  Renderer.ts           - WebGL context, draw methods, batching (~450 lines)
  ShaderProgram.ts      - GLSL compile/link, uniform setters (~150 lines)
```

**Support (~350 lines total):**
```
src/core/graphics/
  TextureManager.ts     - Texture loading, generateTexture (~200 lines)
  Matrix3.ts            - 3x3 matrix for 2D transforms (~150 lines)
```

**Shaders:**
```
src/core/graphics/shaders/
  sprite.vert/frag      - Textured quad
  shape.vert/frag       - Solid color shapes
```

### Existing Files to Modify

**Infrastructure (rewrite):**
- `src/core/graphics/GameRenderer2d.ts` → Becomes thin wrapper or merged into Renderer.ts
- `src/core/graphics/Camera2d.ts` - Replace Pixi.Matrix/Point with Matrix3/V2d
- `src/core/graphics/LayerInfo.ts` - Simplify to just config (parallax, shader), no Container
- `src/core/entity/GameSprite.ts` → **DELETE** (no more sprites)
- `src/core/entity/BaseEntity.ts` - Remove `sprite`/`sprites` properties

**Entity rendering (remove sprite, add draw calls):**

All these entities lose their `sprite` property and gain draw code in `onRender()`:
- `src/game/boat/Sail.ts` - Remove sprite, draw polygon directly
- `src/game/WindIndicator.ts` - Remove sprite, draw circles/arrows directly
- `src/game/boat/Hull.ts` - Remove sprite, draw hull shape directly
- `src/game/water/Water.ts` - Becomes a layer shader, no entity needed
- `src/game/water/Wake.ts` - Remove sprite, draw wake directly
- `src/game/rope/VerletRope.ts` - Remove sprite, draw line segments
- `src/game/WindParticles.ts` - Remove sprite hierarchy, draw all particles in loop
- `src/game/wind-visualization/*.ts` - Remove sprites, draw in loop
- `src/game/boat/Rudder.ts`, `Keel.ts`, `Anchor.ts`, `Bowsprit.ts`
- `src/game/boat/TellTail.ts`, `Sheet.ts`, `Rig.ts`
- `src/game/Buoy.ts`, `BoatSpray.ts`

**Shader:**
- `src/game/water/WaterShader.ts` - Adapt to layer shader system

**Cleanup:**
- `src/core/Polyfills.ts` - Remove PIXI global
- `src/core/Game.ts` - Remove sprite add/remove logic from entity lifecycle
- `package.json` - Remove pixi.js dependency

## Execution Order

### Phase 1: Core Renderer (Sequential)

Build the foundation:

```
1. Create Matrix3.ts
   - 3x3 affine transform matrix
   - Integrate with V2d (accept V2d in translate, return V2d from apply)
   - Methods: identity, translate, rotate, scale, multiply, invert, toArray

2. Create ShaderProgram.ts
   - Compile vertex + fragment shaders
   - Link program, cache uniform locations
   - Uniform setters for common types (f32, vec2, vec3, mat3)

3. Create Renderer.ts
   - WebGL context creation
   - Canvas resize handling
   - Frame begin/end, clear
   - All draw methods live here (drawRect, drawCircle, drawImage, etc.)
   - Batches draw calls by shader+texture
   - Flushes batch on layer change or frame end
```

### Phase 2: Drawing Primitives (Sequential)

Build up the Renderer's draw methods:

```
1. Basic shapes
   - renderer.drawRect(x, y, w, h, options)
   - renderer.drawCircle(x, y, r, options)
   - renderer.drawPolygon(vertices, options)
   - renderer.drawLine(x1, y1, x2, y2, options)

2. Images/Sprites
   - Create TextureManager.ts (load images, generateTexture)
   - renderer.drawImage(texture, x, y, options)
   - Options: rotation, scale, alpha, tint, anchor

3. Transform stack
   - renderer.save() / renderer.restore()
   - renderer.translate(x, y) / renderer.rotate(angle) / renderer.scale(s)

4. Path API (for Sail-like shapes)
   - renderer.beginPath() / renderer.moveTo() / renderer.lineTo()
   - renderer.fill(color) / renderer.stroke(color, width)
```

### Phase 3: Layer System (Sequential)

Layers are simple: just render priority + camera transform. No framebuffers needed.

```
1. Update LayerInfo.ts
   - Remove Pixi.Container entirely
   - Keep parallax config
   - Layers are just config, not containers

2. Update Renderer to iterate layers
   - For each layer in order:
     - Set camera transform (applying parallax)
     - Render all entities on that layer
   - Entities specify their layer (or use tags)

3. Water shader is a special case
   - Water entity draws a full-screen quad with custom shader
   - Not a "layer filter", just an entity that draws itself
   - Renders in the "water" layer like any other entity
```

### Phase 4: Integration (Sequential)

Connect new renderer to game:

```
1. Update Camera2d.ts
   - Replace Pixi.Matrix with Matrix3
   - Replace Pixi.Point with V2d
   - Keep getMatrix(), toWorld(), toScreen()

2. Update GameRenderer2d.ts (or replace with Renderer.ts)
   - Remove all Pixi references
   - Renderer has draw methods: drawRect(), drawCircle(), drawSprite(), etc.
   - Wire up layer rendering

3. Update Game.ts
   - Remove sprite add/remove from entity lifecycle
   - Render loop iterates layers, then entities per layer
   - Pass renderer to onRender: entity.onRender(dt, renderer)

4. Update BaseEntity.ts
   - Remove sprite/sprites properties
   - onRender signature changes: onRender(dt: number, renderer: Renderer)
```

### Phase 5: Entity Migration (Parallel by complexity)

Migrate entities from Pixi to immediate-mode drawing:

```
Group A - Simple shapes (can be done in parallel):
├── Hull.ts - draw.polygon()
├── Rudder.ts, Keel.ts - draw.polygon()
├── Anchor.ts - draw.circle() + draw.line()
├── Buoy.ts - draw.circle()
└── Bowsprit.ts - draw.line()

Group B - Complex shapes:
├── Sail.ts - draw.beginPath/moveTo/lineTo/fill
├── WindIndicator.ts - draw.circle() + draw.polygon() for arrows
├── Wake.ts - draw paths
└── TellTail.ts, Sheet.ts - draw.line()

Group C - Sprite-based:
├── WindParticles.ts - loop calling draw.sprite()
└── wind-visualization/*.ts - loop calling draw.sprite()

Group D - Special:
├── VerletRope.ts - draw.line() segments (replace bezier)
└── Water.ts - becomes layer shader config, minimal entity
```

### Phase 6: Cleanup

```
1. Delete src/core/entity/GameSprite.ts
2. Remove pixi.js from package.json
3. Remove PIXI from Polyfills.ts
4. Search for any remaining "pixi" imports
5. npm install to verify clean dependency tree
6. Full playtest
```

## API Design

### Renderer API (passed to onRender)

The renderer is passed directly to `onRender(dt, renderer)` and has all drawing methods:

```typescript
interface DrawOptions {
  color?: number;      // 0xRRGGBB
  alpha?: number;      // 0-1
}

interface SpriteOptions {
  rotation?: number;
  scaleX?: number;
  scaleY?: number;
  alpha?: number;
  tint?: number;
  anchorX?: number;    // 0-1, default 0.5
  anchorY?: number;
}

class Renderer {
  // Transform stack
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  translate(pos: V2d): void;
  rotate(radians: number): void;
  scale(s: number): void;
  scale(sx: number, sy: number): void;

  // Primitives
  drawRect(x: number, y: number, w: number, h: number, opts?: DrawOptions): void;
  drawCircle(x: number, y: number, r: number, opts?: DrawOptions): void;
  drawPolygon(vertices: V2d[] | number[], opts?: DrawOptions): void;
  drawLine(x1: number, y1: number, x2: number, y2: number, opts?: DrawOptions & { width?: number }): void;

  // Sprites/Images
  drawImage(texture: Texture, x: number, y: number, opts?: SpriteOptions): void;

  // Path API (for complex shapes like Sail)
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
  fill(color: number, alpha?: number): void;
  stroke(color: number, width: number, alpha?: number): void;

  // Textures
  generateTexture(draw: (r: Renderer) => void, width: number, height: number): Texture;
}
```

Note: Layer is determined by which layer the entity is on, not by a draw call. The game loop handles this.

### Usage Examples

**Before (Pixi):**
```typescript
// Sail.ts
constructor() {
  this.sprite = createGraphics("sails");
}
onRender() {
  this.sprite.clear();
  this.sprite.moveTo(head.x, head.y);
  for (const body of this.bodies) {
    this.sprite.lineTo(body.position[0], body.position[1]);
  }
  this.sprite.closePath();
  this.sprite.fill({ color: 0xeeeeff });
}
```

**After (Immediate):**
```typescript
// Sail.ts - no constructor sprite setup, no sprite property
// Entity is on "sails" layer (via tag or layer property)
onRender(dt: number, renderer: Renderer) {
  renderer.beginPath();
  renderer.moveTo(head.x, head.y);
  for (const body of this.bodies) {
    renderer.lineTo(body.position[0], body.position[1]);
  }
  renderer.closePath();
  renderer.fill(0xeeeeff);
}
```

**Before (WindParticles):**
```typescript
constructor() {
  this.sprite = createEmptySprite("windParticles");
}
// Each particle has its own Sprite
const particle = new WindParticle(pos, this.game);
this.sprite.addChild(particle.sprite);
// In particle.onRender:
this.sprite.position.copyFrom(this.pos);
this.sprite.alpha = this.alpha;
```

**After (Immediate):**
```typescript
// No sprite property, WindParticle is just data (pos, alpha)
onRender(dt: number, renderer: Renderer) {
  for (const p of this.particles) {
    renderer.drawImage(particleTexture, p.pos.x, p.pos.y, {
      scaleX: scale,
      scaleY: scale,
      alpha: p.alpha,
      tint: COLOR
    });
  }
}
```

### Matrix3 API

```typescript
class Matrix3 {
  static identity(): Matrix3;
  static translation(x: number, y: number): Matrix3;
  static rotation(radians: number): Matrix3;
  static scaling(sx: number, sy: number): Matrix3;

  clone(): Matrix3;
  identity(): this;
  translate(x: number, y: number): this;
  rotate(radians: number): this;
  scale(sx: number, sy?: number): this;
  multiply(other: Matrix3): this;
  premultiply(other: Matrix3): this;
  invert(): this;

  apply(point: V2d): V2d;
  applyInverse(point: V2d): V2d;

  toArray(transpose?: boolean): Float32Array;
  toArray(transpose: boolean, out: Float32Array): Float32Array;
}
```

## Risk Mitigation

1. **Path tessellation** - Use ear-clipping for simple polygons. Sail shapes are convex-ish, should be fine.
2. **generateTexture** - Implement in Phase 2 with TextureManager. WindParticles needs this.
3. **Water shader** - Test early in Phase 3. Critical visual element.
4. **Batching performance** - WindParticles has ~500 sprites. Batch by texture to minimize draw calls.
5. **Transform stack overflow** - Use reasonable stack size (32 should be plenty).

## Testing Strategy

After each phase, verify:

- **Phase 1:** Colored triangle renders to screen
- **Phase 2:** Can draw rect, circle, polygon, sprite. Transform stack works.
- **Phase 3:** Water shader renders correctly. Layer ordering correct.
- **Phase 4:** Camera panning/zooming works. One entity (Hull) renders.
- **Phase 5:** All entities render. Game is playable.
- **Phase 6:** `npm ls pixi.js` returns empty. No console errors.
