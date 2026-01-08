/**
 * Manages a WebGL shader program with compilation, linking, and uniform/attribute management.
 */
export class ShaderProgram {
  /** The WebGL program object */
  readonly program: WebGLProgram;

  /** Cached attribute locations */
  private attributes: Map<string, number> = new Map();

  /** Cached uniform locations */
  private uniforms: Map<string, WebGLUniformLocation> = new Map();

  constructor(
    private gl: WebGL2RenderingContext,
    vertexSource: string,
    fragmentSource: string,
  ) {
    const vertexShader = this.compileShader(gl.VERTEX_SHADER, vertexSource);
    const fragmentShader = this.compileShader(
      gl.FRAGMENT_SHADER,
      fragmentSource,
    );

    const program = gl.createProgram();
    if (!program) {
      throw new Error("Failed to create WebGL program");
    }

    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const info = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error(`Failed to link shader program: ${info}`);
    }

    // Clean up shaders after linking
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);

    this.program = program;
  }

  /** Compile a single shader */
  private compileShader(type: number, source: string): WebGLShader {
    const gl = this.gl;
    const shader = gl.createShader(type);
    if (!shader) {
      throw new Error("Failed to create shader");
    }

    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const info = gl.getShaderInfoLog(shader);
      const typeStr = type === gl.VERTEX_SHADER ? "vertex" : "fragment";
      gl.deleteShader(shader);
      throw new Error(`Failed to compile ${typeStr} shader: ${info}`);
    }

    return shader;
  }

  /** Use this program */
  use(): void {
    this.gl.useProgram(this.program);
  }

  /** Get an attribute location (cached) */
  getAttribLocation(name: string): number {
    let location = this.attributes.get(name);
    if (location === undefined) {
      location = this.gl.getAttribLocation(this.program, name);
      this.attributes.set(name, location);
    }
    return location;
  }

  /** Get a uniform location (cached) */
  getUniformLocation(name: string): WebGLUniformLocation | null {
    let location = this.uniforms.get(name);
    if (location === undefined) {
      location = this.gl.getUniformLocation(this.program, name) ?? undefined;
      if (location !== undefined) {
        this.uniforms.set(name, location);
      }
    }
    return location ?? null;
  }

  // Uniform setters

  /** Set a float uniform */
  setUniform1f(name: string, value: number): void {
    const location = this.getUniformLocation(name);
    if (location) {
      this.gl.uniform1f(location, value);
    }
  }

  /** Set an integer uniform */
  setUniform1i(name: string, value: number): void {
    const location = this.getUniformLocation(name);
    if (location) {
      this.gl.uniform1i(location, value);
    }
  }

  /** Set a vec2 uniform */
  setUniform2f(name: string, x: number, y: number): void {
    const location = this.getUniformLocation(name);
    if (location) {
      this.gl.uniform2f(location, x, y);
    }
  }

  /** Set a vec3 uniform */
  setUniform3f(name: string, x: number, y: number, z: number): void {
    const location = this.getUniformLocation(name);
    if (location) {
      this.gl.uniform3f(location, x, y, z);
    }
  }

  /** Set a vec4 uniform */
  setUniform4f(name: string, x: number, y: number, z: number, w: number): void {
    const location = this.getUniformLocation(name);
    if (location) {
      this.gl.uniform4f(location, x, y, z, w);
    }
  }

  /** Set a mat3 uniform */
  setUniformMatrix3fv(
    name: string,
    value: Float32Array,
    transpose = false,
  ): void {
    const location = this.getUniformLocation(name);
    if (location) {
      this.gl.uniformMatrix3fv(location, transpose, value);
    }
  }

  /** Set a mat4 uniform */
  setUniformMatrix4fv(
    name: string,
    value: Float32Array,
    transpose = false,
  ): void {
    const location = this.getUniformLocation(name);
    if (location) {
      this.gl.uniformMatrix4fv(location, transpose, value);
    }
  }

  /** Set a float array uniform */
  setUniform1fv(name: string, value: Float32Array | number[]): void {
    const location = this.getUniformLocation(name);
    if (location) {
      this.gl.uniform1fv(location, value);
    }
  }

  /** Set a vec2 array uniform */
  setUniform2fv(name: string, value: Float32Array | number[]): void {
    const location = this.getUniformLocation(name);
    if (location) {
      this.gl.uniform2fv(location, value);
    }
  }

  /** Set a vec4 array uniform */
  setUniform4fv(name: string, value: Float32Array | number[]): void {
    const location = this.getUniformLocation(name);
    if (location) {
      this.gl.uniform4fv(location, value);
    }
  }

  /** Clean up resources */
  destroy(): void {
    this.gl.deleteProgram(this.program);
    this.attributes.clear();
    this.uniforms.clear();
  }
}

// Default shader sources

export const SHAPE_VERTEX_SHADER = `#version 300 es
precision highp float;

in vec2 a_position;
in vec4 a_color;
uniform mat3 u_matrix;

out vec4 v_color;

void main() {
  vec3 position = u_matrix * vec3(a_position, 1.0);
  gl_Position = vec4(position.xy, 0.0, 1.0);
  v_color = a_color;
}
`;

export const SHAPE_FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec4 v_color;
out vec4 fragColor;

void main() {
  fragColor = v_color;
}
`;

export const SPRITE_VERTEX_SHADER = `#version 300 es
precision highp float;

in vec2 a_position;
in vec2 a_texCoord;
in vec4 a_color;

uniform mat3 u_matrix;

out vec2 v_texCoord;
out vec4 v_color;

void main() {
  vec3 position = u_matrix * vec3(a_position, 1.0);
  gl_Position = vec4(position.xy, 0.0, 1.0);
  v_texCoord = a_texCoord;
  v_color = a_color;
}
`;

export const SPRITE_FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec2 v_texCoord;
in vec4 v_color;

uniform sampler2D u_texture;

out vec4 fragColor;

void main() {
  vec4 texColor = texture(u_texture, v_texCoord);
  fragColor = texColor * v_color;
}
`;
