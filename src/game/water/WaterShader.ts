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

// Foam uniforms
uniform float u_foamThreshold;
uniform float u_foamIntensity;
uniform float u_foamCoverage;
uniform float u_foamSharpness;

// Color variation uniforms
uniform float u_colorNoiseStrength;

const float PI = 3.14159265359;

// Hash function for procedural noise
float hash21(vec2 p) {
  p = fract(p * vec2(234.34, 435.345));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}

// Value noise with smooth interpolation
float valueNoise(vec2 uv) {
  vec2 ip = floor(uv);
  vec2 fp = fract(uv);
  fp = fp * fp * (3.0 - 2.0 * fp); // Smoothstep
  float a = hash21(ip);
  float b = hash21(ip + vec2(1.0, 0.0));
  float c = hash21(ip + vec2(0.0, 1.0));
  float d = hash21(ip + vec2(1.0, 1.0));
  return mix(mix(a, b, fp.x), mix(c, d, fp.x), fp.y);
}

// Multi-octave value noise for foam - very slow animation
float foamNoise(vec2 uv, float time) {
  float n = 0.0;
  // Much slower time - foam patches should drift slowly, not flicker
  n += valueNoise(uv * 1.0 + time * 0.02) * 0.5;
  n += valueNoise(uv * 2.0 - time * 0.015) * 0.35;
  n += valueNoise(uv * 4.0 + time * 0.01) * 0.15;
  return n;
}

// Calculate foam amount based on wave height, slope, and noise
float calculateFoam(float height, float gradientMag, vec2 worldPos, float time) {
  // Height-based foam (wave peaks)
  float heightFoam = smoothstep(u_foamThreshold, u_foamThreshold + 0.15, height);

  // Slope-based foam (steep surfaces = breaking waves)
  float slopeFoam = smoothstep(0.3, 0.7, gradientMag);

  float baseFoam = max(heightFoam, slopeFoam * 0.4);

  // Noise breakup for patchy appearance
  float noise = foamNoise(worldPos * 0.12, time);

  float threshold = 1.0 - u_foamCoverage;
  float foamMask = smoothstep(threshold - 0.1, threshold + 0.1, noise);

  // Final foam with sharpness control
  float foam = baseFoam * foamMask * u_foamIntensity;
  foam = pow(clamp(foam, 0.0, 1.0), 1.0 / u_foamSharpness);

  return clamp(foam, 0.0, 1.0);
}

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

  float heightScale = 3.0;
  vec3 normal = normalize(vec3(
    (heightL - heightR) * heightScale,
    (heightD - heightU) * heightScale,
    1.0
  ));

  // Store gradient magnitude for foam calculation
  float gradientMag = length(normal.xy);

  // Dynamic sun position based on time (120 second day cycle)
  float dayLength = 120.0;
  float sunAngle = u_time * (2.0 * PI / dayLength);
  float sunElevation = 0.5 + 0.4 * sin(sunAngle);
  vec3 sunDir = normalize(vec3(
    cos(sunAngle),
    sin(sunAngle) * 0.3,
    sunElevation
  ));

  // Water colors - light, happy cyan tones
  vec3 deepColor = vec3(0.15, 0.35, 0.45);      // Lighter teal-blue
  vec3 shallowColor = vec3(0.25, 0.55, 0.65);   // Bright cyan
  vec3 scatterColor = vec3(0.2, 0.5, 0.5);      // Subtle cyan scatter
  vec3 baseColor = mix(deepColor, shallowColor, rawHeight);

  // Slope-based color variation: sun-facing surfaces warmer, away surfaces cooler
  float sunFacing = dot(normal.xy, sunDir.xy);
  vec3 slopeShift = mix(vec3(-0.03, -0.01, 0.03), vec3(0.03, 0.05, -0.02), sunFacing * 0.5 + 0.5);

  // Noise-based hue variation for organic feel - very slow drift
  float colorNoise = valueNoise(worldPos * 0.02 + u_time * 0.005);
  vec3 hueShift = mix(vec3(-0.02, 0.02, 0.04), vec3(0.02, 0.04, -0.02), colorNoise);

  // Apply color variation
  baseColor = baseColor + slopeShift * 0.2 + hueShift * u_colorNoiseStrength;

  // Troughs are darker and more saturated
  float troughDarken = (1.0 - rawHeight) * 0.12;
  baseColor *= (1.0 - troughDarken);

  // Sun and sky colors
  vec3 sunColor = vec3(1.0, 0.95, 0.85);
  vec3 skyColor = vec3(0.5, 0.7, 0.95);

  // View direction (looking straight down)
  vec3 viewDir = vec3(0.0, 0.0, 1.0);

  // Fresnel effect - tilted surfaces reflect more sky (subtle)
  float facing = dot(normal, viewDir);
  float fresnel = pow(1.0 - facing, 4.0) * 0.5;

  // Subsurface scattering - light passing through wave peaks (subtle)
  float scatter = max(dot(normal, sunDir), 0.0) * (0.5 + 0.5 * rawHeight);
  vec3 subsurface = scatterColor * scatter * 0.3;

  // Diffuse lighting
  float diffuse = max(dot(normal, sunDir), 0.0);

  // Specular lighting (softer)
  vec3 reflectDir = reflect(-sunDir, normal);
  float specular = pow(max(dot(viewDir, reflectDir), 0.0), 32.0);

  // Combine lighting - more ambient, less dramatic
  vec3 ambient = baseColor * 0.6;
  vec3 diffuseLight = baseColor * sunColor * diffuse * 0.3;
  vec3 skyReflection = skyColor * fresnel * 0.3;
  vec3 specularLight = sunColor * specular * 0.25;

  vec3 color = ambient + subsurface + diffuseLight + skyReflection + specularLight;

  // Calculate and blend foam
  float foam = calculateFoam(rawHeight, gradientMag, worldPos, u_time);
  vec3 foamColor = vec3(0.92, 0.95, 0.98);
  color = mix(color, foamColor, foam * 0.85);

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

  // Foam uniforms - subtle defaults for calm water
  private foamThreshold = 0.7;
  private foamIntensity = 0.5;
  private foamCoverage = 0.3;
  private foamSharpness = 2.0;

  // Color variation uniforms
  private colorNoiseStrength = 0.1;

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

  // Foam setters
  setFoamThreshold(value: number): void {
    this.foamThreshold = value;
  }

  setFoamIntensity(value: number): void {
    this.foamIntensity = value;
  }

  setFoamCoverage(value: number): void {
    this.foamCoverage = value;
  }

  setFoamSharpness(value: number): void {
    this.foamSharpness = value;
  }

  // Color variation setter
  setColorNoiseStrength(value: number): void {
    this.colorNoiseStrength = value;
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

    // Foam uniforms
    this.program.setUniform1f("u_foamThreshold", this.foamThreshold);
    this.program.setUniform1f("u_foamIntensity", this.foamIntensity);
    this.program.setUniform1f("u_foamCoverage", this.foamCoverage);
    this.program.setUniform1f("u_foamSharpness", this.foamSharpness);

    // Color variation uniform
    this.program.setUniform1f("u_colorNoiseStrength", this.colorNoiseStrength);

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
