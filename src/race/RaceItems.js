import * as THREE from 'three';

/**
 * Track pickups, boost pads and combat items for MiniCart.
 *
 * Everything lives in track space (arc length `s` + lateral offset) so it
 * follows the banked spline exactly, and works the same for the player and
 * the AI rivals.
 *
 * Items (all original):
 *   TURBO FIZZ    – three shaken-soda bursts of speed
 *   GOO BLOB      – drop a sticky puddle behind you; whoever hits it spins out
 *   ZAP DART      – a homing spark that chases the kart directly ahead
 *   BUBBLE SHIELD – blocks the next hit for a few seconds
 *   SHOCK PULSE   – (back of the pack only) jolts every kart close ahead of you
 */

export const ITEMS = {
  fizz: { key: 'fizz', name: 'TURBO FIZZ', uses: 3 },
  goo: { key: 'goo', name: 'GOO BLOB', uses: 1 },
  dart: { key: 'dart', name: 'ZAP DART', uses: 1 },
  bubble: { key: 'bubble', name: 'BUBBLE SHIELD', uses: 1 },
  pulse: { key: 'pulse', name: 'SHOCK PULSE', uses: 1 },
};

// Original flat icons for the HUD item slot
export const ITEM_ICONS = {
  fizz: `<svg viewBox="0 0 48 48"><rect x="13" y="6" width="22" height="36" rx="5" fill="#ff3b5c"/><rect x="13" y="18" width="22" height="9" fill="#fff"/><rect x="16" y="3" width="16" height="5" rx="2" fill="#c9ced6"/><circle cx="24" cy="22.5" r="2.4" fill="#ff3b5c"/><circle cx="38" cy="10" r="2.5" fill="#bfefff"/><circle cx="41" cy="17" r="1.6" fill="#bfefff"/><circle cx="9" cy="13" r="2" fill="#bfefff"/></svg>`,
  goo: `<svg viewBox="0 0 48 48"><path d="M8 34c-3-6 2-12 7-12 1-7 9-11 15-7 6-2 12 4 10 10 5 3 4 11-2 12-4 4-11 3-14 0-6 3-13 2-16-3z" fill="#7cff4f"/><path d="M14 30c2-3 6-4 9-2" stroke="#d8ffc8" stroke-width="2.5" fill="none" stroke-linecap="round"/><circle cx="31" cy="28" r="3" fill="#3fb82a"/><circle cx="21" cy="35" r="2" fill="#3fb82a"/></svg>`,
  dart: `<svg viewBox="0 0 48 48"><path d="M27 3 11 27h11l-4 18 19-26H26z" fill="#ffe14a" stroke="#ff9d00" stroke-width="2" stroke-linejoin="round"/></svg>`,
  bubble: `<svg viewBox="0 0 48 48"><circle cx="24" cy="24" r="18" fill="#57d8ff" fill-opacity="0.35" stroke="#8fe8ff" stroke-width="3"/><path d="M14 18c2-4 6-6 10-6" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round"/><circle cx="31" cy="31" r="2.5" fill="#fff" fill-opacity="0.7"/></svg>`,
  pulse: `<svg viewBox="0 0 48 48"><circle cx="24" cy="24" r="5" fill="#d36bff"/><circle cx="24" cy="24" r="11" fill="none" stroke="#b44dff" stroke-width="3"/><circle cx="24" cy="24" r="18" fill="none" stroke="#8a2cff" stroke-width="2.5" stroke-dasharray="5 4"/></svg>`,
};

// Odds by race position: leader (0) → last (1)
function rollItem(posFrac, rng = Math.random) {
  const table =
    posFrac < 0.2
      ? [['goo', 0.42], ['bubble', 0.33], ['fizz', 0.25]]
      : posFrac < 0.6
        ? [['fizz', 0.3], ['dart', 0.3], ['goo', 0.2], ['bubble', 0.2]]
        : [['fizz', 0.34], ['dart', 0.36], ['pulse', 0.3]];
  let r = rng();
  for (const [k, w] of table) {
    if ((r -= w) <= 0) return k;
  }
  return table[0][0];
}

