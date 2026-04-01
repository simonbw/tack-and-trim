import { clamp } from "../util/MathUtil";

const LOGITECH_VENDOR_ID = 0x046d;
const G29_PRODUCT_ID = 0xc24f;
const DRIVING_FORCE_PRODUCT_ID = 0xc294;
const FORCE_PACKET_SIZE = 7;
const DEFAULT_WHEEL_RANGE_DEGREES = 900;
const STEERING_DEADZONE = 0.02;
const FORCE_DEADBAND = 0.01;
const FORCE_UPDATE_INTERVAL_MS = 16;

interface HIDOutputReportLike {
  reportId: number;
}

interface HIDCollectionLike {
  outputReports: HIDOutputReportLike[];
}

interface HIDDeviceLike {
  productId: number;
  productName?: string;
  opened: boolean;
  collections: HIDCollectionLike[];
  open(): Promise<void>;
  sendReport(reportId: number, data: BufferSource): Promise<void>;
}

interface HIDConnectionEventLike extends Event {
  device: HIDDeviceLike;
}

interface HIDLike {
  requestDevice(options: {
    filters: Array<{ vendorId: number; productId?: number }>;
  }): Promise<HIDDeviceLike[]>;
  getDevices(): Promise<HIDDeviceLike[]>;
  addEventListener(
    type: "disconnect",
    listener: (event: HIDConnectionEventLike) => void,
  ): void;
  removeEventListener(
    type: "disconnect",
    listener: (event: HIDConnectionEventLike) => void,
  ): void;
}

export type SteeringWheelStatus =
  | "unsupported"
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

export interface SteeringWheelConnectionResult {
  connected: boolean;
  message: string;
}

/**
 * Logitech G29 proof-of-concept:
 * - reads steering angle from Gamepad API (for robust axis parsing)
 * - sends force feedback commands via WebHID
 */
export class SteeringWheelManager {
  private device: HIDDeviceLike | null = null;
  private outputReportId = 0;
  private _status: SteeringWheelStatus;
  private errorMessage = "";

  private queuedPacket: Uint8Array | null = null;
  private isSendingPacket = false;

  private lastForce = Number.NaN;
  private lastForceSentAt = 0;

  private readonly onDisconnect = (event: HIDConnectionEventLike) => {
    if (this.device && event.device === this.device) {
      this.device = null;
      this._status = "disconnected";
      this.errorMessage = "";
      this.lastForce = Number.NaN;
    }
  };

  constructor() {
    this._status = this.isSupported() ? "disconnected" : "unsupported";

    if (!this.isSupported()) return;

    this.getHid()?.addEventListener("disconnect", this.onDisconnect);
    void this.tryReconnectGrantedDevice();
  }

  get status(): SteeringWheelStatus {
    return this._status;
  }

  get isConnected(): boolean {
    return this._status === "connected" && this.device?.opened === true;
  }

  get deviceName(): string | null {
    return this.device?.productName ?? null;
  }

  getDebugLabel(): string {
    if (this._status === "unsupported") {
      return "wheel n/a";
    }
    if (this._status === "connecting") {
      return "wheel connecting...";
    }
    if (this._status === "connected") {
      const name = this.deviceName ?? "connected";
      return `wheel ${name}`;
    }
    if (this._status === "error") {
      return this.errorMessage
        ? `wheel error: ${this.errorMessage}`
        : "wheel error";
    }
    return "wheel off (H connect)";
  }

  async requestConnection(): Promise<SteeringWheelConnectionResult> {
    if (!this.isSupported()) {
      return {
        connected: false,
        message:
          "WebHID is unavailable in this browser. Chromium-based browsers are required.",
      };
    }

    this._status = "connecting";
    this.errorMessage = "";

    try {
      const hid = this.getHid();
      if (!hid) {
        this._status = "unsupported";
        return {
          connected: false,
          message:
            "WebHID is unavailable in this browser. Chromium-based browsers are required.",
        };
      }

      const devices = await hid.requestDevice({
        filters: [
          { vendorId: LOGITECH_VENDOR_ID, productId: G29_PRODUCT_ID },
          {
            vendorId: LOGITECH_VENDOR_ID,
            productId: DRIVING_FORCE_PRODUCT_ID,
          },
        ],
      });
      const device = devices[0];
      if (!device) {
        this._status = "disconnected";
        return {
          connected: false,
          message: "Wheel selection was canceled.",
        };
      }

      await this.attachDevice(device);
      return {
        connected: true,
        message: `${device.productName ?? "Logitech wheel"} connected.`,
      };
    } catch (error) {
      this._status = "error";
      this.errorMessage = this.getErrorMessage(error);
      return {
        connected: false,
        message: `Failed to connect wheel: ${this.errorMessage}`,
      };
    }
  }

  getSteeringInput(): number | null {
    const gamepad = this.findWheelGamepad();
    if (!gamepad) return null;

    const steerAxis = gamepad.axes[0] ?? 0;
    let steer = clamp(steerAxis, -1, 1);
    if (Math.abs(steer) < STEERING_DEADZONE) {
      steer = 0;
    }
    return steer;
  }

