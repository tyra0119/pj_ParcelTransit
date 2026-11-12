// 業者のページ（デモの説明用）。業者層をそのまま見せ、公開層と比べられるようにする。
import { SharedDemo } from './demo.js';
import { MIN, hhmm, windowText } from './util.js';
import { COLORS, $, esc, fc, loadArea, toast, setupClock, createMap, addBaseLayers, startBuses, busPopup, PublicLayer } from './mapbase.js';

const area = await loadArea();
const demo = new SharedDemo(area);
const drawClock = setupClock(demo);

let ready = false;
const map = createMap(area, { onTap });
const pub = new PublicLayer(map, area, { label: '公開の位置' });
pub.visible = false;
const trueMarkers = new Map();

map.on('load', () => {
  addBaseLayers(map, area);
  map.addSource('true-routes', { type: 'geojson', data: fc([]) });
  map.addLayer({ id: 'true-routes', type: 'line', source: 'true-routes', paint: { 'line-color': ['get', 'color'], 'line-width': 2, 'line-opacity': 0.7 } });
  map.addSource('houses', { type: 'geojson', data: fc([]) });
  map.addLayer({
    id: 'houses', type: 'circle', source: 'houses',
    paint: {
      'circle-radius': ['case', ['get', 'requested'], 7, 4],
      'circle-color': ['match', ['get', 'type'], 'pickup', '#d93025', '#1a73e8'],
      'circle-opacity': ['case', ['get', 'done'], 0.2, ['get', 'absent'], 0.2, 0.9],
      'circle-stroke-color': ['case', ['get', 'requested'], '#202124', '#ffffff'],
      'circle-stroke-width': ['case', ['get', 'requested'], 2.5, 1],
    },
  });
  ready = true;
  render(true);
  startBuses(map, area, $('#showBuses'));
});

function onTap(e) {
  const bus = map.queryRenderedFeatures(e.point, { layers: ['buses'] })[0];
  if (bus) return busPopup(map, bus, e.lngLat);
  const f = map.queryRenderedFeatures(e.point, { layers: ['blocks-fill'] })[0];
  if (f) new maplibregl.Popup().setLngLat(e.lngLat).setHTML(`<b>${esc(area.blocks[f.id].label)}</b><br>世帯（模擬の按分） ${area.blocks[f.id].hh}`).addTo(map);
}

$('#showHouses').onchange = () => render(true);
$('#showPublic').onchange = () => { pub.visible = $('#showPublic').checked; render(true); };
$('#restart').onclick = () => { if (confirm('デモを最初からやりなおします。利用者の画面の荷物もなくなります。')) demo.restart(); };

const fmtMin = (ms) => (Math.abs(ms) < MIN ? `${Math.round(ms / 1000)}秒` : `${Math.round(ms / MIN)}分`);

function renderLog() {
  const items = [...demo.log].reverse();
  if (!items.length) return;
  $('#log').innerHTML = items.map((a) => {
    if (a.type === 'pickup') {
      const b = area.block(a.args.blockId);
      const r = a.result;
      return `<div class="card ${r.ok ? 'ok' : 'ng'}"><div class="no">${hhmm(a.t)} 集荷の依頼（${a.args.company ? `${a.args.company}社を指定` : '会社の指定なし'}）</div>
        <b>${esc(b.label)}</b>（${a.args.size}サイズ）<br>
        ${r.ok ? `${r.company}社が受付 → ${r.truckId} 便に差し込み。走行が ${fmtMin(r.extraMs)} 延びる<br>伝えた時間幅 ${windowText(r.window)}`
               : `お断り: ${esc(r.reason)}`}</div>`;
    }
    if (a.type === 'away') {
      return `<div class="card"><div class="no">${hhmm(a.t)} （デモ）留守だったことにする</div>
        ${a.result?.ok ? 'トラックは寄るが渡せず、持ち戻る。持ち戻ったら、不在票の代わりに再配達の QR をお知らせで送る' : esc(a.result?.reason ?? '')}</div>`;
    }
    if (a.type === 'redeliver') {
      const r = a.result;
      return `<div class="card ${r?.ok ? 'ok' : 'ng'}"><div class="no">${hhmm(a.t)} 再配達の依頼（${esc(a.args.truckId)} 便を指定）</div>
        ${r?.ok ? `${r.company}社が受付 → ${r.truckId} 便に差し込み。伝えた時間幅 ${windowText(r.window)}。新しいお届けQR を返した` : `受けなかった: ${esc(r?.reason ?? '')}`}</div>`;
    }
    return `<div class="card"><div class="no">${hhmm(a.t)} 不在の連絡</div>
      ${a.result?.ok ? '受付（お届けQR の合言葉で確認）→ この便では寄らず、次の便へ回す。次の便のお届けQR をお知らせで送る' : `受けなかった: ${esc(a.result?.reason ?? '')}`}</div>`;
  }).join('');
}

