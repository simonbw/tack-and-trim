/**
 * Interactive smoke-test for the capstan-network rope solver.
 *
 * Renders four fixtures side-by-side and ticks the solver each frame.
 * Nodes are circles, sections are lines colored by tension, the working
 * length of each winch is animated via sinusoidal flow-rate injection so
 * you can watch tensions ebb and flow.
 *
 * Tension readouts are pushed to an HTML overlay each tick.
 */

import { BaseEntity } from "../core/entity/BaseEntity";
import { on } from "../core/entity/handler";
import type { Draw } from "../core/graphics/Draw";
import type { GameEventMap } from "../core/entity/Entity";
import { V3d } from "../core/Vector3";
import {
  type CapstanNode,
  type CapstanSection,
  DEFAULT_CAPSTAN_CONFIG,
  makeSection,
  solveNetwork,
} from "../game/rope/capstan";

interface Fixture {
  label: string;
  originX: number;
  originY: number;
  nodes: MutableNode[];
  sections: CapstanSection[];
  /** Called each tick to mutate node worldPos / flow inputs for animation. */
  animate: (t: number) => void;
}

/** Mutable wrapper around a CapstanNode so we can write into worldPos each tick. */
interface MutableNode extends CapstanNode {
  worldPos: V3d;
}

/** Make a fresh mutable node, seeded at (x, y, z). */
function mkNode(
  x: number,
  y: number,
  z: number,
  kind: CapstanNode["kind"],
  mu: number = 0,
): MutableNode {
  return { worldPos: new V3d(x, y, z), mu, kind };
}

/** Seed section rest-length so the rope is gently taut at spawn. */
function seedSections(
  nodes: MutableNode[],
  slack: number = 0,
): CapstanSection[] {
  const out: CapstanSection[] = [];
  for (let i = 0; i < nodes.length - 1; i++) {
    const a = nodes[i].worldPos;
    const b = nodes[i + 1].worldPos;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const dz = b[2] - a[2];
    const chord = Math.sqrt(dx * dx + dy * dy + dz * dz);
    out.push(makeSection(chord * (1 + slack)));
  }
  return out;
}

export class CapstanTestController extends BaseEntity {
  private fixtures: Fixture[] = [];
  private panel!: HTMLDivElement;
  private readouts: HTMLPreElement[] = [];

  onAdd() {
    this.fixtures = [
      this.buildStraightPull(-18, 6),
      this.buildBlockWithFriction(-18, -4),
      this.buildBlockWinch(4, 6),
      this.buildDegenerate(4, -4),
    ];
    this.createPanel();
  }

  onDestroy() {
    this.panel?.remove();
  }

  // ─── Fixture definitions ────────────────────────────────────────

  /** Two endpoints with one moving in a circle — pure spring test. */
  private buildStraightPull(ox: number, oy: number): Fixture {
    const A = mkNode(ox - 4, oy, 0, "endpoint");
    const B = mkNode(ox + 4, oy, 0, "endpoint");
    const nodes = [A, B];
    // Seed shorter than chord so the rope starts taut.
    const sections = seedSections(nodes, -0.05);
    return {
      label: "2-node: straight pull",
      originX: ox,
      originY: oy,
      nodes,
      sections,
      animate: (t) => {
        const r = 1.5;
        B.worldPos[0] = ox + 4 + Math.cos(t * 0.8) * r;
        B.worldPos[1] = oy + Math.sin(t * 0.8) * r;
      },
    };
  }

  /** Three nodes with friction at the middle block. Endpoints oscillate. */
  private buildBlockWithFriction(ox: number, oy: number): Fixture {
    const A = mkNode(ox - 5, oy + 1, 0, "endpoint");
    const B = mkNode(ox, oy + 2, 0, "block", 0.5);
    const C = mkNode(ox + 5, oy + 1, 0, "endpoint");
    const nodes = [A, B, C];
    const sections = seedSections(nodes, -0.02);
    return {
      label: "3-node: block μ=0.5",
      originX: ox,
      originY: oy,
      nodes,
      sections,
      animate: (t) => {
        A.worldPos[1] = oy + 1 + Math.sin(t * 0.5) * 1.2;
        C.worldPos[1] = oy + 1 + Math.cos(t * 0.7) * 1.2;
      },
    };
  }

  /** Four nodes: endpoint → block → winch → endpoint. Winch trims sinusoidally. */
  private buildBlockWinch(ox: number, oy: number): Fixture {
    const A = mkNode(ox - 5, oy, 0, "endpoint");
    const B = mkNode(ox - 1, oy + 2, 0, "block", 0.1);
    const W = mkNode(ox + 2, oy + 2, 0, "winch", 0.3);
    const T = mkNode(ox + 5, oy, 0, "endpoint");
    W.ratchetSign = 0; // free during this demo
    const nodes = [A, B, W, T];
    const sections = seedSections(nodes, 0.1); // slight slack at rest
    return {
      label: "4-node: block+winch",
      originX: ox,
      originY: oy,
      nodes,
      sections,
      animate: (t) => {
        // Sinusoidal winch trim/ease
        W.flowRateIn = Math.sin(t * 0.4) * 1.0;
        // Wiggle endpoint A to excite the system
        A.worldPos[1] = oy + Math.sin(t * 0.6) * 0.5;
      },
    };
  }

