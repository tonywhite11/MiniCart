import * as THREE from 'three';

/**
 * Turns a hand-authored list of control points into the evenly-sampled, banked
 * spline table the physics, AI, track mesh and minimap all consume.
 *
 * Output format (compatible with the original track_spline.json):
 *   { name, track_width_m, curb_width_m, rail_height_m, total_length_m,
 *     start_finish_index: 0, samples: [{ position, tangent, normal, right,
 *     bank_deg, sector, arc_length_m, curvature, radius_m }] }
 *
 * - Closed centripetal Catmull-Rom through the points (no overshoot/cusps)
 * - Resampled at equal arc-length steps, then lightly smoothed
 * - Frames: up-aligned (no twisting), banked into corners from curvature, capped
 * - Sample 0 is the start/finish line
 */
export function generateTrack(def) {
  const width = def.width || 0.034;
  const maxBankDeg = def.maxBankDeg ?? 14;
  const bankGain = def.bankGain ?? 2.6; // degrees per (1/m) of curvature

  const pts = def.points.map((p) => new THREE.Vector3(p[0], p[1], p[2]));
  const curve = new THREE.CatmullRomCurve3(pts, true, 'centripetal', 0.5);
  // ~5mm between samples keeps the physics' curvature/drift tuning identical on every track
  const N = def.samples || Math.max(360, Math.round(curve.getLength() / 0.005));

  // 1. Dense polyline → equal arc-length resample
  const dense = curve.getSpacedPoints(N * 8);
  dense.pop(); // closed: last == first
  const denseLen = [0];
  for (let i = 1; i <= dense.length; i++) {
    denseLen.push(denseLen[i - 1] + dense[i % dense.length].distanceTo(dense[i - 1]));
  }
  const totalDense = denseLen[dense.length];
  let positions = [];
  let j = 0;
  for (let i = 0; i < N; i++) {
    const target = (i / N) * totalDense;
    while (denseLen[j + 1] < target) j++;
    const a = dense[j];
    const b = dense[(j + 1) % dense.length];
    const t = (target - denseLen[j]) / Math.max(1e-9, denseLen[j + 1] - denseLen[j]);
    positions.push(a.clone().lerp(b, t));
  }

  // 2. Light smoothing (keeps the shape, removes knot kinks)
  for (let pass = 0; pass < 3; pass++) {
    positions = positions.map((p, i) => {
      const prev = positions[(i - 1 + N) % N];
      const next = positions[(i + 1) % N];
      return p.clone().multiplyScalar(0.5).addScaledVector(prev, 0.25).addScaledVector(next, 0.25);
    });
  }

  // 3. Arc length + tangents
  const arc = new Float64Array(N + 1);
  for (let i = 1; i <= N; i++) arc[i] = arc[i - 1] + positions[i % N].distanceTo(positions[i - 1]);
  const totalLength = arc[N];
  const tangents = positions.map((_, i) =>
    positions[(i + 1) % N].clone().sub(positions[(i - 1 + N) % N]).normalize()
  );

  // 4. Signed horizontal curvature (1/m, + = turning right) from a ±k sample stencil
  const k = Math.max(2, Math.round(N / 180));
  const up = new THREE.Vector3(0, 1, 0);
  const curvRaw = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const t0 = tangents[(i - k + N) % N];
    const t1 = tangents[(i + k) % N];
    const h0 = Math.atan2(t0.x, t0.z);
    const h1 = Math.atan2(t1.x, t1.z);
    let dh = h1 - h0;
    while (dh > Math.PI) dh -= Math.PI * 2;
    while (dh < -Math.PI) dh += Math.PI * 2;
    const ds = arc[Math.min(N, i + k)] - arc[Math.max(0, i - k)] || (2 * k * totalLength) / N;
    // heading = atan2(x, z): increasing heading turns toward -X when facing +Z, i.e. LEFT with right = t × up
    curvRaw[i] = -dh / ds;
  }
  const curvature = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    let sum = 0;
    let wsum = 0;
    for (let o = -6; o <= 6; o++) {
      const w = 7 - Math.abs(o);
      sum += curvRaw[(i + o + N) % N] * w;
      wsum += w;
    }
    curvature[i] = sum / wsum;
  }

  // 5. Banked frames
  const samples = [];
  let minRadius = Infinity;
  const sectors = def.sectors || 6;
  for (let i = 0; i < N; i++) {
    const tangent = tangents[i];
    const flatRight = new THREE.Vector3().crossVectors(tangent, up).normalize();
    const flatNormal = new THREE.Vector3().crossVectors(flatRight, tangent).normalize();
    // Bank so the OUTSIDE of the corner is raised: right turn (curv > 0) lifts the left edge
    const bankDeg = THREE.MathUtils.clamp(curvature[i] * bankGain, -maxBankDeg, maxBankDeg);
    const q = new THREE.Quaternion().setFromAxisAngle(tangent, THREE.MathUtils.degToRad(bankDeg));
    const right = flatRight.clone().applyQuaternion(q).normalize();
    const normal = flatNormal.clone().applyQuaternion(q).normalize();
    const radius = Math.abs(curvature[i]) > 1e-6 ? 1 / Math.abs(curvature[i]) : Infinity;
    minRadius = Math.min(minRadius, radius);

    samples.push({
      position: positions[i].toArray(),
      tangent: tangent.toArray(),
      normal: normal.toArray(),
      right: right.toArray(),
      bank_deg: bankDeg,
      sector: 1 + Math.min(sectors - 1, Math.floor((i / N) * sectors)),
      arc_length_m: arc[i],
      curvature: curvature[i],
      radius_m: radius,
    });
  }

  const halfWidth = width * 0.5;
  if (minRadius < halfWidth * 3) {
    console.warn(
      `[TrackGenerator] "${def.name}" tightest corner radius ${(minRadius * 1000).toFixed(0)}mm ` +
        `is under 3x the road half-width (${(halfWidth * 3000).toFixed(0)}mm) — inner edge may pinch.`
    );
  }

  return {
    name: def.name,
    is_closed_periodic_loop: true,
    track_width_m: width,
    curb_width_m: def.curbWidth || width * 0.09,
    rail_height_m: def.railHeight || 0.003,
    total_length_m: totalLength,
    num_samples: N,
    start_finish_index: 0,
    ai_pace: def.aiPace ?? 1.0,
    min_radius_m: minRadius,
    samples,
  };
}
