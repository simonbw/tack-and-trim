import { CompatibleVector, V, V2d } from "../Vector";
import { GpuTimer } from "./GpuTimer";
import { Matrix3 } from "./Matrix3";
import {
  ShaderProgram,
  SHAPE_VERTEX_SHADER,
  SHAPE_FRAGMENT_SHADER,
  SPRITE_VERTEX_SHADER,
  SPRITE_FRAGMENT_SHADER,
} from "./ShaderProgram";
import { Texture, TextureManager } from "./TextureManager";

/** Options for sprite drawing */
export interface SpriteOptions {
  rotation?: number;
  scaleX?: number;
  scaleY?: number;
  alpha?: number;
  tint?: number; // 0xRRGGBB
  anchorX?: number; // 0-1, default 0.5
  anchorY?: number; // 0-1, default 0.5
}

// Batch vertex size (position: 2, texCoord: 2, color: 4)
const SPRITE_VERTEX_SIZE = 8;
const SHAPE_VERTEX_SIZE = 6; // position (2) + color (4)
const MAX_BATCH_VERTICES = 65536;
const MAX_BATCH_INDICES = MAX_BATCH_VERTICES * 6;

/**
 * Immediate-mode 2D WebGL renderer.
 * All draw calls are batched and flushed at frame end or on state change.
 */
export class WebGLRenderer {
  readonly canvas: HTMLCanvasElement;
  readonly gl: WebGL2RenderingContext;
  readonly textureManager: TextureManager;

  // Shaders
  private shapeProgram: ShaderProgram;
  private spriteProgram: ShaderProgram;

  // Shape batch buffers
  private shapeVertices: Float32Array;
  private shapeIndices: Uint16Array;
  private shapeVertexBuffer: WebGLBuffer;
  private shapeIndexBuffer: WebGLBuffer;
  private shapeVAO: WebGLVertexArrayObject;
  private shapeVertexCount = 0;
  private shapeIndexCount = 0;

  // Sprite batch buffers
  private spriteVertices: Float32Array;
  private spriteIndices: Uint16Array;
  private spriteVertexBuffer: WebGLBuffer;
  private spriteIndexBuffer: WebGLBuffer;
  private spriteVAO: WebGLVertexArrayObject;
  private spriteVertexCount = 0;
  private spriteIndexCount = 0;
  private currentTexture: Texture | null = null;

  // Transform stack
  private transformStack: Matrix3[] = [];
  private currentTransform: Matrix3 = new Matrix3();

  // View matrix (screen projection)
  private viewMatrix: Matrix3 = new Matrix3();

  // Stats for debugging (current frame, accumulating)
  private drawCallCount: number = 0;
  private triangleCount: number = 0;
  private vertexCount: number = 0;

  // Stats from last completed frame (for display)
  private lastDrawCallCount: number = 0;
  private lastTriangleCount: number = 0;
  private lastVertexCount: number = 0;

  // Pixel ratio for high-DPI displays
  private pixelRatio: number = 1;

  // GPU timing
  private gpuTimer: GpuTimer;

