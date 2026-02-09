/**
 * Type-safe uniform buffer system.
 *
 * Generates both TypeScript accessors and WGSL shader structs from a single definition.
 * Handles WGSL alignment rules automatically.
 *
 * @example
 * const SurfaceUniforms = defineUniformStruct('Uniforms', {
 *   cameraMatrix: mat3x3,
 *   time: f32,
 *   renderMode: i32,
 * });
 *
 * // WGSL generation
 * const shaderCode = `${SurfaceUniforms.wgsl}`;
 *
 * // Type-safe setters
 * const uniforms = SurfaceUniforms.create();
 * uniforms.set.time(1.5);
 * uniforms.set.cameraMatrix(matrix);
 */

import type { Matrix3 } from "./Matrix3";

// ============ Field Type Definitions ============

/** Base field type descriptor with size and alignment info */
interface FieldTypeBase {
  readonly wgslType: string;
  readonly size: number; // Size in bytes
  readonly align: number; // Alignment in bytes
  readonly floatCount: number; // Number of floats for TypedArray
}

// Use branded types to make each field type distinct
interface F32Type extends FieldTypeBase {
  readonly _brand: "f32";
}
interface I32Type extends FieldTypeBase {
  readonly _brand: "i32";
}
interface U32Type extends FieldTypeBase {
  readonly _brand: "u32";
}
interface Vec2Type extends FieldTypeBase {
  readonly _brand: "vec2";
}
interface Vec3Type extends FieldTypeBase {
  readonly _brand: "vec3";
}
interface Vec4Type extends FieldTypeBase {
  readonly _brand: "vec4";
}
interface Mat3x3Type extends FieldTypeBase {
  readonly _brand: "mat3x3";
}

/** Union of all field types */
export type FieldType =
  | F32Type
  | I32Type
  | U32Type
  | Vec2Type
  | Vec3Type
  | Vec4Type
  | Mat3x3Type;

/** f32 scalar (4 bytes, 4-byte aligned) */
export const f32: F32Type = {
  _brand: "f32",
  wgslType: "f32",
  size: 4,
  align: 4,
  floatCount: 1,
};

/** i32 scalar (4 bytes, 4-byte aligned) */
export const i32: I32Type = {
  _brand: "i32",
  wgslType: "i32",
  size: 4,
  align: 4,
  floatCount: 1,
};

/** u32 scalar (4 bytes, 4-byte aligned) */
export const u32: U32Type = {
  _brand: "u32",
  wgslType: "u32",
  size: 4,
  align: 4,
  floatCount: 1,
};

/** vec2<f32> (8 bytes, 8-byte aligned) */
export const vec2: Vec2Type = {
  _brand: "vec2",
  wgslType: "vec2<f32>",
  size: 8,
  align: 8,
  floatCount: 2,
};

/** vec3<f32> (12 bytes, 16-byte aligned) */
export const vec3: Vec3Type = {
  _brand: "vec3",
  wgslType: "vec3<f32>",
  size: 12,
  align: 16,
  floatCount: 3,
};

/** vec4<f32> (16 bytes, 16-byte aligned) */
export const vec4: Vec4Type = {
  _brand: "vec4",
  wgslType: "vec4<f32>",
  size: 16,
  align: 16,
  floatCount: 4,
};

/**
 * mat3x3<f32> (48 bytes, 16-byte aligned)
 * Each column is a vec3 padded to 16 bytes (4 floats)
 */
export const mat3x3: Mat3x3Type = {
  _brand: "mat3x3",
  wgslType: "mat3x3<f32>",
  size: 48, // 3 columns * 16 bytes each
  align: 16,
  floatCount: 12, // 3 columns * 4 floats (with padding)
};

// ============ Type Mapping for Setters ============

/** Maps field types to their setter parameter types */
type SetterParamType<T extends FieldType> = T extends F32Type
  ? number
  : T extends I32Type
    ? number
    : T extends U32Type
      ? number
      : T extends Vec2Type
        ? readonly [number, number]
        : T extends Vec3Type
          ? readonly [number, number, number]
          : T extends Vec4Type
            ? readonly [number, number, number, number]
            : T extends Mat3x3Type
              ? Matrix3 | Float32Array
              : never;

