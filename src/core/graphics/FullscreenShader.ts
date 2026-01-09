import { ShaderProgram } from "./ShaderProgram";
import { FullscreenQuad } from "./FullscreenQuad";
import { FULLSCREEN_VERTEX_SHADER } from "./shaders/fullscreenVert";

/**
 * Uniform value definitions for type-safe shader uniforms.
 */
export interface UniformValue {
  type: string;
  value: any;
}

/**
 * A schema mapping uniform names to their type definitions.
 */
export interface UniformSchema {
  [key: string]: UniformValue;
}

/**
 * Texture binding configuration.
 */
interface TextureBinding {
  name: string;
  unit: number;
}

/**
 * Options for creating a fullscreen shader.
 */
export interface FullscreenShaderOptions {
  /** Fragment shader source */
  fragmentSource: string;
  /** Custom vertex shader source (optional, defaults to standard fullscreen) */
  vertexSource?: string;
  /** Uniform definitions with default values */
  uniforms: UniformSchema;
  /** Texture uniform names (assigned sequential units starting at 0) */
  textures?: string[];
}

/**
 * Base class for fullscreen post-processing shaders.
 * Handles uniform management, texture binding, and fullscreen quad rendering.
 *
 * @example
 * ```typescript
 * class BlurShader extends FullscreenShader<{
 *   u_radius: { type: '1f'; value: number };
 *   u_direction: { type: '2f'; value: [number, number] };
 * }> {
 *   constructor(gl: WebGL2RenderingContext) {
 *     super(gl, {
 *       fragmentSource: BLUR_FRAGMENT_SHADER,
 *       uniforms: {
 *         u_radius: { type: '1f', value: 2.0 },
 *         u_direction: { type: '2f', value: [1, 0] },
 *       },
 *       textures: ['u_inputTexture'],
 *     });
 *   }
 *
 *   setRadius(r: number) { this.uniforms.u_radius.value = r; }
 * }
 * ```
 */
export class FullscreenShader {
  protected program: ShaderProgram;
  protected gl: WebGL2RenderingContext;
  protected quad: FullscreenQuad;
  protected uniforms: UniformSchema;
  private textureBindings: TextureBinding[];

  constructor(gl: WebGL2RenderingContext, options: FullscreenShaderOptions) {
    this.gl = gl;
    this.program = new ShaderProgram(
      gl,
      options.vertexSource ?? FULLSCREEN_VERTEX_SHADER,
      options.fragmentSource,
    );
    this.quad = new FullscreenQuad(gl);

    // Deep clone uniform defaults to avoid mutation issues
    this.uniforms = this.cloneUniforms(options.uniforms);

    // Set up texture bindings with sequential units
    this.textureBindings = (options.textures ?? []).map((name, index) => ({
      name,
      unit: index,
    }));
  }

  private cloneUniforms(uniforms: UniformSchema): UniformSchema {
    const result: UniformSchema = {};
    for (const [key, def] of Object.entries(uniforms)) {
      if (def.type === "mat3") {
        result[key] = {
          type: "mat3",
          value: new Float32Array(def.value),
        };
      } else if (Array.isArray(def.value)) {
        result[key] = {
          type: def.type,
          value: [...def.value],
        };
      } else {
        result[key] = { ...def };
      }
    }
    return result;
  }

  /**
   * Apply all stored uniforms to the shader program.
   */
  protected applyUniforms(): void {
    for (const [name, def] of Object.entries(this.uniforms)) {
      switch (def.type) {
        case "1f":
          this.program.setUniform1f(name, def.value);
          break;
        case "1i":
          this.program.setUniform1i(name, def.value);
          break;
        case "2f":
          this.program.setUniform2f(name, def.value[0], def.value[1]);
          break;
        case "3f":
          this.program.setUniform3f(
            name,
            def.value[0],
            def.value[1],
            def.value[2],
          );
          break;
        case "4f":
          this.program.setUniform4f(
            name,
            def.value[0],
            def.value[1],
            def.value[2],
            def.value[3],
          );
          break;
        case "mat3":
          this.program.setUniformMatrix3fv(name, def.value);
          break;
      }
    }
  }

  /**
   * Bind textures and set their sampler uniforms.
   */
  protected bindTextures(textures: Record<string, WebGLTexture | null>): void {
    const gl = this.gl;
    for (const binding of this.textureBindings) {
      const texture = textures[binding.name];
      gl.activeTexture(gl.TEXTURE0 + binding.unit);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      this.program.setUniform1i(binding.name, binding.unit);
    }
  }

  /**
   * Render the fullscreen effect.
   * @param textures Map of texture uniform names to WebGLTexture objects
   */
  render(textures: Record<string, WebGLTexture | null> = {}): void {
    this.program.use();
    this.applyUniforms();
    this.bindTextures(textures);

    const posLoc = this.program.getAttribLocation("a_position");
    this.quad.bind(posLoc);
    this.quad.draw();
    this.quad.unbind();
  }

  destroy(): void {
    this.program.destroy();
    this.quad.destroy();
  }
}