  constructor(canvas?: HTMLCanvasElement) {
    this.canvas = canvas ?? document.createElement("canvas");

    const gl = this.canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      premultipliedAlpha: false,
      powerPreference: "high-performance",
    });
    if (!gl) {
      throw new Error("WebGL2 not supported");
    }
    this.gl = gl;

    // Initialize texture manager
    this.textureManager = new TextureManager(gl);

    // Initialize shaders
    this.shapeProgram = new ShaderProgram(
      gl,
      SHAPE_VERTEX_SHADER,
      SHAPE_FRAGMENT_SHADER,
    );
    this.spriteProgram = new ShaderProgram(
      gl,
      SPRITE_VERTEX_SHADER,
      SPRITE_FRAGMENT_SHADER,
    );

    // Initialize shape batch buffers
    this.shapeVertices = new Float32Array(
      MAX_BATCH_VERTICES * SHAPE_VERTEX_SIZE,
    );
    this.shapeIndices = new Uint16Array(MAX_BATCH_INDICES);

    this.shapeVertexBuffer = gl.createBuffer()!;
    this.shapeIndexBuffer = gl.createBuffer()!;
    this.shapeVAO = gl.createVertexArray()!;

    gl.bindVertexArray(this.shapeVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.shapeVertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.shapeVertices, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.shapeIndexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.shapeIndices, gl.DYNAMIC_DRAW);

    const posLoc = this.shapeProgram.getAttribLocation("a_position");
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(
      posLoc,
      2,
      gl.FLOAT,
      false,
      SHAPE_VERTEX_SIZE * 4,
      0,
    );

    const colorLoc = this.shapeProgram.getAttribLocation("a_color");
    gl.enableVertexAttribArray(colorLoc);
    gl.vertexAttribPointer(
      colorLoc,
      4,
      gl.FLOAT,
      false,
      SHAPE_VERTEX_SIZE * 4,
      2 * 4, // offset after position (2 floats * 4 bytes)
    );

    // Initialize sprite batch buffers
    this.spriteVertices = new Float32Array(
      MAX_BATCH_VERTICES * SPRITE_VERTEX_SIZE,
    );
    this.spriteIndices = new Uint16Array(MAX_BATCH_INDICES);

    this.spriteVertexBuffer = gl.createBuffer()!;
    this.spriteIndexBuffer = gl.createBuffer()!;
    this.spriteVAO = gl.createVertexArray()!;

    gl.bindVertexArray(this.spriteVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.spriteVertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.spriteVertices, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.spriteIndexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.spriteIndices, gl.DYNAMIC_DRAW);

    const sprPosLoc = this.spriteProgram.getAttribLocation("a_position");
    const sprTexLoc = this.spriteProgram.getAttribLocation("a_texCoord");
    const sprColLoc = this.spriteProgram.getAttribLocation("a_color");

    gl.enableVertexAttribArray(sprPosLoc);
    gl.vertexAttribPointer(
      sprPosLoc,
      2,
      gl.FLOAT,
      false,
      SPRITE_VERTEX_SIZE * 4,
      0,
    );
    gl.enableVertexAttribArray(sprTexLoc);
    gl.vertexAttribPointer(
      sprTexLoc,
      2,
      gl.FLOAT,
      false,
      SPRITE_VERTEX_SIZE * 4,
      8,
    );
    gl.enableVertexAttribArray(sprColLoc);
    gl.vertexAttribPointer(
      sprColLoc,
      4,
      gl.FLOAT,
      false,
      SPRITE_VERTEX_SIZE * 4,
      16,
    );

    gl.bindVertexArray(null);

    // Default GL state
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    // Initialize GPU timer
    this.gpuTimer = new GpuTimer(gl);
  }

  /** Resize the canvas to match the window size */
  resize(
    width: number,
    height: number,
    pixelRatio: number = window.devicePixelRatio,
  ): void {
    this.pixelRatio = pixelRatio;
    const w = Math.floor(width * pixelRatio);
    const h = Math.floor(height * pixelRatio);

    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.canvas.style.width = `${width}px`;
      this.canvas.style.height = `${height}px`;
      this.gl.viewport(0, 0, w, h);
    }

    // Update view matrix to convert from pixel coords to clip space
    // Screen coords: (0,0) = top-left, (width, height) = bottom-right
    // Clip space: (-1,-1) = bottom-left, (1,1) = top-right
    this.viewMatrix.identity();
    this.viewMatrix.scale(2 / width, -2 / height);
    this.viewMatrix.translate(-width / 2, -height / 2);
  }

  /** Get logical width in CSS pixels */
  getWidth(): number {
    return this.canvas.width / this.pixelRatio;
  }

  /** Get logical height in CSS pixels */
  getHeight(): number {
    return this.canvas.height / this.pixelRatio;
  }

  /** Begin a new frame */
  beginFrame(): void {
    // Reset transform stack
    this.transformStack.length = 0;
    this.currentTransform.identity();

    // Reset batches
    this.shapeVertexCount = 0;
    this.shapeIndexCount = 0;
    this.spriteVertexCount = 0;
    this.spriteIndexCount = 0;
    this.currentTexture = null;

    // Reset stats
    this.drawCallCount = 0;
    this.triangleCount = 0;
    this.vertexCount = 0;
  }

  /** Get rendering stats from the last completed frame */
  getStats(): {
    drawCalls: number;
    triangles: number;
    vertices: number;
    textures: number;
    canvasWidth: number;
    canvasHeight: number;
    pixelRatio: number;
  } {
    return {
      drawCalls: this.lastDrawCallCount,
      triangles: this.lastTriangleCount,
      vertices: this.lastVertexCount,
      textures: this.textureManager.getTextureCount(),
      canvasWidth: this.canvas.width,
      canvasHeight: this.canvas.height,
      pixelRatio: this.pixelRatio,
    };
  }

  /** Get the number of draw calls in the current/last frame */
  getDrawCallCount(): number {
    return this.drawCallCount;
  }

  /** End frame and flush all batches */
  endFrame(): void {
    this.flushShapes();
    this.flushSprites();

    // Save stats for display (before next beginFrame resets them)
    this.lastDrawCallCount = this.drawCallCount;
    this.lastTriangleCount = this.triangleCount;
    this.lastVertexCount = this.vertexCount;
  }

  /** Clear the screen with a color */
  clear(color: number = 0x000000, alpha: number = 1.0): void {
    const r = ((color >> 16) & 0xff) / 255;
    const g = ((color >> 8) & 0xff) / 255;
    const b = (color & 0xff) / 255;
    this.gl.clearColor(r, g, b, alpha);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
  }

  // ============ Transform Stack ============

  /** Save the current transform */
  save(): void {
    this.transformStack.push(this.currentTransform.clone());
  }

  /** Restore the previous transform */
  restore(): void {
    const prev = this.transformStack.pop();
    if (prev) {
      this.currentTransform = prev;
    } else {
      this.currentTransform.identity();
    }
  }

  /** Translate by (x, y) */
  translate(x: number, y: number): void;
  translate(pos: CompatibleVector): void;
  translate(xOrPos: number | CompatibleVector, y?: number): void {
    if (typeof xOrPos === "number") {
      this.currentTransform.translate(xOrPos, y!);
    } else {
      this.currentTransform.translate(xOrPos[0], xOrPos[1]);
    }
  }

  /** Rotate by angle (radians) */
  rotate(radians: number): void {
    this.currentTransform.rotate(radians);
  }

  /** Scale uniformly or non-uniformly */
  scale(s: number): void;
  scale(sx: number, sy: number): void;
  scale(sx: number, sy?: number): void {
    this.currentTransform.scale(sx, sy ?? sx);
  }

  /** Set a specific transform matrix */
  setTransform(matrix: Matrix3): void {
    this.currentTransform.copyFrom(matrix);
  }

  /** Get the current transform matrix */
  getTransform(): Matrix3 {
    return this.currentTransform.clone();
  }

  // ============ Core Primitive ============

  /**
   * Submit triangles to the shape batch for rendering.
   * This is the core primitive for all shape drawing.
   * Vertices are transformed by the current transform matrix.
   */
  submitTriangles(
    vertices: V2d[],
    indices: number[],
    color: number,
    alpha: number,
  ): void {
    // Check if we need to flush
    if (
      this.shapeVertexCount + vertices.length > MAX_BATCH_VERTICES ||
      this.shapeIndexCount + indices.length > MAX_BATCH_INDICES
    ) {
      this.flushShapes();
    }

    // Extract color components
    const r = ((color >> 16) & 0xff) / 255;
    const g = ((color >> 8) & 0xff) / 255;
    const b = (color & 0xff) / 255;

    const baseVertex = this.shapeVertexCount;

    // Transform and add vertices with per-vertex color
    for (const v of vertices) {
      const transformed = this.currentTransform.apply(v);
      const offset = this.shapeVertexCount * SHAPE_VERTEX_SIZE;
      this.shapeVertices[offset] = transformed[0];
      this.shapeVertices[offset + 1] = transformed[1];
      this.shapeVertices[offset + 2] = r;
      this.shapeVertices[offset + 3] = g;
      this.shapeVertices[offset + 4] = b;
      this.shapeVertices[offset + 5] = alpha;
      this.shapeVertexCount++;
    }

    // Add indices
    for (const idx of indices) {
      this.shapeIndices[this.shapeIndexCount++] = baseVertex + idx;
    }
  }

  /** Flush the shape batch to the GPU */
  private flushShapes(): void {
    if (this.shapeIndexCount === 0) return;

    this.drawCallCount++;
    this.triangleCount += this.shapeIndexCount / 3;
    this.vertexCount += this.shapeVertexCount;

    const gl = this.gl;

    this.shapeProgram.use();

    // Set uniforms (color is now per-vertex, so only matrix needed)
    const projMatrix = this.viewMatrix.toArray();
    this.shapeProgram.setUniformMatrix3fv("u_matrix", projMatrix);

    // Upload data
    gl.bindVertexArray(this.shapeVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.shapeVertexBuffer);
    gl.bufferSubData(
      gl.ARRAY_BUFFER,
      0,
      this.shapeVertices.subarray(0, this.shapeVertexCount * SHAPE_VERTEX_SIZE),
    );
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.shapeIndexBuffer);
    gl.bufferSubData(
      gl.ELEMENT_ARRAY_BUFFER,
      0,
      this.shapeIndices.subarray(0, this.shapeIndexCount),
    );

    // Draw
    gl.drawElements(gl.TRIANGLES, this.shapeIndexCount, gl.UNSIGNED_SHORT, 0);

    // Reset batch
    this.shapeVertexCount = 0;
    this.shapeIndexCount = 0;
  }

  // ============ Sprite Drawing ============

  /** Draw a textured image */
  drawImage(
    texture: Texture,
    x: number,
    y: number,
    opts: SpriteOptions = {},
  ): void {
    // Flush if texture changes
    if (this.currentTexture && this.currentTexture !== texture) {
      this.flushSprites();
    }
    this.currentTexture = texture;

    const rotation = opts.rotation ?? 0;
    const scaleX = opts.scaleX ?? 1;
    const scaleY = opts.scaleY ?? 1;
    const alpha = opts.alpha ?? 1;
    const tint = opts.tint ?? 0xffffff;
    const anchorX = opts.anchorX ?? 0.5;
    const anchorY = opts.anchorY ?? 0.5;

    const w = texture.width * scaleX;
    const h = texture.height * scaleY;
    const ax = w * anchorX;
    const ay = h * anchorY;

    // Calculate rotated corners
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);

    const corners = [
      [-ax, -ay],
      [w - ax, -ay],
      [w - ax, h - ay],
      [-ax, h - ay],
    ];

    const tr = ((tint >> 16) & 0xff) / 255;
    const tg = ((tint >> 8) & 0xff) / 255;
    const tb = (tint & 0xff) / 255;

    const uvs = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];

    // Check if we need to flush
    if (
      this.spriteVertexCount + 4 > MAX_BATCH_VERTICES ||
      this.spriteIndexCount + 6 > MAX_BATCH_INDICES
    ) {
      this.flushSprites();
    }

    const baseVertex = this.spriteVertexCount / SPRITE_VERTEX_SIZE;

    for (let i = 0; i < 4; i++) {
      const [cx, cy] = corners[i];
      const rx = cx * cos - cy * sin + x;
      const ry = cx * sin + cy * cos + y;

      // Apply transform
      const transformed = this.currentTransform.apply(V(rx, ry));

      const offset = this.spriteVertexCount;
      this.spriteVertices[offset] = transformed[0];
      this.spriteVertices[offset + 1] = transformed[1];
      this.spriteVertices[offset + 2] = uvs[i][0];
      this.spriteVertices[offset + 3] = uvs[i][1];
      this.spriteVertices[offset + 4] = tr;
      this.spriteVertices[offset + 5] = tg;
      this.spriteVertices[offset + 6] = tb;
      this.spriteVertices[offset + 7] = alpha;
      this.spriteVertexCount += SPRITE_VERTEX_SIZE;
    }

    // Add indices (two triangles)
    this.spriteIndices[this.spriteIndexCount++] = baseVertex;
    this.spriteIndices[this.spriteIndexCount++] = baseVertex + 1;
    this.spriteIndices[this.spriteIndexCount++] = baseVertex + 2;
    this.spriteIndices[this.spriteIndexCount++] = baseVertex;
    this.spriteIndices[this.spriteIndexCount++] = baseVertex + 2;
    this.spriteIndices[this.spriteIndexCount++] = baseVertex + 3;
  }

  /** Flush the sprite batch to the GPU */
  private flushSprites(): void {
    if (this.spriteIndexCount === 0 || !this.currentTexture) return;

    this.drawCallCount++;
    this.triangleCount += this.spriteIndexCount / 3;
    this.vertexCount += this.spriteVertexCount / SPRITE_VERTEX_SIZE;

    const gl = this.gl;

    this.spriteProgram.use();

    // Set uniforms
    const projMatrix = this.viewMatrix.toArray();
    this.spriteProgram.setUniformMatrix3fv("u_matrix", projMatrix);
    this.spriteProgram.setUniform1i("u_texture", 0);

    // Bind texture
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.currentTexture.glTexture);

    // Upload data
    gl.bindVertexArray(this.spriteVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.spriteVertexBuffer);
    gl.bufferSubData(
      gl.ARRAY_BUFFER,
      0,
      this.spriteVertices.subarray(0, this.spriteVertexCount),
    );
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.spriteIndexBuffer);
    gl.bufferSubData(
      gl.ELEMENT_ARRAY_BUFFER,
      0,
      this.spriteIndices.subarray(0, this.spriteIndexCount),
    );

    // Draw
    gl.drawElements(gl.TRIANGLES, this.spriteIndexCount, gl.UNSIGNED_SHORT, 0);

    // Reset batch
    this.spriteVertexCount = 0;
    this.spriteIndexCount = 0;
  }

  // ============ Texture Generation ============

  /** Generate a texture from draw commands */
  generateTexture(
    draw: (renderer: WebGLRenderer) => void,
    width: number,
    height: number,
  ): Texture {
    const gl = this.gl;

    // Create framebuffer
    const framebuffer = gl.createFramebuffer()!;
    const texture = this.textureManager.createEmpty(width, height);

    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      texture.glTexture,
      0,
    );

    // Save current state
    const oldWidth = this.getWidth();
    const oldHeight = this.getHeight();
    const oldViewMatrix = this.viewMatrix.clone();
    const oldTransform = this.currentTransform.clone();

    // Set up for framebuffer rendering
    gl.viewport(0, 0, width, height);
    this.viewMatrix.identity();
    this.viewMatrix.scale(2 / width, 2 / height);
    this.viewMatrix.translate(-width / 2, -height / 2);
    this.currentTransform.identity();

    // Clear and draw
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.beginFrame();
    draw(this);
    this.endFrame();

    // Restore state
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(framebuffer);
    this.resize(oldWidth, oldHeight, this.pixelRatio);
    this.viewMatrix = oldViewMatrix;
    this.currentTransform = oldTransform;

    return texture;
  }

  // ============ Custom Shader Support ============

  /** Get the WebGL context for custom shader use */
  getGL(): WebGL2RenderingContext {
    return this.gl;
  }

  /** Draw a full-screen quad with a custom shader */
  drawFullscreenQuad(shader: ShaderProgram): void {
    this.flushShapes();
    this.flushSprites();

    const gl = this.gl;
    shader.use();

    // Create a simple fullscreen quad
    const vertices = new Float32Array([
      -1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1,
    ]);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

    const posLoc = shader.getAttribLocation("a_position");
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    gl.drawArrays(gl.TRIANGLES, 0, 6);

    gl.deleteBuffer(buffer);
  }

  // ============ GPU Timing ============

  /** Check if GPU timer extension is available */
  hasGpuTimerSupport(): boolean {
    return this.gpuTimer.hasSupport();
  }

  /** Enable or disable GPU timing */
  setGpuTimingEnabled(enabled: boolean): void {
    this.gpuTimer.setEnabled(enabled);
  }

  /** Check if GPU timing is enabled */
  isGpuTimingEnabled(): boolean {
    return this.gpuTimer.isEnabled();
  }

  /** Debug: get GPU timing status */
  getGpuTimingDebugInfo(): {
    extensionAvailable: boolean;
    enabled: boolean;
    pendingQueries: number;
  } {
    return this.gpuTimer.getDebugInfo();
  }

  /** Begin a GPU-timed section */
  beginGpuTimer(label: string): void {
    this.gpuTimer.begin(label);
  }

  /** End the current GPU-timed section */
  endGpuTimer(): void {
    this.gpuTimer.end();
  }

  /**
   * Poll for completed GPU timer queries and report results to profiler.
   * Call this at the end of each frame.
   */
  pollGpuTimers(): void {
    this.gpuTimer.poll();
  }

  /** Clean up all resources */
  destroy(): void {
    const gl = this.gl;

    // Clean up GPU timer
    this.gpuTimer.destroy();

    this.shapeProgram.destroy();
    this.spriteProgram.destroy();

    gl.deleteBuffer(this.shapeVertexBuffer);
    gl.deleteBuffer(this.shapeIndexBuffer);
    gl.deleteVertexArray(this.shapeVAO);

    gl.deleteBuffer(this.spriteVertexBuffer);
    gl.deleteBuffer(this.spriteIndexBuffer);
    gl.deleteVertexArray(this.spriteVAO);

    this.textureManager.destroy();
  }
}
