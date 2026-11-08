import * as THREE from 'three';
import { buildMicroKart } from '../scene/MicroKartBuilder.js';

/**
 * AI rival field for MiniCart.
 *
 * Rivals ride the same banked spline as the player (arc-length `s` + lateral offset),
 * hold a corner-aware cruise speed scaled by their skill, pick passing lanes around
 * slower karts, bump into each other (and the player), and are ranked together with
 * the player by continuous race distance.
 */

const RACE_LAPS = 3;

// Original driver roster (player is the red #1 kart)
export const RIVAL_ROSTER = [
  { name: 'BOLT', color: 0x1e7bff, skill: 1.035 },
  { name: 'JADE', color: 0x18c26b, skill: 1.015 },
  { name: 'SUNNY', color: 0xffc21a, skill: 0.995 },
  { name: 'VIOLET', color: 0x9b4dff, skill: 0.98 },
  { name: 'TANGO', color: 0xff7a1a, skill: 0.965 },
];

export const PLAYER_ENTRY = { name: 'YOU', color: 0xe01b24 };

// Speeds in m/s (same calibration as KartPhysicsController)
const CRUISE_SPEED = 0.195; // Same as the player's top speed without turbo
// Rivals run ~12% quicker than the Autopilot line so a clean player lap (~20s) is needed to win
const RIVAL_PACE = 1.06;
const BOOST_SPEED = 0.289;

// Collision footprint at the 1P kart scale (0.38x of the 18mm x 12mm kart)
const KART_LENGTH = 0.0070;
const KART_WIDTH = 0.0050;

const PROCEDURAL_BODY_HEX = 0xff2b1e;