  /** Degenerate: two endpoints at (almost) the same position. */
  private buildDegenerate(ox: number, oy: number): Fixture {
    const A = mkNode(ox, oy, 0, "endpoint");
    const B = mkNode(ox + 1e-5, oy + 1e-5, 0, "endpoint");
    const nodes = [A, B];
    const sections = seedSections(nodes);
    sections[0].length = 0.5; // has slack even though chord ≈ 0
    return {
      label: "degenerate: coincident",
      originX: ox,
      originY: oy,
      nodes,
      sections,
      animate: () => {
        /* nothing moves */
      },
    };
  }

  // ─── Loop ───────────────────────────────────────────────────────

  @on("tick")
  onTick({ dt }: GameEventMap["tick"]) {
    const t = performance.now() / 1000;
    for (const fx of this.fixtures) {
      fx.animate(t);
      solveNetwork(fx.nodes, fx.sections, dt, DEFAULT_CAPSTAN_CONFIG);
    }
    this.updateReadouts();
  }

  @on("render")
  onRender({ draw }: { draw: Draw }) {
    for (const fx of this.fixtures) {
      this.renderFixture(draw, fx);
    }
  }

  private renderFixture(draw: Draw, fx: Fixture) {
    // Sections as lines colored by tension (blue=slack, red=taut).
    for (let i = 0; i < fx.sections.length; i++) {
      const s = fx.sections[i];
      const a = fx.nodes[i].worldPos;
      const b = fx.nodes[i + 1].worldPos;
      const tensionNorm = Math.min(1, s.tension / 1000);
      const color = lerpColor(0x2266ee, 0xee3322, tensionNorm);
      draw.line(a[0], a[1], b[0], b[1], { color, width: 0.12 });
    }
    // Nodes as circles colored by kind.
    for (const node of fx.nodes) {
      const color = nodeColor(node.kind);
      draw.fillCircle(node.worldPos[0], node.worldPos[1], 0.25, { color });
    }
  }

  // ─── Readouts ───────────────────────────────────────────────────

  private createPanel() {
    this.panel = document.createElement("div");
    Object.assign(this.panel.style, {
      position: "fixed",
      top: "16px",
      left: "16px",
      background: "rgba(20, 20, 40, 0.92)",
      border: "1px solid #444",
      borderRadius: "8px",
      padding: "12px 16px",
      fontFamily: "var(--font-mono)",
      fontSize: "12px",
      color: "#ccc",
      zIndex: "100",
      display: "flex",
      flexDirection: "column",
      gap: "12px",
    });
    document.body.appendChild(this.panel);

    const title = document.createElement("div");
    title.textContent = "Capstan Solver Smoke Test";
    Object.assign(title.style, {
      fontSize: "14px",
      fontWeight: "bold",
      color: "#fff",
    });
    this.panel.appendChild(title);

    for (const fx of this.fixtures) {
      const block = document.createElement("div");
      const label = document.createElement("div");
      label.textContent = fx.label;
      Object.assign(label.style, { color: "#88ccff", marginBottom: "4px" });
      block.appendChild(label);

      const pre = document.createElement("pre");
      Object.assign(pre.style, {
        margin: "0",
        padding: "0",
        whiteSpace: "pre",
      });
      block.appendChild(pre);
      this.readouts.push(pre);
      this.panel.appendChild(block);
    }
  }

  private updateReadouts() {
    for (let i = 0; i < this.fixtures.length; i++) {
      const fx = this.fixtures[i];
      const lines: string[] = [];
      for (let s = 0; s < fx.sections.length; s++) {
        const sec = fx.sections[s];
        lines.push(
          `  §${s}: L=${sec.length.toFixed(2)} chord=${sec.chord.toFixed(
            2,
          )} T=${sec.tension.toFixed(1)}`,
        );
      }
      this.readouts[i].textContent = lines.join("\n");
    }
  }
}

function lerpColor(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff;
  const ag = (a >> 8) & 0xff;
  const ab = a & 0xff;
  const br = (b >> 16) & 0xff;
  const bg = (b >> 8) & 0xff;
  const bb = b & 0xff;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bc = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bc;
}

function nodeColor(kind: CapstanNode["kind"]): number {
  switch (kind) {
    case "endpoint":
      return 0xffffff;
    case "block":
      return 0xffaa33;
    case "winch":
      return 0x33ffaa;
    case "free":
      return 0x8888ff;
  }
}
