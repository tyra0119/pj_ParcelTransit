// デモの「業者のサーバ」を、利用者のページと業者のページで共有する。
// 本物のサーバがない代わりに、どちらのページも同じ模擬を手元で動かし、
//  - 時計（いつ始めたか・速さ）
//  - 操作の記録（集荷の依頼・不在の連絡）
// を localStorage に置いて BroadcastChannel で知らせ合う。模擬は決定的なので、同じ記録から同じ状態になる。
import { DemoServer } from './api.js';

const KEY = 'nimotsu-demo-v4';
const channel = 'BroadcastChannel' in window ? new BroadcastChannel(KEY) : null;

function load() {
  try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; }
}
function fresh() {
  const now = Date.now();
  return { seed: Math.floor(now / 86400e3), simStart: now, simBase: now, realBase: now, speed: 30, actions: [] };
}

export class SharedDemo {
  constructor(area) {
    this.area = area;
    this.listeners = new Set();
    this.#reset(load() ?? fresh());
    window.addEventListener('storage', (e) => { if (e.key === KEY) this.#sync(); });
    channel?.addEventListener('message', () => this.#sync());
  }

  #reset(state) {
    this.state = state;
    this.server = new DemoServer(this.area, state.simStart, state.seed);
    this.applied = 0;
    this.log = []; // 操作と結果（業者のページで一覧に出す）
    this.#save();
    this.#catchUp();
  }

  #save() { localStorage.setItem(KEY, JSON.stringify(this.state)); }
  #notify() { channel?.postMessage('changed'); }

  // まだ反映していない操作を、その時刻に戻して順に行う
  #catchUp() {
    const acts = this.state.actions;
    for (; this.applied < acts.length; this.applied++) {
      const a = acts[this.applied];
      this.server.tick(a.t);
      const result = a.type === 'pickup' ? this.server.requestPickup(a.args, a.t)
        : a.type === 'redeliver' ? this.server.redeliver(a.args, a.t)
        : a.type === 'away' ? this.server.away(a.args.qr, a.t)
        : this.server.absent(a.args.qr, a.t);
      this.log.push({ ...a, result });
    }
  }

  #sync() {
    const s = load();
    if (!s) return;
    if (s.simStart !== this.state.simStart) { this.#reset(s); this.#emit('reset'); return; }
    this.state = s;
    const before = this.applied;
    this.#catchUp();
    this.#emit(this.applied > before ? 'action' : 'clock');
  }

  on(fn) { this.listeners.add(fn); }
  #emit(kind) { for (const fn of this.listeners) fn(kind); }

  get speed() { return this.state.speed; }
  now() { return this.state.simBase + (Date.now() - this.state.realBase) * this.state.speed; }

  setSpeed(speed) {
    const now = this.now();
    Object.assign(this.state, { simBase: now, realBase: Date.now(), speed });
    this.#save(); this.#notify();
  }

  restart() { this.#reset(fresh()); this.#notify(); this.#emit('reset'); }

  #act(type, args) {
    const t = this.now();
    this.server.tick(t);
    // ほかのページの操作を先に取りこんでから記録する
    const s = load();
    if (s && s.simStart === this.state.simStart) { this.state = s; this.#catchUp(); }
    this.state.actions.push({ type, args, t });
    this.#save();
    this.#catchUp();
    this.#notify();
    return this.log.at(-1).result;
  }

  // ---- 窓口 ----
  tick() { this.server.tick(this.now()); }
  snapshot() { return this.server.snapshot(this.now()); }
  realtime() { return this.server.realtime(this.now()); }
  requestPickup(args) { return this.#act('pickup', args); }
  absent(qr) { return this.#act('absent', { qr }); }
  redeliver(args) { return this.#act('redeliver', args); }
  away(qr) { return this.#act('away', { qr }); }
  mail(key) { return this.server.mail(key, this.now()); }
  sampleParcel() { return this.server.sampleParcel(this.now()); }
  carrierView() { return this.server.carrierView(this.now()); }
}
