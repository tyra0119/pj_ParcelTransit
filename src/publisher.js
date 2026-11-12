// 公開層: 業者層から、誰が見てもよい情報だけを取り出す。
//  - 停留所は街区（の集まり）。家の位置・件数・配達か集荷かは出さない
//  - 数分ごとにまとめて更新する（集荷依頼の直後に地図が変わらない）
//  - トラックの位置は街区の代表点に寄せ、数分遅らせる。停車中は前の表示のまま止める
import { MIN, dist, floorTo, ceilTo, stopName } from './util.js';

export const PUBLISH = {
  period: 3 * MIN, // まとめて更新する間隔
  delay: 3 * MIN,  // 位置を遅らせる時間
};

export class Publisher {
  constructor(carrier) {
    this.carrier = carrier;
    this.blocks = carrier.area.blocks;
    this.cache = null;
  }

  // 街区の代表点に寄せる（受け持ちの街区の中で一番近いもの）
  #coarse(pos, zone) {
    let best = null, bestD = Infinity;
    for (const b of this.blocks) {
      if (b.zone !== zone) continue;
      const d = dist(pos, b);
      if (d < bestD) { best = b; bestD = d; }
    }
    return best;
  }

  // 公開するトラックの位置。停車中なら、止まる前の最後の更新時点の位置のまま
  // （それまでの呼ばれ方によらず決まるように、時刻から計算する）
  #shownPosition(truck, asOf) {
    const c = this.carrier, P = PUBLISH;
    let d = asOf - P.delay;
    for (let guard = 0; guard < 20; guard++) {
      const p = c.truePosition(truck, d);
      if (p.atDepot) return { atDepot: true };
      if (p.moving || d <= truck.start) {
        const b = this.#coarse(p, truck.id);
        return { blockId: b.id, lat: b.lat, lon: b.lon };
      }
      // 止まっている: この停車が始まる前の更新時点へさかのぼる
      const k = c.nextIndex(truck, d);
      const arrive = k > 0 ? truck.stops[k - 1].arrive : truck.start;
      const prev = floorTo(arrive + P.delay - 1, P.period) - P.delay;
      if (prev >= d) break;
      d = prev;
    }
    const b = this.#coarse(c.truePosition(truck, d), truck.id);
    return { blockId: b.id, lat: b.lat, lon: b.lon };
  }

  // 公開層のスナップショット。同じ更新区間のうちは同じものを返す
  snapshot(now) {
    const asOf = floorTo(now, PUBLISH.period);
    if (this.cache && this.cache.asOf === asOf) return this.cache;
    const c = this.carrier;
    const trucks = c.trucks.map((truck) => {
      const k = c.nextIndex(truck, asOf);
      const stops = truck.stops.map((s, i) => ({
        id: s.id,
        seq: i + 1,
        name: stopName(s.blockIds.map((id) => c.blocks.get(id).label)),
        blockIds: [...s.blockIds],
        passed: i < k,
        // 時間幅（GTFS-RT の TripUpdate 相当）。15 分刻みで前後に幅を持たせ、家ごとの時刻にはしない
        window: [floorTo(s.arrive - 10 * MIN, 15 * MIN), ceilTo(s.arrive + 10 * MIN, 15 * MIN)],
      }));
      // 位置: 遅らせ、街区に寄せ、停車中は止める
      const shown = this.#shownPosition(truck, asOf);
      const acc = c.acceptance(truck, asOf);
      return {
        id: truck.id,
        name: truck.name,
        tripId: truck.tripId,
        position: shown.atDepot ? null : { lat: shown.lat, lon: shown.lon, blockId: shown.blockId },
        positionAsOf: asOf - PUBLISH.delay,
        pickup: { accepting: acc.accepting, deadline: acc.deadline },
        nextSeq: k + 1,
        stops,
      };
    });
    this.cache = { asOf, nextUpdate: asOf + PUBLISH.period, trucks };
    return this.cache;
  }

  // GTFS-RT 相当（JSON で表したもの）。公開層のスナップショットから作る
  realtime(now) {
    const snap = this.snapshot(now);
    const ts = Math.floor(snap.asOf / 1000);
    return {
      header: { gtfs_realtime_version: '2.0', incrementality: 'FULL_DATASET', timestamp: ts },
      entity: snap.trucks.flatMap((t) => {
        const out = [{
          id: `tu-${t.tripId}`,
          trip_update: {
            trip: { trip_id: t.tripId, route_id: t.id },
            // 到着の時刻は出さない（家ごとの時刻に近づくため）。どこまで進んだかだけ
            stop_time_update: t.stops.filter((s) => !s.passed).slice(0, 1)
              .map((s) => ({ stop_sequence: s.seq, location_id: s.id, schedule_relationship: 'SCHEDULED' })),
          },
        }];
        if (t.position) {
          out.push({
            id: `vp-${t.tripId}`,
            vehicle: {
              trip: { trip_id: t.tripId, route_id: t.id },
              position: { latitude: t.position.lat, longitude: t.position.lon },
              current_stop_sequence: t.nextSeq,
              timestamp: Math.floor(t.positionAsOf / 1000),
            },
          });
        }
        return out;
      }),
    };
  }
}
