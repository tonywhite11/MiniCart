import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import { buildMicroKart } from './scene/MicroKartBuilder.js';
import { createKartPhysicsController } from './physics/KartPhysicsController.js';
import { createWebAudioSynth } from './audio/WebAudioSynth.js';
import { createRivalField, cloneKartTemplate, ordinalSuffix } from './race/RivalKarts.js';
import { generateTrack } from './tracks/TrackGenerator.js';
import { TRACK_DEFS, WORLD_ORDER } from './tracks/trackDefs.js';
import { buildTrackMesh } from './tracks/TrackMeshBuilder.js';
import { WORLDS } from './worlds/index.js';
import { initSpeedometer } from './game/speedometer.js';
import { DIFFICULTY_LEVELS, loadProgress, saveProgress } from './game/difficulty.js';

const WORLD_STORAGE_KEY = 'minicart.world';
const KART_SCALE = 0.38;

function pickWorldKey() {
  const fromUrl = new URLSearchParams(window.location.search).get('world');
  if (fromUrl && WORLDS[fromUrl]) return fromUrl;
  try {
    const saved = window.localStorage.getItem(WORLD_STORAGE_KEY);
    if (saved && WORLDS[saved]) return saved;
  } catch {
    // Storage unavailable (private mode): fall back to the default world
  }
  return WORLD_ORDER[0];
}

function switchWorld(key) {
  try {
    window.localStorage.setItem(WORLD_STORAGE_KEY, key);
  } catch {
    // Ignore storage errors; the URL carries the choice
  }
  const url = new URL(window.location.href);
  url.searchParams.set('world', key);
  window.location.href = url.toString();
}

