/**
 * Interactive rope pattern test controller.
 *
 * Renders several horizontal rope strips and provides an HTML overlay panel
 * with controls for switching patterns, editing carrier colors, and loading
 * presets. All changes update in real time.
 */

import { BaseEntity } from "../core/entity/BaseEntity";
import { on } from "../core/entity/handler";
import type { Draw } from "../core/graphics/Draw";
import {
  BRAID_CARRIER_COUNT,
  ROPE_PATTERN_BRAID,
  ROPE_PATTERN_TWIST,
  RopeShaderInstance,
} from "../game/boat/RopeShader";
import {
  extractCameraTransform,
  tessellateRopeStrip,
} from "../game/boat/tessellation";

// ─── Preset definitions ─────────────────────────────────────────

interface RopePreset {
  label: string;
  pattern: "twist" | "braid";
  colorA: number;
  colorB: number;
  braidColors: number[];
}

const PRESETS: RopePreset[] = [
  {
    label: "Marlowbraid Red",
    pattern: "braid",
    colorA: 0xeeeeee,
    colorB: 0xeeeeee,
    braidColors: [
      0xeeeeee, 0xcc2222, 0xcc2222, 0xeeeeee, 0xeeeeee, 0x222222, 0xeeeeee,
      0xeeeeee,
    ],
  },
  {
    label: "Marlowbraid Blue",
    pattern: "braid",
    colorA: 0xeeeeee,
    colorB: 0xeeeeee,
    braidColors: [
      0xeeeeee, 0x2255cc, 0x2255cc, 0xeeeeee, 0xeeeeee, 0x222222, 0xeeeeee,
      0xeeeeee,
    ],
  },
  {
    label: "Green / Gold",
    pattern: "braid",
    colorA: 0x22aa44,
    colorB: 0x22aa44,
    braidColors: [
      0x22aa44, 0x22aa44, 0xddaa00, 0xddaa00, 0x22aa44, 0x22aa44, 0xddaa00,
      0xddaa00,
    ],
  },
  {
    label: "Dyneema Gray",
    pattern: "braid",
    colorA: 0xaaaaaa,
    colorB: 0xaaaaaa,
    braidColors: [
      0xaaaaaa, 0x888888, 0xaaaaaa, 0x888888, 0xaaaaaa, 0x888888, 0xaaaaaa,
      0x888888,
    ],
  },
  {
    label: "Orange / Black",
    pattern: "braid",
    colorA: 0xeeeeee,
    colorB: 0xeeeeee,
    braidColors: [
      0xeeeeee, 0xee6622, 0xee6622, 0xeeeeee, 0xeeeeee, 0x111111, 0xeeeeee,
      0xeeeeee,
    ],
  },
  {
    label: "Red / White Twist",
    pattern: "twist",
    colorA: 0xcc2222,
    colorB: 0xeeeeee,
    braidColors: [
      0xeeeeee, 0xeeeeee, 0xeeeeee, 0xeeeeee, 0xeeeeee, 0xeeeeee, 0xeeeeee,
      0xeeeeee,
    ],
  },
  {
    label: "Blue / White Twist",
    pattern: "twist",
    colorA: 0x2255cc,
    colorB: 0xeeeeee,
    braidColors: [
      0xeeeeee, 0xeeeeee, 0xeeeeee, 0xeeeeee, 0xeeeeee, 0xeeeeee, 0xeeeeee,
      0xeeeeee,
    ],
  },
  {
    label: "Anchor Rode",
    pattern: "twist",
    colorA: 0x333322,
    colorB: 0x333322,
    braidColors: [
      0x333322, 0x333322, 0x333322, 0x333322, 0x333322, 0x333322, 0x333322,
      0x333322,
    ],
  },
];

// ─── Test rope strip config ─────────────────────────────────────

interface TestRope {
  y: number;
  width: number;
  label: string;
  shader: RopeShaderInstance;
}

const ROPE_LENGTH = 20; // ft
const ROPE_POINT_COUNT = 40;

// ─── Controller entity ──────────────────────────────────────────

