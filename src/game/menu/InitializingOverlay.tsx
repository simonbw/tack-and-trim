import { ReactEntity } from "../../core/ReactEntity";
import "./InitializingOverlay.css";

export class InitializingOverlay extends ReactEntity {
  constructor() {
    super(() => {
      // Stub: No loading needed with stub world system
      const percentComplete = 100;

      return (
        <div class="initializing-overlay">
          <div class="initializing-overlay__content">
            <div class="initializing-overlay__title">
              Computing terrain effects...
            </div>
            <div class="initializing-overlay__step">{percentComplete}%</div>
          </div>
        </div>
      );
    });
  }
}