export function createRivalField({ scene, sparkScene, physics, playerKartRoot }) {
  const L = physics.totalLength;
  const MAX_LATERAL = physics.curbLateral - 0.0006; // Rivals stay just inside the curbs
  const PLAYER_MAX_LATERAL = physics.railLateral; // Player rail contact
  const SF = physics.startFinishArc;
  const gridSlots = [];
  for (let i = 0; i < physics.gridSize; i++) {
    if (i !== physics.playerGridSlot) gridSlots.push(i);
  }

  const rivals = RIVAL_ROSTER.slice(0, gridSlots.length).map((def, idx) => {
    const kart = buildMicroKart();
    kart.kartRoot.name = `Rival_${def.name}`;
    stripKartLights(kart.chassisGroup);
    tintProceduralKart(kart.chassisGroup, def.color);
    scene.add(kart.kartRoot);
    if (sparkScene && kart.sparkPoints) sparkScene.add(kart.sparkPoints);

    return {
      ...def,
      id: `rival-${idx}`,
      gridSlot: gridSlots[idx],
      kart,
      frame: makeFrame(),
      // Driving state
      s: 0,
      lateralOffset: 0,
      lateralVel: 0,
      targetLateral: 0,
      speed: 0,
      distance: 0, // Continuous race distance from the start/finish line
      launchDelay: 0,
      boostActive: 0,
      boostCooldown: 0,
      finished: false,
      finishOrder: 0,
      finishTime: null,
      laneBias: 0,
      // Fields consumed by MicroKartBuilder.updateKartVisuals
      vis: {
        speed: 0,
        steerAngle: 0,
        steerInput: 0,
        driftAngle: 0,
        hopHeight: 0,
        boostActive: 0,
        isDrifting: false,
        curbRumble: 0,
        tangent: new THREE.Vector3(),
        right: new THREE.Vector3(),
        normal: new THREE.Vector3(),
      },
      headingYaw: 0,
    };
  });

  let raceStarted = false;
  let finishCounter = 0;
  let playerPlace = null;
  let hidden = false;

  const _left = new THREE.Vector3();
  const _rot = new THREE.Matrix4();
  const _baseQuat = new THREE.Quaternion();
  const _yawQuat = new THREE.Quaternion();

  function wrapS(s) {
    return ((s % L) + L) % L;
  }

  /** Signed shortest arc distance from a to b in [-L/2, L/2). */
  function arcDelta(a, b) {
    return ((((b - a) % L) + L * 1.5) % L) - L * 0.5;
  }

  function resetToGrid() {
    raceStarted = false;
    finishCounter = 0;
    playerPlace = null;
    for (const r of rivals) {
      const slot = physics.getGridSlot(r.gridSlot);
      r.s = slot.s;
      r.lateralOffset = slot.lateralOffset;
      r.targetLateral = slot.lateralOffset;
      r.lateralVel = 0;
      r.speed = 0;
      r.distance = arcDelta(SF, slot.s); // negative: behind the line
      r.launchDelay = 0.08 + Math.random() * 0.32;
      r.boostActive = 0;
      r.boostCooldown = 1.5 + Math.random() * 2.0;
      r.finished = false;
      r.finishOrder = 0;
      r.finishTime = null;
      r.laneBias = (Math.random() * 2 - 1) * MAX_LATERAL * 0.45;
      r.headingYaw = 0;
      syncPose(r, 0);
    }
  }

  function setHidden(val) {
    hidden = val;
    for (const r of rivals) {
      r.kart.kartRoot.visible = !val;
      if (r.kart.sparkPoints) r.kart.sparkPoints.visible = !val;
    }
  }

  // ---------------------------------------------------------------------------
  // AI driving
  // ---------------------------------------------------------------------------
  function driveRival(r, dt, playerProgress, others) {
    const frame = physics.sampleTrackAtArcLength(r.s, r.frame);
    const cornerFactor = physics.computeCruiseSpeedFactor(r.s, frame);

    // Rubber-banding keeps the pack close to the player without being blatant
    const gap = playerProgress - r.distance; // + = player ahead of this rival
    const rubber = THREE.MathUtils.clamp(gap * 0.09, -0.07, 0.07);

    let targetSpeed = CRUISE_SPEED * RIVAL_PACE * physics.aiPace * r.skill * (1 + rubber) * cornerFactor;

    if (r.finished) {
      targetSpeed *= 0.72; // Cool-down lap
    } else {
      // Occasional turbo on gentle sections
      r.boostCooldown -= dt;
      if (r.boostActive > 0) {
        r.boostActive = Math.max(0, r.boostActive - dt);
      } else if (r.boostCooldown <= 0 && cornerFactor > 0.95 && Math.abs(frame.signedCurvature) < 0.3) {
        r.boostActive = 0.55 + Math.random() * 0.35;
        r.boostCooldown = 4.5 + Math.random() * 4.0;
      }
      if (r.boostActive > 0) {
        targetSpeed = Math.max(targetSpeed, BOOST_SPEED * 0.86 * r.skill);
      }
    }

    // Racing line: inside-apex hint + personal lane bias that wanders slowly
    let desiredLateral = THREE.MathUtils.clamp(
      -frame.signedCurvature * 0.0011 + r.laneBias + Math.sin(r.distance * 3.1 + r.skill * 40) * MAX_LATERAL * 0.2,
      -MAX_LATERAL,
      MAX_LATERAL
    );

    // Look ahead for a kart to pass or follow
    let blocker = null;
    let blockerGap = Infinity;
    for (const o of others) {
      if (o.ref === r) continue;
      const ahead = arcDelta(r.s, o.s);
      if (ahead <= 0 || ahead > 0.032) continue;
      if (Math.abs(o.lateralOffset - r.lateralOffset) > KART_WIDTH * 1.25) continue;
      if (ahead < blockerGap) {
        blocker = o;
        blockerGap = ahead;
      }
    }
    if (blocker) {
      const closing = r.speed - blocker.speed;
      if (targetSpeed > blocker.speed * 1.01 || closing > 0.004) {
        // Swing out to whichever side has more room around the blocker
        const roomLeft = blocker.lateralOffset + MAX_LATERAL;
        const roomRight = MAX_LATERAL - blocker.lateralOffset;
        const side = roomRight >= roomLeft ? 1 : -1;
        desiredLateral = THREE.MathUtils.clamp(
          blocker.lateralOffset + side * KART_WIDTH * 1.3,
          -MAX_LATERAL,
          MAX_LATERAL
        );
      }
      // Don't drive through them while the pass is being set up
      if (blockerGap < KART_LENGTH * 1.6 && Math.abs(blocker.lateralOffset - r.lateralOffset) < KART_WIDTH) {
        targetSpeed = Math.min(targetSpeed, blocker.speed * 0.985);
      }
    }
    r.targetLateral = desiredLateral;

    // Longitudinal
    const speedErr = targetSpeed - r.speed;
    const accel = THREE.MathUtils.clamp(speedErr * 4.0, -0.9, r.boostActive > 0 ? 0.42 : 0.24);
    r.speed = Math.max(0, r.speed + (accel - frame.slope * 0.12) * dt);

    // Lateral (critically-damped spring toward the chosen lane)
    const latErr = r.targetLateral - r.lateralOffset;
    r.lateralVel += (latErr * 260 - r.lateralVel * 28) * dt;
    r.lateralVel = THREE.MathUtils.clamp(r.lateralVel, -0.02, 0.02);
    r.lateralOffset = THREE.MathUtils.clamp(r.lateralOffset + r.lateralVel * dt, -MAX_LATERAL, MAX_LATERAL);

    const ds = r.speed * dt;
    r.s = wrapS(r.s + ds);
    r.distance += ds;

    if (!r.finished && r.distance >= RACE_LAPS * L) {
      r.finished = true;
      r.finishOrder = ++finishCounter;
      r.finishTime = physics.state.totalRaceTime;
    }
  }

  // ---------------------------------------------------------------------------
  // Kart-to-kart contact (rivals + player)
  // ---------------------------------------------------------------------------
  function resolveContacts(bodies) {
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        const a = bodies[i];
        const b = bodies[j];
        if (a.ghost || b.ghost) continue;
        const dS = arcDelta(a.s, b.s); // + => b ahead of a
        const dLat = b.lateralOffset - a.lateralOffset;
        const absS = Math.abs(dS);
        const absLat = Math.abs(dLat);
        if (absS >= KART_LENGTH || absLat >= KART_WIDTH) continue;

        const overlapS = KART_LENGTH - absS;
        const overlapLat = KART_WIDTH - absLat;
        const latSign = dLat >= 0 ? 1 : -1;

        if (overlapLat < overlapS * 0.75) {
          // Side-by-side rub: shove apart sideways
          const push = overlapLat * 0.5 + 0.0002;
          a.lateralOffset -= latSign * push;
          b.lateralOffset += latSign * push;
          a.lateralVel = (a.lateralVel || 0) - latSign * 0.01;
          b.lateralVel = (b.lateralVel || 0) + latSign * 0.01;
          a.speed *= 0.995;
          b.speed *= 0.995;
          if (overlapLat > KART_WIDTH * 0.25) {
            a.onBump && a.onBump(0.35);
            b.onBump && b.onBump(0.35);
          }
        } else {
          // Nose-to-tail: separate along the track and trade momentum
          const front = dS >= 0 ? b : a;
          const rear = dS >= 0 ? a : b;
          const sep = overlapS * 0.5;
          front.s = wrapS(front.s + sep);
          rear.s = wrapS(rear.s - sep);
          if (front.distance !== undefined) front.distance += sep;
          if (rear.distance !== undefined) rear.distance -= sep;
          if (rear.speed > front.speed) {
            const closing = rear.speed - front.speed;
            const avg = (rear.speed + front.speed) * 0.5;
            front.speed = Math.max(front.speed, avg * 1.02);
            rear.speed = avg * 0.9;
            // Only a real hit gets a thump; gentle tailgating stays quiet
            if (closing > 0.02) {
              const strength = Math.min(1, 0.35 + closing * 6);
              rear.onBump && rear.onBump(strength);
              front.onBump && front.onBump(strength);
            }
          }
          // Small sideways nudge so they don't stay stacked
          const nudge = (latSign || 1) * 0.0004;
          a.lateralOffset -= nudge;
          b.lateralOffset += nudge;
        }
        a.clampLateral();
        b.clampLateral();
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Pose + visuals
  // ---------------------------------------------------------------------------
  function syncPose(r, dt) {
    const frame = physics.sampleTrackAtArcLength(r.s, r.frame);
    const yawTarget = THREE.MathUtils.clamp(-r.lateralVel * 18, -0.22, 0.22);
    r.headingYaw = dt > 0 ? THREE.MathUtils.lerp(r.headingYaw, yawTarget, 1 - Math.exp(-10 * dt)) : 0;

    const root = r.kart.kartRoot;
    root.position
      .copy(frame.position)
      .addScaledVector(frame.right, r.lateralOffset)
      .addScaledVector(frame.normal, 0.0003);
    _left.crossVectors(frame.normal, frame.tangent).normalize();
    _rot.makeBasis(_left, frame.normal, frame.tangent);
    _baseQuat.setFromRotationMatrix(_rot);
    _yawQuat.setFromAxisAngle(frame.normal, r.headingYaw);
    root.quaternion.copy(_yawQuat.multiply(_baseQuat));

    const v = r.vis;
    v.speed = r.speed;
    v.steerAngle = THREE.MathUtils.clamp(-r.lateralVel * 30 + frame.signedCurvature * -0.12, -0.45, 0.45);
    v.steerInput = THREE.MathUtils.clamp(r.lateralVel * 40, -1, 1);
    v.boostActive = r.boostActive;
    const drifting = Math.abs(frame.signedCurvature) > 0.6 && r.speed > 0.11;
    v.isDrifting = drifting;
    v.driftAngle = THREE.MathUtils.lerp(
      v.driftAngle,
      drifting ? -Math.sign(frame.signedCurvature) * 0.16 : 0,
      dt > 0 ? 1 - Math.exp(-6 * dt) : 1
    );
    v.tangent.copy(frame.tangent);
    v.right.copy(frame.right);
    v.normal.copy(frame.normal);
  }

  function rivalBody(r) {
    return {
      ref: r,
      get s() { return r.s; },
      set s(v) { r.s = v; },
      get distance() { return r.distance; },
      set distance(v) { r.distance = v; },
      get lateralOffset() { return r.lateralOffset; },
      set lateralOffset(v) { r.lateralOffset = v; },
      get lateralVel() { return r.lateralVel; },
      set lateralVel(v) { r.lateralVel = v; },
      get speed() { return r.speed; },
      set speed(v) { r.speed = v; },
      ghost: false,
      clampLateral() {
        r.lateralOffset = THREE.MathUtils.clamp(r.lateralOffset, -MAX_LATERAL, MAX_LATERAL);
      },
    };
  }
  const rivalBodies = rivals.map(rivalBody);

  let bumpCallback = null;
  let playerBumpCooldown = 0;
  const pst = physics.state;
  const playerBody = {
    get s() { return pst.s; },
    set s(v) { pst.s = v; },
    get lateralOffset() { return pst.lateralOffset; },
    set lateralOffset(v) { pst.lateralOffset = v; },
    get lateralVel() { return pst.lateralVel; },
    set lateralVel(v) { pst.lateralVel = v; },
    get speed() { return pst.speed; },
    set speed(v) { pst.speed = v; },
    ghost: false,
    clampLateral() {
      pst.lateralOffset = THREE.MathUtils.clamp(pst.lateralOffset, -PLAYER_MAX_LATERAL, PLAYER_MAX_LATERAL);
    },
    onBump(strength) {
      if (playerBumpCooldown > 0) return;
      playerBumpCooldown = 0.25;
      if (bumpCallback) bumpCallback(strength);
    },
  };
  const allBodies = [playerBody, ...rivalBodies];

  // ---------------------------------------------------------------------------
  // Public update
  // ---------------------------------------------------------------------------
  function update(dt) {
    const step = Math.min(dt, 0.05);
    playerBumpCooldown = Math.max(0, playerBumpCooldown - step);

    // Autopilot demo mode: the field sits out
    if (pst.autopilot) {
      if (!hidden) {
        setHidden(true);
        resetToGrid();
      }
      return;
    }
    if (hidden) setHidden(false);

    if (!raceStarted && !pst.countdownLocked && pst.raceClockActive) {
      raceStarted = true;
    }

    const playerProgress = physics.getRaceProgress();

    if (raceStarted) {
      for (const r of rivals) {
        if (r.launchDelay > 0) {
          r.launchDelay -= step;
          continue;
        }
        driveRival(r, step, playerProgress, rivalBodies.concat(playerBody));
      }
      // The player only collides while racing (not while parked on the grid or after the flag)
      playerBody.ghost = pst.raceFinished || pst.victoryCruise;
      resolveContacts(allBodies);
    }

    const kScale = playerKartRoot ? playerKartRoot.scale.x : 0.38;
    for (const r of rivals) {
      r.kart.kartRoot.scale.setScalar(kScale);
      syncPose(r, step);
      r.kart.updateKartVisuals(step, r.vis);
    }
  }

  /** Ordered standings (index 0 = leader) for player + rivals. */
  function getStandings() {
    const entries = [
      {
        id: 'player',
        name: PLAYER_ENTRY.name,
        color: PLAYER_ENTRY.color,
        isPlayer: true,
        finished: playerPlace !== null,
        finishOrder: playerPlace || 0,
        progress: physics.getRaceProgress(),
      },
      ...rivals.map((r) => ({
        id: r.id,
        name: r.name,
        color: r.color,
        isPlayer: false,
        finished: r.finished,
        finishOrder: r.finishOrder,
        progress: r.distance,
      })),
    ];
    entries.sort((a, b) => {
      if (a.finished && b.finished) return a.finishOrder - b.finishOrder;
      if (a.finished) return -1;
      if (b.finished) return 1;
      return b.progress - a.progress;
    });
    return entries;
  }

  function getPlayerPosition() {
    return getStandings().findIndex((e) => e.isPlayer) + 1;
  }

  /** Call once when the player takes the chequered flag; returns finishing place (1-based). */
  function notifyPlayerFinished() {
    if (playerPlace === null) {
      playerPlace = ++finishCounter;
    }
    return playerPlace;
  }

  /** Clone the loaded kart GLB onto every rival, tinted in their colour. Call BEFORE the player attaches it. */
  function attachGlbKart(template) {
    for (const r of rivals) {
      const { scene: clone, materials } = cloneKartTemplate(template.scene);
      r.kart.attachGlbKart(clone);
      for (const mat of materials) {
        const n = (mat.name || '').toLowerCase();
        if ((n.includes('crimson') || n.includes('red')) && mat.color) {
          mat.color.setHex(r.color);
        }
      }
      stripKartLights(r.kart.chassisGroup);
    }
  }

  resetToGrid();
  physics.onReset(() => resetToGrid());

  return {
    rivals,
    update,
    resetToGrid,
    getStandings,
    getPlayerPosition,
    notifyPlayerFinished,
    attachGlbKart,
    get fieldSize() {
      return rivals.length + 1;
    },
    onPlayerBump(cb) {
      bumpCallback = cb;
    },
  };
}

/** Deep-clone a kart GLB scene including its materials (so later restyling of the original doesn't leak). */
export function cloneKartTemplate(glbScene) {
  const clone = glbScene.clone(true);
  const matMap = new Map();
  clone.traverse((child) => {
    if (!child.isMesh) return;
    const cloneMat = (m) => {
      if (!m) return m;
      if (!matMap.has(m)) matMap.set(m, m.clone());
      return matMap.get(m);
    };
    child.material = Array.isArray(child.material) ? child.material.map(cloneMat) : cloneMat(child.material);
  });
  return { scene: clone, materials: [...matMap.values()] };
}

function makeFrame() {
  return {
    index: 0,
    sector: 6,
    position: new THREE.Vector3(),
    tangent: new THREE.Vector3(),
    right: new THREE.Vector3(),
    normal: new THREE.Vector3(),
    bankDeg: 0,
    signedCurvature: 0,
    slope: 0,
  };
}

/** Rivals don't need their own head/fire lights (keeps the light count and shader cost flat). */
function stripKartLights(group) {
  const lights = [];
  group.traverse((c) => {
    if (c.isLight) lights.push(c);
  });
  for (const l of lights) {
    if (l.parent) l.parent.remove(l);
  }
}

function tintProceduralKart(group, color) {
  const map = new Map();
  group.traverse((c) => {
    if (!c.isMesh || !c.material || Array.isArray(c.material)) return;
    const m = c.material;
    if (m.color && m.color.getHex() === PROCEDURAL_BODY_HEX) {
      if (!map.has(m)) {
        const clone = m.clone();
        clone.color.setHex(color);
        map.set(m, clone);
      }
      c.material = map.get(m);
    }
  });
}

export function ordinalSuffix(n) {
  const v = n % 100;
  if (v >= 11 && v <= 13) return 'TH';
  return ['TH', 'ST', 'ND', 'RD'][n % 10] || 'TH';
}
