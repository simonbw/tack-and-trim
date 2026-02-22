import { parentPort, workerData } from "worker_threads";
import { latLonToFeet } from "../geo-utils";
import {
  simplifyClosedRing,
  ringPerimeter,
  signedArea,
  type Point,
} from "../simplify";

const BLOCK_SIZE = 64;

interface InitData {
  valuesBuffer: SharedArrayBuffer;
  nodataBuffer: SharedArrayBuffer;
  gridWidth: number;
  gridHeight: number;
  hasNodataMask: boolean;
}

const { valuesBuffer, nodataBuffer, gridWidth, gridHeight, hasNodataMask } =
  workerData as InitData;

const values = new Float64Array(valuesBuffer);
const nodataMask = hasNodataMask ? new Uint8Array(nodataBuffer) : null;

// Edge ID encoding constants
const numH = (gridWidth - 1) * gridHeight;

// Block index stored once, reused across march calls
let storedBlockMin: Float64Array | null = null;
let storedBlockMax: Float64Array | null = null;

// Simplify config stored once, reused across simplify calls
let simplifyConfig: SimplifyConfig | null = null;

interface BlockIndexMsg {
  type: "blockIndex";
  blockCols: number;
  blockRowStart: number;
  blockRowEnd: number;
}

interface SetBlockIndexMsg {
  type: "setBlockIndex";
  blockMinBuffer: SharedArrayBuffer;
  blockMaxBuffer: SharedArrayBuffer;
  blockHasNoDataBuffer: SharedArrayBuffer;
}

interface MarchMsg {
  type: "march";
  level: number;
  blockCols: number;
  blockRowStart: number;
  blockRowEnd: number;
}

interface SimplifyConfig {
  centerLat: number;
  centerLon: number;
  bboxMinLon: number;
  bboxMaxLat: number;
  lonStep: number;
  latStep: number;
  simplifyFeet: number;
  minPerimeterFeet: number;
  minPoints: number;
  scale: number;
  flipY: boolean;
}

interface SetSimplifyConfigMsg extends SimplifyConfig {
  type: "setSimplifyConfig";
}

interface SimplifyMsg {
  type: "simplify";
  rings: Float64Array[];
  levelFeet: number;
}

interface ExitMsg {
  type: "exit";
}

type WorkerMsg =
  | BlockIndexMsg
  | SetBlockIndexMsg
  | MarchMsg
  | SetSimplifyConfigMsg
  | SimplifyMsg
  | ExitMsg;

function handleBlockIndex(msg: BlockIndexMsg): void {
  const { blockCols, blockRowStart, blockRowEnd } = msg;
  const numBlocks = blockCols * (blockRowEnd - blockRowStart);
  const blockMin = new Float64Array(numBlocks);
  const blockMax = new Float64Array(numBlocks);
  const blockHasNoData = new Uint8Array(numBlocks);

  for (let by = blockRowStart; by < blockRowEnd; by++) {
    const yStart = by * BLOCK_SIZE;
    const yEnd = Math.min(yStart + BLOCK_SIZE, gridHeight - 1);
    for (let bx = 0; bx < blockCols; bx++) {
      const xStart = bx * BLOCK_SIZE;
      const xEnd = Math.min(xStart + BLOCK_SIZE, gridWidth - 1);
      const bi = (by - blockRowStart) * blockCols + bx;

      let bMin = Infinity;
      let bMax = -Infinity;
      let hasND = 0;

      for (let y = yStart; y <= yEnd; y++) {
        const row = y * gridWidth;
        for (let x = xStart; x <= xEnd; x++) {
          const idx = row + x;
          if (nodataMask && nodataMask[idx] !== 0) {
            hasND = 1;
            continue;
          }
          const v = values[idx];
          if (v < bMin) bMin = v;
          if (v > bMax) bMax = v;
        }
      }

      blockMin[bi] = bMin;
      blockMax[bi] = bMax;
      blockHasNoData[bi] = hasND;
    }
  }

  parentPort!.postMessage(
    {
      type: "blockIndex",
      blockRowStart,
      blockMin: blockMin.buffer,
      blockMax: blockMax.buffer,
      blockHasNoData: blockHasNoData.buffer,
    },
    [blockMin.buffer, blockMax.buffer, blockHasNoData.buffer],
  );
}

function handleSetBlockIndex(msg: SetBlockIndexMsg): void {
  storedBlockMin = new Float64Array(msg.blockMinBuffer);
  storedBlockMax = new Float64Array(msg.blockMaxBuffer);
  parentPort!.postMessage({ type: "setBlockIndex" });
}

