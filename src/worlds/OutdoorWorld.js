import * as THREE from 'three';
import { createTrackProximity, createFollowSun, createSkyDome, canvasTexture, mulberry32 } from './worldUtils.js';

/**
 * Sunny Hills — bright arcade-kart countryside: rolling grass terrain that rises
 * to meet the road, low-poly trees, flower bushes, puffy clouds and a grandstand.
 */
export const outdoorWorld = {
  key: 'outdoor',
  name: 'Sunny Hills',
  blurb: 'Grassy hills, big skies, fast sweepers',
  accent: '#7bd34a',
  trackTheme: {
    asphalt: '#4b4f58',
    asphaltSpeck: 0.12,
    edgeLine: '#f7f7f7',
    curbColors: ['#e5322b', '#f7f7f7'],
    barrierColors: ['#2a7bff', '#f7f7f7'],
    deckColor: '#5a4a38',
    supports: false,
    gantryColor: '#e9edf3',
    signText: 'SUNNY HILLS CIRCUIT',
    signBg: '#1a2b4a',
    signFg: '#ffe27a',
  },
  exposure: 1.05,
  bloom: { strength: 0.18, radius: 0.4, threshold: 0.92 },

  build({ scene, track }) {
    const rng = mulberry32(77);
    const prox = createTrackProximity(track);
    const halfW = track.track_width_m * 0.5;
    const root = new THREE.Group();
    root.name = 'OutdoorWorld';
    scene.add(root);

    scene.background = new THREE.Color('#9fd4ff');
    scene.fog = new THREE.Fog('#cfe8ff', 2.5, 9.0);
    const sunDir = [0.55, 0.9, 0.3];
    const sky = createSkyDome(scene, {
      top: '#2f86ff',
      horizon: '#cfeaff',
      bottom: '#9fcf7a',
      sunDir,
      sunColor: '#fff3c4',
    });

    scene.add(new THREE.HemisphereLight('#cfe8ff', '#5f8a3a', 1.15));
    const sun = createFollowSun(scene, { color: '#fff1d6', intensity: 2.8, dir: sunDir, size: 0.32 });

    // ---------------------------------------------------------------------
    // Terrain: gentle hills, flattened to sit just under the road, rising to a bowl at the edges
    // ---------------------------------------------------------------------
    const size = 9;
    const seg = 220;
    const terrainGeo = new THREE.PlaneGeometry(size, size, seg, seg);
    terrainGeo.rotateX(-Math.PI / 2);
    const pos = terrainGeo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const grassA = new THREE.Color('#5fb83a');
    const grassB = new THREE.Color('#86cf4a');
    const dirt = new THREE.Color('#8f7a52');
    const tmp = new THREE.Color();
    const naturalHeight = (x, z) => {
      const r = Math.hypot(x, z);
      const bowl = Math.max(0, r - 1.5) ** 1.6 * 0.35;
      const rolls =
        Math.sin(x * 2.1 + 1.3) * Math.cos(z * 1.7 - 0.4) * 0.025 +
        Math.sin(x * 5.3 - z * 4.1) * 0.006;
      return bowl + rolls - 0.004;
    };
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const near = prox.nearest(x, z, 3);
      let h = naturalHeight(x, z);
      const shoulder = halfW + 0.012;
      const blend = 0.14;
      let dirtAmt = 0;
      if (near.dist < shoulder + blend) {
        const roadBed = near.y - 0.0035;
        const t = THREE.MathUtils.smoothstep(near.dist, shoulder, shoulder + blend);
        h = THREE.MathUtils.lerp(roadBed, h, t);
        dirtAmt = 1 - THREE.MathUtils.smoothstep(near.dist, halfW, shoulder + 0.01);
      }
      pos.setY(i, h);
      const n = Math.sin(x * 23.0) * Math.cos(z * 19.0) * 0.5 + 0.5;
      tmp.copy(grassA).lerp(grassB, n * 0.8 + rng() * 0.2).lerp(dirt, dirtAmt * 0.6);
      colors[i * 3] = tmp.r;
      colors[i * 3 + 1] = tmp.g;
      colors[i * 3 + 2] = tmp.b;
    }
    terrainGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    terrainGeo.computeVertexNormals();
    const grassTex = canvasTexture(256, 256, (g, w, h) => {
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, w, h);
      const r = mulberry32(5);
      for (let i = 0; i < 5000; i++) {
        g.fillStyle = `rgba(30,70,10,${0.05 + r() * 0.12})`;
        g.fillRect(r() * w, r() * h, 1, 2 + r() * 3);
      }
    }, { repeat: [90, 90] });
    const terrain = new THREE.Mesh(
      terrainGeo,
      new THREE.MeshStandardMaterial({ vertexColors: true, map: grassTex, roughness: 0.95 })
    );
    terrain.receiveShadow = true;
    root.add(terrain);
    const heightAt = (x, z) => {
      const near = prox.nearest(x, z, 3);
      let h = naturalHeight(x, z);
      const shoulder = halfW + 0.012;
      if (near.dist < shoulder + 0.14) {
        const t = THREE.MathUtils.smoothstep(near.dist, shoulder, shoulder + 0.14);
        h = THREE.MathUtils.lerp(near.y - 0.0035, h, t);
      }
      return h;
    };

    // ---------------------------------------------------------------------
    // Trees (instanced trunks + two-tier canopies)
    // ---------------------------------------------------------------------
    const treeSpots = [];
    for (let tries = 0; tries < 4000 && treeSpots.length < 340; tries++) {
      const x = (rng() * 2 - 1) * 3.4;
      const z = (rng() * 2 - 1) * 3.4;
      const near = prox.nearest(x, z, 3);
      if (near.dist < halfW + 0.07) continue;
      // Keep the infield mostly open so the track stays readable from the high cameras
      if (Math.abs(x) < 1.1 && Math.abs(z) < 0.75 && rng() < 0.75) continue;
      treeSpots.push([x, z, 0.05 + rng() * 0.07]);
    }
    const trunkGeo = new THREE.CylinderGeometry(0.0025, 0.0035, 1, 6);
    trunkGeo.translate(0, 0.5, 0);
    const canopyGeo = new THREE.IcosahedronGeometry(1, 1);
    const trunks = new THREE.InstancedMesh(
      trunkGeo,
      new THREE.MeshStandardMaterial({ color: '#7a5232', roughness: 0.9 }),
      treeSpots.length
    );
    const canopies = new THREE.InstancedMesh(
      canopyGeo,
      new THREE.MeshStandardMaterial({ roughness: 0.85, flatShading: true }),
      treeSpots.length * 2
    );
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const greens = ['#2f8f3a', '#3fa548', '#58b947', '#2a7a44', '#6cc04a'].map((c) => new THREE.Color(c));
    let ci = 0;
    treeSpots.forEach(([x, z, h], i) => {
      const y = heightAt(x, z);
      m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(1, h * 0.45, 1));
      trunks.setMatrixAt(i, m);
      const c = greens[Math.floor(rng() * greens.length)];
      const r1 = h * 0.32;
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng() * 6.28);
      m.compose(new THREE.Vector3(x, y + h * 0.55, z), q, new THREE.Vector3(r1, r1 * 1.05, r1));
      canopies.setMatrixAt(ci, m);
      canopies.setColorAt(ci++, c);
      const r2 = r1 * 0.7;
      m.compose(new THREE.Vector3(x + r1 * 0.2, y + h * 0.85, z - r1 * 0.1), q, new THREE.Vector3(r2, r2, r2));
      canopies.setMatrixAt(ci, m);
      canopies.setColorAt(ci++, c.clone().offsetHSL(0, 0, 0.06));
      q.identity();
    });
    trunks.castShadow = true;
    canopies.castShadow = true;
    canopies.receiveShadow = true;
    root.add(trunks, canopies);

    // ---------------------------------------------------------------------
    // Flower bushes along the verges
    // ---------------------------------------------------------------------
    const bushGeo = new THREE.IcosahedronGeometry(1, 0);
    const bushCount = 420;
    const bushes = new THREE.InstancedMesh(
      bushGeo,
      new THREE.MeshStandardMaterial({ roughness: 0.8, flatShading: true }),
      bushCount
    );
    const bushColors = ['#ff6fa8', '#ffd43b', '#ffffff', '#ff8a3d', '#b07cff', '#4fbf4a', '#3c9f42'];
    let b = 0;
    for (let tries = 0; tries < 6000 && b < bushCount; tries++) {
      const i = Math.floor(rng() * track.samples.length);
      const s = track.samples[i];
      const side = rng() < 0.5 ? -1 : 1;
      const off = halfW + 0.012 + rng() * 0.09;
      const x = s.position[0] + s.right[0] * side * off;
      const z = s.position[2] + s.right[2] * side * off;
      if (prox.nearest(x, z, 2).dist < halfW + 0.01) continue;
      const r = 0.0012 + rng() * 0.0016;
      m.compose(new THREE.Vector3(x, heightAt(x, z) + r * 0.4, z), q, new THREE.Vector3(r, r * 0.8, r));
      bushes.setMatrixAt(b, m);
      bushes.setColorAt(b++, new THREE.Color(bushColors[Math.floor(rng() * bushColors.length)]));
    }
    bushes.count = b;
    bushes.castShadow = true;
    root.add(bushes);

    // ---------------------------------------------------------------------
    // Clouds
    // ---------------------------------------------------------------------
    const cloudMat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 1, emissive: '#ffffff', emissiveIntensity: 0.35 });
    const clouds = new THREE.Group();
    for (let c = 0; c < 14; c++) {
      const cloud = new THREE.Group();
      const puffs = 4 + Math.floor(rng() * 4);
      for (let p = 0; p < puffs; p++) {
        const r = 0.12 + rng() * 0.14;
        const puff = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 2), cloudMat);
        puff.position.set(p * 0.16 - puffs * 0.08, rng() * 0.06, (rng() - 0.5) * 0.12);
        puff.scale.y = 0.65;
        cloud.add(puff);
      }
      const a = (c / 14) * Math.PI * 2 + rng();
      const rad = 3.5 + rng() * 2.5;
      cloud.position.set(Math.cos(a) * rad, 1.2 + rng() * 0.9, Math.sin(a) * rad);
      clouds.add(cloud);
    }
    root.add(clouds);

    // ---------------------------------------------------------------------
    // Grandstand beside the start straight
    // ---------------------------------------------------------------------
    const s0 = track.samples[0];
    const right0 = new THREE.Vector3().fromArray(s0.right).setY(0).normalize();
    const tan0 = new THREE.Vector3().fromArray(s0.tangent).setY(0).normalize();
    const standSide = prox.nearest(s0.position[0] + right0.x * 0.12, s0.position[2] + right0.z * 0.12).dist > 0.09 ? 1 : -1;
    const stand = new THREE.Group();
    const standMat = new THREE.MeshStandardMaterial({ color: '#d9dde4', roughness: 0.6 });
    const rows = 5;
    for (let r = 0; r < rows; r++) {
      const step = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.008, 0.016), standMat);
      step.position.set(0, 0.004 + r * 0.008, r * 0.016);
      step.castShadow = true;
      step.receiveShadow = true;
      stand.add(step);
    }
    const crowdGeo = new THREE.BoxGeometry(0.003, 0.005, 0.003);
    const crowd = new THREE.InstancedMesh(crowdGeo, new THREE.MeshStandardMaterial({ roughness: 0.7 }), rows * 70);
    let cc = 0;
    const shirt = ['#ff4d4d', '#ffd43b', '#3b8cff', '#ffffff', '#4fd36b', '#ff8ad1', '#ff9d2e'];
    for (let r = 0; r < rows; r++) {
      for (let k = 0; k < 70; k++) {
        m.makeTranslation(-0.15 + k * 0.0044, 0.0105 + r * 0.008, r * 0.016);
        crowd.setMatrixAt(cc, m);
        crowd.setColorAt(cc++, new THREE.Color(shirt[Math.floor(rng() * shirt.length)]));
      }
    }
    stand.add(crowd);
    const roof = new THREE.Mesh(
      new THREE.BoxGeometry(0.34, 0.003, 0.1),
      new THREE.MeshStandardMaterial({ color: '#e5322b', roughness: 0.5 })
    );
    roof.position.set(0, 0.075, 0.045);
    roof.castShadow = true;
    stand.add(roof);
    for (const px of [-0.16, 0.16]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.075, 0.004), standMat);
      post.position.set(px, 0.0375, 0.088);
      stand.add(post);
    }
    const standPos = new THREE.Vector3(s0.position[0], 0, s0.position[2]).addScaledVector(right0, standSide * (halfW + 0.035));
    stand.position.set(standPos.x, heightAt(standPos.x, standPos.z), standPos.z);
    const facing = right0.clone().multiplyScalar(-standSide);
    stand.lookAt(stand.position.clone().add(facing));
    stand.rotateY(Math.PI);
    stand.position.addScaledVector(tan0, -0.05);
    root.add(stand);

    return {
      root,
      sky,
      update(dt, t, focus) {
        sun.follow(focus);
        clouds.rotation.y += dt * 0.004;
      },
    };
  },
};
