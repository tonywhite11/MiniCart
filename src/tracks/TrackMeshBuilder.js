import * as THREE from 'three';

/**
 * Builds the drivable road, curbs, barriers, supports and start gantry from a
 * generated track (see TrackGenerator.js), styled by a world theme.
 *
 * The road is a constant-width ribbon swept along the banked frames, so it can
 * never pinch as long as corner radii exceed the half-width (the generator
 * warns otherwise).
 */

const DEFAULT_THEME = {
  asphalt: '#3b3e46',
  asphaltSpeck: 0.10,
  edgeLine: '#f4f4f4',
  centerDash: null,
  roadEmissive: null, // e.g. '#00e5ff' paints the edge lines as glowing strips
  roadRoughness: 0.82,
  roadMetalness: 0.0,
  curbColors: ['#e23b2e', '#f5f5f5'],
  barrierColors: ['#1f6fff', '#f5f5f5'],
  barrierEmissive: null,
  barrierHeight: 0.0035,
  deckColor: '#2a2d33',
  supports: true,
  supportColor: '#8a93a3',
  supportEmissive: null,
  gantryColor: '#d8dde6',
  signText: 'MINICART GRAND PRIX',
  signBg: '#14161c',
  signFg: '#ffd27a',
};

export function buildTrackMesh(track, themeIn = {}) {
  const theme = { ...DEFAULT_THEME, ...themeIn };
  const group = new THREE.Group();
  group.name = 'TrackGroup';

  const S = track.samples;
  const N = S.length;
  const halfW = track.track_width_m * 0.5;
  const L = track.total_length_m;

  const P = S.map((s) => new THREE.Vector3().fromArray(s.position));
  const T = S.map((s) => new THREE.Vector3().fromArray(s.tangent));
  const R = S.map((s) => new THREE.Vector3().fromArray(s.right));
  const Nn = S.map((s) => new THREE.Vector3().fromArray(s.normal));
  const arcAt = (i) => (i === N ? L : S[i].arc_length_m);

  // ---------------------------------------------------------------------------
  // 1. Road surface (top) — indexed so physics can also use it as a trimesh
  // ---------------------------------------------------------------------------
  const ACROSS = 6; // vertices across the road (slight crown)
  const roadPos = [];
  const roadNor = [];
  const roadUv = [];
  const roadIdx = [];
  const texRepeatM = 0.12; // texture tile length along the road
  for (let i = 0; i <= N; i++) {
    const k = i % N;
    for (let a = 0; a < ACROSS; a++) {
      const u = a / (ACROSS - 1);
      const lat = (u * 2 - 1) * halfW;
      const crown = (1 - Math.pow(u * 2 - 1, 2)) * 0.00025;
      const p = P[k].clone().addScaledVector(R[k], lat).addScaledVector(Nn[k], crown);
      roadPos.push(p.x, p.y, p.z);
      roadNor.push(Nn[k].x, Nn[k].y, Nn[k].z);
      roadUv.push(u, arcAt(i) / texRepeatM);
    }
  }
  for (let i = 0; i < N; i++) {
    for (let a = 0; a < ACROSS - 1; a++) {
      const v0 = i * ACROSS + a;
      const v1 = v0 + 1;
      const v2 = v0 + ACROSS;
      const v3 = v2 + 1;
      roadIdx.push(v0, v1, v2, v1, v3, v2); // CCW seen from above (normal = right x tangent)
    }
  }
  const roadGeo = new THREE.BufferGeometry();
  roadGeo.setAttribute('position', new THREE.Float32BufferAttribute(roadPos, 3));
  roadGeo.setAttribute('normal', new THREE.Float32BufferAttribute(roadNor, 3));
  roadGeo.setAttribute('uv', new THREE.Float32BufferAttribute(roadUv, 2));
  roadGeo.setIndex(roadIdx);
  roadGeo.computeVertexNormals();

  const roadTex = makeRoadTexture(theme);
  const roadMat = new THREE.MeshStandardMaterial({
    map: roadTex.map,
    roughness: theme.roadRoughness,
    metalness: theme.roadMetalness,
  });
  if (theme.roadEmissive) {
    roadMat.emissive = new THREE.Color(theme.roadEmissive);
    roadMat.emissiveMap = roadTex.emissive;
    roadMat.emissiveIntensity = 1.4;
  }
  const roadMesh = new THREE.Mesh(roadGeo, roadMat);
  roadMesh.receiveShadow = true;
  roadMesh.name = 'Road';
  group.add(roadMesh);

  // ---------------------------------------------------------------------------
  // 2. Deck skirt + underside (gives the road thickness; hidden on terrain worlds)
  // ---------------------------------------------------------------------------
  const deckDepth = 0.003;
  const deckPos = [];
  const deckIdx = [];
  for (let i = 0; i <= N; i++) {
    const k = i % N;
    for (const side of [-1, 1]) {
      const top = P[k].clone().addScaledVector(R[k], side * (halfW + 0.0004));
      const bot = top.clone().addScaledVector(Nn[k], -deckDepth);
      deckPos.push(top.x, top.y, top.z, bot.x, bot.y, bot.z);
    }
  }
  for (let i = 0; i < N; i++) {
    const b = i * 4;
    const n = b + 4;
    // left skirt (0,1), right skirt (2,3), underside (1,3)
    deckIdx.push(b, b + 1, n, n, b + 1, n + 1);
    deckIdx.push(b + 2, n + 2, b + 3, b + 3, n + 2, n + 3);
    deckIdx.push(b + 1, b + 3, n + 1, n + 1, b + 3, n + 3);
  }
  const deckGeo = new THREE.BufferGeometry();
  deckGeo.setAttribute('position', new THREE.Float32BufferAttribute(deckPos, 3));
  deckGeo.setIndex(deckIdx);
  deckGeo.computeVertexNormals();
  const deckMesh = new THREE.Mesh(
    deckGeo,
    new THREE.MeshStandardMaterial({ color: theme.deckColor, roughness: 0.7, side: THREE.DoubleSide })
  );
  deckMesh.castShadow = true;
  deckMesh.receiveShadow = true;
  group.add(deckMesh);

  // ---------------------------------------------------------------------------
  // 3. Curbs — only through real corners (both edges), alternating blocks
  // ---------------------------------------------------------------------------
  const cornerFlag = new Uint8Array(N);
  const curbRadius = theme.curbBelowRadius ?? 0.55;
  for (let i = 0; i < N; i++) {
    if (S[i].radius_m < curbRadius) {
      for (let o = -12; o <= 12; o++) cornerFlag[(i + o + N) % N] = 1;
    }
  }
  const curbW = Math.max(0.003, track.curb_width_m);
  const curbBlock = 0.006;
  const curbPos = [];
  const curbCol = [];
  const cA = new THREE.Color(theme.curbColors[0]);
  const cB = new THREE.Color(theme.curbColors[1]);
  for (let i = 0; i < N; i++) {
    if (!cornerFlag[i]) continue;
    const i1 = (i + 1) % N;
    const col = Math.floor(arcAt(i) / curbBlock) % 2 === 0 ? cA : cB;
    for (const side of [-1, 1]) {
      const q = (k, lat, lift) => P[k].clone().addScaledVector(R[k], side * lat).addScaledVector(Nn[k], lift);
      const a0 = q(i, halfW - curbW, 0.00018);
      const b0 = q(i, halfW, 0.0006);
      const a1 = q(i1, halfW - curbW, 0.00018);
      const b1 = q(i1, halfW, 0.0006);
      const tri = side > 0 ? [a0, a1, b0, b0, a1, b1] : [a0, b0, a1, a1, b0, b1];
      for (const v of tri) {
        curbPos.push(v.x, v.y, v.z);
        curbCol.push(col.r, col.g, col.b);
      }
    }
  }
  if (curbPos.length) {
    const curbGeo = new THREE.BufferGeometry();
    curbGeo.setAttribute('position', new THREE.Float32BufferAttribute(curbPos, 3));
    curbGeo.setAttribute('color', new THREE.Float32BufferAttribute(curbCol, 3));
    curbGeo.computeVertexNormals();
    const curbMesh = new THREE.Mesh(
      curbGeo,
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.5,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      })
    );
    curbMesh.receiveShadow = true;
    group.add(curbMesh);
  }

  // ---------------------------------------------------------------------------
  // 4. Barrier walls just outside both edges (what the kart grinds against)
  // ---------------------------------------------------------------------------
  const bh = theme.barrierHeight;
  const bIn = halfW + 0.0004;
  const bOut = halfW + 0.0024;
  const barPos = [];
  const barCol = [];
  const bc0 = new THREE.Color(theme.barrierColors[0]);
  const bc1 = new THREE.Color(theme.barrierColors[1]);
  const barrierBlock = theme.barrierBlock ?? 0.012;
  for (let i = 0; i < N; i++) {
    const i1 = (i + 1) % N;
    const col = Math.floor(arcAt(i) / barrierBlock) % 2 === 0 ? bc0 : bc1;
    for (const side of [-1, 1]) {
      const q = (k, lat, h) => P[k].clone().addScaledVector(R[k], side * lat).addScaledVector(Nn[k], h);
      const quads = [
        [q(i, bIn, 0), q(i1, bIn, 0), q(i, bIn, bh), q(i1, bIn, bh)], // inner face
        [q(i, bIn, bh), q(i1, bIn, bh), q(i, bOut, bh), q(i1, bOut, bh)], // top
        [q(i, bOut, bh), q(i1, bOut, bh), q(i, bOut, -0.003), q(i1, bOut, -0.003)], // outer face
      ];
      for (const [a, b, c, d] of quads) {
        const tri = side > 0 ? [a, c, b, b, c, d] : [a, b, c, c, b, d];
        for (const v of tri) {
          barPos.push(v.x, v.y, v.z);
          barCol.push(col.r, col.g, col.b);
        }
      }
    }
  }
  const barGeo = new THREE.BufferGeometry();
  barGeo.setAttribute('position', new THREE.Float32BufferAttribute(barPos, 3));
  barGeo.setAttribute('color', new THREE.Float32BufferAttribute(barCol, 3));
  barGeo.computeVertexNormals();
  const barMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.45,
    metalness: 0.1,
    side: THREE.DoubleSide,
  });
  if (theme.barrierEmissive) {
    barMat.emissive = new THREE.Color(theme.barrierEmissive);
    barMat.emissiveIntensity = 0.45;
  }
  const barMesh = new THREE.Mesh(barGeo, barMat);
  barMesh.castShadow = true;
  barMesh.receiveShadow = true;
  group.add(barMesh);

  // ---------------------------------------------------------------------------
  // 5. Support pillars wherever the road is lifted off the ground
  // ---------------------------------------------------------------------------
  if (theme.supports) {
    const spacing = 0.11;
    const stepSamples = Math.max(1, Math.round((spacing / L) * N));
    const spots = [];
    for (let i = 0; i < N; i += stepSamples) {
      if (P[i].y > 0.012) spots.push(i);
    }
    if (spots.length) {
      const pillarGeo = new THREE.CylinderGeometry(0.0028, 0.0034, 1, 10);
      pillarGeo.translate(0, 0.5, 0);
      const pillarMat = new THREE.MeshStandardMaterial({
        color: theme.supportColor,
        roughness: 0.5,
        metalness: 0.3,
      });
      if (theme.supportEmissive) {
        pillarMat.emissive = new THREE.Color(theme.supportEmissive);
        pillarMat.emissiveIntensity = 0.5;
      }
      const pillars = new THREE.InstancedMesh(pillarGeo, pillarMat, spots.length * 2);
      const m = new THREE.Matrix4();
      let n = 0;
      for (const i of spots) {
        for (const side of [-1, 1]) {
          const base = P[i].clone().addScaledVector(R[i], side * halfW * 0.6);
          const h = Math.max(0.001, base.y - deckDepth);
          m.compose(
            new THREE.Vector3(base.x, 0, base.z),
            new THREE.Quaternion(),
            new THREE.Vector3(1, h, 1)
          );
          pillars.setMatrixAt(n++, m);
        }
      }
      pillars.castShadow = true;
      group.add(pillars);
    }
  }

  // ---------------------------------------------------------------------------
  // 6. Start/finish line + gantry with 5 start lights
  // ---------------------------------------------------------------------------
  const gantry = buildGantry(P[0], T[0], R[0], Nn[0], halfW, theme);
  group.add(gantry.group);

  return {
    group,
    roadGeo,
    roadMesh,
    setStartLights: gantry.setStartLights,
  };
}

