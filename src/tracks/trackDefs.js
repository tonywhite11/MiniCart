/**
 * Track layouts, one per world. Points are [x, y, z] in metres (kart is ~7mm long),
 * listed in driving order. The first point is the start/finish line, so keep a
 * straight run through it. y is height above the world's ground (0).
 */

export const TRACK_DEFS = {
  // Rolling grassy hills: fast sweepers, a crest, an S-chicane and a long back straight
  outdoor: {
    name: 'Sunny Hills Circuit',
    width: 0.036,
    maxBankDeg: 12,
    points: [
      [0.0, 0.004, 0.62],
      [0.4, 0.004, 0.62],
      [0.78, 0.012, 0.56],
      [1.0, 0.03, 0.34],
      [1.02, 0.05, 0.02],
      [0.86, 0.06, -0.26],
      [0.56, 0.05, -0.36],
      [0.3, 0.03, -0.2],
      [0.1, 0.018, -0.02],
      [-0.12, 0.018, -0.06],
      [-0.3, 0.03, -0.3],
      [-0.56, 0.05, -0.46],
      [-0.86, 0.04, -0.36],
      [-1.0, 0.025, -0.06],
      [-0.92, 0.012, 0.32],
      [-0.6, 0.004, 0.56],
      [-0.3, 0.004, 0.62],
    ],
  },

  // Kid's bedroom floor: plastic toy track with a bridge over a stack of books
  toyroom: {
    name: 'Toybox Rally',
    width: 0.036,
    aiPace: 1.07, // Tight corners slow the AI more than a wall-scraping player
    maxBankDeg: 10,
    points: [
      [0.0, 0.003, 0.55],
      [0.36, 0.003, 0.55],
      [0.68, 0.003, 0.46],
      [0.86, 0.003, 0.2],
      [0.8, 0.003, -0.08],
      [0.56, 0.02, -0.2],
      [0.3, 0.05, -0.22],
      [0.04, 0.062, -0.22],
      [-0.22, 0.05, -0.22],
      [-0.48, 0.02, -0.26],
      [-0.74, 0.003, -0.4],
      [-0.96, 0.003, -0.2],
      [-0.94, 0.003, 0.12],
      [-0.72, 0.003, 0.26],
      [-0.46, 0.003, 0.24],
      [-0.3, 0.003, 0.4],
      [-0.14, 0.003, 0.55],
    ],
  },

  // Synthwave city: long boulevards, squared-off corners and an elevated skyway
  neon: {
    name: 'Neon Drive',
    width: 0.038,
    aiPace: 1.03,
    maxBankDeg: 8,
    points: [
      [0.0, 0.003, 0.58],
      [0.5, 0.003, 0.58],
      [0.86, 0.003, 0.52],
      [0.98, 0.003, 0.24],
      [0.98, 0.003, -0.1],
      [0.88, 0.02, -0.36],
      [0.6, 0.06, -0.48],
      [0.2, 0.08, -0.48],
      [-0.2, 0.08, -0.48],
      [-0.58, 0.06, -0.46],
      [-0.84, 0.03, -0.32],
      [-0.92, 0.01, -0.04],
      [-0.7, 0.003, 0.12],
      [-0.42, 0.003, 0.2],
      [-0.3, 0.003, 0.42],
      [-0.12, 0.003, 0.58],
    ],
  },
};

export const WORLD_ORDER = ['outdoor', 'toyroom', 'neon'];
