import type { GameEventMap } from "../entity/Entity";
import { ReactEntity } from "../ReactEntity";

/**
 * Base class for modal UI overlays. Modals register on `game.modalStack`
 * when added and unregister when destroyed. The topmost modal receives
 * Escape via `onEscape()` from the central ESC router (GameController).
 *
 * Set `pausesGame = true` on a subclass to automatically pause the game
 * while the modal is open.
 */
export class Modal extends ReactEntity {
  protected pausesGame: boolean = false;
  private didPause: boolean = false;

  onAdd() {
    super.onAdd();
    this.game!.modalStack.push(this);
    if (this.pausesGame && !this.game!.paused) {
      this.didPause = true;
      this.game!.pause();
    }
  }

  onDestroy(data: GameEventMap["destroy"]) {
    const stack = data.game.modalStack;
    const i = stack.indexOf(this);
    if (i >= 0) stack.splice(i, 1);
    if (this.didPause) {
      this.didPause = false;
      data.game.unpause();
    }
    super.onDestroy(data);
  }

  /** Called by the ESC router when this modal is on top of the stack. */
  onEscape(): void {
    this.destroy();
  }
}
