import {
  isMSAAEnabled,
  setMSAAEnabled,
} from "../core/graphics/webgpu/MSAAState";
import "./SettingsPanel.css";

interface Props {
  onBack: () => void;
  /** Called after any setting changes so the parent can re-render. */
  onChange: () => void;
}

export function SettingsPanel({ onBack, onChange }: Props) {
  const msaa = isMSAAEnabled();
  return (
    <div class="settings-panel">
      <div class="settings-panel__title">Settings</div>
      <div class="settings-panel__options">
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
      </div>
      <button class="settings-panel__back" onClick={onBack}>
        ← Back
      </button>
    </div>
  );
}
