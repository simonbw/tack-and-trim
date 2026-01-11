import { LayerName } from "../../config/layers";
import { V, V2d } from "../Vector";
import { Camera2d, ViewportProvider } from "./Camera2d";
import { LayerInfo } from "./LayerInfo";
import { Matrix3 } from "./Matrix3";
import { GPUProfiler, GPUProfileSection } from "./webgpu/GPUProfiler";
import { WebGPURenderer } from "./webgpu/WebGPURenderer";

/** Options for the RenderManager constructor */
export interface RenderManagerOptions {
  antialias?: boolean;
  backgroundColor?: number;
}

/**
 * Coordinates rendering for the game.
 * Manages the WebGPU renderer, camera, and layer system.
 */
export class RenderManager implements ViewportProvider {
  private cursor: CSSStyleDeclaration["cursor"] = "none";
  private backgroundColor: number = 0x1a1a2e;

  /** The underlying WebGPU renderer */
  readonly renderer: WebGPURenderer;

  /** Camera for viewport transformations */
  camera: Camera2d;

  /** Store reference for cleanup */
  private boundHandleResize: () => void;

  constructor(
    private layerInfos: Record<LayerName, LayerInfo>,
    private defaultLayerName: LayerName,
    private onResize?: ([width, height]: [number, number]) => void,
  ) {
    this.renderer = new WebGPURenderer();
    this.showCursor();
    this.camera = new Camera2d(this, V(0, 0));

    this.boundHandleResize = () => this.handleResize();
    window.addEventListener("resize", this.boundHandleResize);
  }

  destroy(): void {
    window.removeEventListener("resize", this.boundHandleResize);
    this.canvas.remove();
    this.renderer.destroy();
  }

  async init(options: RenderManagerOptions = {}): Promise<void> {
    if (options.backgroundColor !== undefined) {
      this.backgroundColor = options.backgroundColor;
    }

    // Initialize WebGPU renderer
    await this.renderer.init();

    // Add canvas to document
    document.body.appendChild(this.canvas);

    // Initial resize
    this.handleResize();
  }

  /** Get the canvas element */
  get canvas(): HTMLCanvasElement {
    return this.renderer.canvas;
  }

  /** Request fullscreen on next click */
  requestFullscreen(): void {
    const makeFullScreen = () => {
      this.canvas.requestFullscreen();
      this.canvas.removeEventListener("click", makeFullScreen);
    };
    this.canvas.addEventListener("click", makeFullScreen);
  }

  /** Gets the effective height of the renderer viewport in logical pixels. */
  getHeight(): number {
    return this.renderer.getHeight();
  }

  /** Gets the effective width of the renderer viewport in logical pixels. */
  getWidth(): number {
    return this.renderer.getWidth();
  }

  getSize(): V2d {
    return V(this.getWidth(), this.getHeight());
  }

  handleResize(): void {
    this.renderer.resize(window.innerWidth, window.innerHeight);
    this.onResize?.(this.getSize());
  }

  hideCursor(): void {
    this.cursor = "none";
  }

  showCursor(): void {
    this.cursor = "auto";
  }

  setCursor(value: CSSStyleDeclaration["cursor"]): void {
    this.cursor = value;
  }

  /** Get the layer infos */
  getLayers(): Record<LayerName, LayerInfo> {
    return this.layerInfos;
  }

  /** Get layer names in render order */
  getLayerNames(): LayerName[] {
    return Object.keys(this.layerInfos) as LayerName[];
  }

  /** Get the camera transform for a specific layer */
  getLayerTransform(layerName: LayerName): Matrix3 {
    const layer = this.layerInfos[layerName];
    return this.camera.getMatrix(layer.parallax, layer.anchor);
  }

  /** Begin rendering a frame */
  beginFrame(): void {
    this.renderer.beginFrame();
  }

  /** End the frame and present */
  endFrame(): void {
    this.renderer.endFrame();

    // Update cursor
    if (this.canvas.style) {
      this.canvas.style.cursor = this.cursor;
    }
  }

  /** Clear the screen */
  clear(color?: number): void {
    this.renderer.clear(color ?? this.backgroundColor);
  }

  /** Set up the renderer for drawing on a specific layer */
  setLayer(layerName: LayerName): void {
    const transform = this.getLayerTransform(layerName);
    this.renderer.setTransform(transform);
  }

  /** Get the low-level renderer for direct drawing */
  getRenderer(): WebGPURenderer {
    return this.renderer;
  }

  // ============ GPU Timing ============

  /** Check if GPU timing (timestamp queries) is supported */
  hasGpuTimerSupport(): boolean {
    return this.renderer.hasGpuTimerSupport();
  }

  /** Enable or disable GPU timing */
  setGpuTimingEnabled(enabled: boolean): void {
    this.renderer.setGpuTimingEnabled(enabled);
  }

  /** Check if GPU timing is enabled */
  isGpuTimingEnabled(): boolean {
    return this.renderer.isGpuTimingEnabled();
  }

  /** Get GPU time in milliseconds for a specific section (default: render) */
  getGpuMs(section?: GPUProfileSection): number {
    return this.renderer.getGpuMs(section);
  }

  /** Get all GPU section timings */
  getAllGpuMs(): Record<GPUProfileSection, number> | null {
    return this.renderer.getAllGpuMs();
  }

  /** Get the GPU profiler instance (for external systems like water compute) */
  getGpuProfiler(): GPUProfiler | null {
    return this.renderer.getGpuProfiler();
  }
}
