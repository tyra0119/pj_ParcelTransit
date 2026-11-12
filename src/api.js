// デモ用の「業者のサーバ」。本番ではサーバの中で動き、画面からは次の窓口だけが見える。
//   GET  /public/snapshot     … 公開層（誰でも）
//   GET  /public/realtime     … GTFS-RT 相当（誰でも）
//   POST /pickup              … 集荷の依頼（登録住所・荷物サイズ）
//   POST /absent              … 不在の連絡（お届けQR の合言葉つき。申し込み先へ）
//   POST /redeliver           … 再配達の依頼（再配達の QR と、選んだ便。申し込み先へ）
//   （本人層はここに問い合わせない。お届けQR と公開層から、アプリが手元で計算する）
// 画面のコード（app.js）は Carrier を直接さわらず、ここを通す。
import { Carrier } from './carrier.js';
import { Publisher } from './publisher.js';

const clone = (x) => JSON.parse(JSON.stringify(x));

export class DemoServer {
  constructor(area, now, seed = Math.floor(now / 86400e3)) {
    this.carrier = new Carrier(area, { seed, now });
    this.publisher = new Publisher(this.carrier);
  }
  tick(now) { this.carrier.tick(now); }
  snapshot(now) { return clone(this.publisher.snapshot(now)); }
  realtime(now) { return clone(this.publisher.realtime(now)); }
  requestPickup(req, now) { return clone(this.carrier.requestPickup(req, now)); }
  // 申し込み先（書く）: 不在の連絡。QR の合言葉で持ち主を確かめる
  absent(qr, now) { return clone(this.carrier.absentByQr(qr, now)); }
  // 申し込み先（書く）: 再配達の依頼。再配達の QR と、本人が選んだ便
  redeliver(args, now) { return clone(this.carrier.requestRedelivery(args, now)); }
  // デモ用: その時間は留守だったことにする（トラックは寄るが渡せず、持ち戻る）
  away(qr, now) { return clone(this.carrier.markAway(qr, now)); }
  // お知らせ（メールの代わり）: 次の便のお届けQR、または持ち戻ったときの再配達の QR（不在票の代わり）
  mail(key, now) { return this.carrier.mail(key, now); }

  // ---- ここから下はデモの説明用（本番では業者の中だけで見る画面） ----
  // デモ用: 宅配会社から、まだ届いていない荷物のお届けQRがメールで届いたことにする
  sampleParcel(now) { const no = this.carrier.sampleTrackingNo(now); return no ? this.carrier.qrOf(no) : null; }
  carrierView(now) {
    const c = this.carrier;
    return {
      stats: { ...c.stats },
      trucks: c.trucks.map((t) => {
        const k = c.nextIndex(t, now);
        return {
          id: t.id, name: t.name, company: t.company, tripId: t.tripId,
          pos: c.truePosition(t, now),
          route: t.stops.slice(k).filter((s) => !s.skip).map((s) => [s.lon, s.lat]),
          stops: t.stops.length, remaining: t.stops.length - k,
          end: t.end, plannedEnd: t.plannedEnd,
          houses: [...t.items.values()].map((it) => ({
            lat: it.lat, lon: it.lon, type: it.type, absent: it.absent, requested: !!it.requested,
            done: t.stops.find((s) => s.itemNos.includes(it.no)).depart <= now,
          })),
        };
      }),
    };
  }
}