export class RopeTestController extends BaseEntity {
  // Current state
  private pattern: "twist" | "braid" = "braid";
  private colorA = 0xeeeeee;
  private colorB = 0xeeeeee;
  private braidColors = [
    0xeeeeee, 0xcc2222, 0xcc2222, 0xeeeeee, 0xeeeeee, 0x222222, 0xeeeeee,
    0xeeeeee,
  ];

  // Test rope strips at different thicknesses
  private ropes: TestRope[] = [];

  // DOM elements
  private panel!: HTMLDivElement;
  private patternSelect!: HTMLSelectElement;
  private twistControls!: HTMLDivElement;
  private braidControls!: HTMLDivElement;
  private colorAInput!: HTMLInputElement;
  private colorBInput!: HTMLInputElement;
  private carrierInputs: HTMLInputElement[] = [];

  // Centerline points (shared by all ropes — just a straight horizontal line)
  private points: [number, number][] = [];
  private zValues: number[] = [];

  onAdd() {
    // Generate straight centerline points
    for (let i = 0; i < ROPE_POINT_COUNT; i++) {
      const t = i / (ROPE_POINT_COUNT - 1);
      const x = (t - 0.5) * ROPE_LENGTH;
      this.points.push([x, 0]);
      this.zValues.push(3);
    }

    // Create test ropes at different thicknesses
    const configs = [
      { y: 3.0, width: 0.6, label: "0.6 ft (thick)" },
      { y: 1.5, width: 0.3, label: "0.3 ft" },
      { y: 0.3, width: 0.15, label: "0.15 ft (sheet)" },
      { y: -0.6, width: 0.08, label: "0.08 ft (thin)" },
      { y: -1.3, width: 0.04, label: "0.04 ft" },
    ];

    for (const cfg of configs) {
      this.ropes.push({
        y: cfg.y,
        width: cfg.width,
        label: cfg.label,
        shader: new RopeShaderInstance(ROPE_POINT_COUNT),
      });
    }

    this.createUI();
    this.applyPreset(PRESETS[0]);
  }

  onDestroy() {
    for (const rope of this.ropes) {
      rope.shader.destroy();
    }
    this.panel?.remove();
  }