function handleMarch(msg: MarchMsg): void {
  const { level, blockCols, blockRowStart, blockRowEnd } = msg;

  const blockMin = storedBlockMin!;
  const blockMax = storedBlockMax!;

  const segAx: number[] = [];
  const segAy: number[] = [];
  const segBx: number[] = [];
  const segBy: number[] = [];
  const segAEdge: number[] = [];
  const segBEdge: number[] = [];

  for (let by = blockRowStart; by < blockRowEnd; by++) {
    const yStart = by * BLOCK_SIZE;
    const yEnd = Math.min(yStart + BLOCK_SIZE, gridHeight - 1);
    for (let bx = 0; bx < blockCols; bx++) {
      const bi = by * blockCols + bx;
      if (blockMin[bi] > level || blockMax[bi] < level) {
        continue;
      }
      if (blockMin[bi] === blockMax[bi]) {
        continue;
      }
      const xStart = bx * BLOCK_SIZE;
      const xEnd = Math.min(xStart + BLOCK_SIZE, gridWidth - 1);
      for (let y = yStart; y < yEnd; y++) {
        const rowTop = y * gridWidth;
        const rowBot = (y + 1) * gridWidth;
        for (let x = xStart; x < xEnd; x++) {
          marchCell(
            x,
            y,
            rowTop,
            rowBot,
            level,
            segAx,
            segAy,
            segBx,
            segBy,
            segAEdge,
            segBEdge,
          );
        }
      }
    }
  }

  const ax = new Float64Array(segAx);
  const ay = new Float64Array(segAy);
  const bx = new Float64Array(segBx);
  const by = new Float64Array(segBy);
  const ae = new Float64Array(segAEdge);
  const be = new Float64Array(segBEdge);

  parentPort!.postMessage(
    {
      type: "march",
      segAx: ax.buffer,
      segAy: ay.buffer,
      segBx: bx.buffer,
      segBy: by.buffer,
      segAEdge: ae.buffer,
      segBEdge: be.buffer,
      count: segAx.length,
    },
    [ax.buffer, ay.buffer, bx.buffer, by.buffer, ae.buffer, be.buffer],
  );
}

function marchCell(
  x: number,
  y: number,
  rowTop: number,
  rowBot: number,
  level: number,
  segAx: number[],
  segAy: number[],
  segBx: number[],
  segBy: number[],
  segAEdge: number[],
  segBEdge: number[],
): void {
  const iTL = rowTop + x;
  const iTR = iTL + 1;
  const iBL = rowBot + x;
  const iBR = iBL + 1;

  if (
    nodataMask &&
    (nodataMask[iTL] | nodataMask[iTR] | nodataMask[iBL] | nodataMask[iBR]) !==
      0
  ) {
    return;
  }

  const vTL = values[iTL];
  const vTR = values[iTR];
  const vBR = values[iBR];
  const vBL = values[iBL];

  const mask =
    (vTL >= level ? 8 : 0) |
    (vTR >= level ? 4 : 0) |
    (vBR >= level ? 2 : 0) |
    (vBL >= level ? 1 : 0);

  if (mask === 0 || mask === 15) {
    return;
  }

  // Lazy interpolation with edge IDs
  let topPx: number,
    topPy: number,
    topEdge: number,
    hasTop = false;
  let rightPx: number,
    rightPy: number,
    rightEdge: number,
    hasRight = false;
  let bottomPx: number,
    bottomPy: number,
    bottomEdge: number,
    hasBottom = false;
  let leftPx: number,
    leftPy: number,
    leftEdge: number,
    hasLeft = false;

  const interpTop = () => {
    if (!hasTop) {
      const d = vTR - vTL;
      const t = Math.abs(d) < 1e-12 ? 0.5 : (level - vTL) / d;
      topPx = x + t;
      topPy = y;
      topEdge = y * (gridWidth - 1) + x;
      hasTop = true;
    }
  };
  const interpRight = () => {
    if (!hasRight) {
      const d = vBR - vTR;
      const t = Math.abs(d) < 1e-12 ? 0.5 : (level - vTR) / d;
      rightPx = x + 1;
      rightPy = y + t;
      rightEdge = numH + y * gridWidth + (x + 1);
      hasRight = true;
    }
  };
  const interpBottom = () => {
    if (!hasBottom) {
      const d = vBR - vBL;
      const t = Math.abs(d) < 1e-12 ? 0.5 : (level - vBL) / d;
      bottomPx = x + t;
      bottomPy = y + 1;
      bottomEdge = (y + 1) * (gridWidth - 1) + x;
      hasBottom = true;
    }
  };
  const interpLeft = () => {
    if (!hasLeft) {
      const d = vBL - vTL;
      const t = Math.abs(d) < 1e-12 ? 0.5 : (level - vTL) / d;
      leftPx = x;
      leftPy = y + t;
      leftEdge = numH + y * gridWidth + x;
      hasLeft = true;
    }
  };

  const push = (
    ax: number,
    ay: number,
    aEdge: number,
    bx: number,
    by: number,
    bEdge: number,
  ) => {
    segAx.push(ax);
    segAy.push(ay);
    segAEdge.push(aEdge);
    segBx.push(bx);
    segBy.push(by);
    segBEdge.push(bEdge);
  };

  switch (mask) {
    case 1:
    case 14:
      interpLeft();
      interpBottom();
      push(leftPx!, leftPy!, leftEdge!, bottomPx!, bottomPy!, bottomEdge!);
      break;
    case 2:
    case 13:
      interpBottom();
      interpRight();
      push(bottomPx!, bottomPy!, bottomEdge!, rightPx!, rightPy!, rightEdge!);
      break;
    case 3:
    case 12:
      interpLeft();
      interpRight();
      push(leftPx!, leftPy!, leftEdge!, rightPx!, rightPy!, rightEdge!);
      break;
    case 4:
    case 11:
      interpTop();
      interpRight();
      push(topPx!, topPy!, topEdge!, rightPx!, rightPy!, rightEdge!);
      break;
    case 5: {
      interpTop();
      interpRight();
      interpBottom();
      interpLeft();
      // Asymptotic decider: use the bilinear saddle value instead of center
      // average. This ensures contours at different levels resolve the saddle
      // consistently, preventing crossings within the same cell.
      const denom5 = vTL - vTR + vBR - vBL;
      const cv =
        Math.abs(denom5) < 1e-12
          ? (vTL + vTR + vBR + vBL) * 0.25
          : (vTL * vBR - vTR * vBL) / denom5;
      if (cv >= level) {
        push(topPx!, topPy!, topEdge!, leftPx!, leftPy!, leftEdge!);
        push(rightPx!, rightPy!, rightEdge!, bottomPx!, bottomPy!, bottomEdge!);
      } else {
        push(topPx!, topPy!, topEdge!, rightPx!, rightPy!, rightEdge!);
        push(leftPx!, leftPy!, leftEdge!, bottomPx!, bottomPy!, bottomEdge!);
      }
      break;
    }
    case 6:
    case 9:
      interpTop();
      interpBottom();
      push(topPx!, topPy!, topEdge!, bottomPx!, bottomPy!, bottomEdge!);
      break;
    case 7:
    case 8:
      interpTop();
      interpLeft();
      push(topPx!, topPy!, topEdge!, leftPx!, leftPy!, leftEdge!);
      break;
    case 10: {
      interpTop();
      interpRight();
      interpBottom();
      interpLeft();
      const denom10 = vTL - vTR + vBR - vBL;
      const cv2 =
        Math.abs(denom10) < 1e-12
          ? (vTL + vTR + vBR + vBL) * 0.25
          : (vTL * vBR - vTR * vBL) / denom10;
      if (cv2 >= level) {
        push(topPx!, topPy!, topEdge!, rightPx!, rightPy!, rightEdge!);
        push(leftPx!, leftPy!, leftEdge!, bottomPx!, bottomPy!, bottomEdge!);
      } else {
        push(topPx!, topPy!, topEdge!, leftPx!, leftPy!, leftEdge!);
        push(rightPx!, rightPy!, rightEdge!, bottomPx!, bottomPy!, bottomEdge!);
      }
      break;
    }
  }
}