  /**
   * Sets continuous constant-force feedback in [-1, 1].
   */
  setForceFeedback(force: number): void {
    if (!this.isConnected) return;

    const now = performance.now();
    const clampedForce = clamp(force, -1, 1);
    if (
      now - this.lastForceSentAt < FORCE_UPDATE_INTERVAL_MS &&
      Math.abs(clampedForce - this.lastForce) < 0.03
    ) {
      return;
    }
    this.lastForceSentAt = now;

    if (Math.abs(clampedForce) <= FORCE_DEADBAND) {
      if (this.lastForce === 0) return;
      this.lastForce = 0;
      this.queuePacket(this.buildStopForcePacket());
      return;
    }

    this.lastForce = clampedForce;
    this.queuePacket(this.buildConstantForcePacket(clampedForce));
  }

  destroy(): void {
    if (!this.isSupported()) return;

    this.getHid()?.removeEventListener("disconnect", this.onDisconnect);
    this.queuePacket(this.buildStopForcePacket());
  }

  private isSupported(): boolean {
    return typeof navigator !== "undefined" && "hid" in navigator;
  }

  private async tryReconnectGrantedDevice(): Promise<void> {
    if (!this.isSupported()) return;
    if (this.device?.opened) return;

    try {
      const hid = this.getHid();
      if (!hid) return;
      const devices = await hid.getDevices();
      const knownWheel = devices.find((device) =>
        this.isSupportedWheelProduct(device.productId),
      );
      if (!knownWheel) return;
      await this.attachDevice(knownWheel);
    } catch {
      // Non-fatal: user can still connect manually with KeyH.
    }
  }

  private async attachDevice(device: HIDDeviceLike): Promise<void> {
    if (!device.opened) {
      await device.open();
    }
    this.device = device;
    this.outputReportId = this.resolveOutputReportId(device);
    this.lastForce = Number.NaN;

    await this.sendPacketNow(
      this.buildSetRangePacket(DEFAULT_WHEEL_RANGE_DEGREES),
    );
    await this.sendPacketNow(this.buildDisableAutoCenterPacket());
    await this.sendPacketNow(this.buildStopForcePacket());
    this._status = "connected";
    this.errorMessage = "";
  }

  private resolveOutputReportId(device: HIDDeviceLike): number {
    for (const collection of device.collections) {
      const report = collection.outputReports[0];
      if (report) {
        return report.reportId;
      }
    }
    return 0;
  }

  private isSupportedWheelProduct(productId: number): boolean {
    return (
      productId === G29_PRODUCT_ID || productId === DRIVING_FORCE_PRODUCT_ID
    );
  }

  private findWheelGamepad(): Gamepad | null {
    const allGamepads = navigator.getGamepads();
    for (const gamepad of allGamepads) {
      if (!gamepad) continue;
      const id = gamepad.id.toLowerCase();
      const isLogitech = id.includes("logitech");
      const isWheel = id.includes("g29") || id.includes("wheel");
      if (isLogitech && isWheel) {
        return gamepad;
      }
    }
    return null;
  }

  private buildStopForcePacket(): Uint8Array {
    return new Uint8Array([0x13, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  }

  private buildConstantForcePacket(force: number): Uint8Array {
    const level = Math.round(clamp(force, -1, 1) * 100);
    const encoded = clamp(Math.round((level * 127) / 100 + 0x80), 0, 0xff);

    return new Uint8Array([0x11, 0x08, encoded, 0x80, 0x00, 0x00, 0x00]);
  }

  private buildDisableAutoCenterPacket(): Uint8Array {
    return new Uint8Array([0xf5, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  }

  private buildSetRangePacket(rangeDegrees: number): Uint8Array {
    const range = clamp(Math.round(rangeDegrees), 40, 900);
    return new Uint8Array([
      0xf8,
      0x81,
      range & 0xff,
      (range >> 8) & 0xff,
      0x00,
      0x00,
      0x00,
    ]);
  }

  private async sendPacketNow(packet: Uint8Array): Promise<void> {
    if (packet.byteLength !== FORCE_PACKET_SIZE) {
      throw new Error("Invalid wheel packet size");
    }
    const device = this.device;
    if (!device?.opened) return;
    await device.sendReport(
      this.outputReportId,
      packet as unknown as BufferSource,
    );
  }

  private queuePacket(packet: Uint8Array): void {
    this.queuedPacket = packet;
    if (this.isSendingPacket) return;
    this.isSendingPacket = true;
    void this.flushPacketQueue();
  }

  private async flushPacketQueue(): Promise<void> {
    while (this.queuedPacket) {
      const packet = this.queuedPacket;
      this.queuedPacket = null;
      try {
        await this.sendPacketNow(packet);
      } catch (error) {
        this._status = "error";
        this.errorMessage = this.getErrorMessage(error);
      }
    }
    this.isSendingPacket = false;
  }

  private getErrorMessage(error: unknown): string {
    if (error instanceof Error && error.message) {
      return error.message;
    }
    return "unknown error";
  }

  private getHid(): HIDLike | null {
    const nav = navigator as Navigator & { hid?: HIDLike };
    return nav.hid ?? null;
  }
}
