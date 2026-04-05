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

const PRESETS: RopePreset[] = [
  {
    label: "Marlowbraid Red (16-plait sym)",
    pattern: {
      type: "braid",
      carriers: [
        0xeeeeee, 0xcc2222, 0xcc2222, 0xeeeeee, 0xeeeeee, 0x222222, 0xeeeeee,
        0xeeeeee, 0xeeeeee, 0xcc2222, 0xcc2222, 0xeeeeee, 0xeeeeee, 0x222222,
        0xeeeeee, 0xeeeeee,
      ],
    },
  },
  {
    label: "Marlowbraid Blue (16-plait sym)",
    pattern: {
      type: "braid",
      carriers: [
        0xeeeeee, 0x2255cc, 0x2255cc, 0xeeeeee, 0xeeeeee, 0x222222, 0xeeeeee,
        0xeeeeee, 0xeeeeee, 0x2255cc, 0x2255cc, 0xeeeeee, 0xeeeeee, 0x222222,
        0xeeeeee, 0xeeeeee,
      ],
    },
  },
  {
    label: "Asymmetric 16-plait",
    pattern: {
      type: "braid",
      carriers: [
        // S-laid
        0xeeeeee, 0xcc2222, 0xcc2222, 0xeeeeee, 0xeeeeee, 0x222222, 0xeeeeee,
        0xeeeeee,
        // Z-laid — different pattern
        0xeeeeee, 0xeeeeee, 0x2255cc, 0x2255cc, 0xeeeeee, 0xeeeeee, 0x222222,
        0xeeeeee,
      ],
    },
  },
  {
    label: "8-plait anchor rode",
    pattern: {
      type: "braid",
      carriers: [
        0x888866, 0x666644, 0x888866, 0x888866, 0x888866, 0x666644, 0x888866,
        0x888866,
      ],
    },
  },
  {
    label: "Green / Gold bands (16-plait)",
    pattern: {
      type: "braid",
      carriers: [
        0x22aa44, 0x22aa44, 0xddaa00, 0xddaa00, 0x22aa44, 0x22aa44, 0xddaa00,
        0xddaa00, 0x22aa44, 0x22aa44, 0xddaa00, 0xddaa00, 0x22aa44, 0x22aa44,
        0xddaa00, 0xddaa00,
      ],
    },
  },
  {
    label: "Dyneema (16-plait)",
    pattern: {
      type: "braid",
      carriers: [
        0xaaaaaa, 0x888888, 0xaaaaaa, 0x888888, 0xaaaaaa, 0x888888, 0xaaaaaa,
        0x888888, 0xaaaaaa, 0x888888, 0xaaaaaa, 0x888888, 0xaaaaaa, 0x888888,
        0xaaaaaa, 0x888888,
      ],
    },
  },
  {
    label: "3-strand laid (red/white)",
    pattern: {
      type: "laid",
      carriers: [0xcc2222, 0xeeeeee, 0xcc2222],
    },
  },
  {
    label: "3-strand manila",
    pattern: {
      type: "laid",
      carriers: [0xa67840, 0x8a6030, 0xa67840],
    },
  },
  {
    label: "Solid anchor rode",
    pattern: {
      type: "laid",
      carriers: [0x333322],
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
  };

  private ropes: TestRope[] = [];
  private points: [number, number][] = [];
  private zValues: number[] = [];

  // DOM
  private panel!: HTMLDivElement;
  private typeSelect!: HTMLSelectElement;
  private carrierCountInput!: HTMLInputElement;
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
    this.pattern = {
      type: preset.pattern.type,
      carriers: preset.pattern.carriers.slice(),
    };
    this.typeSelect.value = preset.pattern.type;
    this.carrierCountInput.value = String(preset.pattern.carriers.length);
    this.carrierCountInput.step = preset.pattern.type === "braid" ? "2" : "1";
    this.rebuildCarrierGrid();
  }

  private resizeCarriers(n: number) {
    const pad = this.pattern.carriers[0] ?? 0xeeeeee;
    const newCarriers: number[] = [];
    for (let i = 0; i < n; i++) {
      newCarriers.push(this.pattern.carriers[i] ?? pad);
    }
    this.pattern = { type: this.pattern.type, carriers: newCarriers };
    this.rebuildCarrierGrid();
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

        const input = document.createElement("input");
        input.type = "color";
        input.value = hexToCSS(this.pattern.carriers[i]);
        Object.assign(input.style, {
          width: "100%",
          height: "24px",
          border: "1px solid #555",
          borderRadius: "3px",
          cursor: "pointer",
          padding: "1px",
          background: "transparent",
        });
        input.addEventListener("input", () => {
          this.pattern.carriers[idx] = cssToHex(input.value);
        });

        wrapper.appendChild(label);
        wrapper.appendChild(input);
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
    const snippet = [
      `ropePattern: {`,
      `  type: "${this.pattern.type}",`,
      `  carriers: [`,
      colors.replace(/^/gm, "  "),
      `  ],`,
      `},`,
    ].join("\n");
    navigator.clipboard.writeText(snippet);
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
