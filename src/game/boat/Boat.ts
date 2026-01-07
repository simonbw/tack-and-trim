import BaseEntity from "../../core/entity/BaseEntity";
import { polarToVec } from "../../core/util/MathUtil";
import { V, V2d } from "../../core/Vector";
import { Anchor } from "./Anchor";
import { Bowsprit, BOWSPRIT_TIP_POSITION } from "./Bowsprit";
import { Hull } from "./Hull";
import { Keel } from "./Keel";
import { Rig } from "./Rig";
import { Rudder } from "./Rudder";
import { Sail } from "./Sail";
import { Sheet } from "./Sheet";

const MAST_POSITION = V(5, 0);
const JIB_HEAD_POSITION = V(5, 0); // At mast (hull-local)
const JIB_TACK_POSITION = BOWSPRIT_TIP_POSITION; // At end of bowsprit (hull-local)

const ROW_DURATION = 0.6; // seconds per row
const ROW_FORCE = 500; // force per row

// Mainsheet attachment points and config
const MAINSHEET_BOOM_ATTACH_RATIO = 0.9;
const MAINSHEET_HULL_ATTACH = V(-12, 0);

// Jib sheet attachment points
const PORT_JIB_SHEET_ATTACH = V(-5, 10);
const STARBOARD_JIB_SHEET_ATTACH = V(-5, -10);

export class Boat extends BaseEntity {
  id = "boat";

  hull: Hull;
  keel: Keel;
  rudder: Rudder;
  rig: Rig;
  bowsprit: Bowsprit;
  jib!: Sail;
  anchor!: Anchor;

  // Sheets - created in onAdd()
  mainsheet!: Sheet;
  portJibSheet!: Sheet;
  starboardJibSheet!: Sheet;
  private activeJibSheet: "port" | "starboard" = "port";

  constructor() {
    super();

    // Create hull first - everything attaches to it
    this.hull = new Hull();

    // Create parts that attach to hull
    this.keel = new Keel(this.hull);
    this.rudder = new Rudder(this.hull);
    this.rig = new Rig(this.hull, MAST_POSITION);
    this.bowsprit = new Bowsprit(this.hull);

    // Sheets and jib are created in onAdd() since they need body references
  }

  onAdd() {
    // Add all children - they will be registered with the game
    this.addChild(this.hull);
    this.addChild(this.keel);
    this.addChild(this.rudder);
    this.addChild(this.rig);
    this.addChild(this.bowsprit);

    // Create mainsheet (boom to hull)
    const boomAttachLocal = V(
      -this.rig.getBoomLength() * MAINSHEET_BOOM_ATTACH_RATIO,
      0
    );
    this.mainsheet = this.addChild(
      new Sheet(this.rig.body, boomAttachLocal, this.hull.body, MAINSHEET_HULL_ATTACH, {
        minLength: 6,
        maxLength: 35,
        defaultLength: 20,
        trimSpeed: 8,
        easeSpeed: 8,
      })
    );

    // Helper to transform hull-local position to world
    const toWorld = (localPos: V2d): V2d => {
      const [hx, hy] = this.hull.body.position;
      return localPos.rotate(this.hull.body.angle).iadd([hx, hy]);
    };

    // Compute initial clew position for jib setup
    // Chain goes tack → clew, so clew is offset from tack
    const computeInitialClew = (): V2d => {
      const tack = toWorld(JIB_TACK_POSITION);
      const head = toWorld(JIB_HEAD_POSITION);
      // Foot direction: perpendicular to luff, toward stern
      const luff = tack.sub(head);
      const footDir = luff.rotate90cw().normalize();
      // Clew is roughly 15 units along foot, slightly back toward stern
      return tack.add(footDir.mul(15)).add(V(-5, 0).rotate(this.hull.body.angle));
    };

    // Create jib sail with config
    // Particle chain goes tack → clew (the foot), matching mainsail's approach
    this.jib = this.addChild(
      new Sail({
        getHeadPosition: () => toWorld(JIB_TACK_POSITION), // Chain starts at tack
        getInitialClewPosition: computeInitialClew,
        // getClewPosition omitted - defaults to reading from clew particle
        headConstraint: {
          body: this.hull.body,
          localAnchor: JIB_TACK_POSITION, // Tack constrained to bow
        },
        // No clewConstraint - clew is free, controlled by sheets
        sailShape: "triangle",
        billowOuter: 1.5,
        extraPoints: () => [toWorld(JIB_HEAD_POSITION)], // Masthead - forms the leech
      })
    );

    // Create jib sheets (clew to hull, port and starboard)
    const jibSheetConfig = {
      minLength: 8,
      maxLength: 40,
      defaultLength: 25,
      trimSpeed: 20,
      easeSpeed: 60,
    };
    const clewBody = this.jib.getClew();

    this.portJibSheet = this.addChild(
      new Sheet(
        clewBody,
        V(0, 0),
        this.hull.body,
        PORT_JIB_SHEET_ATTACH,
        jibSheetConfig
      )
    );

    this.starboardJibSheet = this.addChild(
      new Sheet(
        clewBody,
        V(0, 0),
        this.hull.body,
        STARBOARD_JIB_SHEET_ATTACH,
        { ...jibSheetConfig, defaultLength: 40 } // Inactive sheet starts slack
      )
    );
    // Inactive starboard sheet starts released
    this.starboardJibSheet.release();

    // Create anchor
    this.anchor = this.addChild(new Anchor(this.hull));
  }

