// 利用者のページ（公開地図・集荷お願い・わたしの荷物）。
// 業者のサーバ（demo.js）には決まった窓口からだけ話しかける。業者層の情報はこのページに出さない。
import { SharedDemo } from './demo.js';
import { parseQr, personalFromPublic } from './personal.js';
import { hhmm, windowText } from './util.js';
import { COLORS, $, $$, esc, loadArea, toast, setupClock, createMap, addBaseLayers, startBuses, busPopup, PublicLayer } from './mapbase.js';

const area = await loadArea();
const demo = new SharedDemo(area);
const drawClock = setupClock(demo);

// 自分の荷物と登録住所は、このブラウザだけに置く
const MINE_KEY = 'nimotsu-mine-v3';
const saved = (() => { try { return JSON.parse(localStorage.getItem(MINE_KEY)) ?? {}; } catch { return {}; } })();
const mine = saved.mine ?? []; // { qr（お届けQR の中身）, label, kind: 'delivery' | 'pickup', absent }
let home = saved.home ?? null;
const save = () => localStorage.setItem(MINE_KEY, JSON.stringify({ mine, home }));

let ready = false, picking = false, snap = null;
const map = createMap(area, { focus: myFocus, onTap });
const pub = new PublicLayer(map, area);

map.on('load', () => {
  addBaseLayers(map, area);
  ready = true;
  if (home) setHome(area.block(home.blockId), { lat: home.lat, lng: home.lon });
  render(true);
  startBuses(map, area, $('#showBuses'));
});

