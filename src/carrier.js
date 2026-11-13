// 業者層（非公開）の模擬。
// 実際の住所・配達か集荷かの区別・巡回順を持つのはここだけ。
// 本番では業者のサーバーの中にあり、外へ出るのは publisher.js が作る公開層と、
// 追跡番号を持つ本人に返す personal() の結果だけ。
import { MIN, dist, rng, poisson, floorTo, ceilTo } from './util.js';

export const RULES = {
  ratePerHousehold: 0.007, // 1便で1世帯あたりに届く荷物の数（模擬）
  pickupShare: 0.15,       // そのうち集荷の割合
  speed: 4.2,              // m/秒（時速15km ほど）
  detour: 1.35,            // 直線距離に対する道のりの倍率
  dwellBase: 60 * 1000,    // 停留所1つあたりの停車
  dwellPerItem: 45 * 1000, // 荷物1つあたりの停車
  capacity: 260,           // 荷台の大きさ（60サイズ=1 の単位。1便 60〜100個 ≒ 140〜230）
  maxDetour: 8 * MIN,      // 集荷1件のために延びてよい時間
  endSlack: 20 * MIN,      // 便の終了予定からの遅れの上限
  pickupCutoff: 20 * MIN,  // 便の終了予定のこれだけ前に集荷受付を締め切る
  mergeRadius: 200,        // 1件だけの街区をまとめる相手を探す範囲（m）
  restBetweenTrips: 10 * MIN,
};
export const SIZE_UNITS = { 60: 1, 80: 2, 100: 3, 120: 5 };
// 宅配会社（どちらも架空）。隣り合う受け持ちが別の会社になるように分ける
export const COMPANIES = { A: { id: 'A', name: 'A社' }, B: { id: 'B', name: 'B社' } };
export const ZONE_COMPANY = { K1: 'A', K2: 'B', K3: 'A', O1: 'B', O2: 'A', O3: 'B' };
const SIZES = [60, 60, 60, 80, 80, 100, 120];

export class Carrier {
  constructor(area, { seed = 1, now = Date.now(), warm = true } = {}) {
    this.area = area;
    // 乱数は便ごと・集荷依頼ごとに別の流れにする。時間の進め方（tick の呼び方）が違っても、
    // 同じ操作を同じ順に行えば同じ結果になる（利用者のページと業者のページで同じ状態を作るため）
    this.seed = seed;
    this.reqRand = rng(seed * 7919 + 1);
    this.blocks = new Map(area.blocks.map((b) => [b.id, b]));
    this.finished = new Set();
    this.stats = { pickupsAccepted: 0, pickupsDeclined: 0, extraMs: 0, absentAvoided: 0, savedMs: 0, missed: 0, redelivered: 0 };
    this.held = new Map();    // 合言葉 → 持ち戻った荷物（便が終わったあと、再配達の依頼を待つもの）
    this.mailbox = new Map(); // 合言葉 → 新しいお届けQR（メールで届ける代わり）
    this.carry = new Map();   // 便 → 次の便に回す荷物（不在を先に伝えたもの）
    this.trucks = area.zones.map((z, i) => {
      const company = z.company ?? ZONE_COMPANY[z.id] ?? 'A';
      const truck = { id: z.id, name: `${COMPANIES[company].name} ${z.name}`, company, idx: i, tripNo: 0 };
      this.#newTrip(truck, now);
      // デモでは便の進み具合をずらして始める
      if (warm) this.#shift(truck, -(0.08 + 0.1 * i) * (truck.end - truck.start));
      return truck;
    });
  }

