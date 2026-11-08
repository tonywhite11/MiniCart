import * as THREE from 'three';
import { createTrackProximity, createFollowSun, canvasTexture, mulberry32 } from './worldUtils.js';

/**
 * Toybox Rally — tiny karts on an orange plastic toy track across a kid's bedroom
 * floor: wooden planks, a round rug, giant letter blocks, building bricks, crayons,
 * a beach ball and a stack of books the track bridges over.
 */
export const toyRoomWorld = {
  key: 'toyroom',
  name: 'Toybox Rally',
  blurb: 'Plastic track across a giant bedroom floor',
  accent: '#ff8a1a',
  trackTheme: {
    asphalt: '#ff8a1a',
    asphaltSpeck: 0.04,
    edgeLine: '#ffe0a6',
    roadRoughness: 0.42,
    curbColors: ['#2e6bff', '#ffd43b'],
    barrierColors: ['#ffd43b', '#ffd43b'],
    barrierHeight: 0.004,
    deckColor: '#e8730e',
    supports: true,
    supportColor: '#2e6bff',
    gantryColor: '#ff4d6d',
    signText: 'TOYBOX RALLY',
    signBg: '#2e6bff',
    signFg: '#ffffff',
  },
  exposure: 1.0,
  bloom: { strength: 0.14, radius: 0.35, threshold: 0.95 },

  build({ scene, track }) {
    const rng = mulberry32(31);
    const prox = createTrackProximity(track);
    const halfW = track.track_width_m * 0.5;
    const root = new THREE.Group();
    root.name = 'ToyRoomWorld';
    scene.add(root);

    scene.background = new THREE.Color('#f3e6d3');
    scene.fog = new THREE.Fog('#f3e6d3', 3.5, 9.0);

    scene.add(new THREE.HemisphereLight('#fff6ea', '#b88a5a', 1.1));
    const sun = createFollowSun(scene, { color: '#fff0d8', intensity: 2.4, dir: [-0.5, 1.0, 0.45], size: 0.3 });
    const fill = new THREE.DirectionalLight('#cfe0ff', 0.45);
    fill.position.set(2, 1.5, -2);
    scene.add(fill);

    // Floor: honey-wood planks
    const planks = canvasTexture(512, 512, (g, w, h) => {
      const r = mulberry32(9);
      const plankH = h / 8;
      for (let p = 0; p < 8; p++) {
        const base = 150 + r() * 30;
        g.fillStyle = `rgb(${base + 60}, ${base + 10}, ${base - 50})`;
        g.fillRect(0, p * plankH, w, plankH);
        for (let k = 0; k < 40; k++) {
          g.strokeStyle = `rgba(110, 60, 20, ${0.05 + r() * 0.08})`;
          g.beginPath();
          const y = p * plankH + r() * plankH;
          g.moveTo(0, y);
          g.bezierCurveTo(w * 0.3, y + (r() - 0.5) * 8, w * 0.7, y + (r() - 0.5) * 8, w, y);
          g.stroke();
        }
        g.fillStyle = 'rgba(70, 40, 15, 0.55)';
        g.fillRect(0, p * plankH, w, 2);
        const seam = r() * w;
        g.fillRect(seam, p * plankH, 2, plankH);
      }
    }, { repeat: [10, 10] });
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(12, 12),
      new THREE.MeshStandardMaterial({ map: planks, roughness: 0.55 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    root.add(floor);

    // Round rug under the infield
    const rugTex = canvasTexture(1024, 1024, (g, w) => {
      const rings = ['#4cc9f0', '#ffffff', '#f72585', '#ffffff', '#ffd43b', '#ffffff', '#4cc9f0', '#7209b7'];
      for (let i = 0; i < rings.length; i++) {
        g.fillStyle = rings[i];
        g.beginPath();
        g.arc(w / 2, w / 2, (w / 2) * (1 - i / rings.length), 0, Math.PI * 2);
        g.fill();
      }
      const r = mulberry32(3);
      for (let i = 0; i < 20000; i++) {
        g.fillStyle = `rgba(0,0,0,${r() * 0.05})`;
        g.fillRect(r() * w, r() * w, 2, 2);
      }
    });
    const rug = new THREE.Mesh(
      new THREE.CircleGeometry(0.62, 64),
      new THREE.MeshStandardMaterial({ map: rugTex, roughness: 1 })
    );
    rug.rotation.x = -Math.PI / 2;
    rug.position.set(-0.05, 0.0006, 0.17);
    rug.receiveShadow = true;
    root.add(rug);

    // Walls with simple striped wallpaper + skirting board
    const wallTex = canvasTexture(256, 256, (g, w, h) => {
      g.fillStyle = '#bfe3f2';
      g.fillRect(0, 0, w, h);
      g.fillStyle = '#d6eef8';
      for (let x = 0; x < w; x += 32) g.fillRect(x, 0, 14, h);
      g.fillStyle = 'rgba(255,255,255,0.6)';
      for (let i = 0; i < 18; i++) {
        const x = (i * 53) % w;
        const y = (i * 97) % h;
        g.beginPath();
        g.arc(x, y, 5, 0, Math.PI * 2);
        g.fill();
      }
    }, { repeat: [12, 5] });
    const wallMat = new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.9 });
    const skirtMat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.5 });
    const roomHalf = 2.4;
    for (let wI = 0; wI < 4; wI++) {
      const wall = new THREE.Mesh(new THREE.PlaneGeometry(roomHalf * 2, 2.6), wallMat);
      const a = (wI * Math.PI) / 2;
      wall.position.set(Math.sin(a) * roomHalf, 1.3, Math.cos(a) * roomHalf);
      wall.rotation.y = a + Math.PI;
      root.add(wall);
      const skirt = new THREE.Mesh(new THREE.BoxGeometry(roomHalf * 2, 0.08, 0.02), skirtMat);
      skirt.position.set(Math.sin(a) * (roomHalf - 0.01), 0.04, Math.cos(a) * (roomHalf - 0.01));
      skirt.rotation.y = a;
      root.add(skirt);
    }

    // Helper: is a footprint clear of the road?
    const clear = (x, z, r) => prox.nearest(x, z, 3).dist > halfW + 0.02 + r;

    // Giant alphabet blocks
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const blockColors = ['#ff595e', '#ffca3a', '#8ac926', '#1982c4', '#6a4c93', '#ff924c'];
    const makeBlockMats = (letter, color) => {
      const tex = canvasTexture(256, 256, (g, w) => {
        g.fillStyle = '#fdf6e3';
        g.fillRect(0, 0, w, w);
        g.fillStyle = color;
        g.fillRect(14, 14, w - 28, w - 28);
        g.fillStyle = '#ffffff';
        g.font = 'bold 170px Georgia, serif';
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText(letter, w / 2, w / 2 + 8);
      });
      return new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6 });
    };
    let placed = 0;
    for (let tries = 0; tries < 400 && placed < 26; tries++) {
      const s = 0.07 + rng() * 0.06;
      const x = (rng() * 2 - 1) * 1.9;
      const z = (rng() * 2 - 1) * 1.9;
      if (!clear(x, z, s)) continue;
      const mat = makeBlockMats(letters[placed % 26], blockColors[placed % blockColors.length]);
      const block = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), mat);
      block.position.set(x, s / 2, z);
      block.rotation.y = rng() * Math.PI;
      block.castShadow = true;
      block.receiveShadow = true;
      root.add(block);
      // Sometimes stack a second one
      if (rng() < 0.35) {
        const s2 = s * 0.85;
        const top = new THREE.Mesh(new THREE.BoxGeometry(s2, s2, s2), makeBlockMats(letters[(placed + 7) % 26], blockColors[(placed + 2) % 6]));
        top.position.set(x, s + s2 / 2, z);
        top.rotation.y = rng() * Math.PI;
        top.castShadow = true;
        root.add(top);
      }
      placed++;
    }

    // Building bricks with studs
    const brickColors = ['#e63946', '#2a9d8f', '#f4a261', '#457b9d', '#ffd166', '#06d6a0'];
    const studGeo = new THREE.CylinderGeometry(0.0055, 0.0055, 0.004, 16);
    for (let n = 0, tries = 0; n < 30 && tries < 600; tries++) {
      const w = 0.032 * (1 + Math.floor(rng() * 3));
      const d = 0.032 * (rng() < 0.5 ? 1 : 2);
      const hgt = 0.038;
      const x = (rng() * 2 - 1) * 1.8;
      const z = (rng() * 2 - 1) * 1.8;
      if (!clear(x, z, Math.max(w, d) * 0.7)) continue;
      const mat = new THREE.MeshStandardMaterial({ color: brickColors[n % brickColors.length], roughness: 0.3 });
      const brick = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(w, hgt, d), mat);
      body.position.y = hgt / 2;
      body.castShadow = true;
      body.receiveShadow = true;
      brick.add(body);
      for (let sx = 0; sx < w / 0.016; sx++) {
        for (let sz = 0; sz < d / 0.016; sz++) {
          const stud = new THREE.Mesh(studGeo, mat);
          stud.position.set(-w / 2 + 0.008 + sx * 0.016, hgt + 0.002, -d / 2 + 0.008 + sz * 0.016);
          brick.add(stud);
        }
      }
      brick.position.set(x, 0, z);
      brick.rotation.y = rng() * Math.PI;
      root.add(brick);
      n++;
    }

    // Crayons lying on the floor
    const crayonColors = ['#e63946', '#1d3557', '#2a9d8f', '#ffb703', '#8338ec', '#fb5607', '#06d6a0'];
    for (let n = 0, tries = 0; n < 22 && tries < 500; tries++) {
      const x = (rng() * 2 - 1) * 1.7;
      const z = (rng() * 2 - 1) * 1.7;
      if (!clear(x, z, 0.06)) continue;
      const col = crayonColors[n % crayonColors.length];
      const mat = new THREE.MeshStandardMaterial({ color: col, roughness: 0.65 });
      const crayon = new THREE.Group();
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.09, 10), mat);
      const tip = new THREE.Mesh(new THREE.ConeGeometry(0.006, 0.016, 10), mat);
      tip.position.y = 0.053;
      const label = new THREE.Mesh(
        new THREE.CylinderGeometry(0.0062, 0.0062, 0.05, 10),
        new THREE.MeshStandardMaterial({ color: '#f1f1f1', roughness: 0.8 })
      );
      crayon.add(body, tip, label);
      crayon.rotation.z = Math.PI / 2;
      crayon.rotation.y = rng() * Math.PI;
      crayon.position.set(x, 0.006, z);
      crayon.traverse((c) => {
        c.castShadow = true;
      });
      root.add(crayon);
      n++;
    }

    // Beach ball
    const ballTex = canvasTexture(512, 256, (g, w, h) => {
      const cols = ['#ff595e', '#ffffff', '#1982c4', '#ffffff', '#ffca3a', '#ffffff'];
      cols.forEach((c, i) => {
        g.fillStyle = c;
        g.fillRect((i * w) / cols.length, 0, w / cols.length + 1, h);
      });
    });
    for (let tries = 0; tries < 200; tries++) {
      const x = (rng() * 2 - 1) * 1.6;
      const z = (rng() * 2 - 1) * 1.6;
      if (!clear(x, z, 0.2)) continue;
      const ball = new THREE.Mesh(
        new THREE.SphereGeometry(0.16, 40, 24),
        new THREE.MeshStandardMaterial({ map: ballTex, roughness: 0.3 })
      );
      ball.position.set(x, 0.16, z);
      ball.rotation.set(0.4, rng() * 3, 0.2);
      ball.castShadow = true;
      root.add(ball);
      break;
    }

    // Stack of books under the highest point of the track (the bridge)
    let topI = 0;
    track.samples.forEach((s, i) => {
      if (s.position[1] > track.samples[topI].position[1]) topI = i;
    });
    const topS = track.samples[topI];
    const bridgeH = topS.position[1] - 0.004;
    const bookColors = ['#264653', '#e76f51', '#2a9d8f', '#e9c46a', '#8d99ae'];
    let y = 0;
    const heading = Math.atan2(topS.tangent[0], topS.tangent[2]);
    let bi = 0;
    while (y < bridgeH - 0.002) {
      const th = Math.min(0.011 + rng() * 0.006, bridgeH - y);
      const book = new THREE.Group();
      const coverMat = new THREE.MeshStandardMaterial({ color: bookColors[bi % bookColors.length], roughness: 0.7 });
      const cover = new THREE.Mesh(new THREE.BoxGeometry(0.11, th, 0.15), coverMat);
      const pages = new THREE.Mesh(
        new THREE.BoxGeometry(0.104, th * 0.8, 0.146),
        new THREE.MeshStandardMaterial({ color: '#f7f1e3', roughness: 0.9 })
      );
      pages.position.x = 0.004;
      book.add(cover, pages);
      book.position.set(topS.position[0], y + th / 2, topS.position[2]);
      book.rotation.y = heading + Math.PI / 2 + (rng() - 0.5) * 0.25;
      book.traverse((c) => {
        c.castShadow = true;
        c.receiveShadow = true;
      });
      root.add(book);
      y += th;
      bi++;
    }

    return {
      root,
      update(dt, t, focus) {
        sun.follow(focus);
      },
    };
  },
};
