/**
 * Interactive rope pattern test controller.
 *
 * Renders several horizontal rope strips and provides an HTML overlay panel
 * with controls for editing the current RopePattern (type, carrier count,
 * per-carrier colors). Loads presets and exports the current config as a
 * ready-to-paste snippet.
 */

import { BaseEntity } from "../core/entity/BaseEntity";
import { on } from "../core/entity/handler";
import type { Draw } from "../core/graphics/Draw";
import {
  MAX_CARRIERS,
  type RopePattern,
  RopeShaderInstance,
} from "../game/boat/RopeShader";
import {
  extractCameraTransform,
  tessellateRopeStrip,
} from "../game/boat/tessellation";

// ─── Presets ────────────────────────────────────────────────────

interface RopePreset {
  label: string;
  pattern: RopePattern;
}

// Helper to build a 16-carrier symmetric braid pattern from an 8-carrier
// S-laid array (repeats for Z-laid).
function sym16(sLaid: number[]): number[] {
  return [...sLaid, ...sLaid];
}

// Helper: mostly-base with a single colored carrier at the given index.
function singleFleck(base: number, tracer: number, idx: number): number[] {
  const s = Array(8).fill(base);
  s[idx] = tracer;
  return sym16(s);
}

// Helper: mostly-base with an adjacent pair of colored carriers.
function pairFleck(base: number, tracer: number, idx: number): number[] {
  const s = Array(8).fill(base);
  s[idx] = tracer;
  s[(idx + 1) % 8] = tracer;
  return sym16(s);
}