// ---- タブ ----
$$('.tabs button').forEach((b) => b.onclick = () => {
  $$('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
  $$('.tab').forEach((x) => x.classList.toggle('on', x.id === `tab-${b.dataset.tab}`));
});
const openTab = (name) => $(`.tabs button[data-tab="${name}"]`).click();

// ---- 地図のタップ ----
function onTap(e) {
  if (!ready) return;
  if (picking) return pickHomeAt(e);
  const bus = map.queryRenderedFeatures(e.point, { layers: ['buses'] })[0];
  if (bus) return busPopup(map, bus, e.lngLat);
  const f = map.queryRenderedFeatures(e.point, { layers: ['blocks-fill'] })[0];
  if (!f) return;
  const b = area.blocks[f.id];
  const html = `<b>${esc(b.label)}</b>${pub.describe(b.id)}<br><button class="sub" id="popHome">ここを登録住所にする</button>`;
  const pop = new maplibregl.Popup().setLngLat(e.lngLat).setHTML(html).addTo(map);
  pop.getElement().querySelector('#popHome').onclick = () => { setHome(b, e.lngLat); pop.remove(); openTab('pickup'); };
}

// 現在地が取れない・エリアの外: 追跡中の荷物の停留所 → 登録住所
function myFocus() {
  for (const m of mine) {
    const p = statusOf(m);
    if (p.blockIds && (p.status === 'onway' || p.status === 'arriving')) return { center: area.center(p.blockIds), label: '追跡中の荷物の停留所' };
  }
  return home ? { center: [home.lon, home.lat], label: '登録住所' } : null;
}

// ---- 公開地図 ----
function renderTruckList() {
  $('#pubInfo').textContent = `公開地図は ${hhmm(snap.asOf)} 時点（次の更新 ${hhmm(snap.nextUpdate)}）`;
  $('#truckList').innerHTML = snap.trucks.map((t) => {
    const done = t.stops.filter((s) => s.passed).length;
    return `<div class="truck-card" data-id="${t.id}">
      <div class="name"><i class="dot" style="background:${COLORS[t.id]}"></i>${esc(t.name)}
        <span class="tag ${t.pickup.accepting ? 'open' : 'closed'}">${t.pickup.accepting ? `集荷受付中 〜${hhmm(t.pickup.deadline)}` : '集荷受付終了'}</span></div>
      <div class="muted">${t.position ? `${done} / ${t.stops.length} 停留所` : '営業所で積み込み中'}</div>
      <div class="bar"><i style="width:${(100 * done) / Math.max(1, t.stops.length)}%"></i></div>
    </div>`;
  }).join('');
  $$('.truck-card').forEach((el) => el.onclick = () => {
    const t = snap.trucks.find((x) => x.id === el.dataset.id);
    if (t.position) { map.flyTo({ center: [t.position.lon, t.position.lat], zoom: 15.5 }); pub.popup(t.id); }
  });
}
$('#showRt').onclick = () => {
  const pre = $('#rtView');
  pre.hidden = !pre.hidden;
  if (!pre.hidden) pre.textContent = JSON.stringify(demo.realtime(), null, 1);
};

// ---- 集荷お願い ----
$('#pickHome').onclick = () => {
  picking = !picking;
  $('#mapWrap').classList.toggle('picking', picking);
  $('#pickHome').classList.toggle('on', picking);
  if (picking) toast('地図で家の場所をタップしてください');
};
function pickHomeAt(e) {
  const { block, d } = area.nearest({ lat: e.lngLat.lat, lon: e.lngLat.lng });
  picking = false;
  $('#mapWrap').classList.remove('picking');
  $('#pickHome').classList.remove('on');
  if (d > 250) { toast('デモのエリア（亀戸・大島1〜9丁目）の中を選んでください'); return; }
  setHome(block, e.lngLat);
}
let homeMarker, pickupSent = null; // 同じ住所・サイズで二度押ししない
function setHome(block, lngLat) {
  home = { blockId: block.id, lat: lngLat.lat, lon: lngLat.lng, label: block.label };
  save();
  pickupSent = null;
  $('#homeText').textContent = `江東区${block.chome} ${block.no}番（街区 ${block.label}）`;
  if (!homeMarker) {
    const el = document.createElement('div'); el.className = 'home-mk'; el.textContent = '🏠';
    homeMarker = new maplibregl.Marker({ element: el, anchor: 'bottom' });
  }
  homeMarker.setLngLat(lngLat).addTo(map);
  renderNear();
}
function renderNear() {
  if (!home || !snap) return;
  const t = snap.trucks.find((x) => x.id === area.block(home.blockId).zone);
  $('#nearTruck').innerHTML = `<span class="dot" style="background:${COLORS[t.id]}"></span> ${esc(t.name)}：${t.pickup.accepting
    ? `<b style="color:#137333">集荷受付中</b>（締切 ${hhmm(t.pickup.deadline)}）` : '<b>受付終了</b>（次の便が出たら受け付けます）'}`;
  $('#askPickup').disabled = pickupSent !== null;
}
$$('input[name=size]').forEach((x) => x.onchange = () => { pickupSent = null; renderNear(); });
$('#askPickup').onclick = () => {
  if (!home || pickupSent) return;
  const size = Number(document.querySelector('input[name=size]:checked').value);
  const r = demo.requestPickup({ blockId: home.blockId, lat: home.lat, lon: home.lon, size });
  const box = $('#pickupResult');
  if (!r.ok) {
    box.innerHTML = `<div class="card ng"><b>今回はお受けできません</b><br>${esc(r.reason)}。<br><span class="muted">次の便が出たらもう一度お試しください。</span></div>`;
    return;
  }
  pickupSent = r.qr;
  $('#askPickup').disabled = true;
  addMine(r.qr, `集荷 ${size}サイズ`, 'pickup');
  box.innerHTML = `<div class="card ok">
    <div class="qr">${qr(r.qr)}</div>
    <b>集荷をお受けしました</b>
    <div class="big">${windowText(r.window)}</div>
    <div class="muted">ごろに伺います（${esc(snap.trucks.find((t) => t.id === r.truckId).name)}）</div>
    <div class="muted">返ってきた QR を「わたしの荷物」に入れました。この QR と公開データから「あと○停留所」を計算します。<br>公開地図には次のまとめ更新（${hhmm(snap.nextUpdate)}）で、ほかの停留所と同じ見た目で入ります。</div>
  </div>`;
};
function qr(text) {
  if (!window.qrcode) return '';
  const q = window.qrcode(0, 'M'); q.addData(text); q.make();
  return q.createImgTag(3, 2);
}

// ---- わたしの荷物（本人層） ----
// お届けQR（便・停留所・期限・合言葉）と、ODPT から取る公開層だけで、手元で計算する。宅配会社には問い合わせない
function addMine(text, label, kind = 'delivery') {
  if (!parseQr(text)) { toast('お届けQR として読めません'); return false; }
  if (!mine.some((m) => m.qr === text)) mine.unshift({ qr: text, label, kind, absent: false });
  save(); renderMine(); markMine();
  return true;
}
function statusOf(m) {
  if (!snap) return { status: 'unknown' };
  return personalFromPublic(parseQr(m.qr), snap, demo.now());
}
// 不在で次の便に回した荷物: 宅配会社から新しいお届けQR がお知らせ（メール）で届いたら、差しかえる
function checkMail() {
  for (const m of mine) {
    if (!m.absent) continue;
    const next = demo.mail(parseQr(m.qr).key);
    if (next && next !== m.qr) {
      m.qr = next; m.absent = false; save();
      toast('宅配会社から、次の便のお届けQR が届きました');
    }
  }
}
$('#trackForm').onsubmit = (e) => {
  e.preventDefault();
  const text = $('#trackNo').value.trim();
  if (!text) return;
  if (addMine(text, 'お届け')) $('#trackNo').value = '';
};
$('#demoParcel').onclick = () => {
  const text = demo.sampleParcel();
  if (!text) { toast('いま届く予定の荷物がありません。少し待ってください'); return; }
  addMine(text, 'お届け');
  const p = statusOf(mine[0]);
  if (p.blockIds) map.flyTo({ center: area.center(p.blockIds), zoom: 15.5 });
};
$('#myList').addEventListener('click', (e) => {
  const b = e.target.closest('[data-absent]');
  if (!b) return;
  const m = mine.find((x) => x.qr === b.dataset.absent);
  // 不在の連絡は「書く」操作。QR の合言葉を付けて、宅配会社の申し込み先へ直接送る
  const r = demo.absent(m.qr);
  if (r.ok) { m.absent = true; save(); toast('不在を伝えました。この便では伺わず、次の便に回します'); }
  else toast(r.reason ?? '変更できませんでした');
  renderMine(); markMine();
});
function markMine() {
  if (!ready) return;
  for (const m of mine) {
    const p = statusOf(m);
    for (const id of p.blockIds ?? []) map.setFeatureState({ source: 'blocks', id: area.index.get(id) }, { mine: !m.absent && (p.status === 'onway' || p.status === 'arriving') });
  }
}
const qrSmall = (text) => {
  if (!window.qrcode) return '';
  const q = window.qrcode(0, 'L'); q.addData(text); q.make();
  return q.createImgTag(2, 2);
};
// 荷物ごとのカードは作ったまま残し、中の「表示」と「ボタン」を別々に、変わったときだけ描きなおす
// （毎秒描きなおすと、押そうとしたボタンが消える）
function renderMine() {
  const list = $('#myList');
  if (!mine.length) { list.innerHTML = '<p class="muted">お届けQR を読むか、上のボタンで宅配会社からの QR を受け取ってください。</p>'; return; }
  list.querySelector('p.muted')?.remove();
  for (const el of [...list.children]) if (!mine.some((m) => m.qr === el.dataset.qr)) el.remove();
  mine.forEach((m, i) => {
    let card = list.querySelector(`[data-qr="${CSS.escape(m.qr)}"]`);
    if (!card) {
      const q = parseQr(m.qr);
      card = document.createElement('div');
      card.className = 'card';
      card.dataset.qr = m.qr;
      card.innerHTML = `<div class="qr">${qrSmall(m.qr)}</div><div class="no">${esc(m.label)}・便 ${esc(q.trip)}・停留所 ${esc(q.stop)}</div><div class="body"></div><div class="act"></div>`;
    }
    if (list.children[i] !== card) list.insertBefore(card, list.children[i] ?? null);
    const p = statusOf(m);
    let body, act = '';
    if (m.absent) body = '<b>不在のご連絡を受けました</b><br><span class="muted">この便では伺わず、次の便に回します。次の便が決まると、新しいお届けQR が届きます。</span>';
    else if (p.status === 'passed' || p.status === 'ended') body = `<b>${m.kind === 'pickup' ? '集荷しました' : 'お届けしました'}</b>`;
    else if (p.status === 'expired') body = '<b>QR の期限が切れています</b>';
    else if (p.status === 'unknown') body = '<span class="muted">公開データにこの便が見つかりません</span>';
    else if (p.status === 'arriving') body = `<div class="away">まもなく</div><span class="muted">次がこの停留所です（${esc(p.stopName)}）</span>`;
    else {
      const n = Math.min(p.stopsAway, 20);
      const dots = Array.from({ length: n }, (_, k) => `<i class="${k === n - 1 ? 'me' : ''}"></i>`).join('');
      body = `<div>あと <span class="away">${p.stopsAway}</span> 停留所</div>
        <div class="dots"><i class="truck"></i>${dots}</div>
        <div class="big">${windowText(p.window)}</div><div class="muted">ごろ（${esc(p.truckName)}）</div>`;
      if (m.kind === 'delivery' && p.stopsAway > 2) act = `<button class="sub" data-absent="${esc(m.qr)}">この時間は不在にする</button>`;
    }
    if (p.asOf && !m.absent && (p.status === 'onway' || p.status === 'arriving')) body += `<div class="muted" style="font-size:11px;margin-top:4px">QR と公開データ（${hhmm(p.asOf)} 時点）から計算。宅配会社には問い合わせていません</div>`;
    const b = card.querySelector('.body'), a = card.querySelector('.act');
    if (b.dataset.html !== body) { b.dataset.html = body; b.innerHTML = body; }
    if (a.dataset.html !== act) { a.dataset.html = act; a.innerHTML = act; }
  });
}

// ---- まわす ----
demo.on((kind) => {
  if (kind === 'reset') { mine.length = 0; save(); $('#myList').innerHTML = ''; $('#pickupResult').innerHTML = ''; pickupSent = null; }
  render(true);
});
let lastUi = 0;
function render(force = false) {
  demo.tick();
  const s = demo.snapshot();
  if (force || !snap || s.asOf !== snap.asOf) {
    snap = s;
    if (ready) { pub.apply(snap); markMine(); }
    renderTruckList();
    renderNear();
  }
  const real = performance.now();
  if (force || real - lastUi > 1000) { lastUi = real; checkMail(); renderMine(); }
}
function frame() {
  drawClock();
  render();
  requestAnimationFrame(frame);
}
renderMine();
requestAnimationFrame(frame);
