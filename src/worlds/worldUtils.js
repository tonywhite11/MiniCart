import * as THREE from 'three';
export { mulberry32 } from '../tracks/TrackMeshBuilder.js';

/**
 * Fast "how far is (x, z) from the road centreline?" lookups for scattering
 * scenery off the track and shaping terrain under it.
 */
export function createTrackProximity(track, cell = 0.08) {
  const grid = new Map();
  const S = track.samples;
  const key = (gx, gz) => `${gx},${gz}`;
  S.forEach((s, i) => {
    const gx = Math.floor(s.position[0] / cell);
    const gz = Math.floor(s.position[2] / cell);
    const k = key(gx, gz);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  });

  /** Returns { dist, index, y } of the nearest centreline sample (horizontal distance). */
  function nearest(x, z, searchCells = 2) {
    const gx = Math.floor(x / cell);
    const gz = Math.floor(z / cell);
    let best = Infinity;
    let bestI = -1;
    for (let dx = -searchCells; dx <= searchCells; dx++) {
      for (let dz = -searchCells; dz <= searchCells; dz++) {
        const list = grid.get(key(gx + dx, gz + dz));
        if (!list) continue;
        for (const i of list) {
          const p = S[i].position;
          const d = (p[0] - x) ** 2 + (p[2] - z) ** 2;
          if (d < best) {
            best = d;
            bestI = i;
          }
        }
      }
    }
    if (bestI < 0) return { dist: Infinity, index: -1, y: 0 };
    return { dist: Math.sqrt(best), index: bestI, y: S[bestI].position[1] };
  }

  const bounds = new THREE.Box3();
  S.forEach((s) => bounds.expandByPoint(new THREE.Vector3().fromArray(s.position)));

  return { nearest, bounds, cell };
}

/**
 * A sun/key light whose shadow frustum follows the player so kart-scale shadows
 * stay crisp anywhere on a metres-wide map.
 */
export function createFollowSun(scene, { color = '#fff4e0', intensity = 2.6, dir = [0.6, 1.0, 0.35], size = 0.35 } = {}) {
  const light = new THREE.DirectionalLight(color, intensity);
  const offset = new THREE.Vector3(...dir).normalize().multiplyScalar(1.2);
  light.castShadow = true;
  light.shadow.mapSize.set(2048, 2048);
  light.shadow.camera.near = 0.05;
  light.shadow.camera.far = 3.0;
  light.shadow.camera.left = -size;
  light.shadow.camera.right = size;
  light.shadow.camera.top = size;
  light.shadow.camera.bottom = -size;
  light.shadow.bias = -0.0004;
  light.shadow.normalBias = 0.0008;
  scene.add(light);
  scene.add(light.target);

  function follow(focus) {
    if (!focus) return;
    // Snap to shadow texels to avoid shimmering while driving
    const texel = (size * 2) / light.shadow.mapSize.x;
    const fx = Math.round(focus.x / texel) * texel;
    const fz = Math.round(focus.z / texel) * texel;
    light.target.position.set(fx, focus.y, fz);
    light.position.set(fx, focus.y, fz).add(offset);
  }

  return { light, follow };
}

export function canvasTexture(w, h, draw, { repeat = null, srgb = true } = {}) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  const tex = new THREE.CanvasTexture(c);
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  if (repeat) {
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(repeat[0], repeat[1]);
  }
  tex.anisotropy = 8;
  return tex;
}

/** Vertical gradient sky dome (colours from horizon to zenith). */
export function createSkyDome(scene, { top, horizon, bottom = horizon, radius = 40, sunDir = null, sunColor = '#fff6d8', sunSize = 0.03 }) {
  const uniforms = {
    uTop: { value: new THREE.Color(top) },
    uHorizon: { value: new THREE.Color(horizon) },
    uBottom: { value: new THREE.Color(bottom) },
    uSunDir: { value: new THREE.Vector3(...(sunDir || [0, -1, 0])).normalize() },
    uSunColor: { value: new THREE.Color(sunColor) },
    uSunSize: { value: sunDir ? sunSize : 0 },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 p = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * p;
        gl_Position.z = gl_Position.w; // always at the far plane
      }`,
    fragmentShader: `
      uniform vec3 uTop; uniform vec3 uHorizon; uniform vec3 uBottom;
      uniform vec3 uSunDir; uniform vec3 uSunColor; uniform float uSunSize;
      varying vec3 vDir;
      void main() {
        float h = vDir.y;
        vec3 col = h > 0.0 ? mix(uHorizon, uTop, pow(clamp(h, 0.0, 1.0), 0.55))
                           : mix(uHorizon, uBottom, clamp(-h * 4.0, 0.0, 1.0));
        if (uSunSize > 0.0) {
          float d = dot(normalize(vDir), uSunDir);
          col += uSunColor * smoothstep(1.0 - uSunSize, 1.0 - uSunSize * 0.35, d);
          col += uSunColor * 0.25 * pow(max(d, 0.0), 64.0);
        }
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(radius, 32, 16), mat);
  dome.renderOrder = -1;
  dome.frustumCulled = false;
  scene.add(dome);
  return dome;
}
