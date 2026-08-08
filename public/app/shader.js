import { FACETS } from './facets.js';

const vertexSource = `
  attribute vec2 a_position;
  void main() {
    gl_Position = vec4(a_position, 0.0, 1.0);
  }
`;

const fragmentSource = (derivatives) => `
  ${derivatives ? '#extension GL_OES_standard_derivatives : enable' : ''}
  precision highp float;

  uniform vec2 u_resolution;
  uniform vec2 u_pointer;
  uniform vec2 u_orbit;
  uniform float u_focus;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
               mix(hash(i + vec2(0.0, 1.0)), hash(i + 1.0), f.x), f.y);
  }

  float field(vec2 p) {
    float value = 0.0;
    float scale = 0.5;
    for (int i = 0; i < 4; i++) {
      value += noise(p) * scale;
      p = mat2(1.6, 1.2, -1.2, 1.6) * p + 0.17;
      scale *= 0.5;
    }
    return value;
  }

  void main() {
    vec2 uv = (gl_FragCoord.xy * 2.0 - u_resolution) / min(u_resolution.x, u_resolution.y);
    vec2 mouse = (u_pointer * 2.0 - 1.0) * vec2(u_resolution.x / u_resolution.y, 1.0);

    float mist = field(uv * 1.7 + u_orbit * 0.0018);
    float beam = pow(max(0.0, 1.0 - abs(uv.y + 0.12 + sin(uv.x * 1.8) * 0.08)), 8.0);
    float cursor = exp(-3.5 * length(uv - mouse));

    vec2 plane = vec2(uv.x, uv.y + 1.18);
    float depth = 0.28 / max(0.06, abs(plane.y));
    vec2 lattice = vec2(plane.x * depth * 13.0 + u_orbit.x * 0.015,
                        depth * 8.0 + u_orbit.y * 0.01);
    vec2 cell = abs(fract(lattice) - 0.5);
    float edge = max(cell.x, cell.y);
    float grid = smoothstep(0.5 - ${derivatives ? 'max(fwidth(edge) * 1.25, 0.003)' : '0.01'}, 0.5, edge);
    grid *= smoothstep(-1.15, -0.8, uv.y) * (1.0 - smoothstep(-0.3, 0.1, uv.y));

    vec3 black = vec3(0.018, 0.024, 0.032);
    vec3 steel = vec3(0.22, 0.40, 0.58);
    vec3 signal = vec3(0.28, 0.66, 0.80);
    vec3 color = black;
    color += steel * (mist * 0.09 + beam * 0.055);
    color += signal * (grid * 0.035 + cursor * 0.025 + u_focus * beam * 0.02);
    color *= 1.0 - 0.24 * smoothstep(0.45, 1.35, length(uv));
    color += (hash(gl_FragCoord.xy) - 0.5) / 255.0;

    gl_FragColor = vec4(color, 1.0);
  }
`;

export function startShader(canvas) {
  const gl = canvas.getContext('webgl', { alpha: false, antialias: true, powerPreference: 'high-performance' });
  if (!gl) {
    canvas.hidden = true;
    return { setFocus() {}, setOrbit() {} };
  }

  const program = gl.createProgram();
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vertexSource));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fragmentSource(Boolean(gl.getExtension('OES_standard_derivatives')))));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  gl.useProgram(program);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, 'a_position');
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

  const uniforms = Object.fromEntries(['resolution', 'pointer', 'orbit', 'focus'].map((name) => [name, gl.getUniformLocation(program, `u_${name}`)]));
  const pointer = { x: 0.5, y: 0.5 };
  const orbit = { x: 34, y: -22 };
  let focus = 0;
  let frame = 0;

  function requestRender() {
    if (!frame && !document.hidden) frame = requestAnimationFrame(render);
  }

  function render() {
    frame = 0;
    const width = Math.round(innerWidth);
    const height = Math.round(innerHeight);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      gl.viewport(0, 0, width, height);
    }
    gl.uniform2f(uniforms.resolution, width, height);
    gl.uniform2f(uniforms.pointer, pointer.x, pointer.y);
    gl.uniform2f(uniforms.orbit, orbit.x, orbit.y);
    gl.uniform1f(uniforms.focus, focus);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  window.addEventListener('pointermove', (event) => {
    pointer.x = event.clientX / innerWidth;
    pointer.y = 1 - event.clientY / innerHeight;
    requestRender();
  }, { passive: true });
  window.addEventListener('resize', requestRender);
  document.addEventListener('visibilitychange', requestRender);
  requestRender();

  return {
    setFocus(face) {
      // Normalised by the faces there actually are: u_focus is a 0..1 uniform, and a
      // fixed six sent 1.67 for the tenth face of a ten-face prism.
      focus = face == null ? 0 : (face + 1) / FACETS.length;
      requestRender();
    },
    setOrbit(rotation) {
      orbit.x = rotation.y;
      orbit.y = rotation.x;
      requestRender();
    },
  };
}

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
  return shader;
}