const PRESETS: RopePreset[] = [
  // --- Classic Marlowbraid-style sheets ---
  {
    label: "Marlowbraid Red",
    pattern: {
      type: "braid",
      carriers: sym16([
        0xeeeeee, 0xcc2222, 0xcc2222, 0xeeeeee, 0xeeeeee, 0x222222, 0xeeeeee,
        0xeeeeee,
      ]),
      helixAngle: 35,
    },
  },
  {
    label: "Marlowbraid Red 2/2 twill",
    pattern: {
      type: "braid",
      carriers: sym16([
        0xeeeeee, 0xcc2222, 0xcc2222, 0xeeeeee, 0xeeeeee, 0x222222, 0xeeeeee,
        0xeeeeee,
      ]),
      weave: [2, 2],
      helixAngle: 35,
    },
  },
  {
    label: "Marlowbraid Blue",
    pattern: {
      type: "braid",
      carriers: sym16([
        0xeeeeee, 0x2255cc, 0x2255cc, 0xeeeeee, 0xeeeeee, 0x222222, 0xeeeeee,
        0xeeeeee,
      ]),
      helixAngle: 35,
    },
  },
  {
    label: "Asymmetric 16-plait",
    pattern: {
      type: "braid",
      carriers: [
        0xeeeeee, 0xcc2222, 0xcc2222, 0xeeeeee, 0xeeeeee, 0x222222, 0xeeeeee,
        0xeeeeee, 0xeeeeee, 0xeeeeee, 0x2255cc, 0x2255cc, 0xeeeeee, 0xeeeeee,
        0x222222, 0xeeeeee,
      ],
      helixAngle: 35,
    },
  },

  // --- Sparse tracers (single fleck) ---
  {
    label: "White + red fleck",
    pattern: {
      type: "braid",
      carriers: singleFleck(0xeeeeee, 0xcc2222, 2),
      weave: [2, 2],
      helixAngle: 35,
    },
  },
  {
    label: "White + blue fleck",
    pattern: {
      type: "braid",
      carriers: singleFleck(0xeeeeee, 0x2255cc, 2),
      weave: [2, 2],
      helixAngle: 35,
    },
  },
  {
    label: "White + black tracer",
    pattern: {
      type: "braid",
      carriers: singleFleck(0xeeeeee, 0x222222, 2),
      helixAngle: 35,
    },
  },
  {
    label: "White + red pair",
    pattern: {
      type: "braid",
      carriers: pairFleck(0xeeeeee, 0xcc2222, 2),
      weave: [2, 2],
      helixAngle: 35,
    },
  },
  {
    label: "Navy + white tracer",
    pattern: {
      type: "braid",
      carriers: singleFleck(0x113366, 0xeeeeee, 2),
      helixAngle: 35,
    },
  },
  {
    label: "Gray + red pair",
    pattern: {
      type: "braid",
      carriers: pairFleck(0x999999, 0xcc2222, 2),
      helixAngle: 35,
    },
  },
  {
    label: "Hi-vis orange + black",
    pattern: {
      type: "braid",
      carriers: singleFleck(0xee6622, 0x111111, 2),
      weave: [2, 2],
      helixAngle: 35,
    },
  },
  {
    label: "Tan + dark tracer",
    pattern: {
      type: "braid",
      carriers: pairFleck(0xa67840, 0x3a2410, 2),
      helixAngle: 35,
    },
  },

  // --- Bolder patterns ---
  {
    label: "Red dominant 2/1",
    pattern: {
      type: "braid",
      carriers: [
        0xcc2222, 0xcc2222, 0xcc2222, 0xcc2222, 0xcc2222, 0xcc2222, 0xcc2222,
        0xcc2222, 0xeeeeee, 0xeeeeee, 0xeeeeee, 0xeeeeee, 0xeeeeee, 0xeeeeee,
        0xeeeeee, 0xeeeeee,
      ],
      weave: [2, 1],
      helixAngle: 40,
    },
  },
  {
    label: "Green / Gold bands",
    pattern: {
      type: "braid",
      carriers: sym16([
        0x22aa44, 0x22aa44, 0xddaa00, 0xddaa00, 0x22aa44, 0x22aa44, 0xddaa00,
        0xddaa00,
      ]),
      helixAngle: 40,
    },
  },
  {
    label: "Yellow dock line",
    pattern: {
      type: "braid",
      carriers: sym16([
        0xddaa00, 0xddaa00, 0x222222, 0xddaa00, 0xddaa00, 0xddaa00, 0x222222,
        0xddaa00,
      ]),
      helixAngle: 32,
    },
  },

  // --- Special constructions ---
  {
    label: "8-plait anchor rode",
    pattern: {
      type: "braid",
      carriers: [
        0x888866, 0x666644, 0x888866, 0x888866, 0x888866, 0x666644, 0x888866,
        0x888866,
      ],
      helixAngle: 30,
    },
  },
  {
    label: "Dyneema 12-strand",
    pattern: {
      type: "braid",
      carriers: [
        0xcccccc, 0xcccccc, 0x444488, 0xcccccc, 0xcccccc, 0xcccccc, 0xcccccc,
        0xcccccc, 0xcccccc, 0xcccccc, 0xcccccc, 0xcccccc,
      ],
      helixAngle: 25,
    },
  },
  {
    label: "Dyneema (16-plait)",
    pattern: {
      type: "braid",
      carriers: sym16([
        0xaaaaaa, 0x888888, 0xaaaaaa, 0x888888, 0xaaaaaa, 0x888888, 0xaaaaaa,
        0x888888,
      ]),
      helixAngle: 30,
    },
  },

  // --- Traditional laid ropes ---
  {
    label: "3-strand laid (red/white)",
    pattern: {
      type: "laid",
      carriers: [0xcc2222, 0xeeeeee, 0xcc2222],
      helixAngle: 38,
    },
  },
  {
    label: "3-strand manila",
    pattern: {
      type: "laid",
      carriers: [0xa67840, 0x8a6030, 0xa67840],
      helixAngle: 38,
    },
  },
  {
    label: "Solid anchor rode",
    pattern: {
      type: "laid",
      carriers: [0x333322],
      helixAngle: 30,
    },
  },
];

// ─── Test ropes ──────────────────────────────────────────────────

interface TestRope {
  y: number;
  width: number;
  shader: RopeShaderInstance;
}

const ROPE_LENGTH = 20;
const ROPE_POINT_COUNT = 40;

// ─── Controller ──────────────────────────────────────────────────

export class RopeTestController extends BaseEntity {
  private pattern: RopePattern = {
    type: "braid",
    carriers: Array(16).fill(0xeeeeee),
    weave: [1, 1],
    helixAngle: 45,
  };

