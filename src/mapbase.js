// 利用者のページと業者のページで共通の部分: 地図・地図のボタン・時計・公開層の描き方・都営バス
import { fetchToeiBuses, BUS_INTERVAL } from './buses.js';
import { hhmm, dist } from './util.js';

export const COLORS = { K1: '#1a73e8', K2: '#9334e6', K3: '#d01884', O1: '#188038', O2: '#e37400', O3: '#12b5cb',
  U1: '#1a73e8', U2: '#9334e6', W1: '#1a73e8', W2: '#9334e6' };
// 地区: ?area=kozdai（神戸市北区 上津台・鹿の子台）／ kozdai-joint（同じ町を 1 台で。共同配送）。なければ亀戸・大島
const AREAS = { kozdai: 'data/area-kozdai.json', 'kozdai-joint': 'data/area-kozdai-joint.json' };
const askedArea = new URLSearchParams(location.search).get('area');
export const AREA_ID = AREAS[askedArea] ? askedArea : 'koto';
export const $ = (s) => document.querySelector(s);
export const $$ = (s) => [...document.querySelectorAll(s)];
export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const fc = (features) => ({ type: 'FeatureCollection', features });
const ring = (poly) => (poly.length ? [...poly, poly[0]] : poly);

export async function loadArea() {
  const area = await (await fetch(AREAS[AREA_ID] ?? 'data/area.json')).json();
  area.name = area.areaName ?? '亀戸・大島';
  area.ward = (area.city ?? '東京都江東区').replace(/^.+?[都道府県]/, '').replace(/^神戸市/, '');
  if (AREA_ID !== 'koto') showAreaNote(area);
  const lons = area.blocks.map((b) => b.lon), lats = area.blocks.map((b) => b.lat);
  area.bounds = [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
  area.index = new Map(area.blocks.map((b, i) => [b.id, i]));
  area.block = (id) => area.blocks[area.index.get(id)];
  area.center = (blockIds) => {
    let lat = 0, lon = 0;
    for (const id of blockIds) { const b = area.block(id); lat += b.lat; lon += b.lon; }
    return [lon / blockIds.length, lat / blockIds.length];
  };
  area.nearest = (pt) => {
    let best = null, bestD = Infinity;
    for (const b of area.blocks) { const d = dist(pt, b); if (d < bestD) { best = b; bestD = d; } }
    return { block: best, d: bestD };
  };
  return area;
}

// ほかの地区で試しているときの案内。ページのあいだのリンクにも地区を引きつぐ
function showAreaNote(area) {
  for (const a of document.querySelectorAll('a[href^="index.html"], a[href^="carrier.html"]')) {
    const [file, hash] = a.getAttribute('href').split('#');
    a.setAttribute('href', `${file}?area=${AREA_ID}${hash ? `#${hash}` : ''}`);
  }
  // 静的フィード（gtfs/）は亀戸・大島の分なので、ほかの地区では出さない
  for (const a of document.querySelectorAll('a[href^="gtfs/"]')) a.closest('p').hidden = true;
  const el = document.createElement('div');
  el.className = 'area-note';
  el.innerHTML = `<b>${area.name}（${area.city}）で試しています。</b>街区と世帯数は実際のデータ、配達は模擬、営業所は架空です。 <a href="${location.pathname}">亀戸・大島に戻る</a>`;
  document.querySelector('.top')?.after(el);
}

// ---- 知らせ ----
let toastTimer;
export function toast(msg) {
  const el = $('#toast');
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
}

// ---- 時計と速さ（2 ページで共有） ----
export function setupClock(demo) {
  const buttons = $$('.speed button');
  const mark = () => buttons.forEach((x) => x.classList.toggle('on', Number(x.dataset.speed) === demo.speed));
  buttons.forEach((b) => b.onclick = () => { demo.setSpeed(Number(b.dataset.speed)); mark(); });
  demo.on(mark);
  mark();
  return () => {
    const d = new Date(demo.now());
    $('#clock').textContent = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  };
}

// ---- 地図 ----
const CONTROLS = `
  <button id="btnFull" class="mapbtn full" title="全画面" aria-label="全画面">⛶</button>
  <div class="ctrls">
    <button id="btnNorth" class="mapbtn" title="北を上に" aria-label="北を上に"><svg viewBox="0 0 24 24" id="compass"><path d="M12 2 16 12H8z" fill="#d93025"/><path d="M12 22 8 12h8z" fill="#9aa0a6"/></svg></button>
    <button id="btnLocate" class="mapbtn" title="現在地" aria-label="現在地"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4" fill="#1a73e8"/><circle cx="12" cy="12" r="8" fill="none" stroke="#5f6368" stroke-width="2"/><path d="M12 1v4M12 19v4M1 12h4M19 12h4" stroke="#5f6368" stroke-width="2"/></svg></button>
    <div class="zoom">
      <button id="btnIn" class="mapbtn" title="拡大" aria-label="拡大">＋</button>
      <button id="btnOut" class="mapbtn" title="縮小" aria-label="縮小">−</button>
    </div>
  </div>
  <div id="toast" hidden></div>`;

/**
 * focus(): 現在地が取れない・エリアの外のときに出す場所 { center, label } か null
 * onTap({ point, lngLat }): 地図をタップしたとき
 */
export function createMap(area, { focus = () => null, onTap = () => {} } = {}) {
  const B = area.bounds;
  $('#mapWrap').insertAdjacentHTML('beforeend', CONTROLS);
  const map = new maplibregl.Map({
    container: 'map',
    style: {
      version: 8,
      sources: {
        gsi: {
          type: 'raster', tileSize: 256, maxzoom: 18,
          tiles: ['https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png'],
          // 出典の全文は manual.html#credits（書き方は各提供元の決まりに合わせる）
          attribution: '出典：<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">国土地理院（地理院タイル）</a>'
            + '／「<a href="https://nlftp.mlit.go.jp/isj/" target="_blank">位置参照情報ダウンロードサービス</a>」（国土交通省）、「令和2年国勢調査 小地域集計」（総務省統計局、<a href="https://www.e-stat.go.jp/" target="_blank">e-Stat</a>）を加工して作成'
            + '／東京都交通局・公共交通オープンデータ協議会、東京都交通局 バス関連リアルタイム情報、<a href="https://creativecommons.org/licenses/by/4.0/deed.ja" target="_blank">CC BY 4.0</a>'
            + '／<a href="manual.html#credits" target="_blank">出典の全文</a>',
        },
      },
      layers: [{ id: 'gsi', type: 'raster', source: 'gsi' }],
    },
    bounds: [[B[0], B[1]], [B[2], B[3]]],
    fitBoundsOptions: { padding: 30 },
    maxPitch: 60,
    attributionControl: false,
  });
  map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left');
  map.touchZoomRotate.enableRotation();
  new ResizeObserver(() => map.resize()).observe($('#mapWrap'));
  window.__app = { map }; // 調べもの用

  // 地図のボタン（右下: 方角・現在地・拡大/縮小）と全画面
  $('#btnIn').onclick = () => map.zoomIn();
  $('#btnOut').onclick = () => map.zoomOut();
  $('#btnNorth').onclick = () => map.easeTo({ bearing: 0, pitch: 0 });
  map.on('rotate', () => { $('#compass').style.transform = `rotate(${-map.getBearing()}deg)`; });
  $('#btnLocate').onclick = () => {
    const fallback = (why) => {
      const f = focus();
      map.flyTo({ center: f?.center ?? [(B[0] + B[2]) / 2, (B[1] + B[3]) / 2], zoom: Math.max(map.getZoom(), 15) });
      toast(`${why}。${f?.label ?? 'エリアの中ほど'}を表示します`);
    };
    if (!navigator.geolocation) return fallback('現在地が使えません');
    navigator.geolocation.getCurrentPosition((p) => {
      const { longitude: lon, latitude: lat } = p.coords;
      if (lon < B[0] - 0.01 || lon > B[2] + 0.01 || lat < B[1] - 0.01 || lat > B[3] + 0.01) return fallback(`現在地がデモのエリア（${area.name}）の外です`);
      map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), 15.5) });
    }, () => fallback('現在地が取れませんでした'), { timeout: 8000 });
  };
  $('#btnFull').onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.();
  };

  // タップ。地図ライブラリの click は取りこぼすことがあったので、DOM の click から自前で拾う
  let downAt = null;
  map.getCanvasContainer().addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
  map.getCanvasContainer().addEventListener('click', (e) => {
    if (e.target !== map.getCanvas()) return; // トラックの印など
    if (downAt && Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 6) return; // ドラッグだった
    const r = map.getCanvas().getBoundingClientRect();
    const point = [e.clientX - r.left, e.clientY - r.top];
    if (map.loaded()) onTap({ point, lngLat: map.unproject(point) });
  });
  map.on('load', () => document.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show'));
  return map;
}

