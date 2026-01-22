import { ReactEntity } from "../core/ReactEntity";
import { InfluenceFieldManager } from "./world-data/influence/InfluenceFieldManager";
import "./InitializingOverlay.css";

export class InitializingOverlay extends ReactEntity {
  constructor() {
    super(() => {
      const manager = InfluenceFieldManager.maybeFromGame(this.game!);
      const progress = manager?.getProgress() ?? {
        wind: 0,
        swell: 0,
        fetch: 0,
      };

      // Calculate overall progress as average of all three
      const overallProgress =
        (progress.wind + progress.swell + progress.fetch) / 3;
      const percentComplete = Math.round(overallProgress * 100);

      return (
        <div class="initializing-overlay">
          <div class="initializing-overlay__content">
            <div class="initializing-overlay__title">
              Computing terrain effects...
            </div>
            <div class="initializing-overlay__tasks">
              <div class="initializing-overlay__task">
                <span class="initializing-overlay__task-label">Wind</span>
                <progress
                  class="initializing-overlay__progress"
                  value={progress.wind}
                  max={1}
                />
              </div>
              <div class="initializing-overlay__task">
                <span class="initializing-overlay__task-label">Swell</span>
                <progress
                  class="initializing-overlay__progress"
                  value={progress.swell}
                  max={1}
                />
              </div>
              <div class="initializing-overlay__task">
                <span class="initializing-overlay__task-label">Fetch</span>
                <progress
                  class="initializing-overlay__progress"
                  value={progress.fetch}
                  max={1}
                />
              </div>
            </div>
            <div class="initializing-overlay__step">{percentComplete}%</div>
          </div>
        </div>
      );
    });
  }
}