const BOX_RESPAWN = 2.6;
const PAD_BOOST = 0.8;
const KART_LEN = 0.007;
const KART_W = 0.005;

export function createRaceItems({ scene, physics, rivals, playerKartRoot, track, audio = null }) {
  const L = physics.totalLength;
  const S = track.samples;
  const halfW = track.track_width_m * 0.5;
  const railLat = physics.railLateral;
  const root = new THREE.Group();
  root.name = 'RaceItems';
  scene.add(root);

  const wrapS = (s) => ((s % L) + L) % L;
  const arcDelta = (from, to) => {
    let d = wrapS(to) - wrapS(from);
    if (d > L / 2) d -= L;
    if (d < -L / 2) d += L;
    return d;
  };
  const _f = {
    index: 0,
    sector: 1,
    position: new THREE.Vector3(),
    tangent: new THREE.Vector3(),
    right: new THREE.Vector3(),
    normal: new THREE.Vector3(),
    bankDeg: 0,
    signedCurvature: 0,
    slope: 0,
  };
  const _left = new THREE.Vector3();
  const _m = new THREE.Matrix4();
  const _q = new THREE.Quaternion();
  const _v = new THREE.Vector3();

  /** Place a road-aligned object at (s, lat, height). */
  function placeOnTrack(obj, s, lat, h = 0) {
    const f = physics.sampleTrackAtArcLength(s, _f);
    obj.position.copy(f.position).addScaledVector(f.right, lat).addScaledVector(f.normal, h);
    _left.crossVectors(f.normal, f.tangent).normalize();
    _m.makeBasis(_left, f.normal, f.tangent);
    obj.quaternion.setFromRotationMatrix(_m);
    return f;
  }

  // -------------------------------------------------------------------------
  // Racers (player + rivals) behind one interface
  // -------------------------------------------------------------------------
  const pst = physics.state;
  const racers = [
    {
      id: 'player',
      name: 'YOU',
      isPlayer: true,
      root: playerKartRoot,
      get s() { return pst.s; },
      get lat() { return pst.lateralOffset; },
      get speed() { return pst.speed; },
      get progress() { return physics.getRaceProgress(); },
      get spinning() { return pst.spinTimer > 0; },
      spin: (t) => physics.spinOut(t),
      boost: (t) => physics.addBoost(t),
      item: null,
      uses: 0,
      shield: 0,
      aiDelay: 0,
    },
    ...rivals.rivals.map((r) => ({
      id: r.id,
      name: r.name,
      isPlayer: false,
      ref: r,
      root: r.kart.kartRoot,
      get s() { return r.s; },
      get lat() { return r.lateralOffset; },
      get speed() { return r.speed; },
      get progress() { return r.distance; },
      get spinning() { return r.spinTimer > 0; },
      spin: (t) => rivals.spinOut(r, t),
      boost: (t) => rivals.boost(r, t),
      item: null,
      uses: 0,
      shield: 0,
      aiDelay: 0,
    })),
  ];
  const player = racers[0];

  // Shield bubbles (one per racer)
  const bubbleGeo = new THREE.SphereGeometry(0.0052, 24, 16);
  for (const rc of racers) {
    const mat = new THREE.MeshPhysicalMaterial({
      color: '#7fe6ff',
      emissive: '#2bb8ff',
      emissiveIntensity: 0.6,
      transparent: true,
      opacity: 0.32,
      roughness: 0.05,
      metalness: 0,
      depthWrite: false,
    });
    rc.bubbleMesh = new THREE.Mesh(bubbleGeo, mat);
    rc.bubbleMesh.visible = false;
    root.add(rc.bubbleMesh);
  }

  // -------------------------------------------------------------------------
  // Placement: item box rows + boost pads on the straightest stretches
  // -------------------------------------------------------------------------
  function straightness(i, span = 40) {
    let m = 0;
    for (let k = -span; k <= span; k++) m = Math.max(m, Math.abs(S[(i + k + S.length) % S.length].curvature || 0));
    return m;
  }
  const startS = physics.startFinishArc;
  function pickSpots(count, minGapFrac, avoid = []) {
    const cands = [];
    const step = Math.max(1, Math.floor(S.length / 160));
    for (let i = 0; i < S.length; i += step) {
      const s = S[i].arc_length_m;
      const fromStart = wrapS(s - startS);
      if (fromStart < L * 0.07 || fromStart > L * 0.95) continue; // keep the grid clear
      cands.push({ s, score: straightness(i) });
    }
    cands.sort((a, b) => a.score - b.score);
    const chosen = [];
    for (const c of cands) {
      if (chosen.length >= count) break;
      const clash = [...chosen, ...avoid].some((o) => Math.abs(arcDelta(o.s, c.s)) < L * minGapFrac);
      if (!clash) chosen.push(c);
    }
    return chosen;
  }
  const padSpots = pickSpots(3, 0.16);
  // Item rows spread evenly around the lap, nudged off any boost pad
  const boxSpots = [0.24, 0.55, 0.82].map((frac) => {
    let s = wrapS(startS + frac * L);
    for (let k = 0; k < 6 && padSpots.some((p) => Math.abs(arcDelta(p.s, s)) < 0.25); k++) s = wrapS(s + 0.12);
    return { s };
  });

  // Boost pads
  const padTex = (() => {
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = '#0a2a4a';
    g.fillRect(0, 0, 64, 128);
    g.strokeStyle = '#ffffff';
    g.lineWidth = 9;
    g.lineJoin = 'round';
    for (let k = 0; k < 2; k++) {
      const y = 22 + k * 64;
      g.beginPath();
      g.moveTo(10, y + 28);
      g.lineTo(32, y + 6);
      g.lineTo(54, y + 28);
      g.stroke();
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(1, 2);
    return t;
  })();
  const padMat = new THREE.MeshStandardMaterial({
    color: '#0e3d66',
    emissive: '#ffffff',
    emissiveMap: padTex,
    emissiveIntensity: 1.0,
    map: padTex,
    roughness: 0.4,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const PAD_W = Math.min(0.013, halfW * 0.8);
  const PAD_LEN = 0.03;
  const padGeo = new THREE.PlaneGeometry(PAD_W, PAD_LEN);
  padGeo.rotateX(Math.PI / 2);
  const pads = padSpots.map((spot, i) => {
    const lat = [-0.45, 0.45, 0][i % 3] * (railLat - PAD_W / 2);
    const mesh = new THREE.Mesh(padGeo, padMat);
    mesh.name = 'BoostPad';
    placeOnTrack(mesh, spot.s, lat, 0.0004);
    mesh.renderOrder = 2;
    root.add(mesh);
    return { s: spot.s, lat, mesh, cooldown: new Map() };
  });

  // Item pickups: glowing bubbles with the actual item icons cycling inside,
  // so it is obvious they hand you one of the items (and that it's random).
  const ICON_KEYS = Object.keys(ITEM_ICONS);
  const iconTextures = ICON_KEYS.map((k) => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 128;
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const img = new Image();
    img.onload = () => {
      const c = canvas.getContext('2d');
      c.clearRect(0, 0, 128, 128);
      // dark badge behind the icon so it reads on bright and dark worlds alike
      const grad = c.createRadialGradient(64, 64, 10, 64, 64, 62);
      grad.addColorStop(0, 'rgba(10,14,28,0.92)');
      grad.addColorStop(0.82, 'rgba(10,14,28,0.85)');
      grad.addColorStop(1, 'rgba(10,14,28,0)');
      c.fillStyle = grad;
      c.beginPath();
      c.arc(64, 64, 62, 0, Math.PI * 2);
      c.fill();
      c.drawImage(img, 22, 22, 84, 84);
      tex.needsUpdate = true;
    };
    const svg = ITEM_ICONS[k].replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" ');
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    return tex;
  });

  const orbGeo = new THREE.SphereGeometry(0.0027, 24, 16);
  const orbRingGeo = new THREE.TorusGeometry(0.0033, 0.00028, 8, 40);
  const boxes = [];
  for (const spot of boxSpots) {
    for (const f of [-0.66, -0.22, 0.22, 0.66]) {
      const lat = f * railLat;
      const g = new THREE.Group();
      const shellMat = new THREE.MeshPhysicalMaterial({
        color: '#ffffff',
        emissive: '#ff6bd5',
        emissiveIntensity: 0.06,
        transparent: true,
        opacity: 0.16,
        roughness: 0.05,
        clearcoat: 1,
        depthWrite: false,
      });
      const shell = new THREE.Mesh(orbGeo, shellMat);
      shell.renderOrder = 2;
      const ringMat = new THREE.MeshBasicMaterial({ color: '#ffffff', toneMapped: false });
      const ring = new THREE.Mesh(orbRingGeo, ringMat);
      const iconMat = new THREE.SpriteMaterial({ map: iconTextures[0], transparent: true, depthWrite: false, color: 0xd8d8d8 });
      const icon = new THREE.Sprite(iconMat);
      icon.scale.setScalar(0.0048);
      icon.renderOrder = 3;
      g.add(icon, shell, ring);
      g.userData = { shell, ring, ringMat, icon, iconMat, shellMat };
      root.add(g);
      boxes.push({ s: spot.s, lat, group: g, respawn: 0, phase: Math.random() * 10, iconIdx: Math.floor(Math.random() * ICON_KEYS.length) });
    }
  }

  // -------------------------------------------------------------------------
  // Hazards + projectiles
  // -------------------------------------------------------------------------
  const gooGeo = (() => {
    const shape = new THREE.Shape();
    const n = 14;
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      const r = 0.0034 * (0.78 + 0.22 * Math.sin(a * 3 + 1) + 0.08 * Math.cos(a * 5));
      const x = Math.cos(a) * r;
      const y = Math.sin(a) * r;
      if (i === 0) shape.moveTo(x, y);
      else shape.lineTo(x, y);
    }
    const geo = new THREE.ShapeGeometry(shape);
    geo.rotateX(Math.PI / 2);
    return geo;
  })();
  const gooMat = new THREE.MeshStandardMaterial({
    color: '#4fe02a',
    emissive: '#2a9a12',
    emissiveIntensity: 0.6,
    roughness: 0.15,
    metalness: 0.1,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -3,
  });
  const dartGeo = new THREE.ConeGeometry(0.0011, 0.0046, 8);
  dartGeo.rotateX(Math.PI / 2);
  const dartMat = new THREE.MeshBasicMaterial({ color: '#fff27a', toneMapped: false });
  const ringGeo = new THREE.RingGeometry(0.8, 1.0, 48);
  ringGeo.rotateX(-Math.PI / 2);

  let goos = [];
  let darts = [];
  let rings = [];

  // -------------------------------------------------------------------------
  // Events for the HUD
  // -------------------------------------------------------------------------
  const listeners = {};
  const emit = (ev, data) => (listeners[ev] || []).forEach((cb) => cb(data));
  function on(ev, cb) {
    (listeners[ev] = listeners[ev] || []).push(cb);
  }
  const sfx = (k, v) => audio && audio.playSfx && audio.playSfx(k, v);

  function positionFrac(rc) {
    const standings = rivals.getStandings();
    const idx = standings.findIndex((e) => (rc.isPlayer ? e.isPlayer : e.id === rc.id));
    return standings.length > 1 ? Math.max(0, idx) / (standings.length - 1) : 0;
  }

  /** Apply a hit to a racer, honouring shields. Returns true if it landed. */
  function hit(rc, seconds, by, what) {
    if (rc.shield > 0) {
      rc.shield = 0;
      if (rc.isPlayer) {
        sfx('shield');
        emit('toast', { text: 'BLOCKED!', tone: 'good' });
      }
      return false;
    }
    if (rc.spinning) return false;
    rc.spin(seconds);
    if (rc.isPlayer) {
      sfx('hit');
      emit('playerHit', { by, what });
      emit('toast', { text: by ? `${by.name} GOT YOU!` : 'SPLAT!', tone: 'bad' });
    } else if (by && by.isPlayer) {
      sfx('score');
      emit('toast', { text: `HIT ${rc.name}!`, tone: 'good' });
    }
    return true;
  }

  function useItem(rc) {
    if (!rc.item || rc.rolling > 0 || rc.spinning) return false;
    const k = rc.item;
    if (k === 'fizz') {
      rc.boost(0.9);
      if (rc.isPlayer) sfx('boost');
    } else if (k === 'bubble') {
      rc.shield = 7;
      if (rc.isPlayer) sfx('shield');
    } else if (k === 'goo') {
      const mesh = new THREE.Mesh(gooGeo, gooMat);
      const s = wrapS(rc.s - 0.009);
      const lat = rc.lat;
      placeOnTrack(mesh, s, lat, 0.00045);
      mesh.rotateY(Math.random() * Math.PI);
      root.add(mesh);
      goos.push({ s, lat, mesh, life: 30, owner: rc, grace: 0.6 });
      if (rc.isPlayer) sfx('drop');
    } else if (k === 'dart') {
      // Target: nearest racer ahead in race order
      let target = null;
      let best = Infinity;
      for (const o of racers) {
        if (o === rc) continue;
        const ahead = o.progress - rc.progress;
        if (ahead > 0 && ahead < best) {
          best = ahead;
          target = o;
        }
      }
      const mesh = new THREE.Mesh(dartGeo, dartMat);
      root.add(mesh);
      darts.push({ s: wrapS(rc.s + 0.006), lat: rc.lat, speed: Math.max(0.42, rc.speed * 1.6), target, owner: rc, life: 7, mesh });
      if (rc.isPlayer) sfx('zap');
    } else if (k === 'pulse') {
      let n = 0;
      for (const o of racers) {
        if (o === rc) continue;
        const ahead = o.progress - rc.progress;
        if (ahead > 0 && ahead < 0.35) {
          if (hit(o, 0.7, rc, 'pulse')) n++;
        }
      }
      const mesh = new THREE.Mesh(
        ringGeo,
        new THREE.MeshBasicMaterial({ color: '#c06bff', transparent: true, opacity: 0.9, toneMapped: false, side: THREE.DoubleSide, depthWrite: false })
      );
      mesh.position.copy(rc.root.position);
      root.add(mesh);
      rings.push({ mesh, t: 0 });
      if (rc.isPlayer) {
        sfx('pulse');
        if (n === 0) emit('toast', { text: 'NOBODY CLOSE', tone: 'meh' });
      }
    }
    rc.uses -= 1;
    if (rc.uses <= 0) {
      rc.item = null;
      rc.uses = 0;
    }
    if (rc.isPlayer) emit('item', { item: rc.item, uses: rc.uses });
    return true;
  }

  function giveItem(rc) {
    if (rc.item) return;
    const k = rollItem(positionFrac(rc));
    rc.item = k;
    rc.uses = ITEMS[k].uses;
    rc.rolling = rc.isPlayer ? 0.9 : 0;
    rc.aiDelay = 0.6 + Math.random() * 2.2;
    if (rc.isPlayer) {
      sfx('pickup');
      emit('roll', { item: k, uses: rc.uses, duration: 0.9 });
    }
  }

  // AI decision making for rival items
  function rivalThink(rc, dt) {
    if (!rc.item || rc.spinning) return;
    rc.aiDelay -= dt;
    if (rc.aiDelay > 0) return;
    const k = rc.item;
    const f = physics.sampleTrackAtArcLength(rc.s, _f);
    let go = false;
    if (k === 'fizz') go = Math.abs(f.signedCurvature) < 0.6;
    else if (k === 'bubble') go = true;
    else if (k === 'pulse') go = true;
    else if (k === 'goo') {
      go = racers.some((o) => o !== rc && rc.progress - o.progress > 0.006 && rc.progress - o.progress < 0.06);
      if (rc.aiDelay < -6) go = true;
    } else if (k === 'dart') {
      go = racers.some((o) => o !== rc && o.progress - rc.progress > 0 && o.progress - rc.progress < 0.4);
      if (rc.aiDelay < -8) go = true;
    }
    if (go) {
      useItem(rc);
      rc.aiDelay = 0.5 + Math.random() * 1.0;
    }
  }

  function near(rc, s, lat, alongTol, latTol) {
    return Math.abs(arcDelta(s, rc.s)) < alongTol && Math.abs(rc.lat - lat) < latTol;
  }

  function update(dt, t) {
    const active = rivals.raceStarted && !pst.autopilot && !pst.countdownLocked;

    // Box animation
    for (const b of boxes) {
      if (b.respawn > 0) b.respawn = Math.max(0, b.respawn - dt);
      const show = b.respawn === 0;
      const g = b.group;
      g.visible = show || b.respawn < 0.4;
      const pop = show ? 1 : 1 - b.respawn / 0.4;
      placeOnTrack(g, b.s, b.lat, 0.0042 + Math.sin(t * 2.4 + b.phase) * 0.0006);
      g.scale.setScalar(Math.max(0.01, pop));
      const ud = g.userData;
      const hue = (t * 0.15 + b.phase * 0.1) % 1;
      ud.shellMat.emissive.setHSL(hue, 0.95, 0.5);
      ud.shellMat.color.setHSL(hue, 0.9, 0.7);
      ud.ringMat.color.setHSL((hue + 0.5) % 1, 1, 0.6);
      ud.ring.rotation.set(Math.PI / 2 + Math.sin(t * 1.3 + b.phase) * 0.22, Math.cos(t * 1.1 + b.phase) * 0.22, 0);
      ud.ring.scale.setScalar(1 + Math.sin(t * 3 + b.phase) * 0.06);
      // cycle through the items it might give you
      const idx = (b.iconIdx + Math.floor(t * 2.2 + b.phase)) % ICON_KEYS.length;
      if (ud.iconMat.map !== iconTextures[idx]) ud.iconMat.map = iconTextures[idx];
    }
    padTex.offset.y = -((t * 1.6) % 1);
    padMat.emissiveIntensity = 0.75 + Math.sin(t * 8) * 0.25;

    for (const rc of racers) {
      if (rc.rolling > 0) {
        rc.rolling = Math.max(0, rc.rolling - dt);
        if (rc.rolling === 0 && rc.isPlayer) emit('item', { item: rc.item, uses: rc.uses });
      }
      if (rc.shield > 0) rc.shield = Math.max(0, rc.shield - dt);
      rc.bubbleMesh.visible = rc.shield > 0 && rc.root.visible;
      if (rc.bubbleMesh.visible) {
        rc.bubbleMesh.position.copy(rc.root.position);
        _v.set(0, 0.0016, 0).applyQuaternion(rc.root.quaternion);
        rc.bubbleMesh.position.add(_v);
        rc.bubbleMesh.material.opacity = rc.shield < 1.5 ? 0.18 + 0.18 * Math.abs(Math.sin(t * 14)) : 0.32;
      }
    }

    if (!active) return;

    for (const rc of racers) {
      if (!rc.root.visible) continue;
      // Pickups
      for (const b of boxes) {
        if (b.respawn > 0) continue;
        if (near(rc, b.s, b.lat, 0.0045, 0.0042)) {
          b.respawn = BOX_RESPAWN;
          giveItem(rc);
        }
      }
      // Pads
      for (const p of pads) {
        const cd = p.cooldown.get(rc.id) || 0;
        if (cd > t) continue;
        if (near(rc, p.s, p.lat, PAD_LEN / 2, PAD_W / 2 + 0.0015)) {
          p.cooldown.set(rc.id, t + 0.6);
          rc.boost(PAD_BOOST);
          if (rc.isPlayer) {
            sfx('boost');
            emit('pad', {});
          }
        }
      }
      // Goo puddles
      for (const gz of goos) {
        if (gz.dead) continue;
        if (gz.owner === rc && gz.grace > 0) continue;
        if (near(rc, gz.s, gz.lat, 0.0045, 0.0045)) {
          gz.dead = true;
          hit(rc, 0.95, gz.owner === rc ? null : gz.owner, 'goo');
        }
      }
      if (!rc.isPlayer) rivalThink(rc, dt);
    }

    // Goo lifetime
    for (const gz of goos) {
      gz.grace -= dt;
      gz.life -= dt;
      if (gz.life <= 0) gz.dead = true;
      if (gz.dead) root.remove(gz.mesh);
    }
    goos = goos.filter((g) => !g.dead);

    // Darts: fly along the track, steer toward the target's lane, hit anyone in the way
    for (const d of darts) {
      d.life -= dt;
      d.s = wrapS(d.s + d.speed * dt);
      if (d.target) {
        const gap = arcDelta(d.s, d.target.s);
        const k = THREE.MathUtils.clamp(1 - Math.abs(gap) / 0.12, 0.15, 1);
        d.lat = THREE.MathUtils.lerp(d.lat, d.target.lat, 1 - Math.exp(-dt * 10 * k));
      }
      d.lat = THREE.MathUtils.clamp(d.lat, -railLat, railLat);
      placeOnTrack(d.mesh, d.s, d.lat, 0.0022 + Math.sin(t * 40) * 0.0003);
      for (const o of racers) {
        if (o === d.owner && d.life > 6.6) continue;
        if (!o.root.visible) continue;
        if (near(o, d.s, d.lat, KART_LEN * 0.6, KART_W * 0.75)) {
          hit(o, 1.0, d.owner === o ? null : d.owner, 'dart');
          d.dead = true;
          break;
        }
      }
      if (d.life <= 0) d.dead = true;
      if (d.dead) root.remove(d.mesh);
    }
    darts = darts.filter((d) => !d.dead);

    // Pulse rings
    for (const r of rings) {
      r.t += dt;
      const k = r.t / 0.5;
      r.mesh.scale.setScalar(0.004 + k * 0.09);
      r.mesh.material.opacity = Math.max(0, 0.9 * (1 - k));
      if (k >= 1) {
        root.remove(r.mesh);
        r.dead = true;
      }
    }
    rings = rings.filter((r) => !r.dead);
  }

  function reset() {
    for (const gz of goos) root.remove(gz.mesh);
    for (const d of darts) root.remove(d.mesh);
    for (const r of rings) root.remove(r.mesh);
    goos = [];
    darts = [];
    rings = [];
    for (const b of boxes) b.respawn = 0;
    for (const p of pads) p.cooldown.clear();
    for (const rc of racers) {
      rc.item = null;
      rc.uses = 0;
      rc.rolling = 0;
      rc.shield = 0;
    }
    emit('item', { item: null, uses: 0 });
  }

  return {
    update,
    reset,
    on,
    usePlayerItem: () => useItem(player),
    get playerItem() {
      return player.item;
    },
    pads,
    boxes,
  };
}