function handleSetSimplifyConfig(msg: SetSimplifyConfigMsg): void {
  const { type: _, ...config } = msg;
  simplifyConfig = config;
  parentPort!.postMessage({ type: "setSimplifyConfig" });
}

interface ContourResult {
  height: number;
  polygon: [number, number][];
}

function simplifyOneRing(
  coords: Float64Array,
  levelFeet: number,
): ContourResult | null {
  const cfg = simplifyConfig!;
  const numPoints = coords.length / 2;

  // Convert grid coords → feet
  const feetPoints: Point[] = new Array(numPoints);
  for (let i = 0; i < numPoints; i++) {
    const gx = coords[i * 2];
    const gy = coords[i * 2 + 1];
    const lon = cfg.bboxMinLon + gx * cfg.lonStep;
    const lat = cfg.bboxMaxLat - gy * cfg.latStep;
    const [xFeet, yFeet] = latLonToFeet(lat, lon, cfg.centerLat, cfg.centerLon);
    feetPoints[i] = [xFeet, cfg.flipY ? -yFeet : yFeet];
  }

  const simplified = simplifyClosedRing(feetPoints, cfg.simplifyFeet);
  if (simplified.length < cfg.minPoints) return null;

  const perimeter = ringPerimeter(simplified);
  if (perimeter < cfg.minPerimeterFeet) return null;

  const scaled: Point[] = simplified.map(([x, y]) => [
    x / cfg.scale,
    y / cfg.scale,
  ]);
  if (signedArea(scaled) < 0) scaled.reverse();

  return {
    height: Number(levelFeet.toFixed(3)),
    polygon: scaled.map(
      ([x, y]) =>
        [Number(x.toFixed(3)), Number(y.toFixed(3))] as [number, number],
    ),
  };
}

function handleSimplify(msg: SimplifyMsg): void {
  const { rings, levelFeet } = msg;
  const results: ContourResult[] = [];
  for (const ring of rings) {
    const result = simplifyOneRing(ring, levelFeet);
    if (result) results.push(result);
  }
  parentPort!.postMessage({ type: "simplify", results });
}

parentPort!.on("message", (msg: WorkerMsg) => {
  switch (msg.type) {
    case "blockIndex":
      handleBlockIndex(msg);
      break;
    case "setBlockIndex":
      handleSetBlockIndex(msg);
      break;
    case "march":
      handleMarch(msg);
      break;
    case "setSimplifyConfig":
      handleSetSimplifyConfig(msg);
      break;
    case "simplify":
      handleSimplify(msg);
      break;
    case "exit":
      process.exit(0);
      break;
  }
});