  /** Active color — clicking a carrier sets it to this. */
  private activeColor = 0xeeeeee;
  /** Custom color picker (rightmost swatch). */
  private customColorInput!: HTMLInputElement;
  /** Swatch buttons so we can update the "active" highlight. */
  private swatchButtons: HTMLButtonElement[] = [];

  private ropes: TestRope[] = [];
  private points: [number, number][] = [];
  private zValues: number[] = [];

  // DOM
  private panel!: HTMLDivElement;
  private typeSelect!: HTMLSelectElement;
  private carrierCountInput!: HTMLInputElement;
  private weaveOverInput!: HTMLInputElement;
  private weaveUnderInput!: HTMLInputElement;
  private helixAngleInput!: HTMLInputElement;
  private helixAngleValue!: HTMLSpanElement;
  private carrierGrid!: HTMLDivElement;
  private wheelHandler: ((e: WheelEvent) => void) | null = null;

  onAdd() {
    // Straight horizontal centerline
    for (let i = 0; i < ROPE_POINT_COUNT; i++) {
      const t = i / (ROPE_POINT_COUNT - 1);
      this.points.push([(t - 0.5) * ROPE_LENGTH, 0]);
      this.zValues.push(3);
    }

    // Test ropes at different thicknesses
    const configs = [
      { y: 3.0, width: 0.6 },
      { y: 1.5, width: 0.3 },
      { y: 0.3, width: 0.15 },
      { y: -0.6, width: 0.08 },
      { y: -1.3, width: 0.04 },
    ];
    for (const cfg of configs) {
      this.ropes.push({
        ...cfg,
        shader: new RopeShaderInstance(ROPE_POINT_COUNT),
      });
    }

    this.createUI();
    this.applyPreset(PRESETS[0]);

    // Scroll wheel zoom
    const canvas = this.game.renderer.canvas;
    this.wheelHandler = (e: WheelEvent) => {
      // Ignore wheel events over the control panel
      if (this.panel.contains(e.target as Node)) return;
      e.preventDefault();
      const camera = this.game.renderer.camera;
      const factor = e.deltaY > 0 ? 0.97 : 1.03;
      camera.z = Math.max(5, Math.min(1000, camera.z * factor));
    };
    canvas.addEventListener("wheel", this.wheelHandler, { passive: false });
  }

  onDestroy() {
    for (const rope of this.ropes) rope.shader.destroy();
    this.panel?.remove();
    if (this.wheelHandler) {
      this.game.renderer.canvas.removeEventListener("wheel", this.wheelHandler);
    }
  }

  @on("render")
  onRender({ draw }: { draw: Draw }) {
    const renderer = draw.renderer;
    const cam = extractCameraTransform(renderer.getTransform());

    for (const rope of this.ropes) {
      const pts: [number, number][] = this.points.map(([x]) => [x, rope.y]);
      const { vertexCount, indexCount } = tessellateRopeStrip(
        pts,
        this.zValues,
        rope.width,
        cam,
        rope.shader.scratchVertexData,
        rope.shader.scratchIndexData,
      );
      if (vertexCount === 0) continue;
      renderer.flush();
      rope.shader.draw(
        renderer,
        rope.shader.scratchVertexData,
        vertexCount,
        rope.shader.scratchIndexData,
        indexCount,
        this.pattern,
        1,
        rope.width,
      );
    }
  }

  // ─── UI ─────────────────────────────────────────────────────

