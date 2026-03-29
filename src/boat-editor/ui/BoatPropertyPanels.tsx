/**
 * Property panels for the boat editor.
 * Collapsible sections for each part of the BoatConfig.
 */

import { useState, useCallback, useRef } from "preact/hooks";
import type { BoatEditorController } from "../BoatEditorController";
import { SetPropertyCommand } from "../BoatEditorDocument";
import "../../editor/ui/EditorStyles.css";
import "./BoatEditorStyles.css";

export interface BoatPropertyPanelsProps {
  controller: BoatEditorController;
}

export function BoatPropertyPanels({ controller }: BoatPropertyPanelsProps) {
  const config = controller.document.config;

  return (
    <div class="boat-panels">
      <PanelSection title="Hull" defaultOpen>
        <NumberField
          label="Mass"
          value={config.hull.mass}
          path="hull.mass"
          controller={controller}
          min={50}
          max={5000}
          step={10}
          unit="lbs"
        />
        <NumberField
          label="Draft"
          value={config.hull.draft}
          path="hull.draft"
          controller={controller}
          min={0}
          max={10}
          step={0.1}
          unit="ft"
        />
        <NumberField
          label="Deck Height"
          value={config.hull.deckHeight}
          path="hull.deckHeight"
          controller={controller}
          min={0}
          max={10}
          step={0.1}
          unit="ft"
        />
        <NumberField
          label="Skin Friction"
          value={config.hull.skinFrictionCoefficient}
          path="hull.skinFrictionCoefficient"
          controller={controller}
          min={0.001}
          max={0.01}
          step={0.0005}
        />
      </PanelSection>

      <PanelSection title="Keel">
        <NumberField
          label="Draft"
          value={config.keel.draft}
          path="keel.draft"
          controller={controller}
          min={0}
          max={15}
          step={0.1}
          unit="ft"
        />
        <NumberField
          label="Chord"
          value={config.keel.chord}
          path="keel.chord"
          controller={controller}
          min={0.1}
          max={5}
          step={0.05}
          unit="ft"
        />
      </PanelSection>

      <PanelSection title="Rudder">
        <NumberField
          label="Length"
          value={config.rudder.length}
          path="rudder.length"
          controller={controller}
          min={0.5}
          max={10}
          step={0.1}
          unit="ft"
        />
        <NumberField
          label="Draft"
          value={config.rudder.draft}
          path="rudder.draft"
          controller={controller}
          min={0}
          max={10}
          step={0.1}
          unit="ft"
        />
        <NumberField
          label="Chord"
          value={config.rudder.chord}
          path="rudder.chord"
          controller={controller}
          min={0.1}
          max={5}
          step={0.05}
          unit="ft"
        />
        <NumberField
          label="Max Steer Angle"
          value={toDeg(config.rudder.maxSteerAngle)}
          path="rudder.maxSteerAngle"
          controller={controller}
          min={5}
          max={60}
          step={1}
          unit="deg"
          toConfig={toRad}
          fromConfig={toDeg}
        />
      </PanelSection>

      <PanelSection title="Rig">
        <NumberField
          label="Boom Length"
          value={config.rig.boomLength}
          path="rig.boomLength"
          controller={controller}
          min={0.5}
          max={20}
          step={0.1}
          unit="ft"
        />
        <NumberField
          label="Boom Width"
          value={config.rig.boomWidth}
          path="rig.boomWidth"
          controller={controller}
          min={0.1}
          max={2}
          step={0.05}
          unit="ft"
        />
        <NumberField
          label="Boom Mass"
          value={config.rig.boomMass}
          path="rig.boomMass"
          controller={controller}
          min={1}
          max={100}
          step={1}
          unit="lbs"
        />
      </PanelSection>

      <PanelSection title="Mainsail">
        <NumberField
          label="Lift Scale"
          value={config.rig.mainsail.liftScale ?? 1}
          path="rig.mainsail.liftScale"
          controller={controller}
          min={0}
          max={3}
          step={0.05}
        />
        <NumberField
          label="Drag Scale"
          value={config.rig.mainsail.dragScale ?? 1}
          path="rig.mainsail.dragScale"
          controller={controller}
          min={0}
          max={3}
          step={0.05}
        />
        <NumberField
          label="Node Mass"
          value={config.rig.mainsail.nodeMass ?? 0.5}
          path="rig.mainsail.nodeMass"
          controller={controller}
          min={0.01}
          max={5}
          step={0.05}
        />
        <NumberField
          label="Hoist Speed"
          value={config.rig.mainsail.hoistSpeed ?? 0.3}
          path="rig.mainsail.hoistSpeed"
          controller={controller}
          min={0.05}
          max={2}
          step={0.05}
        />
      </PanelSection>

      {config.jib && (
        <PanelSection title="Jib">
          <NumberField
            label="Lift Scale"
            value={config.jib.liftScale ?? 1}
            path="jib.liftScale"
            controller={controller}
            min={0}
            max={3}
            step={0.05}
          />
          <NumberField
            label="Drag Scale"
            value={config.jib.dragScale ?? 1}
            path="jib.dragScale"
            controller={controller}
            min={0}
            max={3}
            step={0.05}
          />
        </PanelSection>
      )}

      <PanelSection title="Mainsheet">
        <NumberField
          label="Boom Attach Ratio"
          value={config.mainsheet.boomAttachRatio}
          path="mainsheet.boomAttachRatio"
          controller={controller}
          min={0}
          max={1}
          step={0.05}
        />
        <NumberField
          label="Trim Speed"
          value={config.mainsheet.trimSpeed ?? 3}
          path="mainsheet.trimSpeed"
          controller={controller}
          min={0.5}
          max={20}
          step={0.5}
          unit="ft/s"
        />
      </PanelSection>

      <PanelSection title="Tilt / Stability">
        <NumberField
          label="Roll Inertia"
          value={config.tilt.rollInertia}
          path="tilt.rollInertia"
          controller={controller}
          min={100}
          max={50000}
          step={100}
        />
        <NumberField
          label="Pitch Inertia"
          value={config.tilt.pitchInertia}
          path="tilt.pitchInertia"
          controller={controller}
          min={100}
          max={100000}
          step={100}
        />
        <NumberField
          label="Roll Damping"
          value={config.tilt.rollDamping}
          path="tilt.rollDamping"
          controller={controller}
          min={100}
          max={50000}
          step={100}
        />
        <NumberField
          label="Pitch Damping"
          value={config.tilt.pitchDamping}
          path="tilt.pitchDamping"
          controller={controller}
          min={100}
          max={100000}
          step={100}
        />
        <NumberField
          label="Righting Moment"
          value={config.tilt.rightingMomentCoeff}
          path="tilt.rightingMomentCoeff"
          controller={controller}
          min={1000}
          max={200000}
          step={1000}
        />
        <NumberField
          label="Pitch Righting"
          value={config.tilt.pitchRightingCoeff}
          path="tilt.pitchRightingCoeff"
          controller={controller}
          min={1000}
          max={200000}
          step={1000}
        />
        <NumberField
          label="Max Roll"
          value={toDeg(config.tilt.maxRoll)}
          path="tilt.maxRoll"
          controller={controller}
          min={5}
          max={90}
          step={1}
          unit="deg"
          toConfig={toRad}
          fromConfig={toDeg}
        />
        <NumberField
          label="Max Pitch"
          value={toDeg(config.tilt.maxPitch)}
          path="tilt.maxPitch"
          controller={controller}
          min={5}
          max={60}
          step={1}
          unit="deg"
          toConfig={toRad}
          fromConfig={toDeg}
        />
      </PanelSection>

      <PanelSection title="Buoyancy">
        <NumberField
          label="Vertical Mass"
          value={config.buoyancy.verticalMass}
          path="buoyancy.verticalMass"
          controller={controller}
          min={50}
          max={10000}
          step={10}
          unit="lbs"
        />
        <NumberField
          label="CG Height"
          value={config.buoyancy.centerOfGravityZ}
          path="buoyancy.centerOfGravityZ"
          controller={controller}
          min={-5}
          max={5}
          step={0.1}
          unit="ft"
        />
      </PanelSection>

      <PanelSection title="Bilge">
        <NumberField
          label="Max Water Volume"
          value={config.bilge.maxWaterVolume}
          path="bilge.maxWaterVolume"
          controller={controller}
          min={1}
          max={100}
          step={1}
          unit="ft³"
        />
        <NumberField
          label="Bail Bucket Size"
          value={config.bilge.bailBucketSize}
          path="bilge.bailBucketSize"
          controller={controller}
          min={0.05}
          max={2}
          step={0.05}
          unit="ft³"
        />
        <NumberField
          label="Slosh Gravity"
          value={config.bilge.sloshGravity}
          path="bilge.sloshGravity"
          controller={controller}
          min={0}
          max={20}
          step={0.5}
        />
      </PanelSection>

      <PanelSection title="Grounding">
        <NumberField
          label="Keel Friction"
          value={config.grounding.keelFriction}
          path="grounding.keelFriction"
          controller={controller}
          min={0}
          max={5000}
          step={50}
        />
        <NumberField
          label="Rudder Friction"
          value={config.grounding.rudderFriction}
          path="grounding.rudderFriction"
          controller={controller}
          min={0}
          max={5000}
          step={50}
        />
        <NumberField
          label="Hull Friction"
          value={config.grounding.hullFriction}
          path="grounding.hullFriction"
          controller={controller}
          min={0}
          max={10000}
          step={100}
        />
      </PanelSection>

      <PanelSection title="Damage">
        <NumberField
          label="Sail Overpower Threshold"
          value={config.sailDamage.overpowerForceThreshold}
          path="sailDamage.overpowerForceThreshold"
          controller={controller}
          min={50}
          max={2000}
          step={10}
          unit="lbf"
        />
        <NumberField
          label="Max Lift Reduction"
          value={config.sailDamage.maxLiftReduction}
          path="sailDamage.maxLiftReduction"
          controller={controller}
          min={0}
          max={1}
          step={0.05}
        />
        <NumberField
          label="Max Steering Reduction"
          value={config.rudderDamage.maxSteeringReduction}
          path="rudderDamage.maxSteeringReduction"
          controller={controller}
          min={0}
          max={1}
          step={0.05}
        />
      </PanelSection>

      <PanelSection title="Anchor">
        <NumberField
          label="Max Rode Length"
          value={config.anchor.maxRodeLength}
          path="anchor.maxRodeLength"
          controller={controller}
          min={10}
          max={200}
          step={5}
          unit="ft"
        />
        <NumberField
          label="Anchor Mass"
          value={config.anchor.anchorMass}
          path="anchor.anchorMass"
          controller={controller}
          min={1}
          max={200}
          step={1}
          unit="lbs"
        />
        <NumberField
          label="Drag Coefficient"
          value={config.anchor.anchorDragCoefficient}
          path="anchor.anchorDragCoefficient"
          controller={controller}
          min={10}
          max={1000}
          step={10}
        />
      </PanelSection>

      <PanelSection title="Rowing">
        <NumberField
          label="Stroke Duration"
          value={config.rowing.duration}
          path="rowing.duration"
          controller={controller}
          min={0.1}
          max={3}
          step={0.05}
          unit="s"
        />
        <NumberField
          label="Stroke Force"
          value={config.rowing.force}
          path="rowing.force"
          controller={controller}
          min={100}
          max={20000}
          step={100}
          unit="lbf"
        />
      </PanelSection>
    </div>
  );
}