function buildGantry(pos, tangent, right, normal, halfW, theme) {
  const group = new THREE.Group();
  group.name = 'StartGantry';
  // Local right-handed frame: X = left (normal x tangent), Y = normal, Z = tangent
  const left = new THREE.Vector3().crossVectors(normal, tangent).normalize();
  const basis = new THREE.Matrix4().makeBasis(left, normal, tangent);
  group.quaternion.setFromRotationMatrix(basis);
  group.position.copy(pos);

  // Chequered line across the road
  const checker = document.createElement('canvas');
  checker.width = 256;
  checker.height = 32;
  const cx = checker.getContext('2d');
  for (let x = 0; x < 16; x++) {
    for (let y = 0; y < 2; y++) {
      cx.fillStyle = (x + y) % 2 ? '#111' : '#f4f4f4';
      cx.fillRect(x * 16, y * 16, 16, 16);
    }
  }
  const checkerTex = new THREE.CanvasTexture(checker);
  checkerTex.colorSpace = THREE.SRGBColorSpace;
  const line = new THREE.Mesh(
    new THREE.PlaneGeometry(halfW * 2, 0.004),
    new THREE.MeshStandardMaterial({
      map: checkerTex,
      roughness: 0.6,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    })
  );
  line.rotation.x = -Math.PI / 2;
  line.position.y = 0.0004;
  group.add(line);

  const towerMat = new THREE.MeshStandardMaterial({ color: theme.gantryColor, roughness: 0.6, metalness: 0.2 });
  const towerH = 0.032;
  const towerX = halfW + 0.006;
  for (const sx of [-towerX, towerX]) {
    const tower = new THREE.Mesh(new THREE.BoxGeometry(0.004, towerH, 0.004), towerMat);
    tower.position.set(sx, towerH / 2, 0);
    tower.castShadow = true;
    group.add(tower);
  }

  // Sign board with the circuit name
  const signW = towerX * 2 + 0.006;
  const signCanvas = document.createElement('canvas');
  signCanvas.width = 1024;
  signCanvas.height = 160;
  const sx = signCanvas.getContext('2d');
  sx.fillStyle = theme.signBg;
  sx.fillRect(0, 0, 1024, 160);
  sx.fillStyle = theme.signFg;
  sx.font = 'italic 900 78px Orbitron, sans-serif';
  sx.textAlign = 'center';
  sx.textBaseline = 'middle';
  sx.fillText(theme.signText, 512, 84, 980);
  const signTex = new THREE.CanvasTexture(signCanvas);
  signTex.colorSpace = THREE.SRGBColorSpace;
  const signMat = new THREE.MeshStandardMaterial({
    map: signTex,
    emissive: new THREE.Color('#ffffff'),
    emissiveMap: signTex,
    emissiveIntensity: 0.55,
    roughness: 0.4,
  });
  const signBox = new THREE.Mesh(new THREE.BoxGeometry(signW, 0.009, 0.004), [
    towerMat, towerMat, towerMat, towerMat, signMat, signMat,
  ]);
  signBox.position.set(0, towerH - 0.002, 0);
  signBox.rotation.y = Math.PI; // readable when approaching the line
  signBox.castShadow = true;
  group.add(signBox);

  // 5 start lights hanging under the sign (lit right-to-left like F1)
  const lights = [];
  for (let l = 0; l < 5; l++) {
    const mat = new THREE.MeshStandardMaterial({
      color: '#2a0c0c',
      emissive: new THREE.Color('#ff1a1a'),
      emissiveIntensity: 0,
      roughness: 0.3,
    });
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.0013, 12, 10), mat);
    bulb.position.set((l - 2) * 0.0048, towerH - 0.0085, -0.0025);
    group.add(bulb);
    lights.push(mat);
  }

  function setStartLights(count) {
    // count 0 = all off; 1..5 lights turn red from the right-hand side
    for (let l = 0; l < 5; l++) {
      const idxFromRight = 4 - l;
      const on = idxFromRight < count;
      lights[l].emissiveIntensity = on ? 4.0 : 0;
      lights[l].color.set(on ? '#ff3030' : '#2a0c0c');
    }
  }
  setStartLights(0);

  return { group, setStartLights };
}

