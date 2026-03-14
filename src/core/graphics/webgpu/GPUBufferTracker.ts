/**
 * Tracks GPU buffer allocations for memory profiling.
 *
 * Installed by WebGPUDeviceManager after device init — intercepts
 * device.createBuffer so every buffer (regardless of call site) is
 * automatically registered and unregistered on destroy.
 */

export interface BufferEntry {
  label: string;
  size: number;
}

export interface BufferStats {
  /** Individual buffer groups, sorted by total size descending. */
  entries: Array<{ label: string; size: number; count: number }>;
  /** Sum of all live buffer sizes in bytes. */
  totalBytes: number;
}

let instance: GPUBufferTracker | null = null;

export class GPUBufferTracker {
  private buffers = new Map<GPUBuffer, BufferEntry>();

  static getInstance(): GPUBufferTracker {
    if (!instance) {
      instance = new GPUBufferTracker();
    }
    return instance;
  }

  /**
   * Patch a GPUDevice so every createBuffer call is tracked.
   * Also patches each buffer's destroy() to unregister it.
   */
  install(device: GPUDevice): void {
    const tracker = this;
    const originalCreateBuffer = device.createBuffer.bind(device);

    device.createBuffer = (descriptor: GPUBufferDescriptor): GPUBuffer => {
      const buffer = originalCreateBuffer(descriptor);
      tracker.register(
        buffer,
        descriptor.label ?? "(unlabelled)",
        descriptor.size,
      );

      const originalDestroy = buffer.destroy.bind(buffer);
      buffer.destroy = () => {
        tracker.unregister(buffer);
        originalDestroy();
      };

      return buffer;
    };
  }

  private register(buffer: GPUBuffer, label: string, size: number): void {
    this.buffers.set(buffer, { label, size });
  }

  private unregister(buffer: GPUBuffer): void {
    this.buffers.delete(buffer);
  }

  /** Aggregate live buffers by label, sorted by total size descending. */
  getStats(): BufferStats {
    const groups = new Map<string, { size: number; count: number }>();
    let totalBytes = 0;

    for (const { label, size } of this.buffers.values()) {
      totalBytes += size;
      const existing = groups.get(label);
      if (existing) {
        existing.size += size;
        existing.count++;
      } else {
        groups.set(label, { size, count: 1 });
      }
    }

    const entries = Array.from(groups.entries())
      .map(([label, { size, count }]) => ({ label, size, count }))
      .sort((a, b) => b.size - a.size);

    return { entries, totalBytes };
  }
}
