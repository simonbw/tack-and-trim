import { ShaderProgram } from "../../core/graphics/ShaderProgram";

const WATER_VERTEX_SHADER = /*glsl*/ `#version 300 es
precision highp float;

in vec2 a_position;

out vec2 v_position;

void main() {
  v_position = a_position;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

const WATER_FRAGMENT_SHADER = /*glsl*/ `#version 300 es
precision highp float;

in vec2 v_position;
out vec4 fragColor;

uniform mat3 u_cameraMatrix;
uniform float u_time;
uniform vec4 u_viewportBounds;  // [left, top, width, height] in world space
uniform vec2 u_screenSize;      // Screen size in pixels
uniform sampler2D u_waterData;  // 64x64 data texture with height/velocity
uniform int u_renderMode;       // 0 = realistic, 1 = debug height

const float PI = 3.14159265359;

void main(void) {
  // Convert clip space (-1,1) to screen coords (0, screenSize)
  vec2 screenPos = (v_position * 0.5 + 0.5) * u_screenSize;

  // Transform screen position to world position using camera matrix
  vec3 worldPosH = u_cameraMatrix * vec3(screenPos, 1.0);
  vec2 worldPos = worldPosH.xy;

  // Map world position to data texture UV coordinates
  vec2 dataUV = (worldPos - u_viewportBounds.xy) / u_viewportBounds.zw;
  dataUV = clamp(dataUV, 0.0, 1.0);

  // Sample the data texture (values are packed as 0-255 -> 0.0-1.0)
  vec4 waterData = texture(u_waterData, dataUV);

  // Unpack height: 0.5 (127) is neutral, below is trough, above is peak
  float rawHeight = waterData.r;

  // Debug mode: height mapped to blue gradient with clipping indicators
  if (u_renderMode == 1) {
    vec3 debugColor;
    if (rawHeight < 0.02) {
      debugColor = vec3(1.0, 0.0, 0.0);  // Red for min clipping
    } else if (rawHeight > 0.98) {
      debugColor = vec3(1.0, 0.0, 0.0);  // Red for max clipping
    } else {
      // Blue gradient: dark blue (low) to light blue (high)
      vec3 darkBlue = vec3(0.0, 0.1, 0.3);
      vec3 lightBlue = vec3(0.6, 0.85, 1.0);
      debugColor = mix(darkBlue, lightBlue, rawHeight);
    }
    fragColor = vec4(debugColor, 1.0);
    return;
  }

  // Compute surface normal from height gradients
  float texelSize = 1.0 / 64.0;
  float heightL = texture(u_waterData, dataUV + vec2(-texelSize, 0.0)).r;
  float heightR = texture(u_waterData, dataUV + vec2(texelSize, 0.0)).r;
  float heightD = texture(u_waterData, dataUV + vec2(0.0, -texelSize)).r;
  float heightU = texture(u_waterData, dataUV + vec2(0.0, texelSize)).r;

  float heightScale = 8.0;
  vec3 normal = normalize(vec3(
    (heightL - heightR) * heightScale,
    (heightD - heightU) * heightScale,
    1.0
  ));

  // Dynamic sun position based on time (120 second day cycle)
  float dayLength = 120.0;
  float sunAngle = u_time * (2.0 * PI / dayLength);
  float sunElevation = 0.5 + 0.4 * sin(sunAngle);
  vec3 sunDir = normalize(vec3(
    cos(sunAngle),
    sin(sunAngle) * 0.3,
    sunElevation
  ));

  // Water colors
  vec3 deepColor = vec3(0.01, 0.05, 0.15);      // Deep ocean blue
  vec3 shallowColor = vec3(0.02, 0.12, 0.28);   // Shallower blue
  vec3 scatterColor = vec3(0.0, 0.25, 0.22);    // Subsurface scattering (teal/green)
  vec3 baseColor = mix(deepColor, shallowColor, rawHeight);

  // Sun and sky colors
  vec3 sunColor = vec3(1.0, 0.95, 0.85);
  vec3 skyColor = vec3(0.5, 0.7, 0.95);

  // View direction (looking straight down)
  vec3 viewDir = vec3(0.0, 0.0, 1.0);

  // Fresnel effect - tilted surfaces reflect more sky
  float facing = dot(normal, viewDir);
  float fresnel = pow(1.0 - facing, 3.0);

  // Subsurface scattering - light passing through wave peaks
  float scatter = max(dot(normal, sunDir), 0.0) * (0.5 + 0.5 * rawHeight);
  vec3 subsurface = scatterColor * scatter * 0.6;

  // Diffuse lighting
  float diffuse = max(dot(normal, sunDir), 0.0);

  // Specular lighting
  vec3 reflectDir = reflect(-sunDir, normal);
  float specular = pow(max(dot(viewDir, reflectDir), 0.0), 64.0);

  // Combine lighting
  vec3 ambient = baseColor * 0.4;
  vec3 diffuseLight = baseColor * sunColor * diffuse * 0.4;
  vec3 skyReflection = skyColor * fresnel * 0.5;
  vec3 specularLight = sunColor * specular * 0.6;

  vec3 color = ambient + subsurface + diffuseLight + skyReflection + specularLight;

  fragColor = vec4(color, 1.0);
}
`;

/**
 * Water shader using raw WebGL.
 */
export class WaterShader {
  private program: ShaderProgram;
  private gl: WebGL2RenderingContext;
  private vao: WebGLVertexArrayObject;
  private vertexBuffer: WebGLBuffer;

  // Uniform values
  private cameraMatrix = new Float32Array(9);
  private viewportBounds = new Float32Array(4);
  private time = 0;
  private renderMode = 0;
  private screenWidth = 800;
  private screenHeight = 600;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.program = new ShaderProgram(
      gl,
      WATER_VERTEX_SHADER,
      WATER_FRAGMENT_SHADER,
    );

    // Create VAO and fullscreen quad
    this.vao = gl.createVertexArray()!;
    this.vertexBuffer = gl.createBuffer()!;

    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);

    // Fullscreen quad vertices (two triangles)
    const vertices = new Float32Array([
      -1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1,
    ]);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

    const posLoc = this.program.getAttribLocation("a_position");
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    gl.bindVertexArray(null);
  }

  setCameraMatrix(matrix: Float32Array): void {
    this.cameraMatrix.set(matrix);
  }

  setViewportBounds(
    left: number,
    top: number,
    width: number,
    height: number,
  ): void {
    this.viewportBounds[0] = left;
    this.viewportBounds[1] = top;
    this.viewportBounds[2] = width;
    this.viewportBounds[3] = height;
  }

  setTime(time: number): void {
    this.time = time;
  }

  setRenderMode(mode: number): void {
    this.renderMode = mode;
  }

  setScreenSize(width: number, height: number): void {
    this.screenWidth = width;
    this.screenHeight = height;
  }

  render(waterDataTexture: WebGLTexture | null): void {
    const gl = this.gl;

    this.program.use();

    // Set uniforms
    this.program.setUniformMatrix3fv("u_cameraMatrix", this.cameraMatrix);
    this.program.setUniform1f("u_time", this.time);
    this.program.setUniform1i("u_renderMode", this.renderMode);
    this.program.setUniform2f(
      "u_screenSize",
      this.screenWidth,
      this.screenHeight,
    );
    this.program.setUniform4f(
      "u_viewportBounds",
      this.viewportBounds[0],
      this.viewportBounds[1],
      this.viewportBounds[2],
      this.viewportBounds[3],
    );

    // Bind water data texture
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, waterDataTexture);
    this.program.setUniform1i("u_waterData", 0);

    // Draw fullscreen quad
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
  }

  destroy(): void {
    const gl = this.gl;
    this.program.destroy();
    gl.deleteVertexArray(this.vao);
    gl.deleteBuffer(this.vertexBuffer);
  }
}