  private createUI() {
    this.panel = document.createElement("div");
    Object.assign(this.panel.style, {
      position: "fixed",
      top: "16px",
      right: "16px",
      width: "320px",
      maxHeight: "calc(100vh - 32px)",
      overflowY: "auto",
      background: "rgba(20, 20, 40, 0.92)",
      border: "1px solid #444",
      borderRadius: "8px",
      padding: "16px",
      fontFamily: "system-ui, sans-serif",
      fontSize: "13px",
      color: "#ccc",
      zIndex: "100",
      display: "flex",
      flexDirection: "column",
      gap: "12px",
    });
    document.body.appendChild(this.panel);

    // Title
    const title = document.createElement("div");
    title.textContent = "Rope Pattern Test";
    Object.assign(title.style, {
      fontSize: "15px",
      fontWeight: "bold",
      color: "#eee",
      marginBottom: "4px",
    });
    this.panel.appendChild(title);

    // Type selector
    this.typeSelect = this.addSelect("Type", ["laid", "braid"], () => {
      this.pattern = {
        type: this.typeSelect.value as "laid" | "braid",
        carriers: this.pattern.carriers.slice(),
      };
      // Ensure even count for braid
      if (
        this.pattern.type === "braid" &&
        this.pattern.carriers.length % 2 === 1
      ) {
        this.pattern.carriers.push(this.pattern.carriers[0] ?? 0xeeeeee);
      }
      this.rebuildCarrierGrid();
    });

    // Carrier count
    const countRow = document.createElement("div");
    Object.assign(countRow.style, {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
    });
    const countLabel = document.createElement("div");
    countLabel.textContent = "Carrier count";
    countRow.appendChild(countLabel);
    this.carrierCountInput = document.createElement("input");
    this.carrierCountInput.type = "number";
    this.carrierCountInput.min = "2";
    this.carrierCountInput.max = String(MAX_CARRIERS);
    this.carrierCountInput.step = this.pattern.type === "braid" ? "2" : "1";
    Object.assign(this.carrierCountInput.style, {
      width: "60px",
      background: "#333",
      color: "#ccc",
      border: "1px solid #555",
      borderRadius: "4px",
      padding: "3px 6px",
      fontSize: "12px",
    });
    this.carrierCountInput.addEventListener("change", () => {
      let n = parseInt(this.carrierCountInput.value, 10);
      if (isNaN(n)) return;
      n = Math.max(1, Math.min(n, MAX_CARRIERS));
      // For braid, snap to even count
      if (this.pattern.type === "braid" && n % 2 === 1) n += 1;
      this.resizeCarriers(n);
      this.carrierCountInput.value = String(n);
    });
    countRow.appendChild(this.carrierCountInput);
    this.panel.appendChild(countRow);

    // Weave pattern (over / under)
    const weaveRow = document.createElement("div");
    Object.assign(weaveRow.style, {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
    });
    const weaveLabel = document.createElement("div");
    weaveLabel.textContent = "Weave (over / under)";
    weaveRow.appendChild(weaveLabel);

    const weaveInputs = document.createElement("div");
    Object.assign(weaveInputs.style, {
      display: "flex",
      gap: "4px",
      alignItems: "center",
    });

    const makeWeaveInput = (initial: number): HTMLInputElement => {
      const input = document.createElement("input");
      input.type = "number";
      input.min = "1";
      input.max = "8";
      input.value = String(initial);
      Object.assign(input.style, {
        width: "40px",
        background: "#333",
        color: "#ccc",
        border: "1px solid #555",
        borderRadius: "4px",
        padding: "3px 6px",
        fontSize: "12px",
      });
      return input;
    };

    this.weaveOverInput = makeWeaveInput(this.pattern.weave?.[0] ?? 1);
    this.weaveUnderInput = makeWeaveInput(this.pattern.weave?.[1] ?? 1);
    const updateWeave = () => {
      const over = Math.max(1, parseInt(this.weaveOverInput.value, 10) || 1);
      const under = Math.max(1, parseInt(this.weaveUnderInput.value, 10) || 1);
      this.pattern = { ...this.pattern, weave: [over, under] };
    };
    this.weaveOverInput.addEventListener("change", updateWeave);
    this.weaveUnderInput.addEventListener("change", updateWeave);

    const slash = document.createElement("span");
    slash.textContent = "/";
    Object.assign(slash.style, { color: "#666" });

    weaveInputs.appendChild(this.weaveOverInput);
    weaveInputs.appendChild(slash);
    weaveInputs.appendChild(this.weaveUnderInput);
    weaveRow.appendChild(weaveInputs);
    this.panel.appendChild(weaveRow);

    // Helix angle slider
    const helixRow = document.createElement("div");
    Object.assign(helixRow.style, {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: "8px",
    });
    const helixLabel = document.createElement("div");
    helixLabel.textContent = "Helix angle";
    helixRow.appendChild(helixLabel);

    this.helixAngleInput = document.createElement("input");
    this.helixAngleInput.type = "range";
    this.helixAngleInput.min = "15";
    this.helixAngleInput.max = "75";
    this.helixAngleInput.step = "1";
    this.helixAngleInput.value = String(this.pattern.helixAngle ?? 45);
    Object.assign(this.helixAngleInput.style, {
      flex: "1",
      minWidth: "0",
    });

    this.helixAngleValue = document.createElement("span");
    this.helixAngleValue.textContent = `${this.pattern.helixAngle ?? 45}°`;
    Object.assign(this.helixAngleValue.style, {
      width: "32px",
      textAlign: "right",
      color: "#aaa",
      fontSize: "12px",
    });

    this.helixAngleInput.addEventListener("input", () => {
      const angle = parseInt(this.helixAngleInput.value, 10);
      this.pattern = { ...this.pattern, helixAngle: angle };
      this.helixAngleValue.textContent = `${angle}°`;
    });

    helixRow.appendChild(this.helixAngleInput);
    helixRow.appendChild(this.helixAngleValue);
    this.panel.appendChild(helixRow);

    // Color palette
    const paletteLabel = document.createElement("div");
    paletteLabel.textContent = "Paint color (click to paint carriers)";
    Object.assign(paletteLabel.style, { color: "#999", fontSize: "11px" });
    this.panel.appendChild(paletteLabel);

    const paletteRow = document.createElement("div");
    Object.assign(paletteRow.style, {
      display: "grid",
      gridTemplateColumns: "repeat(12, 1fr)",
      gap: "3px",
    });
    this.panel.appendChild(paletteRow);

    const PALETTE = [
      0xeeeeee, 0xdddddd, 0xaaaaaa, 0x777777, 0x222222, 0xcc2222, 0xee6622,
      0xddaa00, 0x22aa44, 0x2255cc, 0x113388, 0xa67840,
    ];
    for (const color of PALETTE) {
      const btn = document.createElement("button");
      Object.assign(btn.style, {
        width: "100%",
        height: "22px",
        background: hexToCSS(color),
        border: "2px solid transparent",
        borderRadius: "3px",
        cursor: "pointer",
        padding: "0",
      });
      btn.addEventListener("click", () => this.setActiveColor(color));
      paletteRow.appendChild(btn);
      this.swatchButtons.push(btn);
    }

    // Custom color input (wrapper keeps grid alignment)
    const customWrapper = document.createElement("button");
    Object.assign(customWrapper.style, {
      width: "100%",
      height: "22px",
      background:
        "repeating-conic-gradient(#555 0% 25%, #888 0% 50%) 50% / 8px 8px",
      border: "2px solid transparent",
      borderRadius: "3px",
      cursor: "pointer",
      padding: "0",
      position: "relative",
      gridColumn: "span 2",
    });
    customWrapper.title = "Custom color";
    this.customColorInput = document.createElement("input");
    this.customColorInput.type = "color";
    this.customColorInput.value = hexToCSS(this.activeColor);
    Object.assign(this.customColorInput.style, {
      position: "absolute",
      inset: "0",
      width: "100%",
      height: "100%",
      opacity: "0",
      cursor: "pointer",
    });
    this.customColorInput.addEventListener("input", () => {
      const color = cssToHex(this.customColorInput.value);
      customWrapper.style.background = hexToCSS(color);
      this.setActiveColor(color);
    });
    customWrapper.appendChild(this.customColorInput);
    paletteRow.appendChild(customWrapper);

    // Start with first swatch active
    this.setActiveColor(PALETTE[0]);

    // Carrier grid
    const carrierLabel = document.createElement("div");
    carrierLabel.textContent = "Carrier colors";
    Object.assign(carrierLabel.style, { color: "#999", fontSize: "11px" });
    this.panel.appendChild(carrierLabel);

    this.carrierGrid = document.createElement("div");
    Object.assign(this.carrierGrid.style, {
      display: "flex",
      flexDirection: "column",
      gap: "8px",
    });
    this.panel.appendChild(this.carrierGrid);

    // Presets
    const presetLabel = document.createElement("div");
    presetLabel.textContent = "Presets";
    Object.assign(presetLabel.style, {
      color: "#999",
      fontSize: "11px",
      marginTop: "4px",
    });
    this.panel.appendChild(presetLabel);

    const presetGrid = document.createElement("div");
    Object.assign(presetGrid.style, {
      display: "flex",
      flexWrap: "wrap",
      gap: "4px",
    });
    this.panel.appendChild(presetGrid);

    for (const preset of PRESETS) {
      const btn = document.createElement("button");
      btn.textContent = preset.label;
      Object.assign(btn.style, {
        padding: "4px 8px",
        fontSize: "11px",
        background: "#333",
        color: "#ccc",
        border: "1px solid #555",
        borderRadius: "4px",
        cursor: "pointer",
      });
      btn.addEventListener("mouseenter", () => {
        btn.style.background = "#444";
      });
      btn.addEventListener("mouseleave", () => {
        btn.style.background = "#333";
      });
      btn.addEventListener("click", () => this.applyPreset(preset));
      presetGrid.appendChild(btn);
    }

    // Export
    const exportBtn = document.createElement("button");
    exportBtn.textContent = "Copy Pattern to Clipboard";
    Object.assign(exportBtn.style, {
      padding: "6px 12px",
      fontSize: "12px",
      background: "#2a4a6a",
      color: "#ccc",
      border: "1px solid #555",
      borderRadius: "4px",
      cursor: "pointer",
      marginTop: "4px",
    });
    exportBtn.addEventListener("click", () => this.copyConfig());
    this.panel.appendChild(exportBtn);
  }