  // ---- 便を作る ----
  #newTrip(truck, start) {
    const R = RULES;
    truck.tripNo += 1;
    const rand = rng(this.seed * 1009 + truck.idx * 100003 + truck.tripNo * 7);
    truck.tripId = `${truck.id}-${truck.tripNo}`;
    truck.start = start;
    truck.items = new Map();
    const zoneBlocks = this.area.blocks.filter((b) => b.zone === truck.id);
    let groups = [];
    for (const b of zoneBlocks) {
      const n = poisson(rand, b.hh * R.ratePerHousehold);
      if (!n) continue;
      const nos = [];
      for (let k = 0; k < n; k++) {
        const item = this.#makeItem(b, rand() < R.pickupShare ? 'pickup' : 'delivery', SIZES[Math.floor(rand() * SIZES.length)], rand);
        truck.items.set(item.no, item);
        nos.push(item.no);
      }
      groups.push({ blockIds: [b.id], itemNos: nos });
    }
    // 前の便で「不在」と伝えられた荷物は、この便で届ける（合言葉はそのまま）
    const carried = this.carry.get(truck.id) ?? [];
    this.carry.delete(truck.id);
    for (const it of carried) {
      it.absent = false;
      truck.items.set(it.no, it);
      const g = groups.find((x) => x.blockIds.includes(it.blockId));
      if (g) g.itemNos.push(it.no); else groups.push({ blockIds: [it.blockId], itemNos: [it.no] });
    }
    groups = this.#mergeSingles(groups, zoneBlocks);
    truck.stops = this.#order(groups.map((g, i) => this.#makeStop(truck, g, i)));
    truck.stopSerial = truck.stops.length;
    this.#reschedule(truck, 0);
    truck.plannedEnd = truck.end;
    // 回した荷物には、新しい便のお届けQRをお知らせで届ける
    for (const it of carried) this.mailbox.set(it.key, this.qrOf(it.no));
  }

  #makeItem(block, type, size, rand) {
    const no = `4912-${String(Math.floor(rand() * 1e4)).padStart(4, '0')}-${String(Math.floor(rand() * 1e4)).padStart(4, '0')}`;
    // 家の位置（模擬）。街区の代表点のまわり。公開層には出さない
    // 合言葉: その荷物の不在の連絡などに使う。QR に入れて本人に渡す
    const key = Array.from({ length: 4 }, () => Math.floor(rand() * 65536).toString(16).padStart(4, '0')).join('');
    return {
      no, key, type, size, blockId: block.id, absent: false,
      lat: block.lat + (rand() - 0.5) * 0.0004, lon: block.lon + (rand() - 0.5) * 0.0005,
    };
  }

  // プライバシーの決まり: 1件だけの街区は、隣の街区とまとめる
  #mergeSingles(groups, zoneBlocks) {
    const center = (g) => this.#center(g.blockIds);
    for (;;) {
      const single = groups.find((g) => g.itemNos.length === 1 && g.blockIds.length === 1);
      if (!single) return groups;
      const c = center(single);
      let best = null, bestD = RULES.mergeRadius;
      for (const g of groups) {
        if (g === single) continue;
        const d = dist(c, center(g));
        if (d < bestD) { best = g; bestD = d; }
      }
      if (best) {
        best.blockIds.push(...single.blockIds);
        best.itemNos.push(...single.itemNos);
        groups = groups.filter((g) => g !== single);
      } else {
        // 近くに荷物のある街区がなければ、荷物のない隣の街区を足す
        const used = new Set(groups.flatMap((g) => g.blockIds));
        const near = this.#nearestBlock(c, zoneBlocks, used);
        if (!near) return groups;
        single.blockIds.push(near.id);
      }
    }
  }

  #nearestBlock(point, candidates, exclude) {
    let best = null, bestD = Infinity;
    for (const b of candidates) {
      if (exclude.has(b.id)) continue;
      const d = dist(point, b);
      if (d < bestD) { best = b; bestD = d; }
    }
    return best;
  }

  #center(blockIds) {
    let lat = 0, lon = 0;
    for (const id of blockIds) { const b = this.blocks.get(id); lat += b.lat; lon += b.lon; }
    return { lat: lat / blockIds.length, lon: lon / blockIds.length };
  }

  #makeStop(truck, group, serial) {
    return { id: `${truck.tripId}-${serial + 1}`, blockIds: group.blockIds, itemNos: group.itemNos, ...this.#center(group.blockIds) };
  }

  // 巡回順: 近い順につないでから、交差をほどく（2-opt）
  #order(stops) {
    const depot = this.area.depot;
    const rest = [...stops], route = [];
    let cur = depot;
    while (rest.length) {
      let bi = 0;
      for (let i = 1; i < rest.length; i++) if (dist(cur, rest[i]) < dist(cur, rest[bi])) bi = i;
      cur = rest.splice(bi, 1)[0];
      route.push(cur);
    }
    const at = (i) => (i < 0 || i >= route.length ? depot : route[i]);
    for (let improved = true, guard = 0; improved && guard < 50; guard++) {
      improved = false;
      for (let i = 0; i < route.length - 1; i++) {
        for (let j = i + 1; j < route.length; j++) {
          const before = dist(at(i - 1), at(i)) + dist(at(j), at(j + 1));
          const after = dist(at(i - 1), at(j)) + dist(at(i), at(j + 1));
          if (after < before - 1) {
            route.splice(i, j - i + 1, ...route.slice(i, j + 1).reverse());
            improved = true;
          }
        }
      }
    }
    return route;
  }

  #travel(a, b) { return (dist(a, b) * RULES.detour / RULES.speed) * 1000; }

  #dwell(truck, stop) {
    const n = stop.itemNos.filter((no) => !truck.items.get(no).absent).length;
    return n ? RULES.dwellBase + RULES.dwellPerItem * n : 0;
  }

  // from 番目より後ろの到着・出発の時刻を計算しなおす
  // 荷物が全部「不在」の停留所には寄らない（skip）
  #reschedule(truck, from) {
    const depot = this.area.depot;
    let prev = this.#lastVisited(truck, from);
    for (let i = from; i < truck.stops.length; i++) {
      const s = truck.stops[i];
      s.skip = this.#dwell(truck, s) === 0;
      if (s.skip) { s.arrive = s.depart = prev.depart; continue; }
      s.arrive = prev.depart + this.#travel(prev, s);
      s.depart = s.arrive + this.#dwell(truck, s);
      prev = s;
    }
    truck.end = prev.depart + this.#travel(prev, depot);
  }

  #lastVisited(truck, before) {
    for (let i = before - 1; i >= 0; i--) if (!truck.stops[i].skip) return truck.stops[i];
    return { ...this.area.depot, depart: truck.start };
  }

  #shift(truck, ms) {
    truck.start += ms; truck.end += ms; truck.plannedEnd += ms;
    for (const s of truck.stops) { s.arrive += ms; s.depart += ms; }
  }

  // ---- 時間を進める ----
  tick(now) {
    for (const truck of this.trucks) {
      // 次の便は「前の便が戻って休憩を終えた時刻」に出る（呼ばれた時刻によらない）
      while (now > truck.end + RULES.restBetweenTrips) {
        const absent = [...truck.items.values()].filter((it) => it.absent);
        if (absent.length) this.carry.set(truck.id, absent);
        for (const it of truck.items.values()) {
          if (it.away) { this.held.set(it.key, { item: it, company: truck.company }); continue; }
          if (!it.absent) this.finished.add(it.no);
        }
        this.#newTrip(truck, truck.end + RULES.restBetweenTrips);
      }
    }
  }

  // まだ着いていない最初の停留所の番号
  nextIndex(truck, t) {
    const i = truck.stops.findIndex((s) => s.arrive > t);
    return i < 0 ? truck.stops.length : i;
  }

  // トラックの本当の位置（業者層）
  truePosition(truck, t) {
    const depot = this.area.depot, stops = truck.stops;
    if (t <= truck.start || t >= truck.end) return { lat: depot.lat, lon: depot.lon, moving: false, atDepot: true };
    let k = this.nextIndex(truck, t);
    while (k < stops.length && stops[k].skip) k++;
    const prev = this.#lastVisited(truck, k);
    if (t < prev.depart) return { lat: prev.lat, lon: prev.lon, moving: false };
    const next = k === stops.length ? { ...depot, arrive: truck.end } : stops[k];
    const f = Math.min(1, (t - prev.depart) / Math.max(1, next.arrive - prev.depart));
    return { lat: prev.lat + (next.lat - prev.lat) * f, lon: prev.lon + (next.lon - prev.lon) * f, moving: true };
  }

  // 集荷を受け付けているか（公開してよい情報）
  acceptance(truck, t) {
    const deadline = truck.plannedEnd - RULES.pickupCutoff;
    const remaining = truck.stops.length - this.nextIndex(truck, t);
    return { accepting: t > truck.start && t < deadline && remaining >= 2, deadline };
  }

  #load(truck, t) {
    let units = 0;
    for (const s of truck.stops) {
      for (const no of s.itemNos) {
        const it = truck.items.get(no);
        const done = s.depart <= t;
        // これから降ろす配達と、積んだ・これから積む集荷を合わせて見る（安全側）
        if (it.type === 'delivery' ? !done : !it.absent) units += SIZE_UNITS[it.size];
      }
    }
    return units;
  }

  // ---- 便に寄り道を足せるか（集荷・再配達で使う）----
  #plan(truck, blockId, size, t, reasons) {
    const block = this.blocks.get(blockId);
    if (!this.acceptance(truck, t).accepting) { reasons.add('受付を締め切っています'); return null; }
    if (this.#load(truck, t) + SIZE_UNITS[size] > RULES.capacity) { reasons.add('荷台に余裕がありません'); return null; }
    const k = this.nextIndex(truck, t);
    const stops = truck.stops, depot = this.area.depot;
    let plan = null;
    const existing = stops.findIndex((st, i) => i >= k && st.blockIds.includes(blockId));
    if (existing >= 0) {
      plan = { truck, existing, extra: RULES.dwellPerItem };
    } else {
      const here = { lat: block.lat, lon: block.lon };
      for (let q = k + 1; q <= stops.length; q++) {
        if (q < stops.length && stops[q].skip) continue;
        const from = this.#lastVisited(truck, q), to = q === stops.length ? depot : stops[q];
        const extra = this.#travel(from, here) + this.#travel(here, to) - this.#travel(from, to) + RULES.dwellBase + RULES.dwellPerItem;
        if (!plan || extra < plan.extra) plan = { truck, insertAt: q, extra };
      }
    }
    if (!plan) { reasons.add('近くに便がありません'); return null; }
    if (plan.extra > RULES.maxDetour) { reasons.add('寄り道が長くなりすぎます'); return null; }
    if (truck.end + plan.extra > truck.plannedEnd + RULES.endSlack) { reasons.add('便の終了時刻に間に合いません'); return null; }
    return plan;
  }

  #insert(plan, item) {
    const truck = plan.truck, block = this.blocks.get(item.blockId);
    truck.items.set(item.no, item);
    const oldEnd = truck.end;
    let stop;
    if (plan.existing !== undefined) {
      stop = truck.stops[plan.existing];
      stop.itemNos.push(item.no);
      this.#reschedule(truck, plan.existing);
    } else {
      // 1件だけの街区にならないよう、隣の街区とまとめて停留所にする
      const used = new Set(truck.stops.flatMap((st) => st.blockIds).concat(block.id));
      const zoneBlocks = this.area.blocks.filter((b) => b.zone === block.zone);
      const near = this.#nearestBlock(block, zoneBlocks, used);
      truck.stopSerial += 1;
      stop = this.#makeStop(truck, { blockIds: near ? [block.id, near.id] : [block.id], itemNos: [item.no] }, truck.stopSerial - 1);
      stop.lat = block.lat; stop.lon = block.lon;
      truck.stops.splice(plan.insertAt, 0, stop);
      this.#reschedule(truck, plan.insertAt);
    }
    return { stop, extraMs: truck.end - oldEnd };
  }

  // ---- 集荷の依頼 ----
  // company: 'A' / 'B'（業者指定）か、無し（未指定: 寄り道がいちばん小さい便を選ぶ）
  requestPickup({ blockId, lat, lon, size, company }, t) {
    const block = this.blocks.get(blockId);
    const reasons = new Set();
    let best = null;
    for (const truck of this.trucks) {
      if (company && truck.company !== company) continue;
      const plan = this.#plan(truck, blockId, size, t, reasons);
      if (plan && (!best || plan.extra < best.extra)) best = plan;
    }
    if (!best) {
      this.stats.pickupsDeclined += 1;
      const who = company ? `${COMPANIES[company].name}の便は` : '';
      return { ok: false, reason: who + ([...reasons][0] || '近くに便がありません') };
    }
    const item = this.#makeItem(block, 'pickup', size, this.reqRand);
    item.lat = lat; item.lon = lon; item.requested = true;
    const { stop, extraMs } = this.#insert(best, item);
    this.stats.pickupsAccepted += 1;
    this.stats.extraMs += extraMs;
    return {
      ok: true, trackingNo: item.no, truckId: best.truck.id, company: best.truck.company, chosen: company ? 'specified' : 'auto',
      window: this.#window(stop.arrive, t), extraMs, qr: this.qrOf(item.no),
    };
  }

  // ---- 留守（デモ用）と再配達 ----
  // デモ用: 本人が「その時間は留守だった」ことにする。トラックは寄るが渡せず、持ち戻る
  markAway(qr, t) {
    const it = this.#byKey(this.#keyOf(qr));
    if (!it || it.type !== 'delivery') return { ok: false, reason: 'お届けの荷物ではありません' };
    if (this.#missed(it, t)) return { ok: false, reason: 'もう持ち戻っています' };
    const hit = this.#find(it.no);
    if (!hit || hit.truck.stops[hit.index].depart <= t) return { ok: false, reason: 'もう届いています' };
    it.away = true;
    return { ok: true };
  }

  #keyOf(qr) { return new URLSearchParams(String(qr).split('?')[1] ?? '').get('k'); }

  // 留守で持ち戻ったか（寄った停留所を出た後か、便が終わって預かっているか）
  #missed(it, t) {
    if (!it.away) return false;
    if (this.held.has(it.key)) return true;
    const hit = this.#find(it.no);
    return !!hit && hit.truck.stops[hit.index].depart <= t;
  }

  #companyOf(it) {
    const h = this.held.get(it.key);
    if (h) return h.company;
    const hit = this.#find(it.no);
    return hit ? hit.truck.company : null;
  }

  // 申し込み先（書く）: 再配達の依頼。持ち戻った会社の、本人が選んだ便に差し込む
  requestRedelivery({ qr, truckId }, t) {
    const it = this.#byKey(this.#keyOf(qr));
    if (!it || !this.#missed(it, t)) return { ok: false, reason: '再配達の QR が正しくありません' };
    const company = this.#companyOf(it);
    const truck = this.trucks.find((x) => x.id === truckId);
    if (!truck || truck.company !== company) return { ok: false, reason: `${COMPANIES[company].name}の便を選んでください` };
    const reasons = new Set();
    const plan = this.#plan(truck, it.blockId, it.size, t, reasons);
    if (!plan) return { ok: false, reason: `この便は${[...reasons][0]}。ほかの便を選んでください` };
    // 前の便からはずし、選んだ便に入れなおす
    const old = this.#find(it.no);
    if (old) { old.truck.items.delete(it.no); const st = old.truck.stops[old.index]; st.itemNos = st.itemNos.filter((n) => n !== it.no); }
    this.held.delete(it.key);
    it.away = false; it.redelivered = true;
    const { stop } = this.#insert(plan, it);
    this.stats.redelivered += 1;
    return { ok: true, truckId: truck.id, company, window: this.#window(stop.arrive, t), qr: this.qrOf(it.no) };
  }

  // 到着予想の時間幅。遠い先ほど広く取る
  #window(eta, t) {
    const half = Math.min(20 * MIN, Math.max(5 * MIN, (eta - t) * 0.2));
    return [floorTo(eta - half, 5 * MIN), ceilTo(eta + half, 5 * MIN)];
  }

  #find(trackingNo) {
    for (const truck of this.trucks) {
      const item = truck.items.get(trackingNo);
      if (item) return { truck, item, index: truck.stops.findIndex((s) => s.itemNos.includes(trackingNo)) };
    }
    return null;
  }

  // ---- 本人層: 追跡番号を持つ本人だけに返す ----
  personal(trackingNo, t) {
    if (this.finished.has(trackingNo)) return { found: true, status: 'done' };
    const hit = this.#find(trackingNo);
    if (!hit) return { found: false };
    const { truck, item, index } = hit;
    const stop = truck.stops[index];
    const base = { found: true, type: item.type, truckId: truck.id, truckName: truck.name, stopId: stop.id, blockIds: stop.blockIds };
    if (item.absent) return { ...base, status: 'absent' };
    if (stop.depart <= t) return { ...base, status: 'done' };
    if (stop.arrive <= t) return { ...base, status: 'arriving', stopsAway: 0 };
    return {
      ...base, status: 'onway',
      stopsAway: index - this.nextIndex(truck, t) + 1,
      window: this.#window(stop.arrive, t),
      canChange: index > this.nextIndex(truck, t),
    };
  }

  // 本人が「その時間は不在」と先に伝える → この便では寄らず、次の便へ回す
  markAbsent(trackingNo, t) {
    const hit = this.#find(trackingNo);
    if (!hit || hit.item.absent) return false;
    const { truck, item, index } = hit;
    if (index <= this.nextIndex(truck, t)) return false; // もう向かっている
    const oldEnd = truck.end;
    item.absent = true;
    this.#reschedule(truck, index);
    this.stats.absentAvoided += 1;
    this.stats.savedMs += oldEnd - truck.end;
    return true;
  }

  // ---- お届けQR（本人に渡す）----
  // 中身は、便・停留所（街区）・期限・合言葉だけ。住所・名前・追跡番号・配達か集荷かは入れない
  qrOf(no) {
    const hit = this.#find(no);
    if (!hit) return null;
    const stop = hit.truck.stops[hit.index];
    const day = new Date(hit.truck.start + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');
    return `nimotsu:v1?f=${hit.truck.company}&t=${hit.truck.tripId}&s=${stop.id}&e=${day}&k=${hit.item.key}`;
  }

  #byKey(key) {
    for (const truck of this.trucks) for (const it of truck.items.values()) if (it.key === key) return it;
    for (const list of this.carry.values()) for (const it of list) if (it.key === key) return it;
    return this.held.get(key)?.item ?? null;
  }

  // 申し込み先（書く）: QR の合言葉で、その荷物の持ち主と確かめてから受ける
  absentByQr(qr, t) {
    const key = new URLSearchParams(qr.split('?')[1] ?? '').get('k');
    const it = key && this.#byKey(key);
    if (!it) return { ok: false, reason: 'QR が正しくありません' };
    if (it.type !== 'delivery') return { ok: false, reason: '集荷の荷物には使えません' };
    if (it.absent) return { ok: true, already: true };
    return this.markAbsent(it.no, t) ? { ok: true } : { ok: false, reason: 'もうトラックが向かっているため変えられません' };
  }

  // お知らせ（メールの代わり）: 不在で次の便に回したときの、新しいお届けQR
  mail(key, t) {
    const it = this.#byKey(key);
    if (it && this.#missed(it, t)) {
      const day = new Date(t + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');
      return `nimotsu:v1?f=${this.#companyOf(it)}&r=1&e=${day}&k=${key}`;
    }
    return this.mailbox.get(key) ?? null;
  }

  // デモ用: まだ届いていない配達の追跡番号を1つ選ぶ
  sampleTrackingNo(t) {
    const list = [];
    for (const truck of this.trucks) {
      const k = this.nextIndex(truck, t);
      truck.stops.forEach((s, i) => {
        if (i < k + 3) return;
        for (const no of s.itemNos) {
          const it = truck.items.get(no);
          if (it.type === 'delivery' && !it.absent) list.push(no);
        }
      });
    }
    return list.length ? list[Math.floor(Math.random() * list.length)] : null;
  }
}
