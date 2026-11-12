// 本人層を、アプリの手元で計算する。
// 使うのは「お届けQR」（便・停留所・期限・合言葉）と、ODPT から取る公開層だけ。宅配会社には問い合わせない。

/** QR の中身を読む。読めなければ null */
export function parseQr(text) {
  const t = String(text ?? '').trim();
  if (!t.startsWith('nimotsu:v1?')) return null;
  const q = new URLSearchParams(t.slice('nimotsu:v1?'.length));
  const qr = { feed: q.get('f'), trip: q.get('t'), stop: q.get('s'), expires: q.get('e'), key: q.get('k'), redeliver: q.get('r') === '1', raw: t };
  if (!qr.feed || !qr.key) return null;
  // 再配達の QR（不在票の代わり）は、便と停留所がまだ決まっていない
  if (qr.redeliver) return qr;
  return qr.trip && qr.stop ? qr : null;
}

/**
 * QR と公開層のスナップショットから、「あと○停留所」と時間幅を出す。
 * status: onway（向かっている）／ arriving（次がこの停留所）／ passed（寄り終えた）／ ended（便が終わった）／ unknown
 */
export function personalFromPublic(qr, snap, now) {
  if (qr.redeliver) return { status: 'redeliver', company: qr.feed };
  const day = new Date(now + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');
  if (qr.expires && qr.expires < day) return { status: 'expired' };
  const truck = snap.trucks.find((t) => t.tripId === qr.trip);
  if (!truck) {
    // 同じ車の後の便が走っていれば、この便は終わっている
    const [zone, no] = qr.trip.split('-');
    const later = snap.trucks.find((t) => t.id === zone && Number(t.tripId.split('-')[1]) > Number(no));
    return later ? { status: 'ended' } : { status: 'unknown' };
  }
  const stop = truck.stops.find((s) => s.id === qr.stop);
  // 差し込まれたばかりの停留所は、次のまとめ更新まで公開データに出ない
  if (!stop) return { status: 'pending', truckName: truck.name, nextUpdate: snap.nextUpdate };
  const base = { truckId: truck.id, truckName: truck.name, stopName: stop.name, blockIds: stop.blockIds, asOf: snap.asOf, nextUpdate: snap.nextUpdate };
  if (stop.passed) return { ...base, status: 'passed' };
  const stopsAway = stop.seq - truck.nextSeq + 1;
  return { ...base, status: stopsAway <= 1 ? 'arriving' : 'onway', stopsAway, window: stop.window };
}