  onTick(): void {
    // Fade jib sheets based on jib hoist amount
    const jibOpacity = this.jib.getHoistAmount();
    this.portJibSheet.setOpacity(jibOpacity);
    this.starboardJibSheet.setOpacity(jibOpacity);
  }

  // ============ Action Methods ============
  // These are called by controllers (player input, AI, etc.)

  /** Steer the boat. input: -1 (left) to +1 (right) */
  steer(input: number, dt: number, fast: boolean = false): void {
    this.rudder.setSteer(input, dt, fast);
  }

  /** Adjust mainsheet. input: -1 (trim in) to +1 (ease out) */
  adjustMainsheet(input: number, dt: number, fast: boolean = false): void {
    const effectiveDt = fast ? dt * 2.5 : dt;
    this.mainsheet.adjust(input, effectiveDt);
  }

  /** Adjust the active jib sheet. input: -1 (trim in) to +1 (ease out) */
  adjustJibSheet(input: number, dt: number, fast: boolean = false): void {
    const effectiveDt = fast ? dt : dt * 0.5;
    const activeSheet =
      this.activeJibSheet === "port" ? this.portJibSheet : this.starboardJibSheet;
    activeSheet.adjust(input, effectiveDt);
  }

  /** Switch active jib sheet (tack) */
  tackJib(side: "port" | "starboard"): void {
    if (this.activeJibSheet === side) return;

    // Release the old sheet
    if (this.activeJibSheet === "port") {
      this.portJibSheet.release();
    } else {
      this.starboardJibSheet.release();
    }

    this.activeJibSheet = side;
  }

  /** Get current active jib sheet side */
  getActiveJibSheet(): "port" | "starboard" {
    return this.activeJibSheet;
  }

  /** Check if the active jib sheet is fully eased out */
  isActiveJibSheetAtMax(): boolean {
    const activeSheet =
      this.activeJibSheet === "port" ? this.portJibSheet : this.starboardJibSheet;
    return activeSheet.isAtMaxLength();
  }

  /** Row the boat forward */
  row(): void {
    this.wait(ROW_DURATION, (dt, t) => {
      this.hull.body.applyForce(polarToVec(this.hull.body.angle, ROW_FORCE));
    });
  }

  /** Toggle sails hoisted/lowered */
  toggleSails(): void {
    const newState = !this.rig.sail.isHoisted();
    this.rig.sail.setHoisted(newState);
    this.jib.setHoisted(newState);
  }

  /** Toggle anchor deployed/retrieved */
  toggleAnchor(): void {
    this.anchor.toggle();
  }

  // ============ Getters ============

  getPosition(): V2d {
    return this.hull.getPosition();
  }

  getVelocity(): V2d {
    return V(this.hull.body.velocity);
  }
}