async function initGame() {
  const worldKey = pickWorldKey();
  const world = WORLDS[worldKey];

  // ---------------------------------------------------------------------------
  // 1. Renderer, scene, camera, post-processing
  // ---------------------------------------------------------------------------
  const container = document.getElementById('canvas-container');
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = world.exposure ?? 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(56, window.innerWidth / window.innerHeight, 0.002, 60);

  const composerTarget = new THREE.WebGLRenderTarget(window.innerWidth, window.innerHeight, {
    type: THREE.HalfFloatType,
    samples: 4,
  });
  const composer = new EffectComposer(renderer, composerTarget);
  composer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  composer.addPass(new RenderPass(scene, camera));
  const bloom = world.bloom || { strength: 0.2, radius: 0.4, threshold: 0.9 };
  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    bloom.strength,
    bloom.radius,
    bloom.threshold
  );
  composer.addPass(bloomPass);
  composer.addPass(new OutputPass());

  // ---------------------------------------------------------------------------
  // 2. Track + world
  // ---------------------------------------------------------------------------
  const track = generateTrack(TRACK_DEFS[worldKey]);
  const trackMesh = buildTrackMesh(track, world.trackTheme);
  scene.add(trackMesh.group);
  const env = world.build({ scene, renderer, track });

  // ---------------------------------------------------------------------------
  // 3. Physics, player kart, rivals, audio
  // ---------------------------------------------------------------------------
  const physics = await createKartPhysicsController(track, null, trackMesh.roadGeo);

  const kart = buildMicroKart();
  kart.kartRoot.scale.setScalar(KART_SCALE);
  scene.add(kart.kartRoot);
  scene.add(kart.sparkPoints);
  // Sparks occlusion-test against a scene depth texture; give them a "nothing in front" depth
  const farDepth = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  farDepth.needsUpdate = true;
  const sparkUniforms = kart.sparkPoints.material.uniforms;
  const prepSparks = (u) => {
    if (!u) return;
    if (u.tSceneDepth) u.tSceneDepth.value = farDepth;
    if (u.uFarClip) u.uFarClip.value = camera.far;
    if (u.uNearClip) u.uNearClip.value = camera.near;
  };
  prepSparks(sparkUniforms);

  const rivals = createRivalField({ scene, sparkScene: scene, physics, playerKartRoot: kart.kartRoot });
  for (const r of rivals.rivals) {
    prepSparks(r.kart.sparkPoints && r.kart.sparkPoints.material.uniforms);
  }

  let activeCameraMode = 1;

  // Kart model (shared with the rivals, tinted per driver)
  const gltfLoader = new GLTFLoader();
  const kartUrls = [
    '/assets/models/kart_1to87.glb',
    '/api/gstatic-models/kart_1to87.glb',
    'https://www.gstatic.com/aistudio/starter-apps/desk-racer/models/kart_1to87.glb',
  ];
  const loadKart = (i) => {
    if (i >= kartUrls.length) return;
    gltfLoader.load(
      kartUrls[i],
      (gltf) => {
        rivals.attachGlbKart(cloneKartTemplate(gltf.scene));
        kart.attachGlbKart(gltf.scene);
        if (kart.setCockpitRoadOnly) kart.setCockpitRoadOnly(activeCameraMode === 2);
      },
      undefined,
      () => loadKart(i + 1)
    );
  };
  loadKart(0);

  const audioSynth = createWebAudioSynth();
  if (audioSynth.preload) audioSynth.preload();

  let camShakeTimer = 0;
  let camShakeIntensity = 0;
  physics.onRailImpact((severity = 0.5) => {
    if (audioSynth.playRailImpact) audioSynth.playRailImpact(severity);
    camShakeTimer = 0.18;
    camShakeIntensity = THREE.MathUtils.clamp(severity, 0.3, 1.0);
  });
  rivals.onPlayerBump((strength) => {
    if (audioSynth.playRailImpact) audioSynth.playRailImpact(strength * 0.6);
    camShakeTimer = 0.12;
    camShakeIntensity = THREE.MathUtils.clamp(strength, 0.3, 0.7);
  });

  if (import.meta.env && import.meta.env.DEV) {
    window.__minicart = { physics, rivals, track, scene, camera, renderer };
  }

  // ---------------------------------------------------------------------------
  // 4. Cameras: 1 chase, 2 cockpit, 3 TV cam, 4 overview
  // ---------------------------------------------------------------------------
  const camPos = new THREE.Vector3();
  const camLook = new THREE.Vector3();
  const camUp = new THREE.Vector3(0, 1, 0);
  const _fwd = new THREE.Vector3();
  const _back = new THREE.Vector3();
  const _yAxis = new THREE.Vector3(0, 1, 0);
  const _desiredPos = new THREE.Vector3();
  const _desiredLook = new THREE.Vector3();
  const _blendUp = new THREE.Vector3();
  const trackBounds = new THREE.Box3();
  track.samples.forEach((s) => trackBounds.expandByPoint(new THREE.Vector3().fromArray(s.position)));
  const trackCenter = trackBounds.getCenter(new THREE.Vector3());
  const trackSize = trackBounds.getSize(new THREE.Vector3());
  let camInitialised = false;

  const camPills = Array.from(document.querySelectorAll('.cam-pill'));
  const helmetOverlay = document.getElementById('helmet-visor-overlay');

  function setCameraMode(mode) {
    activeCameraMode = mode;
    camInitialised = false;
    if (kart.setCockpitRoadOnly) kart.setCockpitRoadOnly(mode === 2);
    if (helmetOverlay) helmetOverlay.classList.toggle('hidden', mode !== 2);
    camPills.forEach((p) => p.classList.toggle('active', Number(p.dataset.cam) === mode));
    camera.fov = mode === 4 ? 40 : 56;
    camera.updateProjectionMatrix();
  }
  camPills.forEach((p) =>
    p.addEventListener('click', (e) => {
      e.stopPropagation();
      setCameraMode(Number(p.dataset.cam));
    })
  );

  function updateCamera(dt, t, st) {
    _fwd.copy(st.tangent).applyAxisAngle(st.normal, (st.headingYaw || 0) * 0.4).normalize();
    let shakeR = 0;
    let shakeU = 0;
    if (camShakeTimer > 0) {
      camShakeTimer = Math.max(0, camShakeTimer - dt);
      const k = (camShakeTimer / 0.18) * camShakeIntensity;
      shakeR = Math.sin(t * 95) * 0.0008 * k;
      shakeU = Math.cos(t * 125) * 0.0008 * k;
    }

    if (activeCameraMode === 1) {
      _desiredPos
        .copy(st.position)
        .addScaledVector(_fwd, -0.0175)
        .addScaledVector(st.normal, 0.0078 + st.hopHeight * 0.38)
        .addScaledVector(st.right, shakeR)
        .addScaledVector(st.normal, shakeU);
      _desiredLook.copy(st.position).addScaledVector(_fwd, 0.024).addScaledVector(st.normal, 0.003);
      _blendUp.set(0, 0.6, 0).addScaledVector(st.normal, 0.4).normalize();
      const a = camInitialised ? 1 - Math.exp(-dt * 14) : 1;
      camPos.lerp(_desiredPos, camInitialised ? 1 - Math.exp(-dt * 30) : 1);
      camLook.lerp(_desiredLook, a);
      camUp.lerp(_blendUp, a).normalize();
    } else if (activeCameraMode === 2) {
      _desiredPos
        .copy(st.position)
        .addScaledVector(_fwd, 0.0022)
        .addScaledVector(st.normal, 0.0036 + st.hopHeight * 0.38)
        .addScaledVector(st.right, shakeR)
        .addScaledVector(st.normal, shakeU);
      _desiredLook.copy(st.position).addScaledVector(_fwd, 0.032).addScaledVector(st.normal, 0.0026);
      camPos.copy(_desiredPos);
      camLook.copy(_desiredLook);
      camUp.lerp(st.normal, camInitialised ? 1 - Math.exp(-dt * 24) : 1).normalize();
    } else if (activeCameraMode === 3) {
      // TV cam: high and behind, slowly swinging, always framing the kart and the road ahead
      const swing = Math.sin(t * 0.25) * 0.5;
      _back.copy(_fwd).setY(0).normalize().applyAxisAngle(_yAxis, swing);
      _desiredPos.copy(st.position).addScaledVector(_back, -0.11);
      _desiredPos.y = st.position.y + 0.07;
      _desiredLook.copy(st.position).addScaledVector(_fwd, 0.02);
      camPos.lerp(_desiredPos, camInitialised ? 1 - Math.exp(-dt * 3) : 1);
      camLook.lerp(_desiredLook, camInitialised ? 1 - Math.exp(-dt * 8) : 1);
      camUp.set(0, 1, 0);
    } else {
      // Overview: whole circuit from above, gently tracking the kart
      const span = Math.max(trackSize.x, trackSize.z);
      _desiredLook.copy(trackCenter).lerp(st.position, 0.25);
      _desiredPos.set(_desiredLook.x, span * 1.05 + 0.3, _desiredLook.z + span * 0.55);
      const a = camInitialised ? 1 - Math.exp(-dt * 2) : 1;
      camPos.lerp(_desiredPos, a);
      camLook.lerp(_desiredLook, a);
      camUp.set(0, 1, 0);
    }
    camInitialised = true;
    camera.up.copy(camUp);
    camera.position.copy(camPos);
    camera.lookAt(camLook);
  }

  // ---------------------------------------------------------------------------
  // 5. HUD
  // ---------------------------------------------------------------------------
  const { speedoSegEls, SPEEDO_SEG_COLORS } = initSpeedometer();
  const $ = (id) => document.getElementById(id);
  const elScaleSpeed = $('hud-scale-speed');
  const elLapCurr = $('hud-lap-curr');
  const elLapSplit = $('hud-lap-split');
  const lapDigitEls = [0, 1, 2, 3, 4, 5].map((i) => $(`lap-d${i}`));
  const elLapTimer = $('hud-lap-timer');
  const elCountdown = $('hud-f1-countdown');
  const elFinishOverlay = $('hud-finish-overlay');
  const elFinishTitle = $('hud-finish-title');
  const elFinishTime = $('hud-finish-time');
  const elFinishSub = $('hud-finish-sub');
  const elFinishEyebrow = document.querySelector('#hud-finish-overlay .welcome-eyebrow');
  const elFinishStandings = $('hud-finish-standings');
  const elPosNum = $('hud-pos-num');
  const elPosSuffix = $('hud-pos-suffix');
  const elPosTotal = $('hud-pos-total');
  const elWelcome = $('welcome-dialog-overlay');
  const elWelcomeEyebrow = document.querySelector('#welcome-dialog-overlay .welcome-eyebrow');
  const btnStart = $('btn-welcome-start');
  const btnRaceAgain = $('btn-finish-race-again');
  const btnFinishMenu = $('btn-finish-menu');
  const btnMute = $('btn-mute-sound');
  const iconSoundOn = $('icon-sound-on');
  const iconSoundOff = $('icon-sound-off');
  const elBrand = $('hud-brand-logo');
  const worldPicker = $('world-picker');
  const levelPicker = $('level-picker');
  const elFinishUnlock = $('hud-finish-unlock');
  const elRaceAgainText = btnRaceAgain ? btnRaceAgain.querySelector('.welcome-start-text') : null;

  const trackName = TRACK_DEFS[worldKey].name.toUpperCase();
  document.title = `MiniCart — ${world.name}`;

  // Difficulty ladder (per world): win to unlock and move up to the next level
  const progress = loadProgress(worldKey);
  const currentLevel = () => DIFFICULTY_LEVELS[progress.selected];
  function applyLevel() {
    rivals.setDifficulty(currentLevel());
    if (elWelcomeEyebrow) {
      elWelcomeEyebrow.textContent = `${trackName} · ${currentLevel().name} · 3 LAPS · ${rivals.fieldSize} RACERS`;
    }
    if (elFinishEyebrow) elFinishEyebrow.textContent = `${trackName} · ${currentLevel().name} · 3 LAPS COMPLETE`;
    renderLevelPicker();
  }
  function renderLevelPicker() {
    if (!levelPicker) return;
    levelPicker.innerHTML = '';
    DIFFICULTY_LEVELS.forEach((lvl, i) => {
      const locked = i > progress.unlocked;
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'level-pill' + (i === progress.selected ? ' active' : '') + (locked ? ' locked' : '');
      pill.disabled = locked;
      pill.textContent = locked ? `🔒 ${lvl.name}` : lvl.name;
      pill.title = locked ? `Win at ${DIFFICULTY_LEVELS[i - 1].name} to unlock` : `Race at ${lvl.name}`;
      pill.addEventListener('click', (e) => {
        e.stopPropagation();
        progress.selected = i;
        saveProgress(worldKey, progress);
        applyLevel();
        pill.blur();
      });
      levelPicker.appendChild(pill);
    });
  }
  document.documentElement.style.setProperty('--world-accent', world.accent);

  if (worldPicker) {
    worldPicker.innerHTML = '';
    for (const key of WORLD_ORDER) {
      const w = WORLDS[key];
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'world-card' + (key === worldKey ? ' active' : '');
      card.style.setProperty('--card-accent', w.accent);
      const name = document.createElement('span');
      name.className = 'world-card-name';
      name.textContent = w.name;
      const blurb = document.createElement('span');
      blurb.className = 'world-card-blurb';
      blurb.textContent = w.blurb;
      card.append(name, blurb);
      card.addEventListener('click', (e) => {
        e.stopPropagation();
        if (key !== worldKey) switchWorld(key);
      });
      worldPicker.appendChild(card);
    }
  }

  const formatTime = (sec) => {
    const c = Math.max(0, Math.floor((sec || 0) * 100));
    const mm = String(Math.floor(c / 6000)).padStart(2, '0');
    const ss = String(Math.floor((c % 6000) / 100)).padStart(2, '0');
    return `${mm}:${ss}.${String(c % 100).padStart(2, '0')}`;
  };

  // Minimap: top-down projection of the generated track (height tilts it slightly)
  const radar = $('minimap-canvas');
  const radarCtx = radar ? radar.getContext('2d') : null;
  let radarBg = null;
  let mapX = () => 0;
  let mapY = () => 0;
  if (radar) {
    const W = radar.width;
    const H = radar.height;
    const pad = 34;
    const projY = (y, z) => z - y * 1.2;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const s of track.samples) {
      const [x, y, z] = s.position;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, projY(y, z));
      maxY = Math.max(maxY, projY(y, z));
    }
    const sc = Math.min((W - pad * 2) / (maxX - minX), (H - pad * 2) / (maxY - minY));
    const ox = (W - (maxX - minX) * sc) / 2;
    const oy = (H - (maxY - minY) * sc) / 2;
    mapX = (x) => ox + (x - minX) * sc;
    mapY = (y, z) => oy + (projY(y, z) - minY) * sc;
    radarBg = document.createElement('canvas');
    radarBg.width = W;
    radarBg.height = H;
    const g = radarBg.getContext('2d');
    const path = () => {
      g.beginPath();
      track.samples.forEach((s, i) => {
        const [x, y, z] = s.position;
        if (i === 0) g.moveTo(mapX(x), mapY(y, z));
        else g.lineTo(mapX(x), mapY(y, z));
      });
      g.closePath();
    };
    g.lineJoin = 'round';
    g.strokeStyle = 'rgba(0, 0, 0, 0.55)';
    g.lineWidth = 22;
    path();
    g.stroke();
    g.strokeStyle = 'rgba(255, 255, 255, 0.92)';
    g.lineWidth = 11;
    path();
    g.stroke();
    const [sx, sy, sz] = track.samples[0].position;
    g.fillStyle = '#ffd27a';
    g.beginPath();
    g.arc(mapX(sx), mapY(sy, sz), 9, 0, Math.PI * 2);
    g.fill();
  }

  function dot(x, y, r, color) {
    radarCtx.fillStyle = color;
    radarCtx.beginPath();
    radarCtx.arc(x, y, r, 0, Math.PI * 2);
    radarCtx.fill();
  }
  function drawMinimap(st) {
    if (!radarCtx) return;
    radarCtx.clearRect(0, 0, radar.width, radar.height);
    radarCtx.drawImage(radarBg, 0, 0);
    for (const r of rivals.rivals) {
      if (!r.kart.kartRoot.visible) continue;
      const p = r.kart.kartRoot.position;
      dot(mapX(p.x), mapY(p.y, p.z), 10, 'rgba(0,0,0,0.6)');
      dot(mapX(p.x), mapY(p.y, p.z), 7.5, `#${r.color.toString(16).padStart(6, '0')}`);
    }
    const px = mapX(st.position.x);
    const py = mapY(st.position.y, st.position.z);
    const halo = radarCtx.createRadialGradient(px, py, 3, px, py, 24);
    halo.addColorStop(0, 'rgba(0,240,255,0.9)');
    halo.addColorStop(1, 'rgba(0,210,255,0)');
    dot(px, py, 24, halo);
    dot(px, py, 10, '#00e8ff');
    dot(px, py, 4.5, '#dcfdff');
  }

  let lastKmh = -1;
  let lastSegs = -1;
  let lastLap = -1;
  let lastTimer = '';
  let lastPos = -1;
  function updateHUD(st) {
    const kmh = Math.round(Math.abs(st.speed) * 102.35 * 3.6);
    if (kmh !== lastKmh && elScaleSpeed) {
      lastKmh = kmh;
      elScaleSpeed.textContent = String(kmh);
    }
    const segs = kmh <= 0 ? 0 : Math.min(18, Math.max(1, Math.round((kmh / 104) * 18)));
    if (segs !== lastSegs && speedoSegEls.length === 18) {
      lastSegs = segs;
      speedoSegEls.forEach((el, i) => {
        if (!el) return;
        el.style.fill = i < segs ? SPEEDO_SEG_COLORS[i] : 'rgba(255, 255, 255, 0.12)';
        if (i < segs && i >= 10) el.setAttribute('filter', 'url(#speedoCyanGlow)');
        else el.removeAttribute('filter');
      });
    }
    const lap = Math.min(3, Math.max(1, st.lapCount || 1));
    if (lap !== lastLap && elLapCurr) {
      lastLap = lap;
      elLapCurr.textContent = String(lap);
    }
    const timeStr = formatTime(st.raceFinished ? st.finishTotalTime : st.totalRaceTime);
    if (timeStr !== lastTimer) {
      lastTimer = timeStr;
      const digits = timeStr.replace(/[:.]/g, '');
      lapDigitEls.forEach((el, i) => {
        if (el) el.textContent = digits[i];
      });
      if (elLapTimer) elLapTimer.setAttribute('aria-label', timeStr);
    }
    const pos = rivals.getPlayerPosition();
    if (pos !== lastPos && elPosNum) {
      lastPos = pos;
      elPosNum.textContent = String(pos);
      if (elPosSuffix) elPosSuffix.textContent = ordinalSuffix(pos);
      if (elPosTotal) elPosTotal.textContent = String(rivals.fieldSize);
    }
    drawMinimap(st);
  }

  let splitTimeout = null;
  function showLapSplit(n, time) {
    if (!elLapSplit) return;
    clearTimeout(splitTimeout);
    elLapSplit.textContent = `LAP ${n}  ${formatTime(time)}`;
    elLapSplit.classList.remove('hidden');
    splitTimeout = setTimeout(() => elLapSplit.classList.add('hidden'), 2400);
  }
  function hideLapSplit() {
    clearTimeout(splitTimeout);
    if (elLapSplit) elLapSplit.classList.add('hidden');
  }

  let finishShown = false;
  let standingsKey = '';
  function renderStandings() {
    if (!elFinishStandings) return;
    const standings = rivals.getStandings();
    const key = standings.map((e) => `${e.id}:${e.finished ? 1 : 0}`).join('|');
    if (key === standingsKey) return;
    standingsKey = key;
    elFinishStandings.innerHTML = '';
    standings.forEach((e, i) => {
      const li = document.createElement('li');
      li.className = 'finish-standing-row' + (e.isPlayer ? ' is-player' : '') + (e.finished ? '' : ' is-running');
      const pos = document.createElement('span');
      pos.className = 'finish-standing-pos';
      pos.textContent = `${i + 1}${ordinalSuffix(i + 1)}`;
      const swatch = document.createElement('span');
      swatch.className = 'finish-standing-dot';
      swatch.style.background = `#${e.color.toString(16).padStart(6, '0')}`;
      const name = document.createElement('span');
      name.className = 'finish-standing-name';
      name.textContent = e.name;
      const status = document.createElement('span');
      status.className = 'finish-standing-status';
      status.textContent = e.finished ? 'FINISHED' : 'RACING';
      li.append(pos, swatch, name, status);
      elFinishStandings.appendChild(li);
    });
  }
  function showFinish(total, best) {
    hideLapSplit();
    const place = rivals.notifyPlayerFinished();
    // Progression: a win moves you up a level (unlocking it if new)
    const raced = currentLevel();
    let unlockMsg = '';
    if (!finishShown && place === 1) {
      const next = progress.selected + 1;
      if (next < DIFFICULTY_LEVELS.length) {
        if (next > progress.unlocked) {
          progress.unlocked = next;
          unlockMsg = `${DIFFICULTY_LEVELS[next].name} UNLOCKED!`;
        } else {
          unlockMsg = `MOVING UP TO ${DIFFICULTY_LEVELS[next].name}`;
        }
        progress.selected = next;
      } else {
        unlockMsg = `${raced.name} CONQUERED — TRY ANOTHER WORLD!`;
      }
      saveProgress(worldKey, progress);
    } else if (!finishShown) {
      unlockMsg = place <= 3 ? `WIN TO REACH THE NEXT LEVEL` : '';
    }
    if (!finishShown) {
      if (elFinishUnlock) {
        elFinishUnlock.textContent = unlockMsg;
        elFinishUnlock.classList.toggle('hidden', !unlockMsg);
      }
      if (elRaceAgainText) {
        elRaceAgainText.textContent =
          place === 1 && progress.selected !== DIFFICULTY_LEVELS.indexOf(raced)
            ? `NEXT: ${currentLevel().name}`
            : 'RACE AGAIN';
      }
      if (elFinishEyebrow) elFinishEyebrow.textContent = `${trackName} · ${raced.name} · 3 LAPS COMPLETE`;
      renderLevelPicker();
    }
    if (elFinishTitle) {
      elFinishTitle.textContent = `${place}${ordinalSuffix(place)} PLACE`;
      elFinishTitle.classList.toggle('is-winner', place === 1);
    }
    if (elFinishTime) elFinishTime.textContent = formatTime(total);
    if (elFinishSub) elFinishSub.textContent = `BEST LAP ${formatTime(best ?? total / 3)}`;
    standingsKey = '';
    renderStandings();
    if (!finishShown && audioSynth.playRaceFinishFanfare) audioSynth.playRaceFinishFanfare();
    finishShown = true;
    if (elFinishOverlay) elFinishOverlay.classList.remove('hidden');
    syncTouchVisibility();
  }
  function hideFinish() {
    finishShown = false;
    if (elFinishOverlay) elFinishOverlay.classList.add('hidden');
    syncTouchVisibility();
  }

  physics.onLapComplete((lapTime, bestLap, completedLap, totalTime, isFinish) => {
    if (isFinish) {
      showFinish(totalTime ?? physics.state.finishTotalTime, bestLap ?? lapTime);
    } else {
      if (audioSynth.playLapChime) audioSynth.playLapChime();
      showLapSplit(completedLap, lapTime);
    }
  });

  // ---------------------------------------------------------------------------
  // 6. Countdown (5 red lights, then lights out)
  // ---------------------------------------------------------------------------
  const countdown = { active: false, elapsed: 0, step: 0.8, last: -1 };
  let goTimeout = null;
  function startCountdown() {
    hideFinish();
    hideLapSplit();
    physics.setAutopilot(false);
    physics.resetToStart();
    physics.state.countdownLocked = true;
    physics.state.raceClockActive = false;
    countdown.active = true;
    countdown.elapsed = 0;
    countdown.last = 1;
    trackMesh.setStartLights(1);
    if (audioSynth.playF1CountdownBeep) audioSynth.playF1CountdownBeep(false);
    clearTimeout(goTimeout);
    if (elCountdown) {
      elCountdown.textContent = '5';
      elCountdown.classList.remove('hidden');
    }
  }
  function stepCountdown(dt) {
    if (!countdown.active) return;
    countdown.elapsed += dt;
    const idx = Math.floor(countdown.elapsed / countdown.step) + 1;
    if (idx <= 5) {
      if (idx !== countdown.last) {
        countdown.last = idx;
        trackMesh.setStartLights(idx);
        if (audioSynth.playF1CountdownBeep) audioSynth.playF1CountdownBeep(false);
        if (elCountdown) elCountdown.textContent = String(6 - idx);
      }
    } else {
      countdown.active = false;
      trackMesh.setStartLights(0);
      if (audioSynth.playF1CountdownBeep) audioSynth.playF1CountdownBeep(true);
      if (elCountdown) {
        elCountdown.textContent = 'GO!';
        goTimeout = setTimeout(() => elCountdown.classList.add('hidden'), 650);
      }
      physics.state.countdownLocked = false;
      physics.state.raceClockActive = true;
      if (physics.notifyLightsOut) physics.notifyLightsOut();
    }
  }

  // ---------------------------------------------------------------------------
  // 7. Menus, sound, keyboard, touch
  // ---------------------------------------------------------------------------
  let soundOn = false;
  function setSound(on) {
    soundOn = audioSynth.setEnabled ? Boolean(audioSynth.setEnabled(on)) : on;
    if (btnMute) {
      btnMute.classList.toggle('is-muted', !soundOn);
      btnMute.title = soundOn ? 'Mute Sound (M)' : 'Unmute Sound (M)';
    }
    if (iconSoundOn) iconSoundOn.classList.toggle('hidden', !soundOn);
    if (iconSoundOff) iconSoundOff.classList.toggle('hidden', soundOn);
  }
  if (btnMute) {
    btnMute.addEventListener('click', (e) => {
      e.stopPropagation();
      setSound(!soundOn);
      btnMute.blur();
    });
  }

  const isWelcomeOpen = () => elWelcome && !elWelcome.classList.contains('hidden');
  const isFinishOpen = () => elFinishOverlay && !elFinishOverlay.classList.contains('hidden');
  function showWelcome() {
    if (elWelcome) elWelcome.classList.remove('hidden');
    syncTouchVisibility();
  }
  function startRace() {
    if (!soundOn) setSound(true);
    applyLevel();
    if (elWelcome) elWelcome.classList.add('hidden');
    syncTouchVisibility();
    startCountdown();
  }
  const onClick = (el, fn) =>
    el &&
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      fn();
      el.blur();
    });
  onClick(btnStart, startRace);
  onClick(btnRaceAgain, startRace);
  onClick(btnFinishMenu, () => {
    hideFinish();
    showWelcome();
  });
  onClick(elBrand, showWelcome);

  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    if (e.code === 'Enter' || e.code === 'NumpadEnter') {
      if (isWelcomeOpen() || isFinishOpen()) {
        e.preventDefault();
        startRace();
      }
    } else if (e.code === 'Escape') {
      if (isFinishOpen()) hideFinish();
      if (isWelcomeOpen()) {
        elWelcome.classList.add('hidden');
        syncTouchVisibility();
      } else {
        showWelcome();
      }
    } else if (e.code === 'KeyM') {
      setSound(!soundOn);
    } else if (/^Digit[1-4]$/.test(e.code)) {
      setCameraMode(Number(e.code.slice(5)));
    }
  });

  const elTouch = $('mobile-touch-controls');
  const touchButtons = elTouch ? Array.from(elTouch.querySelectorAll('.mobile-ctrl-btn')) : [];
  const touchDirs = new Set();
  const pointerDirs = new Map();
  function applyTouch() {
    for (const dir of ['left', 'right', 'forward', 'backward']) {
      let pressed = touchDirs.has(dir);
      for (const d of pointerDirs.values()) if (d === dir) pressed = true;
      physics.setTouchKey(dir, pressed);
    }
    for (const btn of touchButtons) {
      btn.classList.toggle('is-pressed', Boolean(physics.keys[btn.dataset.control]));
    }
  }
  function releaseTouch() {
    touchDirs.clear();
    pointerDirs.clear();
    physics.clearTouchKeys();
    touchButtons.forEach((b) => b.classList.remove('is-pressed'));
  }
  function syncTouchVisibility() {
    if (!elTouch) return;
    const hide = isWelcomeOpen() || isFinishOpen();
    elTouch.classList.toggle('hidden', hide);
    if (hide) releaseTouch();
  }
  if (elTouch) {
    const fromTouches = (e) => {
      if (e.cancelable) e.preventDefault();
      touchDirs.clear();
      for (const t of e.touches || []) {
        const hit = document.elementFromPoint(t.clientX, t.clientY);
        const btn = hit && hit.closest ? hit.closest('.mobile-ctrl-btn') : null;
        if (btn && btn.dataset.control) touchDirs.add(btn.dataset.control);
      }
      applyTouch();
    };
    for (const ev of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) {
      elTouch.addEventListener(ev, fromTouches, { passive: false });
    }
    elTouch.addEventListener('contextmenu', (e) => e.preventDefault());
    for (const btn of touchButtons) {
      btn.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'touch') return;
        e.preventDefault();
        try {
          btn.setPointerCapture(e.pointerId);
        } catch {
          // ignore
        }
        pointerDirs.set(e.pointerId, btn.dataset.control);
        applyTouch();
      });
      const release = (e) => {
        if (pointerDirs.delete(e.pointerId)) applyTouch();
      };
      btn.addEventListener('pointerup', release);
      btn.addEventListener('pointercancel', release);
      btn.addEventListener('lostpointercapture', release);
    }
    window.addEventListener('blur', releaseTouch);
  }

  // ---------------------------------------------------------------------------
  // 8. Resize + loop
  // ---------------------------------------------------------------------------
  window.addEventListener('resize', () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    composer.setSize(w, h);
  });

  setCameraMode(1);
  applyLevel();
  showWelcome();
  const clock = new THREE.Clock();
  let elapsed = 0;
  function animate() {
    requestAnimationFrame(animate);
    const dt = Math.min(clock.getDelta(), 0.05);
    elapsed += dt;

    stepCountdown(dt);
    const st = physics.stepPhysics(dt);
    rivals.update(dt);

    kart.kartRoot.position.copy(st.position);
    kart.kartRoot.quaternion.copy(st.quaternion);
    kart.updateKartVisuals(dt, st);
    if (sparkUniforms && sparkUniforms.uResolution) {
      sparkUniforms.uResolution.value.set(renderer.domElement.width, renderer.domElement.height);
    }

    env.update(dt, elapsed, st.position);
    updateCamera(dt, elapsed, st);
    if (env.sky) env.sky.position.copy(camera.position);

    updateHUD(st);
    if (finishShown) renderStandings();
    if (audioSynth.update) audioSynth.update(st);

    composer.render();
  }
  animate();
}

initGame().catch((err) => {
  console.error('MiniCart failed to start:', err);
});