// ============ Computed Field Info ============

interface ComputedField {
  name: string;
  type: FieldType;
  byteOffset: number;
  offset: number;
}

// ============ Uniform Instance ============

/** Setter functions generated for each field */
type SetterMap<T extends Record<string, FieldType>> = {
  [K in keyof T]: (value: SetterParamType<T[K]>) => void;
};

/** Instance of a uniform struct with typed setters */
export interface UniformInstance<T extends Record<string, FieldType>> {
  /** The raw Float32Array backing the uniform data */
  readonly data: Float32Array;
  /** The raw ArrayBuffer for upload to GPU */
  readonly buffer: ArrayBuffer;
  /** The total byte size of the struct */
  readonly byteSize: number;
  /** Type-safe setters for each field */
  readonly set: SetterMap<T>;
  /** Upload to a GPU buffer at the given offset */
  uploadTo(gpuBuffer: GPUBuffer, offset?: number): void;
}

// ============ Uniform Struct Definition ============

/** Definition of a uniform struct with type info and factory */
export interface UniformStructDef<T extends Record<string, FieldType>> {
  /** The struct name used in WGSL */
  readonly name: string;
  /** Field definitions */
  readonly fields: T;
  /** WGSL struct declaration (ready to embed in shader code) */
  readonly wgsl: string;
  /** Total byte size with proper alignment */
  readonly byteSize: number;
  /** Create a new instance with zero-initialized data */
  create(): UniformInstance<T>;
}

// ============ Implementation ============

/**
 * Align a value up to the given alignment.
 */