  private applyPreset(preset: RopePreset) {
    const weave: [number, number] = preset.pattern.weave ?? [1, 1];
    const helixAngle = preset.pattern.helixAngle ?? 45;
    this.pattern = {
      type: preset.pattern.type,
      carriers: preset.pattern.carriers.slice(),
      weave,
      helixAngle,
    };
    this.typeSelect.value = preset.pattern.type;
    this.carrierCountInput.value = String(preset.pattern.carriers.length);
    this.carrierCountInput.step = preset.pattern.type === "braid" ? "2" : "1";
    this.weaveOverInput.value = String(weave[0]);
    this.weaveUnderInput.value = String(weave[1]);
    this.helixAngleInput.value = String(helixAngle);
    this.helixAngleValue.textContent = `${helixAngle}°`;
    this.rebuildCarrierGrid();
  }

  private resizeCarriers(n: number) {
    const pad = this.pattern.carriers[0] ?? 0xeeeeee;
    const newCarriers: number[] = [];
    for (let i = 0; i < n; i++) {
      newCarriers.push(this.pattern.carriers[i] ?? pad);
    }
    this.pattern = {
      ...this.pattern,
      carriers: newCarriers,
    };
    this.rebuildCarrierGrid();
  }

  private setActiveColor(color: number) {
    this.activeColor = color;
    // Highlight matching swatch (or none)
    for (const btn of this.swatchButtons) {
      const btnColor = cssToHex(rgbToHex(btn.style.background));
      btn.style.border =
        btnColor === color ? "2px solid #6af" : "2px solid transparent";
    }
  }