  @on("render")
  onRender({ draw }: { draw: Draw }) {
    const renderer = draw.renderer;
    const cam = extractCameraTransform(renderer.getTransform());
    const patternType =
      this.pattern === "braid" ? ROPE_PATTERN_BRAID : ROPE_PATTERN_TWIST;
    const braidColors = this.pattern === "braid" ? this.braidColors : null;

    for (const rope of this.ropes) {
      // Offset centerline points to this rope's y position
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

      // Flush the draw API so our custom pipeline doesn't interleave
      renderer.flush();

      rope.shader.draw(
        renderer,
        rope.shader.scratchVertexData,
        vertexCount,
        rope.shader.scratchIndexData,
        indexCount,
        this.colorA,
        this.colorB,
        1,
        rope.width,
        patternType,
        braidColors,
        0,
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
      width: "260px",
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

    // Pattern selector
    this.patternSelect = this.addSelect("Pattern", ["twist", "braid"], () => {
      this.pattern = this.patternSelect.value as "twist" | "braid";
      this.updateControlVisibility();
    });

    // Twist controls
    this.twistControls = document.createElement("div");
    Object.assign(this.twistControls.style, {
      display: "flex",
      flexDirection: "column",
      gap: "8px",
    });
    this.panel.appendChild(this.twistControls);

    this.colorAInput = this.addColorPicker(
      this.twistControls,
      "Color A",
      this.colorA,
      (c) => {
        this.colorA = c;
      },
    );
    this.colorBInput = this.addColorPicker(
      this.twistControls,
      "Color B",
      this.colorB,
      (c) => {
        this.colorB = c;
      },
    );

    // Braid controls
    this.braidControls = document.createElement("div");
    Object.assign(this.braidControls.style, {
      display: "flex",
      flexDirection: "column",
      gap: "6px",
    });
    this.panel.appendChild(this.braidControls);

    const carrierLabel = document.createElement("div");
    carrierLabel.textContent = "Carrier Colors";
    Object.assign(carrierLabel.style, { color: "#999", fontSize: "11px" });
    this.braidControls.appendChild(carrierLabel);

    const carrierGrid = document.createElement("div");
    Object.assign(carrierGrid.style, {
      display: "grid",
      gridTemplateColumns: "repeat(4, 1fr)",
      gap: "4px",
    });
    this.braidControls.appendChild(carrierGrid);

    for (let i = 0; i < BRAID_CARRIER_COUNT; i++) {
      const idx = i;
      const wrapper = document.createElement("div");
      Object.assign(wrapper.style, {
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: "2px",
      });

      const label = document.createElement("div");
      label.textContent = `${i}`;
      Object.assign(label.style, { fontSize: "10px", color: "#777" });

      const input = document.createElement("input");
      input.type = "color";
      input.value = hexToCSS(this.braidColors[i]);
      Object.assign(input.style, {
        width: "100%",
        height: "28px",
        border: "1px solid #555",
        borderRadius: "4px",
        cursor: "pointer",
        padding: "1px",
        background: "transparent",
      });
      input.addEventListener("input", () => {
        this.braidColors[idx] = cssToHex(input.value);
      });

      wrapper.appendChild(label);
      wrapper.appendChild(input);
      carrierGrid.appendChild(wrapper);
      this.carrierInputs.push(input);
    }

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

    // Config export
    const exportBtn = document.createElement("button");
    exportBtn.textContent = "Copy Config to Clipboard";
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

    this.updateControlVisibility();
  }

  private applyPreset(preset: RopePreset) {
    this.pattern = preset.pattern;
    this.colorA = preset.colorA;
    this.colorB = preset.colorB;
    this.braidColors = [...preset.braidColors];

    // Update UI
    this.patternSelect.value = preset.pattern;
    this.colorAInput.value = hexToCSS(preset.colorA);
    this.colorBInput.value = hexToCSS(preset.colorB);
    for (let i = 0; i < BRAID_CARRIER_COUNT; i++) {
      this.carrierInputs[i].value = hexToCSS(preset.braidColors[i] ?? 0xeeeeee);
    }
    this.updateControlVisibility();
  }

  private updateControlVisibility() {
    this.twistControls.style.display =
      this.pattern === "twist" ? "flex" : "none";
    this.braidControls.style.display =
      this.pattern === "braid" ? "flex" : "none";
  }

  private copyConfig() {
    let config: string;
    if (this.pattern === "twist") {
      config = [
        `ropeColor: 0x${this.colorA.toString(16).padStart(6, "0")},`,
        `ropeStrandColor: 0x${this.colorB.toString(16).padStart(6, "0")},`,
      ].join("\n");
    } else {
      const colors = this.braidColors
        .map((c) => `  0x${c.toString(16).padStart(6, "0")},`)
        .join("\n");
      config = [
        `ropePattern: "braid",`,
        `ropeColor: 0x${this.braidColors[0].toString(16).padStart(6, "0")},`,
        `braidColors: [`,
        colors,
        `],`,
      ].join("\n");
    }
    navigator.clipboard.writeText(config);
  }

  // ─── UI helpers ─────────────────────────────────────────────

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

  private addColorPicker(
    parent: HTMLElement,
    label: string,
    initial: number,
    onChange: (color: number) => void,
  ): HTMLInputElement {
    const row = document.createElement("div");
    Object.assign(row.style, {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
    });

    const lbl = document.createElement("div");
    lbl.textContent = label;
    row.appendChild(lbl);

    const input = document.createElement("input");
    input.type = "color";
    input.value = hexToCSS(initial);
    Object.assign(input.style, {
      width: "48px",
      height: "24px",
      border: "1px solid #555",
      borderRadius: "4px",
      cursor: "pointer",
      padding: "1px",
      background: "transparent",
    });
    input.addEventListener("input", () => {
      onChange(cssToHex(input.value));
    });
    row.appendChild(input);

    parent.appendChild(row);
    return input;
  }
}

// ─── Color conversion utilities ─────────────────────────────────

function hexToCSS(hex: number): string {
  return `#${hex.toString(16).padStart(6, "0")}`;
}

function cssToHex(css: string): number {
  return parseInt(css.slice(1), 16);
}
