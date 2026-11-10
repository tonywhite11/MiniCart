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
import { createRaceItems, ITEM_ICONS, ITEMS } from './race/RaceItems.js';
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
  // Tablets and phones get a lighter profile: lower resolution, cheaper shadows,
  // and the resolution steps down further if frames run slow (see animate()).
  const lowPower = document.documentElement.classList.contains('touch-ui');
  let pixelRatio = Math.min(window.devicePixelRatio, lowPower ? 1.5 : 2);
  const renderer = new THREE.WebGLRenderer({ antialias: !lowPower, powerPreference: 'high-performance' });
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = world.exposure ?? 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = lowPower ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(56, window.innerWidth / window.innerHeight, 0.002, 60);

  const composerTarget = new THREE.WebGLRenderTarget(window.innerWidth, window.innerHeight, {
    type: THREE.HalfFloatType,
    samples: lowPower ? 2 : 4,
  });
  const composer = new EffectComposer(renderer, composerTarget);
  composer.setPixelRatio(pixelRatio);
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
  if (lowPower) {
    scene.traverse((o) => {
      if (o.isLight && o.castShadow && o.shadow) o.shadow.mapSize.set(1024, 1024);
    });
  }

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
    `${import.meta.env.BASE_URL}assets/models/kart_1to87.glb`,
    `${import.meta.env.BASE_URL}api/gstatic-models/kart_1to87.glb`,
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

  // ---------------------------------------------------------------------------
  // Items, boost pads, drift turbos + arcade feedback
  // ---------------------------------------------------------------------------
  const items = createRaceItems({ scene, physics, rivals, playerKartRoot: kart.kartRoot, track, audio: audioSynth });
  physics.onReset(() => items.reset());
  const sfx = (k, v) => audioSynth.playSfx && audioSynth.playSfx(k, v);

  const hudFx = document.createElement('div');
  hudFx.id = 'hud-fx';
  hudFx.innerHTML = `
    <div id="speed-lines" class="speed-lines"></div>
    <div id="hit-flash" class="hit-flash"></div>
    <div id="hud-item" class="hud-item empty" aria-label="Item">
      <div class="hud-item-icon" id="hud-item-icon"></div>
      <div class="hud-item-uses" id="hud-item-uses"></div>
      <div class="hud-item-key">E</div>
    </div>
    <div id="hud-toast" class="hud-toast"></div>
    <div id="hud-drift" class="hud-drift"><span></span></div>`;
  document.getElementById('hud-root').appendChild(hudFx);
  const elSpeedLines = document.getElementById('speed-lines');
  const elHitFlash = document.getElementById('hit-flash');
  const elItem = document.getElementById('hud-item');
  const elItemIcon = document.getElementById('hud-item-icon');
  const elItemUses = document.getElementById('hud-item-uses');
  const elToast = document.getElementById('hud-toast');
  const elDrift = document.getElementById('hud-drift');

  let toastTimer = null;
  function toast(text, tone = 'good') {
    elToast.textContent = text;
    elToast.className = `hud-toast show ${tone}`;
    void elToast.offsetWidth;
    elToast.classList.add('pop');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => elToast.classList.remove('show', 'pop'), 1100);
  }
  function setItemSlot(item, uses) {
    elItem.classList.toggle('empty', !item);
    elItem.classList.remove('rolling');
    elItemIcon.innerHTML = item ? ITEM_ICONS[item] : '';
    elItemUses.textContent = item && uses > 1 ? `×${uses}` : '';
    elItem.title = item ? ITEMS[item].name : '';
  }
  let rollTimer = null;
  let rollDone = null;
  items.on('roll', ({ item, uses, duration }) => {
    const keys = Object.keys(ITEM_ICONS);
    let n = 0;
    elItem.classList.remove('empty');
    elItem.classList.add('rolling');
    clearInterval(rollTimer);
    clearTimeout(rollDone);
    rollTimer = setInterval(() => {
      elItemIcon.innerHTML = ITEM_ICONS[keys[n++ % keys.length]];
      sfx('roll');
    }, 70);
    rollDone = setTimeout(() => {
      clearInterval(rollTimer);
      setItemSlot(item, uses);
      sfx('ready');
      toast(ITEMS[item].name, 'item');
    }, duration * 1000);
  });
  items.on('item', ({ item, uses }) => {
    clearInterval(rollTimer);
    clearTimeout(rollDone);
    setItemSlot(item, uses);
  });
  items.on('toast', ({ text, tone }) => toast(text, tone));
  items.on('playerHit', () => {
    camShakeTimer = 0.4;
    camShakeIntensity = 1.6;
    elHitFlash.classList.remove('on');
    void elHitFlash.offsetWidth;
    elHitFlash.classList.add('on');
  });
  items.on('pad', () => {
    fovKick = 1;
  });

  let fovKick = 0;
  const TURBO_NAMES = ['', 'TURBO!', 'SUPER TURBO!', 'ULTRA TURBO!'];
  physics.onDriftTier((tier) => {
    sfx('tier', tier);
    elDrift.dataset.tier = String(tier);
  });
  physics.onDriftBoost((tier) => {
    sfx('turbo', tier);
    toast(TURBO_NAMES[tier], `tier${tier}`);
    fovKick = 0.6 + tier * 0.2;
  });

  if (import.meta.env && import.meta.env.DEV) {
    window.__minicart = { physics, rivals, items, track, scene, camera, renderer };
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

  let boostPull = 0;
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

    // Speed feel: FOV widens with speed, kicks on turbos, camera drops back a touch
    const boosting = st.boostActive > 0 ? 1 : 0;
    boostPull = THREE.MathUtils.lerp(boostPull, boosting, 1 - Math.exp(-dt * 5));
    fovKick = Math.max(0, fovKick - dt * 1.6);
    if (activeCameraMode === 1 || activeCameraMode === 2) {
      const speedK = THREE.MathUtils.clamp((Math.abs(st.speed) - 0.08) / 0.2, 0, 1);
      const targetFov = 54 + speedK * 8 + boostPull * 8 + fovKick * 6;
      if (Math.abs(camera.fov - targetFov) > 0.05) {
        camera.fov = THREE.MathUtils.lerp(camera.fov, targetFov, 1 - Math.exp(-dt * 6));
        camera.updateProjectionMatrix();
      }
    }
    if (elSpeedLines) {
      const lines = activeCameraMode <= 2 && st.speed > 0.05 ? Math.min(1, boostPull * 0.85 + fovKick * 0.5) : 0;
      elSpeedLines.style.opacity = lines.toFixed(3);
    }

    if (activeCameraMode === 1) {
      _desiredPos
        .copy(st.position)
        .addScaledVector(_fwd, -0.0175 - boostPull * 0.004)
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
        // SVG glow filters are slow to repaint on iPad Safari
        if (i < segs && i >= 10 && !lowPower) el.setAttribute('filter', 'url(#speedoCyanGlow)');
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
      const racing = st.raceClockActive && !st.raceFinished && lastPos > 0;
      const badge = document.getElementById('hud-pos');
      if (racing && badge && pos !== lastPos) {
        if (pos < lastPos) sfx('overtake');
        badge.classList.remove('pos-up', 'pos-down');
        void badge.offsetWidth;
        badge.classList.add(pos < lastPos ? 'pos-up' : 'pos-down');
      }
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

  // How to Play modal
  const elHowto = $('howto-overlay');
  const elHowtoItems = $('howto-items');
  const HOWTO_ITEM_TEXT = {
    fizz: 'Three bursts of speed. Press E once for each.',
    goo: 'Drops a sticky puddle behind you. Anyone who drives into it spins out.',
    dart: 'A homing spark that chases down the kart directly ahead of you.',
    bubble: 'A bubble that blocks the next hit for a few seconds.',
    pulse: 'Only for the back of the pack. Jolts every kart close ahead of you.',
  };
  if (elHowtoItems) {
    elHowtoItems.innerHTML = Object.keys(HOWTO_ITEM_TEXT)
      .map(
        (k) =>
          `<li><span class="howto-item-icon">${ITEM_ICONS[k]}</span><span><span class="howto-item-name">${ITEMS[k].name}</span><span class="howto-item-desc">${HOWTO_ITEM_TEXT[k]}</span></span></li>`
      )
      .join('');
  }
  const isHowtoOpen = () => elHowto && !elHowto.classList.contains('hidden');
  let howtoReturnFocus = null;
  function openHowto() {
    if (!elHowto) return;
    howtoReturnFocus = document.activeElement;
    elHowto.classList.remove('hidden');
    const scroller = elHowto.querySelector('.howto-scroll');
    if (scroller) scroller.scrollTop = 0;
    const done = $('btn-howto-done');
    if (done) done.focus({ preventScroll: true });
  }
  function closeHowto() {
    if (!elHowto) return;
    elHowto.classList.add('hidden');
    try {
      localStorage.setItem('minicart-howto-seen', '1');
    } catch (_) {}
    if (howtoReturnFocus && howtoReturnFocus.blur) howtoReturnFocus.blur();
  }
  onClick($('btn-welcome-howto'), openHowto);
  onClick($('btn-howto-done'), closeHowto);
  onClick($('btn-howto-close'), closeHowto);
  if (elHowto) {
    elHowto.addEventListener('click', (e) => {
      if (e.target === elHowto) closeHowto();
    });
  }
  // First visit: show the rules before the first race
  try {
    if (!localStorage.getItem('minicart-howto-seen')) openHowto();
  } catch (_) {}

  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    if (isHowtoOpen()) {
      if (['Enter', 'NumpadEnter', 'Escape', 'KeyH'].includes(e.code)) {
        e.preventDefault();
        closeHowto();
      }
      return;
    }
    if (e.code === 'KeyH' && (isWelcomeOpen() || isFinishOpen())) {
      openHowto();
      return;
    }
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
    } else if (e.code === 'KeyE' || e.code === 'KeyF') {
      items.usePlayerItem();
    } else if (e.code === 'KeyM') {
      setSound(!soundOn);
    } else if (/^Digit[1-4]$/.test(e.code)) {
      setCameraMode(Number(e.code.slice(5)));
    }
  });

  // Touch controls, gamepad style. Left: a floating stick (analog steering,
  // pull down to brake). Right: DRIFT and ITEM. The gas is on automatically.
  const elTouch = $('mobile-touch-controls');
  const elStickZone = $('touch-stick-zone');
  const elStickBase = $('touch-stick-base');
  const elStickKnob = $('touch-stick-knob');
  const touchButtons = elTouch ? Array.from(elTouch.querySelectorAll('.mobile-ctrl-btn')) : [];
  const STICK_RADIUS = 56; // px the knob can travel
  const stick = { id: null, cx: 0, cy: 0, x: 0, y: 0 };
  const buttonTouches = new Map(); // touch / pointer id -> control
  let touchItemDown = false;
  let touchActive = false;
  // Auto-gas only kicks in once the on-screen controls are actually used, so a
  // touchscreen laptop driven from the keyboard behaves normally.
  let touchSeen = false;
  function markTouchSeen() {
    if (touchSeen) return;
    touchSeen = true;
    touchActive = !elTouch.classList.contains('hidden');
  }

  function applyTouch() {
    if (!touchActive) return;
    const held = (c) => {
      for (const d of buttonTouches.values()) if (d === c) return true;
      return false;
    };
    const braking = stick.id !== null && stick.y > 0.55;
    // Analog steer with a small dead zone and a gentle curve for fine control
    const ax = Math.abs(stick.x);
    const steer = ax < 0.12 ? 0 : Math.sign(stick.x) * Math.min(1, Math.pow((ax - 0.12) / 0.78, 1.25));
    physics.setTouchSteer(steer);
    physics.setTouchKey('forward', !braking);
    physics.setTouchKey('backward', braking);
    physics.setTouchKey('drift', held('drift'));
    const itemPressed = held('item');
    if (itemPressed && !touchItemDown) items.usePlayerItem();
    touchItemDown = itemPressed;
    for (const btn of touchButtons) btn.classList.toggle('is-pressed', held(btn.dataset.control));
    if (elStickBase) elStickBase.classList.toggle('is-braking', braking);
  }
  function drawStick() {
    if (!elStickKnob) return;
    elStickKnob.style.transform = `translate(${stick.x * STICK_RADIUS}px, ${stick.y * STICK_RADIUS}px)`;
  }
  function stickStart(id, x, y) {
    stick.id = id;
    // The stick appears wherever your thumb lands inside the left zone
    const zr = elStickZone.getBoundingClientRect();
    const half = elStickBase.offsetWidth / 2;
    stick.cx = Math.min(Math.max(x, zr.left + half), zr.right - half);
    stick.cy = Math.min(Math.max(y, zr.top + half), zr.bottom - half);
    elStickBase.style.left = `${stick.cx - zr.left - half}px`;
    elStickBase.style.top = `${stick.cy - zr.top - half}px`;
    elStickBase.classList.add('is-active');
    stickMove(x, y);
  }
  function stickMove(x, y) {
    let dx = (x - stick.cx) / STICK_RADIUS;
    let dy = (y - stick.cy) / STICK_RADIUS;
    const len = Math.hypot(dx, dy);
    if (len > 1) {
      dx /= len;
      dy /= len;
    }
    stick.x = dx;
    stick.y = dy;
    drawStick();
    applyTouch();
  }
  function stickEnd() {
    stick.id = null;
    stick.x = stick.y = 0;
    drawStick();
    if (elStickBase) {
      elStickBase.classList.remove('is-active', 'is-braking');
      elStickBase.style.left = elStickBase.style.top = '';
    }
    applyTouch();
  }
  function releaseTouch() {
    buttonTouches.clear();
    if (stick.id !== null) stickEnd();
    physics.clearTouchKeys();
    touchButtons.forEach((b) => b.classList.remove('is-pressed'));
  }
  function syncTouchVisibility() {
    if (!elTouch) return;
    const hide = isWelcomeOpen() || isFinishOpen();
    elTouch.classList.toggle('hidden', hide);
    touchActive = !hide && touchSeen;
    releaseTouch();
    applyTouch();
  }
  if (elTouch && elStickZone) {
    const buttonAt = (x, y) => {
      const hit = document.elementFromPoint(x, y);
      const btn = hit && hit.closest ? hit.closest('.mobile-ctrl-btn') : null;
      return btn && btn.dataset.control ? btn.dataset.control : null;
    };
    const onTouch = (e) => {
      if (e.cancelable) e.preventDefault();
      markTouchSeen();
      for (const t of e.changedTouches) {
        if (e.type === 'touchstart') {
          if (stick.id === null && elStickZone.contains(t.target)) {
            stickStart(t.identifier, t.clientX, t.clientY);
            continue;
          }
          const c = buttonAt(t.clientX, t.clientY);
          if (c) buttonTouches.set(t.identifier, c);
        } else if (e.type === 'touchmove') {
          if (t.identifier === stick.id) {
            stickMove(t.clientX, t.clientY);
          } else if (buttonTouches.has(t.identifier)) {
            // slide your thumb between DRIFT and ITEM
            const c = buttonAt(t.clientX, t.clientY);
            if (c) buttonTouches.set(t.identifier, c);
          }
        } else {
          if (t.identifier === stick.id) stickEnd();
          buttonTouches.delete(t.identifier);
        }
      }
      applyTouch();
    };
    for (const ev of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) {
      elTouch.addEventListener(ev, onTouch, { passive: false });
    }
    elTouch.addEventListener('contextmenu', (e) => e.preventDefault());
    // Mouse / pen fallback (testing on a desktop with ?touch=1)
    const pointerId = (e) => `p${e.pointerId}`;
    elTouch.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch') return;
      e.preventDefault();
      markTouchSeen();
      if (stick.id === null && elStickZone.contains(e.target)) {
        stickStart(pointerId(e), e.clientX, e.clientY);
      } else {
        const c = buttonAt(e.clientX, e.clientY);
        if (c) buttonTouches.set(pointerId(e), c);
        applyTouch();
      }
    });
    window.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'touch' && stick.id === pointerId(e)) stickMove(e.clientX, e.clientY);
    });
    window.addEventListener('pointerup', (e) => {
      if (e.pointerType === 'touch') return;
      if (stick.id === pointerId(e)) stickEnd();
      if (buttonTouches.delete(pointerId(e))) applyTouch();
    });
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
  // Adaptive resolution: if the average frame is slower than ~45 fps for two
  // seconds, render fewer pixels (down to 1x). Never steps back up mid-session,
  // so it cannot oscillate.
  let perfTime = 0;
  let perfFrames = 0;
  function adaptQuality(rawDt) {
    if (document.hidden || rawDt > 0.5) return;
    perfTime += rawDt;
    perfFrames += 1;
    if (perfTime < 2) return;
    const avg = perfTime / perfFrames;
    perfTime = 0;
    perfFrames = 0;
    if (avg > 1 / 45 && pixelRatio > 1) {
      pixelRatio = Math.max(1, Math.round((pixelRatio - 0.25) * 100) / 100);
      renderer.setPixelRatio(pixelRatio);
      composer.setPixelRatio(pixelRatio);
      renderer.setSize(window.innerWidth, window.innerHeight);
      composer.setSize(window.innerWidth, window.innerHeight);
    }
  }
  const clock = new THREE.Clock();
  let elapsed = 0;
  function animate() {
    requestAnimationFrame(animate);
    const rawDt = clock.getDelta();
    const dt = Math.min(rawDt, 0.05);
    elapsed += dt;
    adaptQuality(rawDt);

    stepCountdown(dt);
    const st = physics.stepPhysics(dt);
    rivals.update(dt);

    kart.kartRoot.position.copy(st.position);
    kart.kartRoot.quaternion.copy(st.quaternion);
    if (st.spinYaw) kart.kartRoot.rotateY(st.spinYaw);
    kart.updateKartVisuals(dt, st);
    items.update(dt, elapsed);
    elDrift.classList.toggle('on', Boolean(st.isDrifting));
    if (!st.isDrifting) elDrift.dataset.tier = '0';
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
