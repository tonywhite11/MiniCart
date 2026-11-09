/**
 * Difficulty ladder. Each world keeps its own progress: win a race to unlock
 * (and move up to) the next level.
 *
 * pace            — multiplies every rival's speed
 * easeWhenAhead   — how much rivals slow down while they lead the player
 * pushWhenBehind  — how much rivals speed up while the player leads them
 * cornerTurbo     — chance a rival fires a mini-turbo out of each corner
 */
export const DIFFICULTY_LEVELS = [
  { key: 'rookie', name: 'ROOKIE', pace: 0.93, easeWhenAhead: 0.1, pushWhenBehind: 0.03, cornerTurbo: 0 },
  { key: 'pro', name: 'PRO', pace: 1.0, easeWhenAhead: 0.07, pushWhenBehind: 0.07, cornerTurbo: 0.35 },
  { key: 'expert', name: 'EXPERT', pace: 1.05, easeWhenAhead: 0.04, pushWhenBehind: 0.085, cornerTurbo: 0.7 },
  { key: 'champion', name: 'CHAMPION', pace: 1.09, easeWhenAhead: 0.02, pushWhenBehind: 0.1, cornerTurbo: 1.0 },
];

const storageKey = (world) => `minicart.progress.${world}`;

/** { unlocked: highest unlocked index, selected: index chosen for the next race } */
export function loadProgress(world) {
  try {
    const raw = window.localStorage.getItem(storageKey(world));
    if (raw) {
      const p = JSON.parse(raw);
      const max = DIFFICULTY_LEVELS.length - 1;
      const unlocked = Math.min(max, Math.max(0, p.unlocked | 0));
      return { unlocked, selected: Math.min(unlocked, Math.max(0, p.selected | 0)) };
    }
  } catch {
    // Storage unavailable or corrupt: start fresh
  }
  return { unlocked: 0, selected: 0 };
}

export function saveProgress(world, progress) {
  try {
    window.localStorage.setItem(storageKey(world), JSON.stringify(progress));
  } catch {
    // Progress just won't persist this session
  }
}