// ============================================
// Reusable components
// ============================================

function PanelSection({
  title,
  defaultOpen = false,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: preact.ComponentChildren;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div class={`boat-panel-section ${open ? "open" : ""}`}>
      <div class="boat-panel-header" onClick={() => setOpen(!open)}>
        <span class="boat-panel-chevron">{open ? "\u25BE" : "\u25B8"}</span>
        {title}
      </div>
      {open && <div class="boat-panel-body">{children}</div>}
    </div>
  );
}

interface NumberFieldProps {
  label: string;
  value: number;
  path: string;
  controller: BoatEditorController;
  min: number;
  max: number;
  step: number;
  unit?: string;
  toConfig?: (displayValue: number) => number;
  fromConfig?: (configValue: number) => number;
}

function NumberField({
  label,
  value,
  path,
  controller,
  min,
  max,
  step,
  unit,
  toConfig,
  fromConfig,
}: NumberFieldProps) {
  const displayValue = fromConfig ? fromConfig(value) : value;
  const dragRef = useRef<{
    startX: number;
    startValue: number;
    committed: boolean;
  } | null>(null);

  const commitValue = useCallback(
    (displayVal: number) => {
      const clamped = Math.max(min, Math.min(max, displayVal));
      const configVal = toConfig ? toConfig(clamped) : clamped;
      controller.document.executeCommand(
        new SetPropertyCommand(controller.document, path, configVal),
      );
    },
    [controller, path, min, max, toConfig],
  );

  return (
    <div class="boat-field">
      <label
        class="boat-field-label"
        onMouseDown={(e: MouseEvent) => {
          e.preventDefault();
          dragRef.current = {
            startX: e.clientX,
            startValue: displayValue,
            committed: false,
          };
          const onMove = (me: MouseEvent) => {
            if (!dragRef.current) return;
            const dx = me.clientX - dragRef.current.startX;
            const newVal =
              dragRef.current.startValue + dx * step * (me.shiftKey ? 0.1 : 1);
            commitValue(newVal);
            dragRef.current.committed = true;
          };
          const onUp = () => {
            dragRef.current = null;
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
          };
          window.addEventListener("mousemove", onMove);
          window.addEventListener("mouseup", onUp);
        }}
      >
        {label}
      </label>
      <div class="boat-field-controls">
        <input
          type="range"
          class="boat-field-slider"
          min={min}
          max={max}
          step={step}
          value={displayValue}
          onInput={(e) => {
            commitValue(parseFloat((e.target as HTMLInputElement).value));
          }}
        />
        <input
          type="number"
          class="boat-field-input"
          min={min}
          max={max}
          step={step}
          value={roundDisplay(displayValue, step)}
          onChange={(e) => {
            commitValue(parseFloat((e.target as HTMLInputElement).value));
          }}
        />
        {unit && <span class="boat-field-unit">{unit}</span>}
      </div>
    </div>
  );
}

// ============================================
// Helpers
// ============================================

function toDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function roundDisplay(value: number, step: number): number {
  const decimals = Math.max(0, -Math.floor(Math.log10(step)));
  return parseFloat(value.toFixed(decimals));
}