// 街区の区画（公開層の色分け・自分の街区の囲み）と、都営バス
export function addBaseLayers(map, area) {
  map.addSource('blocks', {
    type: 'geojson',
    data: fc(area.blocks.map((b, i) => ({ type: 'Feature', id: i, properties: { zone: b.zone }, geometry: { type: 'Polygon', coordinates: [ring(b.poly)] } }))),
  });
  const zoneColor = ['match', ['get', 'zone'], ...Object.entries(COLORS).flat(), '#888'];
  map.addLayer({
    id: 'blocks-fill', type: 'fill', source: 'blocks',
    paint: {
      'fill-color': ['case',
        ['boolean', ['feature-state', 'glow'], false], '#ffffff',
        ['==', ['feature-state', 'k'], 2], '#e8710a',
        ['==', ['feature-state', 'k'], 1], ['interpolate', ['linear'], ['coalesce', ['feature-state', 'o'], 0], 0, '#fef7e0', 1, '#fbbc04'],
        ['==', ['feature-state', 'k'], 3], '#bdc1c6',
        '#ffffff'],
      'fill-opacity': ['case',
        ['boolean', ['feature-state', 'glow'], false], 0.95,
        ['==', ['feature-state', 'k'], 2], 0.8,
        ['==', ['feature-state', 'k'], 1], 0.65,
        ['==', ['feature-state', 'k'], 3], 0.45,
        0.08],
    },
  });
  map.addLayer({ id: 'blocks-line', type: 'line', source: 'blocks', paint: { 'line-color': zoneColor, 'line-width': 0.6, 'line-opacity': 0.5 } });
  map.addLayer({
    id: 'blocks-mine', type: 'line', source: 'blocks',
    paint: { 'line-color': '#202124', 'line-width': ['case', ['boolean', ['feature-state', 'mine'], false], 3.5, 0] },
  });
  map.addSource('routes', { type: 'geojson', data: fc([]) });
  map.addLayer({ id: 'routes', type: 'line', source: 'routes', paint: { 'line-color': ['get', 'color'], 'line-width': 2.5, 'line-dasharray': [2, 1.5], 'line-opacity': 0.8 } });
  map.addSource('buses', { type: 'geojson', data: fc([]) });
  map.addLayer({ id: 'buses', type: 'circle', source: 'buses', paint: { 'circle-radius': 6, 'circle-color': '#34a853', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
  for (const id of ['blocks-fill', 'buses']) {
    map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; });
  }
}

// 都営バス（ODPT・tyra.jp 中継経由、30 秒ごと）。宅配とは関係がないので、初めは出さない。
// toggle（チェックボックス）を入れたときだけ取りにいき、表示する
export function startBuses(map, area, toggle) {
  if (AREA_ID !== 'koto') { const l = toggle?.closest('label'); if (l) l.hidden = true; return; }
  const B = area.bounds, pad = 0.01;
  let timer = null;
  const show = () => toggle?.checked ?? false;
  const apply = () => {
    map.setLayoutProperty('buses', 'visibility', show() ? 'visible' : 'none');
    clearTimeout(timer);
    if (show()) load();
  };
  toggle?.addEventListener('change', apply);
  const load = async () => {
    if (!show()) return;
    try {
      const { list } = await fetchToeiBuses([B[0] - pad, B[1] - pad, B[2] + pad, B[3] + pad]);
      map.getSource('buses').setData(fc(list.map((v) => ({
        type: 'Feature', properties: { id: v.id, route: v.routeId, time: hhmm(v.ts * 1000) }, geometry: { type: 'Point', coordinates: [v.lon, v.lat] },
      }))));
    } catch (e) {
      console.warn('都営バスの位置が取れませんでした', e);
    }
    timer = setTimeout(load, BUS_INTERVAL);
  };
  apply();
}

export function busPopup(map, feature, lngLat) {
  const p = feature.properties;
  new maplibregl.Popup().setLngLat(lngLat).setHTML(`<b>都営バス</b> ${esc(p.id)}<br>系統 ${esc(p.route)}<br><span class="muted">${esc(p.time)} 時点の実際の位置（ODPT）</span>`).addTo(map);
}

// 公開層を地図に描く: 街区の色分け（配達順に光っていく）・トラック（街区単位・遅れ）・この先の道すじ
export class PublicLayer {
  constructor(map, area, { label = '' } = {}) {
    this.map = map; this.area = area; this.label = label;
    this.markers = new Map();
    this.passed = new Set();
    this.first = true;
    this.visible = true;
    this.snap = null;
  }

  apply(snap) {
    const { map, area } = this;
    this.snap = snap;
    map.removeFeatureState({ source: 'blocks' });
    const glow = [], routes = [];
    for (const t of snap.trucks) {
      const remaining = t.stops.filter((s) => !s.passed);
      for (const s of t.stops) {
        let state;
        if (s.passed) {
          state = { k: 3 };
          if (!this.first && !this.passed.has(s.id)) glow.push(...s.blockIds);
          this.passed.add(s.id);
        } else if (s.seq === t.nextSeq) state = { k: 2 };
        else state = { k: 1, o: 1 - (s.seq - t.nextSeq) / Math.max(1, remaining.length) };
        if (this.visible) for (const id of s.blockIds) map.setFeatureState({ source: 'blocks', id: area.index.get(id) }, state);
      }
      const coords = remaining.map((s) => area.center(s.blockIds));
      if (t.position) coords.unshift([t.position.lon, t.position.lat]);
      if (coords.length > 1) routes.push({ type: 'Feature', properties: { color: COLORS[t.id] }, geometry: { type: 'LineString', coordinates: coords } });

      let mk = this.markers.get(t.id);
      if (!mk) {
        const el = document.createElement('div');
        el.className = 'truck-mk';
        el.innerHTML = `<div class="ic" style="border-color:${COLORS[t.id]}">${t.id}</div><div class="lb"></div>`;
        el.addEventListener('click', (e) => { e.stopPropagation(); this.popup(t.id); });
        mk = new maplibregl.Marker({ element: el });
        this.markers.set(t.id, mk);
      }
      if (t.position && this.visible) mk.setLngLat([t.position.lon, t.position.lat]).addTo(map); else mk.remove();
      mk.getElement().querySelector('.lb').textContent = this.label || (t.pickup.accepting ? `集荷受付中 〜${hhmm(t.pickup.deadline)}` : '集荷受付終了');
    }
    map.getSource('routes').setData(fc(this.visible ? routes : []));
    if (this.visible) {
      for (const id of glow) map.setFeatureState({ source: 'blocks', id: area.index.get(id) }, { glow: true });
      if (glow.length) setTimeout(() => { for (const id of glow) map.setFeatureState({ source: 'blocks', id: area.index.get(id) }, { glow: false }); }, 900);
    }
    this.first = false;
  }

  popup(id) {
    const t = this.snap?.trucks.find((x) => x.id === id);
    if (!t?.position) return;
    const left = t.stops.filter((s) => !s.passed).length;
    new maplibregl.Popup({ offset: 20 }).setLngLat([t.position.lon, t.position.lat]).setHTML(
      `<b>${esc(t.name)}</b><br>残り ${left} 停留所<br>${t.pickup.accepting ? `集荷受付中（締切 ${hhmm(t.pickup.deadline)}）` : '集荷の受付は終わりました'}<br><span class="muted">公開の位置: ${hhmm(t.positionAsOf)} 時点・街区単位</span>`).addTo(this.map);
  }

  // 街区をタップしたときの説明
  describe(blockId) {
    let html = '';
    for (const t of this.snap?.trucks ?? []) {
      const s = t.stops.find((x) => x.blockIds.includes(blockId));
      if (!s) continue;
      html += `<br>${esc(t.name)} の停留所「${esc(s.name)}」<br>${s.passed ? '寄り終えました' : `巡回 ${s.seq} 番目（いま ${t.nextSeq} 番目）`}`;
    }
    return html;
  }
}
