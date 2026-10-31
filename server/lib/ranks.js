'use strict';

// Pure rank maths. Thresholds live in app_settings.rank_thresholds and are
// passed in, so the frontend never hardcodes them.

const DEFAULT_THRESHOLDS = Object.freeze([
  { name: 'Rookie', minXp: 0 },
  { name: 'Regular', minXp: 100 },
  { name: 'Star', minXp: 300 },
  { name: 'Master', minXp: 700 },
  { name: 'Elite', minXp: 1500 },
  { name: 'Ultimate', minXp: 3000 },
]);

function normalizeThresholds(list) {
  if (!Array.isArray(list) || list.length < 2 || list.length > 12) throw new Error('rank_thresholds must have 2–12 ranks');
  const out = list.map((r) => {
    if (!r || typeof r.name !== 'string' || !/^[A-Za-z ]{2,16}$/.test(r.name) || !Number.isInteger(r.minXp) || r.minXp < 0) {
      throw new Error('each rank needs a 2–16 letter name and a non-negative integer minXp');
    }
    return { name: r.name, minXp: r.minXp };
  });
  if (out[0].minXp !== 0) throw new Error('the first rank must start at 0 XP');
  for (let i = 1; i < out.length; i++) {
    if (out[i].minXp <= out[i - 1].minXp) throw new Error('rank thresholds must strictly increase');
  }
  return out;
}

/** Returns { index, name, minXp, nextName, nextMinXp, progress (0..1) }. */
function rankFor(xp, thresholds = DEFAULT_THRESHOLDS) {
  let i = 0;
  while (i + 1 < thresholds.length && xp >= thresholds[i + 1].minXp) i++;
  const cur = thresholds[i];
  const next = thresholds[i + 1] || null;
  const progress = next ? (xp - cur.minXp) / (next.minXp - cur.minXp) : 1;
  return {
    index: i,
    name: cur.name,
    minXp: cur.minXp,
    nextName: next ? next.name : null,
    nextMinXp: next ? next.minXp : null,
    progress: Math.max(0, Math.min(1, progress)),
  };
}

module.exports = { DEFAULT_THRESHOLDS, normalizeThresholds, rankFor };
