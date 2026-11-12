// 都営バスの実際の位置（ODPT の GTFS-RT VehiclePosition）。
// ODPT へは必ず中継サーバ（https://tyra.jp/odpt/api/ 。トークンはサーバ側）を通す。
// 中継のキャッシュは 30 秒なので、それより短く呼ばない。
const RELAY = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? '/odpt-relay' : 'https://tyra.jp/odpt/api';
const URL_TOEI = `${RELAY}/main/v4/gtfs/realtime/ToeiBus`;
export const BUS_INTERVAL = 30e3;

// protobuf の最小デコーダ（BusTracker/web/realtime.mjs と同じ）
function decode(buf, off = 0, end = buf.length) {
  const out = [];
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  while (off < end) {
    let key = 0, shift = 0, b;
    do { b = buf[off++]; key |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
    const field = key >>> 3, wt = key & 7;
    if (wt === 0) { let v = 0, m = 1; do { b = buf[off++]; v += (b & 0x7f) * m; m *= 128; } while (b & 0x80); out.push([field, v]); }
    else if (wt === 1) { out.push([field, dv.getFloat64(off, true)]); off += 8; }
    else if (wt === 5) { out.push([field, dv.getFloat32(off, true)]); off += 4; }
    else if (wt === 2) { let len = 0, s = 0; do { b = buf[off++]; len |= (b & 0x7f) << s; s += 7; } while (b & 0x80); out.push([field, buf.subarray(off, off + len)]); off += len; }
    else throw new Error(`unsupported wire type ${wt}`);
  }
  return out;
}
const td = new TextDecoder();
const str = (u8) => (u8 ? td.decode(u8) : '');
const get = (fields, n) => fields.find((f) => f[0] === n)?.[1];

export function parseVehicles(buf) {
  const msg = decode(buf);
  const header = decode(get(msg, 1) ?? new Uint8Array());
  const feedTs = get(header, 3) ?? 0;
  const list = [];
  for (const e of msg) {
    if (e[0] !== 2) continue;
    const fe = decode(e[1]);
    const vpb = get(fe, 4);
    if (!vpb) continue;
    const v = decode(vpb);
    const trip = get(v, 1) ? decode(get(v, 1)) : [];
    const pos = get(v, 2) ? decode(get(v, 2)) : [];
    const veh = get(v, 8) ? decode(get(v, 8)) : [];
    const lat = get(pos, 1), lon = get(pos, 2);
    if (!lat || !lon) continue;
    list.push({ routeId: str(get(trip, 5)), lat, lon, ts: get(v, 5) ?? feedTs, id: str(get(veh, 1)) || str(get(fe, 1)) });
  }
  return { feedTs, list };
}

export async function fetchToeiBuses(bounds) {
  const r = await fetch(URL_TOEI, { signal: AbortSignal.timeout(20e3) });
  if (!r.ok) throw new Error(`中継 ${r.status}`);
  const { feedTs, list } = parseVehicles(new Uint8Array(await r.arrayBuffer()));
  const [w, s, e, n] = bounds;
  return { feedTs, list: list.filter((v) => v.lon > w && v.lon < e && v.lat > s && v.lat < n) };
}
