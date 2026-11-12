// 小さな道具（ブラウザと Node の両方で使う）
export const MIN = 60 * 1000;

export function dist(a, b) {
  const ky = 110940, kx = 111320 * Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180);
  return Math.hypot((a.lat - b.lat) * ky, (a.lon - b.lon) * kx);
}

// 種を決めると同じ並びになる乱数
export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function poisson(rand, mean) {
  const limit = Math.exp(-mean);
  let k = 0, p = 1;
  do { k++; p *= rand(); } while (p > limit);
  return k - 1;
}

export const floorTo = (t, step) => Math.floor(t / step) * step;
export const ceilTo = (t, step) => Math.ceil(t / step) * step;

export function hhmm(t) {
  const d = new Date(t);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}
export const windowText = (w) => `${hhmm(w[0])}〜${hhmm(w[1])}`;

// 「大島3-5」「大島3-6」→「大島3-5・6」
export function stopName(labels) {
  const groups = new Map();
  for (const l of labels) {
    const i = l.lastIndexOf('-');
    const head = l.slice(0, i);
    if (!groups.has(head)) groups.set(head, []);
    groups.get(head).push(l.slice(i + 1));
  }
  return [...groups].map(([head, nos]) => `${head}-${nos.join('・')}`).join('／');
}