function renderCarrier(v) {
  $('#stats').innerHTML = `<div class="stat">
    <div><small>集荷の受付</small><b>${v.stats.pickupsAccepted} 件</b><small>断った ${v.stats.pickupsDeclined} 件</small></div>
    <div><small>集荷で延びた走行</small><b>${fmtMin(v.stats.extraMs)}</b><small>別便を出さずに済んだ</small></div>
    <div><small>不在の事前連絡</small><b>${v.stats.absentAvoided} 件</b><small>持ち戻りを防いだ</small></div>
    <div><small>不在で短くなった</small><b>${fmtMin(v.stats.savedMs)}</b><small>寄らずに済んだ時間</small></div>
    <div><small>再配達の依頼</small><b>${v.stats.redelivered} 件</b><small>空いている便に差し込んだ</small></div>
  </div>`;
  $('#trucks').innerHTML = `<table><tr><th>会社・便</th><th>残り</th><th>終了見込み</th><th>予定</th></tr>${v.trucks.map((t) => {
    const diff = t.end - t.plannedEnd;
    return `<tr><td><i class="dot" style="background:${COLORS[t.id]}"></i> ${t.company}社 ${t.tripId}</td><td>${t.remaining}/${t.stops}</td>
      <td>${hhmm(t.end)}${Math.abs(diff) >= 30e3 ? ` <small style="color:${diff > 0 ? '#c5221f' : '#137333'}">${diff > 0 ? '+' : '−'}${fmtMin(Math.abs(diff))}</small>` : ''}</td><td>${hhmm(t.plannedEnd)}</td></tr>`;
  }).join('')}</table>`;
  if (!ready) return;
  const showHouses = $('#showHouses').checked;
  map.getSource('houses').setData(fc(showHouses ? v.trucks.flatMap((t) => t.houses.map((h) => ({
    type: 'Feature', properties: { type: h.type, done: h.done, absent: h.absent, requested: h.requested }, geometry: { type: 'Point', coordinates: [h.lon, h.lat] },
  }))) : []));
  map.getSource('true-routes').setData(fc(v.trucks.filter((t) => !t.pos.atDepot).map((t) => ({
    type: 'Feature', properties: { color: COLORS[t.id] }, geometry: { type: 'LineString', coordinates: [[t.pos.lon, t.pos.lat], ...t.route] },
  }))));
  for (const t of v.trucks) {
    let mk = trueMarkers.get(t.id);
    if (!mk) {
      const el = document.createElement('div');
      el.className = 'truck-mk real';
      el.innerHTML = `<div class="ic" style="border-color:${COLORS[t.id]}">${t.id}</div><div class="lb"></div>`;
      mk = new maplibregl.Marker({ element: el });
      trueMarkers.set(t.id, mk);
    }
    mk.getElement().querySelector('.lb').textContent = t.pos.moving ? `走行中・残り${t.remaining}` : `停車中・残り${t.remaining}`;
    if (!t.pos.atDepot) mk.setLngLat([t.pos.lon, t.pos.lat]).addTo(map); else mk.remove();
  }
}

// ---- まわす ----
demo.on((kind) => {
  if (kind === 'action') {
    const a = demo.log.at(-1);
    toast(a.type === 'pickup' ? `集荷の依頼が届きました（${area.block(a.args.blockId).label}）` : '不在の連絡が届きました');
  }
  if (kind === 'reset') { $('#log').innerHTML = '<p class="muted">やりなおしました。</p>'; pub.passed.clear(); }
  render(true);
});
let snap = null, lastUi = 0;
function render(force = false) {
  demo.tick();
  const s = demo.snapshot();
  if (ready && (force || !snap || s.asOf !== snap.asOf)) { snap = s; pub.apply(snap); }
  const real = performance.now();
  if (force || real - lastUi > 500) {
    lastUi = real;
    renderCarrier(demo.carrierView());
    if (force) renderLog();
  }
}
function frame() {
  drawClock();
  render();
  requestAnimationFrame(frame);
}
renderLog();
requestAnimationFrame(frame);
