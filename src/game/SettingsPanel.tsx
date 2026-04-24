import {
  isMSAAEnabled,
  setMSAAEnabled,
} from "../core/graphics/webgpu/MSAAState";
import {
  getMasterVolume,
  setMasterVolume,
} from "../core/sound/MasterVolumeState";
import {
  getQueryBackend,
  setQueryBackend,
} from "./world/query/QueryBackendState";
import "./SettingsPanel.css";

interface Props {
  onBack: () => void;
  /** Called after any setting changes so the parent can re-render. */
  onChange: () => void;
}

export function SettingsPanel({ onBack, onChange }: Props) {
  const msaa = isMSAAEnabled();
  const volume = getMasterVolume();
  const queryBackend = getQueryBackend();
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
            setQueryBackend(queryBackend === "gpu" ? "cpu" : "gpu");
            onChange();
          }}
          title="Requires reloading the level to take effect"
        >
          <span class="settings-panel__option-label">Query Backend</span>
          <span class="settings-panel__option-value">
            {queryBackend === "gpu" ? "GPU" : "CPU"}
          </span>
        </button>
      </div>
      <button class="settings-panel__back" onClick={onBack}>
        ← Back
      </button>
    </div>
  );
}