function alignUp(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

/**
 * Compute field layouts with proper WGSL alignment.
 */
function computeFieldLayouts<T extends Record<string, FieldType>>(
  fields: T,
): ComputedField[] {
  const result: ComputedField[] = [];
  let currentOffset = 0;

  for (const [name, type] of Object.entries(fields)) {
    // Align to the field's required alignment
    currentOffset = alignUp(currentOffset, type.align);

    result.push({
      name,
      type,
      byteOffset: currentOffset,
      offset: currentOffset / 4,
    });

    currentOffset += type.size;
  }

  return result;
}

/**
 * Compute total struct size with final alignment padding.
 * WGSL structs must be aligned to their largest member alignment.
 */
function computeStructSize(fields: ComputedField[]): number {
  if (fields.length === 0) return 0;

  const lastField = fields[fields.length - 1];
  const endOffset = lastField.byteOffset + lastField.type.size;

  // Find largest alignment
  const maxAlign = Math.max(...fields.map((f) => f.type.align));

  // Pad to largest alignment for array usage
  return alignUp(endOffset, maxAlign);
}

/**
 * Generate WGSL struct declaration.
 */
function generateWGSL<T extends Record<string, FieldType>>(
  name: string,
  fields: T,
): string {
  const lines = [`struct ${name} {`];

  for (const [fieldName, fieldType] of Object.entries(fields)) {
    lines.push(`  ${fieldName}: ${fieldType.wgslType},`);
  }

  lines.push("}");
  return lines.join("\n");
}

/**
 * Create setter functions for all fields.
 */
function createSetters<T extends Record<string, FieldType>>(
  fields: ComputedField[],
  data: Float32Array,
): SetterMap<T> {
  // Use any for the internal record since we build this dynamically
  // The public API is type-safe via SetterMap<T>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const setters: Record<string, any> = {};
  const intView = new Int32Array(data.buffer);
  const uintView = new Uint32Array(data.buffer);

  for (const field of fields) {
    const { name, type, offset } = field;
    const brand = type._brand;

    if (brand === "f32") {
      setters[name] = (value: number) => {
        data[offset] = value;
      };
    } else if (brand === "i32") {
      setters[name] = (value: number) => {
        intView[offset] = value;
      };
    } else if (brand === "u32") {
      setters[name] = (value: number) => {
        uintView[offset] = value;
      };
    } else if (brand === "vec2") {
      setters[name] = (value: readonly [number, number]) => {
        data[offset] = value[0];
        data[offset + 1] = value[1];
      };
    } else if (brand === "vec3") {
      setters[name] = (value: readonly [number, number, number]) => {
        data[offset] = value[0];
        data[offset + 1] = value[1];
        data[offset + 2] = value[2];
        // Note: vec3 uses 12 bytes but offset 3 is padding
      };
    } else if (brand === "vec4") {
      setters[name] = (value: readonly [number, number, number, number]) => {
        data[offset] = value[0];
        data[offset + 1] = value[1];
        data[offset + 2] = value[2];
        data[offset + 3] = value[3];
      };
    } else if (brand === "mat3x3") {
      setters[name] = (value: Matrix3 | Float32Array) => {
        // mat3x3 in WGSL is column-major with each column padded to vec4
        if ("toArray" in value) {
          // Matrix3 object - convert to padded format
          const arr = value.toArray();
          // Column 0
          data[offset] = arr[0]; // a
          data[offset + 1] = arr[1]; // b
          data[offset + 2] = arr[2]; // 0 (from 2D matrix)
          data[offset + 3] = 0; // padding

          // Column 1
          data[offset + 4] = arr[3]; // c
          data[offset + 5] = arr[4]; // d
          data[offset + 6] = arr[5]; // 0
          data[offset + 7] = 0; // padding

          // Column 2
          data[offset + 8] = arr[6]; // tx
          data[offset + 9] = arr[7]; // ty
          data[offset + 10] = arr[8]; // 1
          data[offset + 11] = 0; // padding
        } else {
          // Already a Float32Array in the correct padded format
          for (let i = 0; i < 12; i++) {
            data[offset + i] = value[i];
          }
        }
      };
    }
  }

  return setters as SetterMap<T>;
}

let deviceRef: GPUDevice | null = null;

/**
 * Set the GPU device reference for upload operations.
 * This should be called once during initialization.
 */
export function setUniformDevice(device: GPUDevice): void {
  deviceRef = device;
}

/**
 * Define a uniform struct with typed fields.
 *
 * @param name - The struct name used in WGSL
 * @param fields - Field definitions using f32, i32, vec2, vec3, vec4, mat3x3
 * @returns A struct definition with WGSL code generation and typed factory
 *
 * @example
 * const MyUniforms = defineUniformStruct('Uniforms', {
 *   time: f32,
 *   viewport: vec4,
 *   transform: mat3x3,
 * });
 *
 * // Embed in shader
 * const shader = `${MyUniforms.wgsl}\n@group(0) @binding(0) var<uniform> u: Uniforms;`;
 *
 * // Create instance and set values
 * const uniforms = MyUniforms.create();
 * uniforms.set.time(1.5);
 * uniforms.set.viewport([0, 0, 800, 600]);
 * uniforms.uploadTo(gpuBuffer);
 */
export function defineUniformStruct<T extends Record<string, FieldType>>(
  name: string,
  fields: T,
): UniformStructDef<T> {
  const computedFields = computeFieldLayouts(fields);
  const byteSize = computeStructSize(computedFields);
  const wgsl = generateWGSL(name, fields);

  return {
    name,
    fields,
    wgsl,
    byteSize,
    create(): UniformInstance<T> {
      const buffer = new ArrayBuffer(byteSize);
      const data = new Float32Array(buffer);
      const setters = createSetters<T>(computedFields, data);

      return {
        data,
        buffer,
        byteSize,
        set: setters,
        uploadTo(gpuBuffer: GPUBuffer, offset = 0): void {
          if (!deviceRef) {
            throw new Error(
              "GPU device not set. Call setUniformDevice() during initialization.",
            );
          }
          deviceRef.queue.writeBuffer(gpuBuffer, offset, buffer);
        },
      };
    },
  };
}