  private rebuildCarrierGrid() {
    this.carrierGrid.innerHTML = "";

    const n = this.pattern.carriers.length;
    const half = this.pattern.type === "braid" ? n / 2 : n;

    const makeSection = (title: string, startIdx: number, endIdx: number) => {
      const header = document.createElement("div");
      header.textContent = title;
      Object.assign(header.style, {
        fontSize: "10px",
        color: "#777",
        textTransform: "uppercase",
        letterSpacing: "0.5px",
      });
      this.carrierGrid.appendChild(header);

      const grid = document.createElement("div");
      Object.assign(grid.style, {
        display: "grid",
        gridTemplateColumns: "repeat(8, 1fr)",
        gap: "3px",
      });
      this.carrierGrid.appendChild(grid);

      for (let i = startIdx; i < endIdx; i++) {
        const idx = i;
        const wrapper = document.createElement("div");
        Object.assign(wrapper.style, {
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: "1px",
        });
        const label = document.createElement("div");
        label.textContent = `${i}`;
        Object.assign(label.style, { fontSize: "9px", color: "#666" });

        const swatch = document.createElement("button");
        Object.assign(swatch.style, {
          width: "100%",
          height: "24px",
          background: hexToCSS(this.pattern.carriers[i]),
          border: "1px solid #555",
          borderRadius: "3px",
          cursor: "pointer",
          padding: "0",
        });
        swatch.title =
          "Click: paint with active color. Shift-click: open custom picker";
        swatch.addEventListener("click", (e) => {
          if (e.shiftKey) {
            // Open native color picker for this specific carrier
            const picker = document.createElement("input");
            picker.type = "color";
            picker.value = hexToCSS(this.pattern.carriers[idx]);
            picker.style.position = "fixed";
            picker.style.opacity = "0";
            document.body.appendChild(picker);
            picker.addEventListener("input", () => {
              const c = cssToHex(picker.value);
              this.pattern.carriers[idx] = c;
              swatch.style.background = hexToCSS(c);
            });
            picker.addEventListener("change", () => picker.remove());
            picker.click();
          } else {
            this.pattern.carriers[idx] = this.activeColor;
            swatch.style.background = hexToCSS(this.activeColor);
          }
        });

        wrapper.appendChild(label);
        wrapper.appendChild(swatch);
        grid.appendChild(wrapper);
      }
    };

    if (this.pattern.type === "braid") {
      makeSection("S-laid", 0, half);
      makeSection("Z-laid", half, n);
    } else {
      makeSection("Strands", 0, n);
    }
  }

