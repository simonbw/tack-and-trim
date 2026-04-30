import {
  getRenderScale,
  setRenderScale,
  type RenderScale,
} from "../core/graphics/RenderScaleState";
import {
  isMSAAEnabled,
  setMSAAEnabled,
} from "../core/graphics/webgpu/MSAAState";
import {
  getMasterVolume,
  setMasterVolume,
} from "../core/sound/MasterVolumeState";
import {
  getQueryEngine,
  setQueryEngine,
  type QueryEngine,
} from "./world/query/QueryBackendState";
import {
  getWaterQuality,
  setWaterQuality,
  type WaterQuality,
} from "./surface-rendering/WaterQualityState";
import "./SettingsPanel.css";

interface Props {
  onBack: () => void;
  /** Called after any setting changes so the parent can re-render. */
  onChange: () => void;
}

const QUERY_ENGINE_CYCLE: QueryEngine[] = ["js", "wasm"];
const QUERY_ENGINE_LABELS: Record<QueryEngine, string> = {
  js: "JS",
  wasm: "WASM",
};

const WATER_QUALITY_CYCLE: WaterQuality[] = ["low", "medium", "high"];
const WATER_QUALITY_LABELS: Record<WaterQuality, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
};

const RENDER_SCALE_CYCLE: RenderScale[] = ["low", "medium", "high"];
const RENDER_SCALE_LABELS: Record<RenderScale, string> = {
  low: "Low (50%)",
  medium: "Medium (75%)",
  high: "High (100%)",
};

export function SettingsPanel({ onBack, onChange }: Props) {
  const msaa = isMSAAEnabled();
  const volume = getMasterVolume();
  const queryEngine = getQueryEngine();
  const waterQuality = getWaterQuality();
  const renderScale = getRenderScale();
  return (
    <div class="settings-panel">
      <div class="settings-panel__title">Settings</div>
      <div class="settings-panel__options">
        <label class="settings-panel__option settings-panel__option--slider">
          <span class="settings-panel__option-label">Master Volume</span>
          <input
            class="settings-panel__slider"
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={volume}
            onInput={(e) => {
              setMasterVolume(Number((e.target as HTMLInputElement).value));
              onChange();
            }}
          />
          <span class="settings-panel__option-value">
            {Math.round(volume * 100)}%
          </span>
        </label>
        <button
          class="settings-panel__option"
          onClick={() => {
            setMSAAEnabled(!msaa);
            onChange();
          }}
        >
          <span class="settings-panel__option-label">
            Antialiasing (MSAA 4x)
          </span>
          <span class="settings-panel__option-value">
            {msaa ? "On" : "Off"}
          </span>
        </button>
        <button
          class="settings-panel__option"
          onClick={() => {
            const i = QUERY_ENGINE_CYCLE.indexOf(queryEngine);
            const next =
              QUERY_ENGINE_CYCLE[(i + 1) % QUERY_ENGINE_CYCLE.length];
            setQueryEngine(next);
            onChange();
          }}
          title="JS/WASM run the CPU worker pool with the corresponding math kernel. Requires reloading the level to take effect."
        >
          <span class="settings-panel__option-label">Query Engine</span>
          <span class="settings-panel__option-value">
            {QUERY_ENGINE_LABELS[queryEngine]}
          </span>
        </button>
        <button
          class="settings-panel__option"
          onClick={() => {
            const i = WATER_QUALITY_CYCLE.indexOf(waterQuality);
            const next =
              WATER_QUALITY_CYCLE[(i + 1) % WATER_QUALITY_CYCLE.length];
            setWaterQuality(next);
            onChange();
          }}
          title="Water-height texture resolution. Low (¼) is fastest; High (full) is sharpest. Medium is the default."
        >
          <span class="settings-panel__option-label">Water Quality</span>
          <span class="settings-panel__option-value">
            {WATER_QUALITY_LABELS[waterQuality]}
          </span>
        </button>
        <button
          class="settings-panel__option"
          onClick={() => {
            const i = RENDER_SCALE_CYCLE.indexOf(renderScale);
            const next =
              RENDER_SCALE_CYCLE[(i + 1) % RENDER_SCALE_CYCLE.length];
            setRenderScale(next);
            onChange();
          }}
          title="Overall render resolution as a fraction of your display's native pixel density. Low halves the render resolution; High renders at native (default)."
        >
          <span class="settings-panel__option-label">Render Resolution</span>
          <span class="settings-panel__option-value">
            {RENDER_SCALE_LABELS[renderScale]}
          </span>
        </button>
      </div>
      <button class="settings-panel__back" onClick={onBack}>
        ← Back
      </button>
    </div>
  );
}
