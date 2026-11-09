import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';

/**
 * Initializes the @dimforge/rapier3d-compat 3D Physics World with colliders for the
 * oak desk, 8 monuments, and 720-sample coaster trimesh, paired with a 60FPS
 * Spline-Assisted Banked Coaster Surface & Raycast Vehicle Controller.
 */
export async function createKartPhysicsController(splineData, manifest, roadGeo) {
  await RAPIER.init();

  const gravity = { x: 0.0, y: -9.81, z: 0.0 };
  const world = new RAPIER.World(gravity);

  // 1. Static Oak Desk Collider (1100 x 25 x 600 mm, top at Y=0)
  const deskBodyDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(0.0, -0.0125, 0.0);
  const deskBody = world.createRigidBody(deskBodyDesc);
  world.createCollider(RAPIER.ColliderDesc.cuboid(0.55, 0.0125, 0.3), deskBody);

  // 2. Static Colliders for the Desk Monuments
  if (manifest && Array.isArray(manifest.desk_objects)) {
    for (const obj of manifest.desk_objects) {
      if (obj.id === 'oak_desk_tabletop') continue;
      const c = obj.center_xyz || obj.base_xyz || obj.mat_center_xyz || [0, 0, 0];
      const d =
        obj.dimensions_wdh ||
        obj.panel_dimensions_wdh ||
        obj.head_dimensions_wdh ||
        obj.mat_dimensions_wdh || [0.06, 0.06, 0.06];
      const bDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(
        c[0],
        c[1] + d[2] * 0.5,
        c[2]
      );
      const body = world.createRigidBody(bDesc);
      world.createCollider(
        RAPIER.ColliderDesc.cuboid(d[0] * 0.5, d[2] * 0.5, d[1] * 0.5),
        body
      );
    }
  }

  // 3. Coaster Roadbed Trimesh Collider inside Rapier World
  if (roadGeo && roadGeo.attributes.position && roadGeo.index) {
    const verts = new Float32Array(roadGeo.attributes.position.array);
    const indices = new Uint32Array(roadGeo.index.array);
    const trackBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    world.createCollider(RAPIER.ColliderDesc.trimesh(verts, indices), trackBody);
  }

  // 4. Kinematic Position-Based RigidBody for the 1:87 Micro-Kart (18mm x 12mm x 8mm)
  const kartBodyDesc = RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(
    0.0,
    0.036,
    0.255
  );
  const kartBody = world.createRigidBody(kartBodyDesc);
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(0.006, 0.004, 0.009).setRestitution(0.4),
    kartBody
  );

  // -------------------------------------------------------------------------
  // PRECOMPUTE PERIODIC SPLINE TABLE & SECTOR START ARC-LENGTHS
  // -------------------------------------------------------------------------
  const samples = splineData.samples;
  const N = samples.length;
  const totalLength = splineData.total_length_m || 3.8371;

  // Lateral limits derived from the road width (original 22mm road: curbs at 7.8mm, rail contact at 9.0mm)
  const trackHalfWidth = (splineData.track_width_m || 0.022) * 0.5;
  const CURB_LAT = trackHalfWidth - 0.0032; // Kart centre reaches the red/white curb
  const RAIL_LAT = trackHalfWidth - 0.0020; // Kart centre at guardrail contact
  const RAIL_SCRAPE_DRAG = 0.9; // m/s² lost while grinding along a guardrail

  // C2 Position & Orientation Frame Smoothing:
  // track_spline.json has 18-sample Catmull-Rom knot boundaries in Sector 2 (Cat Helix) and Sector 4 (Lamp Corkscrew)
  // where adjacent tangents jump by up to 8.3°–10.1° across a single 3.1mm segment.
  // A 2-pass [0.2, 0.6, 0.2] position filter + 4-pass circular [1, 2, 3, 2, 1]/9 frame filter removes knot kinks
  // so position and tangent are 100% C2-consistent.
  const smoothPositions = samples.map((s) => new THREE.Vector3().fromArray(s.position));
  for (let pass = 0; pass < 2; pass++) {
    const nextP = smoothPositions.map((v) => v.clone());
    for (let i = 0; i < N; i++) {
      const pPrev = smoothPositions[(i - 1 + N) % N];
      const pCurr = smoothPositions[i];
      const pNext = smoothPositions[(i + 1) % N];
      nextP[i]
        .copy(pCurr)
        .multiplyScalar(0.6)
        .addScaledVector(pPrev, 0.2)
        .addScaledVector(pNext, 0.2);
    }
    for (let i = 0; i < N; i++) {
      smoothPositions[i].copy(nextP[i]);
    }
  }

  const smoothTangents = samples.map((s) => new THREE.Vector3().fromArray(s.tangent).normalize());
  const smoothNormals = samples.map((s) => new THREE.Vector3().fromArray(s.normal).normalize());
  const smoothRights = samples.map((s) => new THREE.Vector3().fromArray(s.right).normalize());
  const smoothBanks = samples.map((s) => s.bank_deg || 0);

  for (let pass = 0; pass < 4; pass++) {
    const nextT = smoothTangents.map((v) => v.clone());
    const nextN = smoothNormals.map((v) => v.clone());
    const nextB = smoothBanks.slice();
    const weights = [1, 2, 3, 2, 1];
    for (let i = 0; i < N; i++) {
      nextT[i].set(0, 0, 0);
      nextN[i].set(0, 0, 0);
      let bSum = 0;
      for (let k = -2; k <= 2; k++) {
        const idx = (i + k + N) % N;
        const w = weights[k + 2];
        nextT[i].addScaledVector(smoothTangents[idx], w);
        nextN[i].addScaledVector(smoothNormals[idx], w);
        bSum += smoothBanks[idx] * w;
      }
      nextT[i].normalize();
      nextN[i].normalize();
      nextB[i] = bSum / 9.0;
    }
    for (let i = 0; i < N; i++) {
      smoothTangents[i].copy(nextT[i]);
      // Re-orthonormalize right = tangent x normal, normal = right x tangent
      smoothRights[i].crossVectors(smoothTangents[i], nextN[i]).normalize();
      smoothNormals[i].crossVectors(smoothRights[i], smoothTangents[i]).normalize();
      smoothBanks[i] = nextB[i];
    }
  }

  // Precompute continuous per-sample signed horizontal curvature (smoothed across knots so Autopilot never chatters at 45Hz)
  const rawCurvatures = new Float32Array(N);
  const smoothCurvatures = new Float32Array(N);
  const _tmpDiff = new THREE.Vector3();
  for (let i = 0; i < N; i++) {
    const iPrev = (i - 3 + N) % N;
    const iNext = (i + 3) % N;
    _tmpDiff.subVectors(smoothTangents[iNext], smoothTangents[iPrev]);
    rawCurvatures[i] = _tmpDiff.dot(smoothRights[i]) * 8.0;
  }
  for (let i = 0; i < N; i++) {
    let cSum = 0;
    const weights = [1, 2, 3, 2, 1];
    for (let k = -2; k <= 2; k++) {
      cSum += rawCurvatures[(i + k + N) % N] * weights[k + 2];
    }
    smoothCurvatures[i] = cSum / 9.0;
  }

  // Anchor the main Start/Finish Line to sample 646 (X = +0.0183m, Z = 0.255m,
  // where the F1 5-light countdown gantry and 645..646 black-and-white
  // checkered road stripes are located)
  let startFinishIdx = Math.min(646, N - 1);
  let minFinishDist = Infinity;
  const sectorStartArcs = {};

  for (let i = 0; i < N; i++) {
    const s = samples[i];
    if (sectorStartArcs[s.sector] === undefined) {
      sectorStartArcs[s.sector] = s.arc_length_m;
    }
    if (s.sector === 6) {
      const dx = s.position[0] - 0.0183;
      const dz = s.position[2] - 0.255;
      const d2 = dx * dx + dz * dz;
      if (d2 < minFinishDist) {
        minFinishDist = d2;
        startFinishIdx = i;
      }
    }
  }

  if (Number.isInteger(splineData.start_finish_index)) {
    startFinishIdx = splineData.start_finish_index;
  }
  const startFinishArc = samples[startFinishIdx].arc_length_m;
  // Position the kart on the starting grid right behind the black-and-white
  // checkered stripes (645..646, entry edge at startFinishArc - 0.0095m) so the
  // car starts close to the stripes while keeping the overhead F1 5-light
  // countdown gantry in clear view.
  sectorStartArcs[6] = (startFinishArc - 0.025 + totalLength) % totalLength;

  // Pre-allocated scratch vectors/matrices to avoid GC allocations on every physics step
  const _p1 = new THREE.Vector3();
  const _left = new THREE.Vector3();
  const _tangentDelta = new THREE.Vector3();
  const _rotMat = new THREE.Matrix4();
  const _baseQuat = new THREE.Quaternion();
  const _yawQuat = new THREE.Quaternion();
  const _sampleOut = {
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
  const _nextSampleOut = {
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

  function sampleTrackAtArcLength(sVal, out = _sampleOut) {
    const wrappedS = ((sVal % totalLength) + totalLength) % totalLength;

    // Binary search in samples[].arc_length_m
    let lo = 0;
    let hi = N - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (samples[mid].arc_length_m <= wrappedS) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }

    const i0 = lo;
    const i1 = (lo + 1) % N;
    const s0 = samples[i0];
    const s1 = samples[i1];

    const arc0 = s0.arc_length_m;
    const arc1 = i1 === 0 ? totalLength : s1.arc_length_m;
    const segLen = Math.max(1e-6, arc1 - arc0);
    const alpha = THREE.MathUtils.clamp((wrappedS - arc0) / segLen, 0, 1);

    out.position.copy(smoothPositions[i0]).lerp(smoothPositions[i1], alpha);
    out.tangent.copy(smoothTangents[i0]).lerp(smoothTangents[i1], alpha).normalize();
    out.right.copy(smoothRights[i0]).lerp(smoothRights[i1], alpha).normalize();
    out.normal.copy(smoothNormals[i0]).lerp(smoothNormals[i1], alpha).normalize();

    const signedCurvature = THREE.MathUtils.lerp(
      smoothCurvatures[i0],
      smoothCurvatures[i1],
      alpha
    );
    const bankDeg = THREE.MathUtils.lerp(smoothBanks[i0], smoothBanks[i1], alpha);

    out.index = i0;
    out.sector = s0.sector;
    out.bankDeg = bankDeg;
    out.signedCurvature = signedCurvature;
    out.slope = out.tangent.y;
    return out;
  }

  function computeSlopeSpeedDelta(frame) {
    return THREE.MathUtils.clamp(
      frame.slope > 0 ? -frame.slope * 0.68 : -frame.slope * 0.42,
      -0.25,
      0.18
    );
  }

  /**
   * Fraction of cruise speed a computer driver should hold at arc-length `sVal`
   * (shared by Autopilot and the AI rival karts). Slows through the Cat Helix and
   * Lamp Corkscrew envelopes and any tight curvature; ~0.56..1.12.
   */
  // Generated tracks carry per-sample corner radii: precompute a look-ahead cruise table
  // (slow for the tightest corner in the next 15cm, full speed on big sweepers).
  const cruiseTable = (() => {
    if (samples[0].radius_m === undefined) return null;
    const lookSamples = Math.max(1, Math.round((0.15 / totalLength) * N));
    const table = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      let minR = Infinity;
      for (let j = -4; j <= lookSamples; j++) {
        minR = Math.min(minR, samples[(i + j + N) % N].radius_m);
      }
      table[i] = THREE.MathUtils.clamp(Math.sqrt(minR / 0.3), 0.76, 1.0);
    }
    return table;
  })();

  function computeCruiseSpeedFactor(sVal, frame = sampleTrackAtArcLength(sVal, _nextSampleOut)) {
    if (cruiseTable) {
      return THREE.MathUtils.clamp(
        cruiseTable[frame.index] + computeSlopeSpeedDelta(frame) * 0.5,
        0.56,
        1.12
      );
    }
    const sWrapped = ((sVal % totalLength) + totalLength) % totalLength;
    const curvatureNorm = THREE.MathUtils.clamp(Math.abs(frame.signedCurvature) / 1.25, 0.0, 1.0);
    const inCatEnvelope =
      THREE.MathUtils.smoothstep(sWrapped, 0.40, 0.56) *
      (1.0 - THREE.MathUtils.smoothstep(sWrapped, 1.20, 1.38));
    const inLampEnvelope =
      THREE.MathUtils.smoothstep(sWrapped, 1.46, 1.64) *
      (1.0 - THREE.MathUtils.smoothstep(sWrapped, 2.34, 2.52));
    const catProgress = THREE.MathUtils.clamp((sWrapped - 0.46) / 0.86, 0.0, 1.0);
    const catDynamicSlowdown =
      inCatEnvelope *
      (0.34 * Math.exp(-Math.pow((catProgress - 0.24) / 0.26, 2.0)) +
        0.14 * (1.0 - catProgress) +
        0.045 * Math.sin(catProgress * Math.PI * 3.0));
    const lampProgress = THREE.MathUtils.clamp((sWrapped - 1.50) / 0.98, 0.0, 1.0);
    const lampDynamicSlowdown =
      inLampEnvelope *
      (0.36 * Math.exp(-Math.pow((lampProgress - 0.38) / 0.28, 2.0)) +
        0.12 * (1.0 - lampProgress) +
        0.05 * Math.cos(lampProgress * Math.PI * 2.5));
    const throttleCadenceWave =
      0.032 * Math.sin(sWrapped * 11.2) + 0.021 * Math.cos(sWrapped * 18.7);

    const baseSlowdown = Math.max(catDynamicSlowdown, lampDynamicSlowdown, curvatureNorm * 0.24);
    return THREE.MathUtils.clamp(
      1.0 - baseSlowdown + computeSlopeSpeedDelta(frame) + throttleCadenceWave,
      0.56,
      1.12
    );
  }

  // -------------------------------------------------------------------------
  // STARTING GRID (player + AI rivals, two staggered columns behind the line)
  // -------------------------------------------------------------------------
  const GRID_FIRST_ROW_GAP = 0.025; // Front row sits 25mm behind the checkered stripes
  const GRID_ROW_SPACING = 0.016; // 16mm between rows
  const GRID_LANE_OFFSET = trackHalfWidth * 0.36; // Two lanes either side of the centreline
  const GRID_ROWS = 3; // 6 karts: 2 per row
  const PLAYER_GRID_SLOT = GRID_ROWS * 2 - 1; // Player starts at the back (slot index 5 → 6th)

  /** Arc-length + lateral offset for a starting-grid slot (0 = pole). */
  function getGridSlot(slotIndex) {
    const row = Math.floor(slotIndex / 2);
    const lane = slotIndex % 2 === 0 ? -1 : 1;
    const s = startFinishArc - GRID_FIRST_ROW_GAP - row * GRID_ROW_SPACING - (lane > 0 ? 0.004 : 0);
    return {
      s: ((s % totalLength) + totalLength) % totalLength,
      lateralOffset: lane * GRID_LANE_OFFSET,
    };
  }
  sectorStartArcs[6] = getGridSlot(PLAYER_GRID_SLOT).s;

  // -------------------------------------------------------------------------
  // VEHICLE STATE & INPUT LISTENERS
  // -------------------------------------------------------------------------
  const keys = {
    forward: false,
    backward: false,
    left: false,
    right: false,
    drift: false,
  };
  const kbKeys = {
    forward: false,
    backward: false,
    left: false,
    right: false,
    drift: false,
  };
  const touchKeys = {
    forward: false,
    backward: false,
    left: false,
    right: false,
    drift: false,
  };

  const state = {
    s: sectorStartArcs[6], // Start on Sector 6 G915 Viaduct approaching Start/Finish gantry
    lateralOffset: getGridSlot(PLAYER_GRID_SLOT).lateralOffset, // Between ±CURB_LAT on the road
    lateralVel: 0.0,
    speed: 0.0, // Stationary (0.0 m/s) in Manual Mode at startup until player presses W/Up or P
    headingYaw: 0.0, // World-differential heading yaw relative to track tangent (clamped to [-1.05, +1.05] = ±60°)
    turnRight: 0.0, // +1 for D/Right, -1 for A/Left
    steerSmooth: 0.0, // Progressive smoothed manual steering input
    steerAngle: 0.0, // Front wheel steering angle in radians (+0.45 Left A, -0.45 Right D)
    topSpeedMultiplier: 1.0,
    steerInput: 0.0,
    isDrifting: false,
    driftDir: 0, // -1 left, +1 right
    driftAngle: 0.0,
    driftChargeTimer: 0.0,
    cornerCleanTimer: 0.0,
    boostCharge: 1.0, // 0.0 to 1.0 (3 tiers)
    boostActive: 0.0, // remaining turbo boost timer
    hopHeight: 0.0,
    hopVel: 0.0,
    driftCharge: 0.0, // seconds held in a manual drift
    driftTier: 0, // 0 none, 1 blue, 2 orange, 3 pink mini-turbo
    sparkTint: null, // [r,g,b] override for drift sparks
    spinTimer: 0.0, // >0 while spun out by a hazard
    spinYaw: 0.0, // visual spin angle (radians)
    curbRumble: 0.0,
    railImpactActive: false,
    railHitCooldown: 0.0,
    downforceG: 1.0,
    autopilot: false, // Starts 100% in Manual Mode at 0.0 m/s!
    victoryCruise: false, // Celebratory AI cruise after completing 3 laps
    raceClockActive: false, // Starts ticking when F1 5-light countdown turns OFF (or when driving begins)
    countdownLocked: false, // Holds kart at starting grid while 5 F1 red lights count down
    wasCountdownLocked: false,
    launchWindowTimer: 0.0,
    lapCount: 1,
    lapDistance: 0.0, // Track distance driven since the last lap boundary (guards against counting the grid roll-over as a lap)
    currentLapTime: 0.0,
    totalRaceTime: 0.0,
    lapTimes: [],
    raceFinished: false,
    finishTotalTime: null,
    bestLapTime: null,
    lastLapTime: null,
    sector: 6,
    bankDeg: 0.0,
    altitudeMm: 35.0,
    activeKeysStr: 'NONE',
    lastRoadTurnDeg: 0.0,
    lastSteerTurnDeg: 0.0,
    signedCurvature: 0.0,
    distToLeftRailMm: 9.0,
    distToRightRailMm: 9.0,
    railZone: 'TRACK',
    angledIntoRail: false,
    steeringAway: false,
    position: new THREE.Vector3(0, 0.035, 0.255),
    tangent: new THREE.Vector3(-1, 0, 0),
    right: new THREE.Vector3(0, 0, -1),
    normal: new THREE.Vector3(0, 1, 0),
    quaternion: new THREE.Quaternion(),
  };

  let onLapCompleteCallback = null;
  let onModeChangeCallback = null;
  let onRaceFinishCallback = null;
  let onRailImpactCallback = null;
  let onDriftBoostCallback = null;
  let onDriftTierCallback = null;
  const onResetCallbacks = [];

  function computeActiveKeysStr() {
    return (
      [keys.forward && 'W', keys.left && 'A', keys.backward && 'S', keys.right && 'D']
        .filter(Boolean)
        .join('+') || 'NONE'
    );
  }

  function computeRailZone(latOffset) {
    if (latOffset <= -(RAIL_LAT - 0.0001)) return 'L-RAIL';
    if (latOffset >= RAIL_LAT - 0.0001) return 'R-RAIL';
    if (latOffset <= -CURB_LAT) return 'L-CURB';
    if (latOffset >= CURB_LAT) return 'R-CURB';
    return 'TRACK';
  }

  /**
   * Updates 3D world position and right-handed basis quaternion (det = +1)
   * from the current spline arc-length `state.s`, `state.lateralOffset`, and `state.headingYaw`.
   */
  function syncPoseFromSpline() {
    const newFrame = sampleTrackAtArcLength(state.s);
    state.sector = newFrame.sector;
    state.bankDeg = newFrame.bankDeg;
    state.slope = newFrame.slope;
    state.curvature = Math.abs(newFrame.signedCurvature);
    state.signedCurvature = newFrame.signedCurvature;
    state.distToLeftRailMm = (state.lateralOffset + RAIL_LAT) * 1000;
    state.distToRightRailMm = (RAIL_LAT - state.lateralOffset) * 1000;
    state.railZone = computeRailZone(state.lateralOffset);
    state.activeKeysStr = computeActiveKeysStr();
    state.tangent.copy(newFrame.tangent);
    state.right.copy(newFrame.right);
    state.normal.copy(newFrame.normal);

    // Compute magnetic/aerodynamic downforce G-load (1.0G + speed^2 banking G)
    state.downforceG =
      1.0 +
      (state.speed * state.speed) / 0.26 +
      Math.abs(Math.sin(THREE.MathUtils.degToRad(newFrame.bankDeg))) * 0.65;

    // World 3D position = spline center + right * lateralOffset + normal * surfaceClearance
    const rumbleLift =
      state.curbRumble > 0
        ? Math.abs(Math.sin(state.s * 620.0)) * 0.00028 * state.curbRumble
        : 0.0;

    state.position
      .copy(newFrame.position)
      .addScaledVector(newFrame.right, state.lateralOffset)
      .addScaledVector(newFrame.normal, 0.0003 + rumbleLift);

    state.altitudeMm = Math.max(0, state.position.y * 1000.0);

    // Right-handed orthonormal basis: +X = left = normal x tangent, +Y = normal, +Z = tangent (det = +1)
    _left.crossVectors(newFrame.normal, newFrame.tangent).normalize();
    _rotMat.makeBasis(_left, newFrame.normal, newFrame.tangent);
    _baseQuat.setFromRotationMatrix(_rotMat);
    _yawQuat.setFromAxisAngle(newFrame.normal, state.headingYaw);
    state.quaternion.copy(_yawQuat.multiply(_baseQuat));
  }

  // Initialize exact right-handed pose at the Start/Finish gantry before frame 1
  syncPoseFromSpline();

  function setAutopilot(val) {
    const nextVal = Boolean(val);
    const changed = state.autopilot !== nextVal;
    state.autopilot = nextVal;
    if (nextVal) {
      state.victoryCruise = false;
      state.raceFinished = false;
      state.raceClockActive = false;
      state.totalRaceTime = 0.0;
      state.currentLapTime = 0.0;
      state.lapCount = 1;
      state.lapDistance = 0.0;
      state.lapTimes = [];
      state.finishTotalTime = null;
      state.cornerCleanTimer = 0.0;
      state.railImpactActive = false;
      state.railHitCooldown = 0.0;
      if (state.speed < 0.10) {
        state.speed = 0.187;
      }
    }
    if (changed && onModeChangeCallback) {
      onModeChangeCallback(nextVal);
    }
  }

  function teleportToSector(sectorNum) {
    const targetArc = sectorStartArcs[sectorNum] ?? sectorStartArcs[6] ?? 0.0;
    state.s = targetArc;
    state.lateralOffset = sectorNum === 6 ? getGridSlot(PLAYER_GRID_SLOT).lateralOffset : 0.0;
    state.lateralVel = 0.0;
    state.headingYaw = 0.0;
    state.turnRight = 0.0;
    state.steerSmooth = 0.0;
    state.steerAngle = 0.0;
    state.steerInput = 0.0;
    state.driftAngle = 0.0;
    state.isDrifting = false;
    state.driftDir = 0;
    state.driftChargeTimer = 0.0;
    state.driftCharge = 0.0;
    state.driftTier = 0;
    state.sparkTint = null;
    state.spinTimer = 0.0;
    state.spinYaw = 0.0;
    state.isDrifting = false;
    state.cornerCleanTimer = 0.0;
    state.railImpactActive = false;
    state.railHitCooldown = 0.0;
    state.angledIntoRail = false;
    state.steeringAway = false;
    state.lastRoadTurnDeg = 0.0;
    state.lastSteerTurnDeg = 0.0;
    state.boostActive = 0.0;
    state.lapDistance = 0.0;
    state.speed = state.autopilot || state.victoryCruise ? 0.187 : 0.0;
    syncPoseFromSpline();
  }

  function resetToStart() {
    state.victoryCruise = false;
    state.raceFinished = false;
    state.totalRaceTime = 0.0;
    state.currentLapTime = 0.0;
    state.lapCount = 1;
    state.lapDistance = 0.0;
    state.lapTimes = [];
    state.finishTotalTime = null;
    state.raceClockActive = false;
    state.countdownLocked = false;
    state.wasCountdownLocked = false;
    state.launchWindowTimer = 0.0;
    state.cornerCleanTimer = 0.0;
    state.railImpactActive = false;
    state.railHitCooldown = 0.0;
    state.angledIntoRail = false;
    state.steeringAway = false;
    teleportToSector(6);
    for (const cb of onResetCallbacks) cb();
  }

  /**
   * Continuous race distance in metres from the start/finish line
   * (negative on the grid, 3 * totalLength at the flag). Used to rank karts.
   */
  function getRaceProgress() {
    if (state.raceFinished && state.finishTotalTime !== null) return 3 * totalLength;
    let offset = (((state.s - startFinishArc) % totalLength) + totalLength) % totalLength;
    // Still on the grid side of the line for this lap (hasn't crossed yet)
    if (state.lapDistance < totalLength * 0.5 && offset > totalLength * 0.5) offset -= totalLength;
    return (state.lapCount - 1) * totalLength + offset;
  }

  function notifyLightsOut() {
    state.countdownLocked = false;
    state.wasCountdownLocked = false;
    state.raceClockActive = true;
    state.launchWindowTimer = 0.30;
    if (!state.autopilot && !state.victoryCruise && keys.forward) {
      state.boostActive = Math.max(state.boostActive, 0.75);
      state.launchWindowTimer = 0.0;
    }
  }

  function syncCombinedKeys() {
    keys.forward = Boolean(kbKeys.forward || touchKeys.forward);
    keys.backward = Boolean(kbKeys.backward || touchKeys.backward);
    keys.left = Boolean(kbKeys.left || touchKeys.left);
    keys.right = Boolean(kbKeys.right || touchKeys.right);
    keys.drift = Boolean(kbKeys.drift || touchKeys.drift);
    state.activeKeysStr = computeActiveKeysStr();
  }

  function setTouchKey(dir, isDown) {
    if (!(dir in touchKeys)) return;
    const nextDown = Boolean(isDown);
    touchKeys[dir] = nextDown;
    if (nextDown && state.autopilot) {
      setAutopilot(false);
    }
    syncCombinedKeys();
  }

  function clearTouchKeys() {
    touchKeys.forward = false;
    touchKeys.backward = false;
    touchKeys.left = false;
    touchKeys.right = false;
    touchKeys.drift = false;
    syncCombinedKeys();
  }

  // Pure Grip Racing (W/A/S/D or Arrow Keys only, plus P for Autopilot and R for Reset)
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('keydown', (e) => {
      if (e.target && ['INPUT', 'TEXTAREA'].includes(e.target.tagName) && !e.target.readOnly) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const code = e.code;
      if (code === 'KeyW' || code === 'ArrowUp') {
        kbKeys.forward = true;
        if (state.autopilot) setAutopilot(false);
      } else if (code === 'KeyS' || code === 'ArrowDown') {
        kbKeys.backward = true;
        if (state.autopilot) setAutopilot(false);
      } else if (code === 'KeyA' || code === 'ArrowLeft') {
        kbKeys.left = true;
        if (state.autopilot) setAutopilot(false);
      } else if (code === 'KeyD' || code === 'ArrowRight') {
        kbKeys.right = true;
        if (state.autopilot) setAutopilot(false);
      } else if (code === 'Space' || code === 'ShiftLeft' || code === 'ShiftRight') {
        e.preventDefault();
        kbKeys.drift = true;
      } else if (code === 'KeyP') {
        setAutopilot(!state.autopilot);
      } else if (code === 'KeyR') {
        resetToStart();
      }
      syncCombinedKeys();
    });

    window.addEventListener('keyup', (e) => {
      const code = e.code;
      if (code === 'KeyW' || code === 'ArrowUp') kbKeys.forward = false;
      else if (code === 'KeyS' || code === 'ArrowDown') kbKeys.backward = false;
      else if (code === 'KeyA' || code === 'ArrowLeft') kbKeys.left = false;
      else if (code === 'KeyD' || code === 'ArrowRight') kbKeys.right = false;
      else if (code === 'Space' || code === 'ShiftLeft' || code === 'ShiftRight') kbKeys.drift = false;
      syncCombinedKeys();
    });

    window.addEventListener('blur', () => {
      kbKeys.forward = false;
      kbKeys.backward = false;
      kbKeys.left = false;
      kbKeys.right = false;
      kbKeys.drift = false;
      clearTouchKeys();
    });
  }

  // -------------------------------------------------------------------------
  // 60FPS PHYSICS STEP
  // -------------------------------------------------------------------------
  function stepPhysics(dt) {
    const clampedDt = Math.min(dt, 0.05);
    const frame = sampleTrackAtArcLength(state.s);
    state.activeKeysStr = computeActiveKeysStr();
    state.signedCurvature = frame.signedCurvature;

    // Calibrated speeds in real meters/second (1:150 N-scale: ~15% reduction from 1:87 to balance lower eye-height optical flow)
    const manualMaxSpeed = 0.195 * state.topSpeedMultiplier;
    const boostMaxSpeed = 0.289 * state.topSpeedMultiplier;
    const autopilotCruiseSpeed = 0.204 * state.topSpeedMultiplier;
    const manualAccel = 0.204; // Smooth progressive acceleration (0 -> top speed in ~1.0s)

    if (state.railHitCooldown > 0) {
      state.railHitCooldown = Math.max(0.0, state.railHitCooldown - clampedDt);
    }

    // Track F1 5-light countdown lights-out transition for F1 Grid Launch Surge (0.30s window)
    if (state.countdownLocked) {
      state.wasCountdownLocked = true;
      state.launchWindowTimer = 0.0;
    } else if (state.wasCountdownLocked) {
      state.wasCountdownLocked = false;
      state.launchWindowTimer = 0.30;
    }

    if (state.launchWindowTimer > 0) {
      if (!state.autopilot && !state.victoryCruise && keys.forward) {
        state.boostActive = Math.max(state.boostActive, 0.75);
        state.launchWindowTimer = 0.0;
      } else {
        state.launchWindowTimer = Math.max(0.0, state.launchWindowTimer - clampedDt);
      }
    }

    const isAiCruise = state.autopilot;
    let throttle = 0.0;
    let turnRight = 0.0;

    if (isAiCruise) {
      // Smooth Cinematic AI Coaster Cruise (~75 km/h on straights, pulled back smoothly around Cat & Lamp curves)
      throttle = 1.0;
      const idealApexOffset = THREE.MathUtils.clamp(
        -frame.signedCurvature * 0.0005,
        -0.0014,
        0.0014
      );
      const latError = idealApexOffset - state.lateralOffset;
      turnRight = THREE.MathUtils.clamp(latError * 36.0, -0.35, 0.35);
      state.steerSmooth = turnRight;

      const targetAutoYaw = THREE.MathUtils.clamp(-turnRight * 0.14, -0.14, 0.14);
      const yawAlpha = 1.0 - Math.exp(-10.5 * clampedDt);
      state.headingYaw = THREE.MathUtils.lerp(state.headingYaw, targetAutoYaw, yawAlpha);

      // Auto-drift with sparks inside the Cat 360° Helix (Sector 2), Lamp Corkscrew (Sector 4), and Mouse C-turn (Sector 5)
      const driftAlpha = 1.0 - Math.exp(-8.0 * clampedDt);
      if (Math.abs(frame.signedCurvature) > 0.52 && state.speed > 0.10) {
        state.isDrifting = true;
        state.driftDir = Math.sign(frame.signedCurvature) || 1;
        state.driftAngle = THREE.MathUtils.lerp(
          state.driftAngle,
          -state.driftDir * 0.20,
          driftAlpha
        );
        state.boostCharge = Math.min(1.0, state.boostCharge + clampedDt * 0.28);
      } else {
        state.isDrifting = false;
        state.driftDir = 0;
        state.driftAngle = THREE.MathUtils.lerp(state.driftAngle, 0.0, driftAlpha);
      }

      if (frame.sector === 6 && state.boostCharge > 0.45) {
        // Fire gentle turbo boost ONLY on Sector 6 Logitech G915 straightaway in Autopilot
        state.boostActive = 0.45;
        state.boostCharge = Math.max(0.2, state.boostCharge - clampedDt * 0.35);
      }
    } else if (state.raceFinished) {
      // Post-finish stop: lock out manual throttle/steering and gently straighten the car as it brakes to a stop
      throttle = 0.0;
      turnRight = 0.0;
      state.boostActive = 0.0;
      state.isDrifting = false;
      state.driftDir = 0;
      const stopAlpha = 1.0 - Math.exp(-8.0 * clampedDt);
      state.headingYaw = THREE.MathUtils.lerp(state.headingYaw, 0.0, stopAlpha);
      state.driftAngle = THREE.MathUtils.lerp(state.driftAngle, 0.0, stopAlpha);
    } else {
      // Manual Player Control (Pure Grip W/A/S/D or Arrow Keys)
      if (keys.forward) throttle += 1.0;
      if (keys.backward) throttle -= 1.0;
      turnRight = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
    }

    // Spun out by a hazard: no control until the kart recovers
    if (state.spinTimer > 0) {
      state.spinTimer = Math.max(0, state.spinTimer - clampedDt);
      state.spinYaw += clampedDt * 15.0 * Math.min(1, state.spinTimer / 0.25 + 0.2);
      if (state.spinTimer === 0) state.spinYaw = 0;
      throttle = 0;
      turnRight = 0;
    }

    if (state.boostActive > 0) {
      state.boostActive = Math.max(0.0, state.boostActive - clampedDt);
    } else if (!state.isDrifting) {
      // Passive ambient trickle charge
      state.boostCharge = Math.min(1.0, state.boostCharge + clampedDt * 0.06);
    }

    // Longitudinal speed update
    const slopeSpeedDelta = computeSlopeSpeedDelta(frame);

    if (state.spinTimer > 0) {
      state.speed = THREE.MathUtils.lerp(state.speed, 0.03, 1.0 - Math.exp(-3.0 * clampedDt));
    } else if (isAiCruise) {
      const cornerSpeedFactor = computeCruiseSpeedFactor(state.s, frame);

      const baseAutoSpeed = autopilotCruiseSpeed * cornerSpeedFactor;
      const targetAutoSpeed =
        state.boostActive > 0 && (frame.sector === 6 || state.victoryCruise)
          ? boostMaxSpeed * 0.88
          : baseAutoSpeed;
      const gravitySlopeAccel = -frame.slope * 0.16;
      const speedErr = targetAutoSpeed - state.speed;
      const autoAccel = THREE.MathUtils.clamp(speedErr * 4.2, -0.95, 0.48);
      state.speed += (autoAccel + gravitySlopeAccel) * clampedDt;
      state.speed = THREE.MathUtils.clamp(state.speed, 0.0, boostMaxSpeed);
    } else {
      // Manual mode: NO scripted Cat Helix or Lamp Corkscrew speed caps — player controls their own cornering speed!
      const dynamicManualTopFactor = THREE.MathUtils.clamp(
        1.0 + slopeSpeedDelta * 0.45,
        0.88,
        1.10
      );
      const currentManualMaxSpeed =
        (state.boostActive > 0 ? boostMaxSpeed : manualMaxSpeed) * dynamicManualTopFactor;
      if (throttle === 0) {
        // Auto-Hold Parking Brake when neither W/Up nor S/Down is held:
        // Decelerate smoothly at 1.6 m/s² to 0.0 m/s
        const brakeDecel = 1.6 * clampedDt;
        if (Math.abs(state.speed) <= brakeDecel) {
          state.speed = 0.0;
        } else {
          state.speed -= Math.sign(state.speed) * brakeDecel;
        }
        if (Math.abs(state.speed) < 0.008) {
          state.speed = 0.0;
        }
      } else {
        const gravitySlopeAccel = -frame.slope * 0.22;
        let engineAccel = 0.0;
        if (throttle > 0) {
          // If currently moving backward, brake briskly first, then accelerate at manualAccel (0.204 m/s²)
          engineAccel =
            state.speed < -0.01
              ? 1.25 * throttle
              : (state.boostActive > 0 ? 0.36 : manualAccel) * throttle;
        } else {
          // Pressing S / Down: brake briskly if moving forward, or reverse gently
          engineAccel = state.speed > 0.01 ? 1.35 * throttle : 0.19 * throttle;
        }
        state.speed += (engineAccel + gravitySlopeAccel) * clampedDt;
        if (state.speed > currentManualMaxSpeed) {
          state.speed = THREE.MathUtils.lerp(
            state.speed,
            currentManualMaxSpeed,
            1.0 - Math.exp(-8.5 * clampedDt)
          );
        } else {
          state.speed = Math.max(-0.12 * state.topSpeedMultiplier, state.speed);
        }
      }
    }

    if (state.countdownLocked) {
      state.speed = 0.0;
    }

    const apexFactor = isAiCruise
      ? 1.0
      : THREE.MathUtils.clamp(
          1.0 - frame.signedCurvature * state.lateralOffset * 16.0,
          0.88,
          1.14
        );

    // 1. Damped Curvature-Matched Heading Model (Zero Ping-Pong, Active Steering Required in Corners)
    if (!isAiCruise) {
      const prevYaw = state.headingYaw;
      state.steerSmooth = THREE.MathUtils.lerp(
        state.steerSmooth,
        turnRight,
        1.0 - Math.exp(-(turnRight !== 0 ? 16.0 : 20.0) * clampedDt)
      );

      // Speed factor so the kart doesn't spin in place at 35° while accelerating from low speed
      const speedRatio = THREE.MathUtils.clamp(Math.abs(state.speed) / manualMaxSpeed, 0.0, 1.15);
      const steerSpeedFactor = THREE.MathUtils.clamp(Math.abs(state.speed) / 0.11, 0.25, 1.0);

      // Natural outward drift angle caused by track curvature when NOT steering (W only):
      // Right turn (signedCurvature > 0) -> positive headingYaw (drifts left into outside L-RAIL).
      // Left turn (signedCurvature < 0)  -> negative headingYaw (drifts right into outside R-RAIL).
      // Smoothly saturates via tanh so extreme spiral hairpins (|curv| ~ 5.4) never overpower player steering.
      const roadDriftYaw = Math.tanh(frame.signedCurvature * 0.55) * 0.29 * Math.max(0.25, speedRatio);

      // Check if player is steering WITH the corner (D in right turn, A in left turn)
      const isSteeringWithCorner = turnRight !== 0 && turnRight * frame.signedCurvature > 0.20;
      const isWrongWaySteer = turnRight !== 0 && turnRight * frame.signedCurvature < -0.20;

      // Inside-apex racing-line stabilizer: when steering WITH the corner (e.g. holding D in a right turn),
      // guide the kart smoothly onto the 6.0mm inside apex line (just inside the 7.8mm FIA curb)
      // so holding D through a sweeping right turn hugs the clean apex instead of crashing into the inside rail!
      const insideProgress = turnRight * state.lateralOffset;
      const apexTargetOffset = CURB_LAT - 0.0020; // Ideal inside racing line, 2mm inside the curb

      // ---- Manual power-slide (hold Space/Shift + steer) ----
      if (!state.isDrifting) {
        if (keys.drift && turnRight !== 0 && state.speed > 0.09 && state.spinTimer <= 0 && !state.countdownLocked) {
          state.isDrifting = true;
          state.driftDir = Math.sign(turnRight);
          state.driftCharge = 0.0;
          state.driftTier = 0;
          state.hopVel = 0.03; // little hop into the slide
          if (state.hopHeight <= 0) state.hopHeight = 0.00001;
        }
      } else if (!keys.drift || state.speed < 0.07 || state.spinTimer > 0) {
        // Release: fire the mini-turbo for whatever tier was reached
        const tier = state.spinTimer > 0 ? 0 : state.driftTier;
        state.isDrifting = false;
        state.driftCharge = 0.0;
        state.driftTier = 0;
        if (tier > 0) {
          state.boostActive = Math.max(state.boostActive, [0, 0.55, 1.0, 1.55][tier]);
          if (onDriftBoostCallback) onDriftBoostCallback(tier);
        }
      } else {
        const tighten = turnRight * state.driftDir; // +1 tightening, -1 widening, 0 neutral
        state.driftCharge += clampedDt * (tighten > 0 ? 1.15 : tighten < 0 ? 0.7 : 0.9);
        const prevTier = state.driftTier;
        state.driftTier = state.driftCharge >= 2.0 ? 3 : state.driftCharge >= 1.2 ? 2 : state.driftCharge >= 0.55 ? 1 : 0;
        if (state.driftTier > prevTier && onDriftTierCallback) onDriftTierCallback(state.driftTier);
      }

      let targetYaw = 0.0;
      if (state.isDrifting) {
        const tighten = turnRight * state.driftDir;
        const slideMag = 0.17 + 0.09 * tighten;
        targetYaw = roadDriftYaw * 0.55 - state.driftDir * slideMag * steerSpeedFactor;
      } else if (turnRight === 0) {
        // Holding W only (no steering): kart fails to turn with the corner and drifts outward into the outside rail!
        targetYaw = roadDriftYaw;
      } else if (isSteeringWithCorner) {
        // Steering into the corner cancels outward road drift and carves onto the 5.8mm inside apex line
        const distToApex = apexTargetOffset - insideProgress;
        const apexSteerFactor = THREE.MathUtils.clamp(distToApex / 0.0045, -0.45, 1.0);
        const inwardCarveYaw = -state.steerSmooth * 0.21 * steerSpeedFactor * apexSteerFactor;
        targetYaw = roadDriftYaw * (1.0 - Math.abs(state.steerSmooth)) + inwardCarveYaw;
      } else if (isWrongWaySteer) {
        // Steering toward the outside wall in a corner adds to outward drift
        targetYaw = roadDriftYaw - state.steerSmooth * 0.20 * steerSpeedFactor;
      } else {
        // Straightaway or gentle transition steering (~10.5° max lane-change angle)
        targetYaw = roadDriftYaw - state.steerSmooth * 0.185 * steerSpeedFactor;
      }

      targetYaw = THREE.MathUtils.clamp(targetYaw, -0.34, 0.34);

      // Fast yaw response when steering or releasing keys so the kart never slingshots across the track
      const yawResponseRate = turnRight !== 0 ? 11.5 : 10.5;
      const nextYaw = THREE.MathUtils.lerp(
        prevYaw,
        targetYaw,
        1.0 - Math.exp(-yawResponseRate * clampedDt)
      );

      // Decompose per-step road vs steer yaw contribution for live telemetry logging
      const roadOnlyYaw = THREE.MathUtils.lerp(
        prevYaw,
        roadDriftYaw,
        1.0 - Math.exp(-yawResponseRate * clampedDt)
      );
      const roadStepRad = roadOnlyYaw - prevYaw;
      const steerStepRad = nextYaw - roadOnlyYaw;

      state.headingYaw = THREE.MathUtils.clamp(nextYaw, -0.42, 0.42);
      state.lastRoadTurnDeg = (roadStepRad * 180) / Math.PI;
      state.lastSteerTurnDeg = (steerStepRad * 180) / Math.PI;
    } else {
      state.lastRoadTurnDeg = 0.0;
      state.lastSteerTurnDeg = 0.0;
    }

    state.turnRight = turnRight;
    state.steerAngle = -(isAiCruise ? turnRight : state.steerSmooth) * 0.45; // +0.45 rad for Left (A), -0.45 rad for Right (D)
    state.steerInput = THREE.MathUtils.lerp(
      state.steerInput,
      turnRight,
      1.0 - Math.exp(-12.0 * clampedDt)
    );

    if (!isAiCruise) {
      // Drift visuals: body kicks out, sparks change colour with the charge tier
      if (state.isDrifting) {
        state.driftAngle = THREE.MathUtils.lerp(
          state.driftAngle,
          -state.driftDir * 0.34,
          1.0 - Math.exp(-10.0 * clampedDt)
        );
        state.sparkTint = [
          [1.0, 0.92, 0.75],
          [0.35, 0.7, 1.0],
          [1.0, 0.55, 0.1],
          [1.0, 0.3, 0.95],
        ][state.driftTier];
      } else {
        state.sparkTint = null;
        state.driftAngle = THREE.MathUtils.lerp(
          state.driftAngle,
          0.0,
          1.0 - Math.exp(-11.0 * clampedDt)
        );
      }

      // Clean Apex Exit Surge: reward carving a curve cleanly without hitting the guardrail
      if (
        state.railImpactActive ||
        state.speed <= 0.08 ||
        Math.abs(state.lateralOffset) >= RAIL_LAT - 0.0001
      ) {
        state.cornerCleanTimer = 0.0;
      } else if (
        Math.abs(frame.signedCurvature) > 0.35 &&
        state.speed > 0.11 &&
        Math.abs(state.lateralOffset) < RAIL_LAT - 0.0005 &&
        !state.railImpactActive
      ) {
        state.cornerCleanTimer += clampedDt;
      } else if (Math.abs(frame.signedCurvature) < 0.26) {
        state.cornerCleanTimer = Math.max(0.0, state.cornerCleanTimer - clampedDt * 2.0);
      }
    }

    // 2. Pure Nose-Driven Lateral Velocity (zero sideways magnet pull)
    let lateralDot = 0.0;
    if (isAiCruise) {
      lateralDot =
        state.speed * (-Math.sin(state.headingYaw)) +
        turnRight * 0.024 * (0.35 + 0.65 * Math.min(1.0, Math.abs(state.speed) / 0.10));
    } else {
      lateralDot = state.speed * (-Math.sin(state.headingYaw)) * 0.82;
    }
    state.lateralVel = lateralDot;
    state.lateralOffset += lateralDot * clampedDt;

    // 3. Two-Stage Curb Warning & Outside-Guardrail Impact / Pinning Stop
    state.curbRumble = 0.0;
    const absLat = Math.abs(state.lateralOffset);
    const signLatCurrent = Math.sign(state.lateralOffset) || 1;
    // Determine if this rail is the INSIDE apex of a corner (e.g. R-RAIL in a right turn, or L-RAIL in a left turn)
    const isInsideApexRail =
      Math.abs(frame.signedCurvature) > 0.35 &&
      signLatCurrent * frame.signedCurvature > 0;
    state.angledIntoRail =
      absLat >= CURB_LAT &&
      !isInsideApexRail &&
      ((signLatCurrent > 0 && state.headingYaw < -0.05) ||
        (signLatCurrent < 0 && state.headingYaw > 0.05));
    state.steeringAway =
      absLat >= CURB_LAT &&
      ((signLatCurrent > 0 && turnRight < 0) || (signLatCurrent < 0 && turnRight > 0));

    if (absLat < RAIL_LAT - 0.0004) {
      state.railImpactActive = false;
    }

    if (absLat >= CURB_LAT && absLat < RAIL_LAT) {
      // Stage 1 — Red/White Curbs
      state.curbRumble = THREE.MathUtils.clamp((absLat - CURB_LAT) / (RAIL_LAT - CURB_LAT), 0.0, 1.0);
      if (!isAiCruise && !isInsideApexRail) {
        state.speed *= 1.0 - 0.08 * state.curbRumble * clampedDt;
      }
    } else if (absLat >= RAIL_LAT) {
      // Stage 2 — Guardrail contact. The rail is a cushioned barrier: it deflects the kart back
      // onto the road with a spark-throwing scrape and scrubs some speed, but never pins or stops it.
      const signLat = Math.sign(state.lateralOffset) || 1;
      state.lateralOffset = signLat * RAIL_LAT;
      state.lateralVel = 0.0;

      if (!isAiCruise) {
        const insideApexContact =
          Math.abs(frame.signedCurvature) > 0.35 && signLat * frame.signedCurvature > 0;
        const steeringAway =
          (signLat > 0 && turnRight < 0) || (signLat < 0 && turnRight > 0);
        const steeringIntoWall =
          (signLat > 0 && turnRight > 0) || (signLat < 0 && turnRight < 0);
        state.angledIntoRail = false;
        state.railImpactActive = false;
        state.steeringAway = steeringAway;

        if (insideApexContact && !steeringIntoWall) {
          // Gliding along the INSIDE apex of a corner: align nose parallel to the curb without losing speed
          state.lateralOffset = signLat * (RAIL_LAT - 0.0005);
          state.headingYaw = signLat > 0
            ? Math.max(0.0, state.headingYaw)
            : Math.min(0.0, state.headingYaw);
          state.curbRumble = 0.5;
        } else {
          // Angle (rad) at which the nose points into the barrier
          const incidence = Math.max(0.0, -signLat * state.headingYaw);
          // Bounce the nose back toward the centre of the road; harder hits bounce further
          const bounceYaw = THREE.MathUtils.clamp(0.05 + incidence * 0.55, 0.05, steeringAway ? 0.20 : 0.15);
          state.headingYaw = signLat * bounceYaw;
          state.lateralOffset = signLat * (RAIL_LAT - 0.0003);
          state.curbRumble = 0.85;
          state.isDrifting = true; // Throw sparks off the rail
          state.driftDir = -signLat;
          // Grinding along the barrier is forgiving but slow: continuous friction while in contact
          state.speed = Math.max(0.0, state.speed - RAIL_SCRAPE_DRAG * clampedDt);

          if (state.railHitCooldown <= 0.0) {
            state.railHitCooldown = 0.25;
            // ~4% scrub for a brush, up to ~22% for a head-on smack
            const scrub = THREE.MathUtils.clamp(0.04 + incidence * 0.75, 0.04, 0.22);
            state.speed *= 1.0 - scrub;
            state.cornerCleanTimer = 0.0;
            if (incidence > 0.15) state.boostActive = 0.0;
            state.hopVel = Math.max(state.hopVel, 0.004 + incidence * 0.01);
            if (onRailImpactCallback) {
              onRailImpactCallback(THREE.MathUtils.clamp(0.22 + incidence * 1.6, 0.22, 0.85));
            }
          }
        }
      }
    }

    // Advance arc-length s along periodic loop projected by cos(headingYaw) and inside-apex racing line factor
    const prevS = state.s;
    const forwardProjection = isAiCruise ? 1.0 : Math.max(0.0, Math.cos(state.headingYaw));
    const ds = (state.speed * forwardProjection * clampedDt) / apexFactor;
    state.s = ((state.s + ds) % totalLength + totalLength) % totalLength;

    // Continuous 3-Lap Total Race Clock & Lap Completion (Manual Mode only; NEVER advances in Autopilot P)
    if (state.autopilot) {
      state.raceClockActive = false;
      state.currentLapTime = 0.0;
      state.totalRaceTime = 0.0;
      state.lapCount = 1;
      state.lapDistance = 0.0;
    } else if (!state.victoryCruise && !state.raceFinished) {
      if (state.currentLapTime > 0 && state.totalRaceTime < state.currentLapTime) {
        state.totalRaceTime = state.currentLapTime;
      }
      if (!state.countdownLocked && Math.abs(state.speed) > 0.005) {
        state.raceClockActive = true;
      }
      if (!state.countdownLocked && state.raceClockActive) {
        state.currentLapTime += clampedDt;
        state.totalRaceTime += clampedDt;
      }
      state.lapDistance += ds;
      if (state.speed > 0 && state.currentLapTime > 2.5 && state.lapDistance > totalLength * 0.5) {
        const distBefore =
          ((startFinishArc - prevS) % totalLength + totalLength) % totalLength;
        if (distBefore > 0 && distBefore <= ds * 1.5) {
          state.lastLapTime = state.currentLapTime;
          if (state.bestLapTime === null || state.lastLapTime < state.bestLapTime) {
            state.bestLapTime = state.lastLapTime;
          }
          state.lapTimes.push(state.lastLapTime);
          state.currentLapTime = 0.0;
          state.lapDistance = 0.0;

          if (state.lapCount < 3) {
            const completedLap = state.lapCount;
            state.lapCount += 1;
            if (onLapCompleteCallback) {
              onLapCompleteCallback(
                state.lastLapTime,
                state.bestLapTime,
                completedLap,
                state.totalRaceTime,
                false
              );
            }
          } else {
            state.finishTotalTime = state.totalRaceTime;
            state.raceFinished = true;
            state.raceClockActive = false;
            state.victoryCruise = false;
            state.boostActive = 0.0;
            if (onLapCompleteCallback) {
              onLapCompleteCallback(
                state.lastLapTime,
                state.bestLapTime,
                3,
                state.finishTotalTime,
                true
              );
            }
            if (onRaceFinishCallback) {
              onRaceFinishCallback(
                state.finishTotalTime,
                state.lapTimes.slice(),
                state.bestLapTime
              );
            }
          }
        }
      }
    }

    // Vertical hop suspension spring
    if (state.hopHeight > 0 || state.hopVel !== 0) {
      state.hopHeight += state.hopVel * clampedDt;
      state.hopVel -= 0.18 * clampedDt;
      if (state.hopHeight <= 0) {
        state.hopHeight = 0;
        state.hopVel = 0;
      }
    }

    // Re-evaluate exact 3D pose & right-handed orientation quaternion on the banked spline
    syncPoseFromSpline();

    return state;
  }

  return {
    world,
    state,
    keys,
    stepPhysics,
    sampleTrackAtArcLength,
    teleportToSector,
    resetToStart,
    setAutopilot,
    setTouchKey,
    clearTouchKeys,
    notifyLightsOut,
    onLapComplete: (cb) => {
      onLapCompleteCallback = cb;
    },
    onModeChange: (cb) => {
      onModeChangeCallback = cb;
    },
    onRaceFinish: (cb) => {
      onRaceFinishCallback = cb;
    },
    onRailImpact: (cb) => {
      onRailImpactCallback = cb;
    },
    onReset: (cb) => {
      onResetCallbacks.push(cb);
    },
    onDriftBoost: (cb) => {
      onDriftBoostCallback = cb;
    },
    onDriftTier: (cb) => {
      onDriftTierCallback = cb;
    },
    /** Turbo from a boost pad or item (seconds). */
    addBoost(seconds) {
      if (state.spinTimer > 0) return;
      state.boostActive = Math.max(state.boostActive, seconds);
    },
    /** Spin the player out (hazard hit). */
    spinOut(seconds = 0.9) {
      state.spinTimer = Math.max(state.spinTimer, seconds);
      state.boostActive = 0.0;
    },
    totalLength,
    startFinishArc,
    gridSize: GRID_ROWS * 2,
    playerGridSlot: PLAYER_GRID_SLOT,
    getGridSlot,
    getRaceProgress,
    computeCruiseSpeedFactor,
    aiPace: splineData.ai_pace ?? 1.0,
    curbLateral: CURB_LAT,
    railLateral: RAIL_LAT,
  };
}