  private copyConfig() {
    const colors = this.pattern.carriers
      .map((c) => `  0x${c.toString(16).padStart(6, "0")},`)
      .join("\n");
    const weave = this.pattern.weave ?? [1, 1];
    const helixAngle = this.pattern.helixAngle ?? 45;
    const lines = [
      `ropePattern: {`,
      `  type: "${this.pattern.type}",`,
      `  carriers: [`,
      colors.replace(/^/gm, "  "),
      `  ],`,
    ];
    if (this.pattern.type === "braid" && (weave[0] !== 1 || weave[1] !== 1)) {
      lines.push(`  weave: [${weave[0]}, ${weave[1]}],`);
    }
    if (helixAngle !== 45) {
      lines.push(`  helixAngle: ${helixAngle},`);
    }
    lines.push(`},`);
    navigator.clipboard.writeText(lines.join("\n"));
  }

  private addSelect(
    label: string,
    options: string[],
    onChange: () => void,
  ): HTMLSelectElement {
    const row = document.createElement("div");
    Object.assign(row.style, {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
    });

    const lbl = document.createElement("div");
    lbl.textContent = label;
    row.appendChild(lbl);

    const select = document.createElement("select");
    for (const opt of options) {
      const o = document.createElement("option");
      o.value = opt;
      o.textContent = opt;
      select.appendChild(o);
    }
    Object.assign(select.style, {
      background: "#333",
      color: "#ccc",
      border: "1px solid #555",
      borderRadius: "4px",
      padding: "3px 6px",
      fontSize: "12px",
    });
    select.addEventListener("change", onChange);
    row.appendChild(select);

    this.panel.appendChild(row);
    return select;
  }
}

function hexToCSS(hex: number): string {
  return `#${hex.toString(16).padStart(6, "0")}`;
}

function cssToHex(css: string): number {
  return parseInt(css.slice(1), 16);
}

/** Convert a browser-normalized "rgb(r, g, b)" string to "#rrggbb". */
function rgbToHex(rgb: string): string {
  const match = rgb.match(/\d+/g);
  if (!match || match.length < 3) return "#000000";
  const r = parseInt(match[0], 10);
  const g = parseInt(match[1], 10);
  const b = parseInt(match[2], 10);
  return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
}
