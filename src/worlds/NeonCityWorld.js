import * as THREE from 'three';
import { createTrackProximity, createFollowSun, createSkyDome, canvasTexture, mulberry32 } from './worldUtils.js';

/**
 * Neon Drive — synthwave night city: glowing grid floor, skyline blocks with lit
 * windows, a striped retro sun on the horizon and a dark glossy road with
 * cyan/magenta light strips.
 */
export const neonCityWorld = {
  key: 'neon',
  name: 'Neon Drive',
  blurb: 'Glowing skyways through a synthwave city',
  accent: '#ff2bd6',
  trackTheme: {
    asphalt: '#15151f',
    asphaltSpeck: 0.06,
    edgeLine: '#7ff6ff',
    roadEmissive: '#00e5ff',
    roadRoughness: 0.32,
    roadMetalness: 0.25,
    curbColors: ['#ff2bd6', '#1b1b2a'],
    barrierColors: ['#ff2bd6', '#7a2cff'],
    barrierEmissive: '#ff2bd6',
    deckColor: '#101018',
    supports: true,
    supportColor: '#1c1c2a',
    supportEmissive: '#00b8d4',
    gantryColor: '#2a2a3a',
    signText: 'NEON DRIVE',
    signBg: '#0b0b14',
    signFg: '#ff2bd6',
  },
  exposure: 1.1,
  bloom: { strength: 0.85, radius: 0.55, threshold: 0.55 },

  build({ scene, track }) {
    const rng = mulberry32(2077);
    const prox = createTrackProximity(track);
    const halfW = track.track_width_m * 0.5;
    const root = new THREE.Group();
    root.name = 'NeonCityWorld';
    scene.add(root);

    scene.background = new THREE.Color('#0a0518');
    scene.fog = new THREE.FogExp2('#1a0830', 0.16);

    const sky = createSkyDome(scene, {
      top: '#05020f',
      horizon: '#5a1a6e',
      bottom: '#0a0518',
    });

    scene.add(new THREE.HemisphereLight('#6a4cff', '#120a20', 0.55));
    const sun = createFollowSun(scene, { color: '#b9a6ff', intensity: 0.9, dir: [-0.3, 1.0, -0.6], size: 0.3 });

    // Retro striped sun on the horizon
    const sunTex = canvasTexture(512, 512, (g, w) => {
      const grad = g.createLinearGradient(0, 0, 0, w);
      grad.addColorStop(0, '#ffe066');
      grad.addColorStop(0.55, '#ff6b9a');
      grad.addColorStop(1, '#c41aff');
      g.fillStyle = grad;
      g.beginPath();
      g.arc(w / 2, w / 2, w / 2, 0, Math.PI * 2);
      g.fill();
      g.globalCompositeOperation = 'destination-out';
      for (let i = 0; i < 8; i++) {
        const y = w * 0.55 + i * i * 4 + i * 8;
        g.fillRect(0, y, w, 4 + i * 1.6);
      }
    });
    const retroSun = new THREE.Mesh(
      new THREE.PlaneGeometry(3.2, 3.2),
      new THREE.MeshBasicMaterial({ map: sunTex, transparent: true, fog: false, depthWrite: false })
    );
    retroSun.position.set(0, 0.9, -7.5);
    root.add(retroSun);

    // Glowing grid floor
    const gridTex = canvasTexture(256, 256, (g, w) => {
      g.fillStyle = '#000000';
      g.fillRect(0, 0, w, w);
      g.strokeStyle = '#ffffff';
      g.lineWidth = 3;
      g.strokeRect(0, 0, w, w);
    }, { repeat: [120, 120], srgb: false });
    const floorMat = new THREE.MeshStandardMaterial({
      color: '#0c0716',
      roughness: 0.35,
      metalness: 0.4,
      emissive: new THREE.Color('#7a2cff'),
      emissiveMap: gridTex,
      emissiveIntensity: 0.9,
    });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    root.add(floor);

    // Window texture for buildings
    const makeWindows = (hue) =>
      canvasTexture(128, 256, (g, w, h) => {
        g.fillStyle = '#07060d';
        g.fillRect(0, 0, w, h);
        const r = mulberry32(Math.floor(hue * 1000));
        for (let y = 6; y < h; y += 12) {
          for (let x = 6; x < w; x += 14) {
            if (r() < 0.45) continue;
            const l = 45 + r() * 30;
            g.fillStyle = `hsl(${hue + (r() - 0.5) * 30}, 100%, ${l}%)`;
            g.fillRect(x, y, 8, 6);
          }
        }
      }, { srgb: true });
    const palettes = [190, 300, 270, 40];
    const winTex = palettes.map(makeWindows);

    // Buildings in loose blocks around (but never on) the track
    const buildings = new THREE.Group();
    const roofLines = [];
    for (let n = 0, tries = 0; n < 220 && tries < 5000; tries++) {
      const x = (rng() * 2 - 1) * 4.0;
      const z = (rng() * 2 - 1) * 4.0;
      const w = 0.08 + rng() * 0.12;
      const d = 0.08 + rng() * 0.12;
      const near = prox.nearest(x, z, 3);
      if (near.dist < halfW + 0.05 + Math.max(w, d) * 0.75) continue;
      const centerDist = Math.hypot(x, z);
      const h = 0.12 + rng() * (centerDist < 1.4 ? 0.25 : 0.8);
      const pi = Math.floor(rng() * winTex.length);
      const tex = winTex[pi].clone();
      tex.needsUpdate = true;
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      tex.repeat.set(Math.max(1, Math.round(w / 0.06)), Math.max(1, Math.round(h / 0.08)));
      const sideMat = new THREE.MeshStandardMaterial({
        color: '#0d0b16',
        roughness: 0.6,
        emissive: new THREE.Color('#ffffff'),
        emissiveMap: tex,
        emissiveIntensity: 1.2,
      });
      const roofMat = new THREE.MeshStandardMaterial({ color: '#0d0b16', roughness: 0.7 });
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), [sideMat, sideMat, roofMat, roofMat, sideMat, sideMat]);
      b.position.set(x, h / 2, z);
      b.castShadow = true;
      b.receiveShadow = true;
      buildings.add(b);
      roofLines.push([x, h, z, w, d, palettes[pi]]);
      n++;
    }
    root.add(buildings);

    // Neon rim on roofs
    const rimGeo = new THREE.BoxGeometry(1, 0.003, 1);
    const rims = new THREE.InstancedMesh(rimGeo, new THREE.MeshBasicMaterial({ toneMapped: false }), roofLines.length);
    const m = new THREE.Matrix4();
    roofLines.forEach(([x, h, z, w, d, hue], i) => {
      m.compose(new THREE.Vector3(x, h + 0.0015, z), new THREE.Quaternion(), new THREE.Vector3(w * 1.02, 1, d * 1.02));
      rims.setMatrixAt(i, m);
      rims.setColorAt(i, new THREE.Color().setHSL(hue / 360, 1, 0.6));
    });
    root.add(rims);

    // Light posts along the road (emissive heads, no real lights)
    const postGeo = new THREE.CylinderGeometry(0.001, 0.0012, 0.045, 6);
    postGeo.translate(0, 0.0225, 0);
    const headGeo = new THREE.SphereGeometry(0.0028, 10, 8);
    const spacing = 0.22;
    const step = Math.max(1, Math.round((spacing / track.total_length_m) * track.samples.length));
    const spots = [];
    for (let i = 0; i < track.samples.length; i += step) spots.push(i);
    const posts = new THREE.InstancedMesh(postGeo, new THREE.MeshStandardMaterial({ color: '#2a2a3a' }), spots.length);
    const heads = new THREE.InstancedMesh(headGeo, new THREE.MeshBasicMaterial({ toneMapped: false }), spots.length);
    spots.forEach((i, k) => {
      const s = track.samples[i];
      const side = k % 2 === 0 ? 1 : -1;
      const off = halfW + 0.008;
      const x = s.position[0] + s.right[0] * side * off;
      const z = s.position[2] + s.right[2] * side * off;
      const y = s.position[1] + s.right[1] * side * off - 0.003;
      m.makeTranslation(x, y, z);
      posts.setMatrixAt(k, m);
      m.makeTranslation(x, y + 0.045, z);
      heads.setMatrixAt(k, m);
      heads.setColorAt(k, new THREE.Color(k % 3 === 0 ? '#ff2bd6' : '#00e5ff'));
    });
    root.add(posts, heads);

    return {
      root,
      sky,
      update(dt, t, focus) {
        sun.follow(focus);
        floorMat.emissiveIntensity = 0.75 + Math.sin(t * 1.3) * 0.15;
      },
    };
  },
};