function makeRoadTexture(theme) {
  const W = 256;
  const H = 256;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = theme.asphalt;
  ctx.fillRect(0, 0, W, H);
  // Speckle
  const rng = mulberry32(1234);
  for (let i = 0; i < 9000; i++) {
    const v = rng();
    const a = theme.asphaltSpeck * (0.4 + rng() * 0.6);
    ctx.fillStyle = v > 0.5 ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${a})`;
    ctx.fillRect(rng() * W, rng() * H, 1 + rng() * 1.5, 1 + rng() * 1.5);
  }
  // Edge lines
  const lineW = Math.round(W * 0.035);
  const inset = Math.round(W * 0.06);
  const drawLines = (g, color) => {
    g.fillStyle = color;
    g.fillRect(inset, 0, lineW, H);
    g.fillRect(W - inset - lineW, 0, lineW, H);
    if (theme.centerDash) {
      g.fillStyle = theme.centerDash;
      g.fillRect(W / 2 - lineW / 2, 0, lineW, H * 0.5);
    }
  };
  drawLines(ctx, theme.edgeLine);
  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = THREE.ClampToEdgeWrapping;
  map.wrapT = THREE.RepeatWrapping;
  map.anisotropy = 8;

  let emissive = null;
  if (theme.roadEmissive) {
    const e = document.createElement('canvas');
    e.width = W;
    e.height = H;
    const eg = e.getContext('2d');
    eg.fillStyle = '#000';
    eg.fillRect(0, 0, W, H);
    drawLines(eg, '#fff');
    emissive = new THREE.CanvasTexture(e);
    emissive.wrapS = THREE.ClampToEdgeWrapping;
    emissive.wrapT = THREE.RepeatWrapping;
  }
  return { map, emissive };
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
