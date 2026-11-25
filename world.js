/* Мапа цілі як світ: розкладка, небо за годиною доби й малюнки.
   Лише чисті функції та SVG-рядки — без DOM і без даних застосунку. tasks.js бере звідси розкладку
   (де дорога, кроки, етапи, річка, озера, дерева, хмари) і малюнки, а сам лише збирає сцену.
   Усе детерміноване: той самий шлях — той самий світ, дерева не скачуть між відкриттями. */
(function () {
  'use strict';

  var TILT = 56;               // нахил землі до екрана, градусів
  /** Камера сцени: перспектива (px), точка зору й точка, де стоїть фокус камери, — частки ширини й висоти екрана.
      CSS сцени ставиться з цих чисел (tasks.js), і той самий розрахунок малює рослини на полотні (project). */
  var CAM = { d: 900, ox: 0.5, oy: 0.2, tx: 0.5, ty: 0.64 };
  var GW = 1400;               // ширина острова, px землі
  var STEP = 170;              // відстань між сусідніми кроками
  var TOP = 420, BOT = 400;    // місце для замку за фінішем і для хатинки перед стартом
  var AMP = 330;               // наскільки дорога петляє вбік
  var RIVER_GAP = 120, GATE_GAP = 60;
  var PER_ZONE = 5;            // кроків в одному етапі
  var CELL = 64;               // крок сітки, по якій садимо дерева

  /** Місцевості етапів по черзі (після «Гір» — знову «Луки»): густота й склад рослинності. */
  var ZONES = [
    { key: 'meadow', name: 'Луки', p: 0.17, kinds: [['bush', 0.42], ['round', 0.36], ['birch', 0.12], ['rock', 0.1]], flowers: 0.8 },
    { key: 'forest', name: 'Ліс', p: 0.44, kinds: [['pine', 0.55], ['round', 0.3], ['bush', 0.08], ['mushroom', 0.07]], flowers: 0.15 },
    { key: 'lake', name: 'Озеро', p: 0.19, kinds: [['birch', 0.4], ['bush', 0.25], ['rock', 0.2], ['round', 0.15]], flowers: 0.4 },
    { key: 'hills', name: 'Пагорби', p: 0.16, kinds: [['rock', 0.45], ['pine', 0.3], ['bush', 0.25]], flowers: 0.25 },
    { key: 'peaks', name: 'Гори', p: 0.15, kinds: [['pine', 0.55], ['rock', 0.45]], flowers: 0.05 }
  ];

  /** Детермінований «випадок» з [0, 1). */
  function rnd(i) { var x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); }
  function r1(v) { return Math.round(v * 10) / 10; }
  /** Етап (з 0), до якого належить крок no (з 1). */
  function zoneOfStep(no) { return Math.max(0, Math.floor((no - 1) / PER_ZONE)); }
  function zoneInfo(z) { var Z = ZONES[z % ZONES.length]; return { i: z, key: Z.key, name: Z.name }; }

  /** Небо за годиною: схід і захід сонця наближено для широти Києва (з літнім часом). */
  function skyAt(d) {
    var doy = Math.round((d - new Date(d.getFullYear(), 0, 1)) / 864e5) + 1;
    var k = Math.sin(2 * Math.PI * (doy - 80) / 365);
    var sunset = 18.55 + 2.65 * k, sunrise = 6.33 - 1.58 * k;
    var hr = d.getHours() + d.getMinutes() / 60;
    if (hr < sunrise - 0.5 || hr > sunset + 0.75) return 'night';
    if (hr < sunrise + 0.75 || hr > sunset - 1) return 'dusk';
    return 'day';
  }

  /* ---------- дорога ---------- */

  /** Точка дороги між сусідніми точками a і b: крива з дотичними по вертикалі, t від 0 до 1. */
  function roadAt(a, b, t) {
    var my = (a[1] + b[1]) / 2, u = 1 - t;
    return [(u * u * u + 3 * u * u * t) * a[0] + (3 * u * t * t + t * t * t) * b[0],
      u * u * u * a[1] + (3 * u * u * t + 3 * u * t * t) * my + t * t * t * b[1]];
  }
  /** SVG-шлях дороги від підходу до старту через перші upto відрізків. */
  function roadPath(P, upto) {
    var d = 'M' + r1(P[0][0]) + ' ' + r1(P[0][1] + 170) + ' L' + r1(P[0][0]) + ' ' + r1(P[0][1]);
    for (var k = 1; k <= upto && k < P.length; k++) {
      var my = r1((P[k - 1][1] + P[k][1]) / 2);
      d += ' C' + r1(P[k - 1][0]) + ' ' + my + ' ' + r1(P[k][0]) + ' ' + my + ' ' + r1(P[k][0]) + ' ' + r1(P[k][1]);
    }
    return d;
  }

  /* ---------- розкладка світу ---------- */

  /** Світ для n кроків. P[0] — старт, P[1..n] — кроки, P[n+1] — фініш (замок).
      Кожні 5 кроків — брама й нова місцевість; посередині шляху — річка з мостом. */
  function layout(n) {
    var gates = [];
    for (var k = PER_ZONE; k < n; k += PER_ZONE) gates.push(k + 1);   // відрізок між кроками k і k+1
    var xs = [];
    for (var i = 0; i <= n + 1; i++) xs.push(i === 0 || i === n + 1 ? GW / 2 : GW / 2 + AMP * Math.sin(i * 1.15));
    // річка — ближче до середини шляху й там, де дорога йде прямо вгору: міст упоперек, а не вздовж
    var kr = 0, best = Infinity;
    for (var s = 2; s <= n; s++) {
      if (gates.indexOf(s) >= 0) continue;
      var cost = Math.abs(xs[s] - xs[s - 1]) + 40 * Math.abs(s - (n + 1) / 2);
      if (cost < best) { best = cost; kr = s; }
    }
    var len = [0], total = 0;
    for (var j = 1; j <= n + 1; j++) {
      len.push(STEP + (j === kr ? RIVER_GAP : 0) + (gates.indexOf(j) >= 0 ? GATE_GAP : 0));
      total += len[j];
    }
    var H = TOP + total + BOT, P = [], y = H - BOT;
    for (var m = 0; m <= n + 1; m++) { if (m) y -= len[m]; P.push([xs[m], y]); }
    function mid(seg) {
      var a = P[seg - 1], b = P[seg];
      return { x: r1((a[0] + b[0]) / 2), y: r1((a[1] + b[1]) / 2), angle: r1(Math.atan2(b[1] - a[1], 2 * (b[0] - a[0])) * 180 / Math.PI) };
    }
    var gateList = gates.map(function (seg, gi) {
      var p = mid(seg), z = zoneInfo(gi + 1);
      return { seg: seg, x: p.x, y: p.y, no: gi + 2, name: z.name };
    });
    var nz = zoneOfStep(Math.max(1, n)) + 1, zones = [];
    for (var z = 0; z < nz; z++) {
      zones.push(Object.assign(zoneInfo(z), {
        y0: z === nz - 1 ? 0 : gateList[z].y,          // далекий край
        y1: z === 0 ? H : gateList[z - 1].y            // ближній край
      }));
    }
    // підпис кроку — з боку, далекого від центру острова; якщо просто перед кроком брама — з іншого боку
    var sides = [0];
    for (var st = 1; st <= n; st++) {
      var side = P[st][0] > GW / 2 ? -1 : 1, gt = gateList.filter(function (q) { return q.seg === st; })[0];
      if (gt) {
        var a = side > 0 ? P[st][0] + 40 : P[st][0] - 340, b = side > 0 ? P[st][0] + 340 : P[st][0] - 40;
        if (a < gt.x + 130 && b > gt.x - 130) side = -side;
      }
      sides.push(side);
    }
    var L = {
      GW: GW, H: H, P: P, gates: gateList, zones: zones, sides: sides,
      river: kr ? Object.assign(mid(kr), { seg: kr }) : null,
      camp: { sign: [P[0][0] - 125, P[0][1] + 36], house: [P[0][0] + 215, P[0][1] + 80], fire: [P[0][0] + 105, P[0][1] + 150] },
      castle: [P[n + 1][0], P[n + 1][1] - 24]
    };
    decorate(L, n);
    return L;
  }

  /** y річки в точці x: хвиля, що точно проходить через міст. */
  function riverY(R, x) { return R.y + 24 * Math.sin((x - R.x) / 150); }

  function zoneAtY(L, y) {
    for (var i = 0; i < L.zones.length; i++) if (y >= L.zones[i].y0 && y < L.zones[i].y1) return L.zones[i];
    return L.zones[L.zones.length - 1];
  }

  /** Озера, гори, дерева, квіти й хмари — подалі від дороги, підписів, будівель і води. */
  function decorate(L, n) {
    var P = L.P, samples = [];
    for (var k = 1; k < P.length; k++) for (var t = 0; t <= 1.0001; t += 1 / 14) samples.push(roadAt(P[k - 1], P[k], t));
    for (var e = 0; e <= 170; e += 17) samples.push([P[0][0], P[0][1] + e]);
    function nearRoad(x, y, r) {
      for (var i = 0; i < samples.length; i++) {
        var dx = samples[i][0] - x, dy = samples[i][1] - y;
        if (dx * dx + dy * dy < r * r) return true;
      }
      return false;
    }
    // заборонені прямокутники: [x1, x2, y1, y2] — там стоять підписи, піни, персонаж, будівлі
    var keep = [];
    for (var i = 1; i <= n; i++) {
      var p = P[i], side = L.sides[i];
      keep.push(side > 0 ? [p[0] + 40, p[0] + 340, p[1] - 20, p[1] + 190] : [p[0] - 340, p[0] - 40, p[1] - 20, p[1] + 190]);
      keep.push([p[0] - 110, p[0] + 110, p[1] - 40, p[1] + 210]);
    }
    var c = L.camp;
    keep.push([c.house[0] - 120, c.house[0] + 120, c.house[1] - 70, c.house[1] + 210]);
    keep.push([c.sign[0] - 80, c.sign[0] + 80, c.sign[1] - 40, c.sign[1] + 160]);
    keep.push([c.fire[0] - 60, c.fire[0] + 60, c.fire[1] - 40, c.fire[1] + 140]);
    keep.push([L.castle[0] - 240, L.castle[0] + 240, L.castle[1] - 340, L.castle[1] + 280]);
    L.gates.forEach(function (g) { keep.push([g.x - 160, g.x + 160, g.y - 60, g.y + 230]); });
    var lakes = [], decor = [], flowers = [];
    function inLake(x, y, pad) {
      return lakes.some(function (l) { var a = (x - l.x) / (l.rx + pad), b = (y - l.y) / (l.ry + pad); return a * a + b * b < 1; });
    }
    function wet(x, y, pad) { return (L.river && Math.abs(y - riverY(L.river, x)) < 58 + pad) || inLake(x, y, pad); }
    function blocked(x, y) {
      for (var i = 0; i < keep.length; i++) { var r = keep[i]; if (x > r[0] && x < r[1] && y > r[2] && y < r[3]) return true; }
      return wet(x, y, 24);
    }
    // озеро — у місцевості «Озеро»: перше вільне місце поруч з її кроками, не на дорозі й не під будівлями
    var builds = keep.slice(2 * n);
    L.zones.forEach(function (z) {
      if (z.key !== 'lake') return;
      var ys = [];
      for (var s = 1; s <= n; s++) if (zoneOfStep(s) === z.i) ys.push(P[s][1]);
      if (!ys.length) return;
      var my = ys.reduce(function (a, v) { return a + v; }, 0) / ys.length;
      var lake = null, mx = 0;
      for (var s2 = 1; s2 <= n; s2++) if (zoneOfStep(s2) === z.i) mx += P[s2][0] / ys.length;
      var dir = mx > GW / 2 ? 1 : -1;                    // шукаємо з того краю, що далі від дороги
      [0, -140, 140, -280, 280].some(function (dy) {
        for (var k = 0; k <= (GW - 460) / 40; k++) {
          var x = dir > 0 ? 230 + k * 40 : GW - 230 - k * 40;
          var cand = { x: x, y: r1(my + dy), rx: 180, ry: 110 };
          if (cand.y - cand.ry < z.y0 + 30 || cand.y + cand.ry > z.y1 - 30) continue;
          if (lakeFits(cand)) { lake = cand; return true; }
        }
        return false;
      });
      if (!lake) return;
      lakes.push(lake);
      for (var q = 0; q < 8; q++) {
        var a = q * Math.PI / 4 + rnd(q + lake.x) * 0.5;
        decor.push({ t: 'reed', x: r1(lake.x + Math.cos(a) * (lake.rx + 6)), y: r1(lake.y + Math.sin(a) * (lake.ry + 6)), s: 0.9, v: 0 });
      }
    });
    function lakeFits(l) {
      var road = samples.some(function (q) { var a = (q[0] - l.x) / (l.rx + 70), b = (q[1] - l.y) / (l.ry + 70); return a * a + b * b < 1; });
      if (road) return false;
      return !builds.some(function (r) { return r[1] > l.x - l.rx && r[0] < l.x + l.rx && r[3] > l.y - l.ry && r[2] < l.y + l.ry; });
    }
    // гори — у місцевості «Гори», ближче до країв острова
    L.zones.forEach(function (z) {
      if (z.key !== 'peaks') return;
      for (var m = 0; m < 4; m++) {
        var y = z.y1 - (m + 0.5) * (z.y1 - z.y0) / 4, x = m % 2 ? GW - 160 - rnd(m + z.i) * 90 : 160 + rnd(m * 3 + z.i) * 90;
        if (nearRoad(x, y, 250) || blocked(x, y)) continue;
        decor.push({ t: 'mountain', x: r1(x), y: r1(y), s: r1(0.8 + rnd(m * 7 + z.i) * 0.45), v: m % 2 });
        keep.push([x - 200, x + 200, y - 90, y + 60]);
      }
    });
    var seed = 0;
    for (var cy = CELL / 2; cy < L.H; cy += CELL) {
      for (var cx = CELL / 2; cx < GW; cx += CELL) {
        seed++;
        var Z = ZONES[zoneAtY(L, cy).i % ZONES.length];
        var x = cx + (rnd(seed * 3.1) - 0.5) * 50, y = cy + (rnd(seed * 5.7) - 0.5) * 50;
        if (x < 40 || x > GW - 40 || y < 40 || y > L.H - 30) continue;
        if (rnd(seed * 1.3) < Z.p && !nearRoad(x, y, 92) && !blocked(x, y)) {
          var kind = pick(Z.kinds, rnd(seed * 2.9));
          decor.push({ t: kind, x: r1(x), y: r1(y), s: r1(0.8 + rnd(seed * 7.3) * 0.55), v: Math.floor(rnd(seed * 9.1) * 3), snow: Z.key === 'peaks' });
        } else if (rnd(seed * 4.4) < Z.flowers && !nearRoad(x, y, 52) && !wet(x, y, 10)) {
          var nf = 1 + Math.floor(rnd(seed * 6.6) * 3);
          for (var f = 0; f < nf; f++) {
            flowers.push({ x: r1(x + (rnd(seed * 8 + f) - 0.5) * 40), y: r1(y + (rnd(seed * 9 + f) - 0.5) * 40), c: Math.floor(rnd(seed * 10 + f) * 4) });
          }
        }
      }
    }
    // хмари: обабіч острова й під урвищем, нижче землі — острів ніби висить у небі
    var clouds = [];
    for (var cl = 0; cl < Math.ceil(L.H / 760); cl++) {
      clouds.push({ x: r1(-250 - rnd(cl * 13.7) * 260), y: r1(cl * 760 + rnd(cl * 3.3) * 300), z: -Math.round(150 + rnd(cl * 5.1) * 250), s: r1(0.9 + rnd(cl * 7.7) * 0.9) });
      clouds.push({ x: r1(GW + 250 + rnd(cl * 17.9) * 260), y: r1(cl * 760 + 380 + rnd(cl * 2.2) * 300), z: -Math.round(150 + rnd(cl * 6.4) * 250), s: r1(0.9 + rnd(cl * 9.9) * 0.9) });
    }
    for (var b = 0; b < 4; b++) clouds.push({ x: r1(150 + b * 380 + rnd(b * 4.4) * 120), y: r1(L.H + 140 + rnd(b * 8.8) * 220), z: -Math.round(260 + rnd(b * 1.7) * 200), s: r1(1 + rnd(b * 2.6) * 0.8) });
    L.lakes = lakes; L.decor = decor; L.flowers = flowers; L.clouds = clouds;
  }
  function pick(kinds, r) {
    for (var i = 0, acc = 0; i < kinds.length; i++) { acc += kinds[i][1]; if (r < acc) return kinds[i][0]; }
    return kinds[kinds.length - 1][0];
  }

  /* ---------- земля: одне SVG на весь острів ---------- */

  /** Розмір підніжжя (ширина, px) для тіні. */
  var FOOT = { pine: 66, round: 84, birch: 62, bush: 72, rock: 60, mushroom: 26, reed: 26, mountain: 330 };

  /** Де стоїть персонаж: на поточному кроці; коли все пройдено — біля замку. states — стан кожного кроку. */
  function mePoint(L, states) {
    var i = states.indexOf('now');
    return i < 0 ? [L.castle[0] + 120, L.castle[1] + 80] : L.P[i + 1];
  }

  /** Земля острова: трава, місцевості, вода, квіти, дорога (пройдене — золоте), міст, майданчики кроків, тіні, вогники.
      states — 'done' | 'now' | 'locked' для кожного кроку; поточний майданчик живий (пульсує), тож він не тут, а окремо. */
  function groundSvg(L, states) {
    var P = L.P, o = [], nowI = states.indexOf('now'), walked = nowI < 0 ? P.length - 1 : nowI + 1;
    o.push('<svg class="w-roads" width="' + GW + '" height="' + L.H + '" viewBox="0 0 ' + GW + ' ' + L.H + '" aria-hidden="true"><defs>' +
      '<radialGradient id="wsh"><stop offset="0" stop-color="#000" stop-opacity=".36"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient>' +
      '<radialGradient id="wglow"><stop offset="0" class="wg0"/><stop offset="1" class="wg1"/></radialGradient>' +
      '<radialGradient id="wnd-done" cx=".4" cy=".35"><stop offset="0" stop-color="#70e2a9"/><stop offset="1" stop-color="#34b077"/></radialGradient>' +
      '<radialGradient id="wnd-locked" cx=".4" cy=".35"><stop offset="0" stop-color="#f1f2f7"/><stop offset="1" stop-color="#c6cad8"/></radialGradient>' +
      '<pattern id="wtex" width="150" height="150" patternUnits="userSpaceOnUse">');
    for (var t = 0; t < 22; t++) {
      var tx = r1(rnd(t * 1.7) * 150), ty = r1(rnd(t * 2.3) * 150);
      o.push('<path class="gtx" d="M' + tx + ' ' + ty + 'l-2 -7M' + (tx + 3) + ' ' + ty + 'l1 -8M' + (tx + 6) + ' ' + ty + 'l3 -6"/>');
    }
    o.push('</pattern>');
    // хмара — один раз; хмари під островом ставлять її через <use>
    o.push('<g id="wt-cloud">' + inline(ART.cloud()[2]) + '</g>');
    L.zones.forEach(function (z) {
      o.push('<linearGradient id="wz' + z.i + '" x1="0" y1="0" x2="0" y2="1">' +
        '<stop offset="0" class="zs-' + z.key + '" stop-opacity="0"/><stop offset=".1" class="zs-' + z.key + '" stop-opacity=".8"/>' +
        '<stop offset=".9" class="zs-' + z.key + '" stop-opacity=".8"/><stop offset="1" class="zs-' + z.key + '" stop-opacity="0"/></linearGradient>');
    });
    o.push('</defs>');
    L.zones.forEach(function (z) {
      o.push('<rect class="w-zone" x="0" y="' + r1(z.y0) + '" width="' + GW + '" height="' + r1(z.y1 - z.y0) + '" fill="url(#wz' + z.i + ')"/>');
    });
    o.push('<rect width="' + GW + '" height="' + L.H + '" fill="url(#wtex)"/>');
    L.lakes.forEach(function (l) {
      o.push('<ellipse class="lk-bank" cx="' + l.x + '" cy="' + l.y + '" rx="' + r1(l.rx + 14) + '" ry="' + r1(l.ry + 11) + '"/>' +
        '<ellipse class="lk-water" cx="' + l.x + '" cy="' + l.y + '" rx="' + l.rx + '" ry="' + l.ry + '"/>' +
        '<ellipse class="lk-deep" cx="' + l.x + '" cy="' + r1(l.y + 10) + '" rx="' + r1(l.rx * 0.6) + '" ry="' + r1(l.ry * 0.52) + '"/>' +
        '<path class="lk-shine" d="M' + r1(l.x - l.rx * 0.45) + ' ' + r1(l.y - l.ry * 0.3) + ' q' + r1(l.rx * 0.3) + ' -14 ' + r1(l.rx * 0.6) + ' 0"/>');
    });
    if (L.river) {
      var d = '';
      for (var x = -60; x <= GW + 60; x += 30) d += (d ? ' L' : 'M') + x + ' ' + r1(riverY(L.river, x));
      o.push('<path class="wr-bank" d="' + d + '"/><path class="wr-water" d="' + d + '"/><path class="wr-deep" d="' + d + '"/><path class="wr-shine" d="' + d + '"/>');
    }
    // квіти: по одному шляху на колір (сотні кіл — це сотні вузлів)
    var fl = ['', '', '', ''];
    L.flowers.forEach(function (f) { fl[f.c] += 'M' + r1(f.x - 5) + ' ' + f.y + 'a5 5 0 1 0 10 0a5 5 0 1 0 -10 0'; });
    o.push('<g class="w-flowers">');
    fl.forEach(function (d, c) { if (d) o.push('<path class="fl fl' + c + '" d="' + d + '"/>'); });
    o.push('</g>');
    var road = roadPath(P, P.length - 1);
    o.push('<path class="w-road-edge" d="' + road + '"/><path class="w-road" d="' + road + '"/>' +
      '<path class="w-road-done" d="' + roadPath(P, walked) + '"/><path class="w-road-mid" d="' + road + '"/>');
    if (L.river) {
      var R = L.river, deck = '<rect class="br-deck" x="-82" y="-42" width="164" height="84" rx="6"/>';
      for (var sx = -70; sx <= 70; sx += 14) deck += '<path class="br-seam" d="M' + sx + ' -40v80"/>';
      deck += '<rect class="br-rail" x="-86" y="-48" width="172" height="8" rx="4"/><rect class="br-rail" x="-86" y="40" width="172" height="8" rx="4"/>';
      o.push('<g class="w-bridge" transform="translate(' + R.x + ' ' + R.y + ') rotate(' + R.angle + ')">' + deck + '</g>');
    }
    // майданчики кроків: товщина — темніше коло нижче, кільце, верх; клік і клавіатура — у tasks.js
    states.forEach(function (st, i) {
      if (st === 'now') return;
      var p = P[i + 1];
      o.push('<g class="w-node ' + st + '" data-step="' + (i + 1) + '" transform="translate(' + r1(p[0]) + ' ' + r1(p[1]) + ')">' +
        '<ellipse cy="18" rx="50" ry="46" fill="url(#wsh)"/><circle class="nd-side" cy="11" r="43"/><circle class="nd-ring" r="43"/>' +
        '<circle r="37" fill="url(#wnd-' + st + ')"/></g>');
    });
    // тіні: усе, що стоїть, кидає тінь; сонце й довжину тіні задає небо (CSS)
    o.push('<g class="w-shadows">');
    function shadow(x, y, w, s) {
      o.push('<ellipse class="w-shadow" cx="' + r1(x) + '" cy="' + r1(y - 2) + '" rx="' + r1(w * 0.44 * s) + '" ry="' + r1((7 + w * 0.05) * s) + '" fill="url(#wsh)"/>');
    }
    L.decor.forEach(function (dd) { shadow(dd.x, dd.y, FOOT[dd.t] || 60, dd.s); });
    shadow(L.camp.house[0], L.camp.house[1], 160, 1);
    shadow(L.camp.sign[0], L.camp.sign[1], 40, 1);
    shadow(L.castle[0], L.castle[1], 300, 1);
    var me = mePoint(L, states);
    shadow(me[0], me[1] + 4, 90, 1);
    L.gates.forEach(function (g) { shadow(g.x - 92, g.y, 34, 1); shadow(g.x + 92, g.y, 34, 1); });
    o.push('</g>');
    // вогники на вечір і ніч: пройдене, хатинка, багаття, замок
    o.push('<g class="w-glows">');
    for (var k = 1; k < Math.min(walked + 1, P.length - 1); k++) o.push('<circle class="w-glow" cx="' + r1(P[k][0]) + '" cy="' + r1(P[k][1]) + '" r="120" fill="url(#wglow)"/>');
    o.push('<circle class="w-glow" cx="' + r1(L.camp.fire[0]) + '" cy="' + r1(L.camp.fire[1]) + '" r="170" fill="url(#wglow)"/>' +
      '<circle class="w-glow" cx="' + r1(L.camp.house[0]) + '" cy="' + r1(L.camp.house[1]) + '" r="150" fill="url(#wglow)"/>' +
      '<circle class="w-glow" cx="' + r1(L.castle[0]) + '" cy="' + r1(L.castle[1]) + '" r="280" fill="url(#wglow)"/></g>');
    o.push('</svg>');
    return o.join('');
  }

  /* ---------- малюнки (стоять на землі; низ малюнка — точка опори) ---------- */

  function svgOf(w, h, s, body) {
    return '<svg viewBox="0 0 ' + w + ' ' + h + '" width="' + r1(w * s) + '" height="' + r1(h * s) + '" aria-hidden="true">' + body + '</svg>';
  }
  var ART = {
    pine: function (v, snow) {
      var b = '<rect class="tk" x="31" y="98" width="8" height="26" rx="2"/>' +
        '<polygon class="pn1" points="35,46 2,104 35,104"/><polygon class="pn2" points="35,46 68,104 35,104"/>' +
        '<polygon class="pn1" points="35,22 7,78 35,78"/><polygon class="pn2" points="35,22 63,78 35,78"/>' +
        '<polygon class="pn1" points="35,2 12,50 35,50"/><polygon class="pn2" points="35,2 58,50 35,50"/>';
      if (snow) b += '<polygon class="snow" points="35,2 24,24 30,21 35,27 40,21 46,24"/><polygon class="snow" points="35,24 20,50 28,46 35,52 42,46 50,50"/>';
      return [70, 124, b];
    },
    round: function (v) {
      var b = '<path class="tk" d="M40 72 L37 120 L53 120 L50 72 Z"/><path class="tk" d="M46 96 L60 82 L62 86 L49 100 Z"/>' +
        '<circle class="lf2" cx="47" cy="52" r="34"/><circle class="lf1" cx="38" cy="46" r="28"/><circle class="lf1" cx="59" cy="36" r="20"/>' +
        '<circle class="lf3" cx="31" cy="35" r="11"/>';
      if (v === 1) b += '<circle class="ap" cx="58" cy="52" r="4"/><circle class="ap" cx="36" cy="62" r="4"/><circle class="ap" cx="66" cy="34" r="3.5"/>';
      return [90, 120, b];
    },
    birch: function () {
      return [70, 132, '<rect class="bk" x="31" y="40" width="8" height="92" rx="3"/><path class="bm" d="M31 62h4M35 80h4M31 98h5M34 114h5"/>' +
        '<ellipse class="lb2" cx="36" cy="44" rx="28" ry="38"/><ellipse class="lb1" cx="31" cy="37" rx="20" ry="28"/><ellipse class="lf3" cx="27" cy="28" rx="8" ry="11"/>'];
    },
    bush: function (v) {
      var b = '<circle class="lf2" cx="24" cy="32" r="16"/><circle class="lf2" cx="54" cy="33" r="15"/><circle class="lf1" cx="38" cy="24" r="20"/><circle class="lf3" cx="31" cy="17" r="7"/>';
      if (v === 1) b += '<circle class="bry" cx="22" cy="30" r="3"/><circle class="bry" cx="47" cy="22" r="3"/><circle class="bry" cx="56" cy="34" r="3"/>';
      return [76, 48, b];
    },
    rock: function (v) {
      return [64, 44, v === 2
        ? '<polygon class="rk1" points="4,44 8,28 22,18 40,20 52,30 60,44"/><polygon class="rk2" points="22,18 40,20 36,30 20,28"/><polygon class="rk3" points="8,28 20,28 18,44 4,44"/>'
        : '<polygon class="rk1" points="4,44 10,22 26,8 46,10 60,26 58,44"/><polygon class="rk2" points="26,8 46,10 42,26 24,22"/><polygon class="rk3" points="10,22 24,22 20,44 4,44"/>'];
    },
    mushroom: function () {
      return [30, 30, '<rect class="ms" x="11" y="14" width="8" height="16" rx="3"/><path class="mc" d="M2 16 Q15 -4 28 16 Z"/>' +
        '<circle class="md" cx="10" cy="9" r="2"/><circle class="md" cx="18" cy="6.5" r="2.2"/><circle class="md" cx="22" cy="12" r="1.6"/>'];
    },
    reed: function () {
      return [34, 64, '<path class="rd" d="M8 64 Q6 30 4 18M17 64 Q17 30 17 8M26 64 Q28 34 31 22"/>' +
        '<rect class="rc" x="1.5" y="16" width="5" height="16" rx="2.5"/><rect class="rc" x="14.5" y="6" width="5" height="18" rx="2.5"/><rect class="rc" x="28.5" y="20" width="5" height="14" rx="2.5"/>'];
    },
    mountain: function (v) {
      return [380, 300, '<polygon class="mt3" points="' + (v ? '20,300 90,130 170,300' : '210,300 290,120 380,300') + '"/>' +
        '<polygon class="mt1" points="10,300 180,18 180,300"/><polygon class="mt2" points="180,18 350,300 180,300"/>' +
        '<polygon class="snow" points="180,18 134,94 152,86 166,106 180,88 196,104 212,84 226,94"/>'];
    },
    house: function () {
      return [160, 170, '<g class="smoke"><circle cx="110" cy="30" r="7"/><circle cx="116" cy="16" r="9"/><circle cx="108" cy="0" r="11"/></g>' +
        '<rect class="hc" x="100" y="44" width="15" height="34" rx="2"/>' +
        '<rect class="hw" x="24" y="86" width="112" height="82"/><rect class="hw2" x="80" y="86" width="56" height="82"/>' +
        '<polygon class="hr" points="10,92 80,34 150,92"/><polygon class="hr2" points="80,34 150,92 80,92"/>' +
        '<rect class="hd" x="69" y="118" width="22" height="50" rx="4"/><circle class="hk" cx="86" cy="145" r="2"/>' +
        '<rect class="hwin" x="36" y="104" width="22" height="20" rx="2"/><rect class="hwin" x="102" y="104" width="22" height="20" rx="2"/>' +
        '<path class="hwf" d="M47 104v20M36 114h22M113 104v20M102 114h22"/>'];
    },
    fire: function () {
      return [60, 60, '<rect class="lg" x="8" y="48" width="44" height="8" rx="4" transform="rotate(-16 30 52)"/>' +
        '<rect class="lg2" x="8" y="48" width="44" height="8" rx="4" transform="rotate(16 30 52)"/>' +
        '<path class="f1" d="M30 6 C40 22 45 31 39 44 C35 51 25 51 21 44 C15 33 22 22 30 6Z"/>' +
        '<path class="f2" d="M30 22 C35 31 37 37 34 44 C32 48 28 48 26 44 C23 37 26 31 30 22Z"/>'];
    },
    castle: function () {
      var b = '<rect class="cs1" x="40" y="128" width="220" height="152"/>';
      for (var i = 0; i < 11; i++) b += '<rect class="cs1" x="' + (42 + i * 20) + '" y="114" width="12" height="16"/>';
      b += '<rect class="csh" x="150" y="114" width="110" height="166"/>' +
        '<rect class="cs2" x="10" y="84" width="62" height="196"/><rect class="csh" x="41" y="84" width="31" height="196"/>' +
        '<rect class="cs2" x="228" y="84" width="62" height="196"/><rect class="csh" x="259" y="84" width="31" height="196"/>' +
        '<rect class="cs2" x="108" y="60" width="84" height="220"/><rect class="csh" x="150" y="60" width="42" height="220"/>' +
        '<polygon class="cr" points="2,88 41,24 80,88"/><polygon class="cr2" points="41,24 80,88 41,88"/>' +
        '<polygon class="cr" points="220,88 259,24 298,88"/><polygon class="cr2" points="259,24 298,88 259,88"/>' +
        '<polygon class="cr" points="98,64 150,0 202,64"/><polygon class="cr2" points="150,0 202,64 150,64"/>' +
        '<path class="fp" d="M150 0V-36M41 24V-6M259 24V-6"/>' +
        '<path class="fg" d="M150 -36L188 -27L150 -17Z"/><path class="fg" d="M41 -6L66 0L41 7Z"/><path class="fg" d="M259 -6L284 0L259 7Z"/>' +
        '<path class="cg" d="M124 280V238a26 26 0 0 1 52 0V280Z"/><path class="cgl" d="M134 230V280M150 214V280M166 230V280M124 254H176"/>' +
        '<rect class="cw" x="34" y="126" width="14" height="24" rx="7"/><rect class="cw" x="252" y="126" width="14" height="24" rx="7"/>' +
        '<rect class="cw" x="142" y="96" width="16" height="28" rx="8"/><rect class="cw" x="142" y="150" width="16" height="26" rx="8"/>' +
        '<rect class="cw" x="34" y="186" width="14" height="22" rx="7"/><rect class="cw" x="252" y="186" width="14" height="22" rx="7"/>';
      return [300, 280, b];
    },
    gate: function (v, no, name) {
      return [240, 210, '<rect class="gp" x="26" y="52" width="16" height="158" rx="3"/><rect class="gp" x="198" y="52" width="16" height="158" rx="3"/>' +
        '<path class="gb" d="M2 40 Q120 18 238 40 L236 56 Q120 36 4 56 Z"/><rect class="gb2" x="20" y="74" width="200" height="10" rx="3"/>' +
        '<rect class="gs" x="66" y="52" width="108" height="54" rx="8"/>' +
        '<text class="gt" x="120" y="76" text-anchor="middle">Етап ' + no + '</text>' +
        '<text class="gn" x="120" y="97" text-anchor="middle">' + name + '</text>'];
    },
    cloud: function () {
      return [240, 120, '<ellipse class="cl2" cx="120" cy="94" rx="112" ry="24"/>' +
        '<circle class="cl1" cx="70" cy="74" r="40"/><circle class="cl1" cx="122" cy="58" r="52"/><circle class="cl1" cx="174" cy="74" r="38"/>' +
        '<circle class="cl1" cx="98" cy="86" r="32"/><circle class="cl1" cx="148" cy="88" r="30"/><circle class="cl3" cx="108" cy="44" r="22"/>'];
    }
  };
  /** Кольори малюнків, що ставляться через <use>: стилі документа до їхніх копій не доходять, а змінні — успадковуються. */
  var CLASS_STYLE = {
    tk: 'fill:var(--trunk)', lf1: 'fill:var(--leaf1)', lf2: 'fill:var(--leaf2)', lf3: 'fill:var(--leaf3)', lb1: 'fill:var(--lb1)', lb2: 'fill:var(--lb2)',
    pn1: 'fill:var(--pine1)', pn2: 'fill:var(--pine2)', snow: 'fill:#f4f8ff', ap: 'fill:#e8473b', bry: 'fill:#d23a6a',
    bk: 'fill:var(--birch)', bm: 'fill:none;stroke:#3b3b3b;stroke-width:2.5;stroke-linecap:round',
    rk1: 'fill:var(--rock1)', rk2: 'fill:var(--rock2)', rk3: 'fill:var(--rock3)', ms: 'fill:#f5eee0', mc: 'fill:#e0483c', md: 'fill:#fff',
    rd: 'fill:none;stroke:#5e8f3a;stroke-width:3;stroke-linecap:round', rc: 'fill:#7a4b2a',
    mt1: 'fill:var(--mt1)', mt2: 'fill:var(--mt2)', mt3: 'fill:var(--mt3)',
    cl1: 'fill:var(--cloud)', cl2: 'fill:var(--cloud2)', cl3: 'fill:#fff;opacity:.6'
  };
  function inline(body) { return body.replace(/class="([\w-]+)"/g, function (m, c) { return CLASS_STYLE[c] ? 'style="' + CLASS_STYLE[c] + '"' : m; }); }

  /* ---------- проєкція й рослини на полотні ----------
     Кожен «стоячий» елемент у CSS-3D — окремий шар і прохід рендерингу. Тому рослини (їх сотні)
     малюються на одному полотні: точка землі переводиться в екран тією самою формулою, що й CSS сцени. */

  /** Точка землі (u, v) → екран. cam — { x, y, z } (точка землі у фокусі й наближення), view — { w, h } екрана.
      Повертає { x, y, k }: екранну точку й масштаб «стоячого» малюнка, або null, якщо точка позаду камери. */
  function project(cam, view, u, v) {
    var a = TILT * Math.PI / 180, w = cam.z * (v - cam.y);
    var X = view.w * CAM.tx + cam.z * (u - cam.x), Y = view.h * CAM.ty + w * Math.cos(a), Z = w * Math.sin(a);
    if (Z >= CAM.d - 1) return null;
    var f = CAM.d / (CAM.d - Z), ox = view.w * CAM.ox, oy = view.h * CAM.oy;
    return { x: ox + (X - ox) * f, y: oy + (Y - oy) * f, k: cam.z * f };
  }
  /** Зворотне: точка екрана → точка землі { u, v } (для кліків: хто під пальцем). */
  function unproject(cam, view, sx, sy) {
    var a = TILT * Math.PI / 180, ox = view.w * CAM.ox, oy = view.h * CAM.oy, tx = view.w * CAM.tx, ty = view.h * CAM.ty;
    var w = CAM.d * (sy - ty) / (CAM.d * Math.cos(a) + (sy - oy) * Math.sin(a));
    var f = CAM.d / (CAM.d - w * Math.sin(a)), X = ox + (sx - ox) / f;
    return { u: cam.x + (X - tx) / cam.z, v: cam.y + w / cam.z };
  }
  function spriteId(d) { return d.t === 'mountain' ? 'mountain-' + (d.v ? 1 : 0) : decalId(d); }
  /** SVG рослини чи гори зі справжніми кольорами (для растеризації в картинку); r — роздільність. */
  function sprite(id, colors, r) {
    var a = id.indexOf('mountain-') === 0 ? ART.mountain(+id.slice(9)) : DECAL[id]();
    var body = inline(a[2]).replace(/var\(--([\w-]+)\)/g, function (m, k) { return colors[k] || '#888'; });
    return { w: a[0], h: a[1], svg: '<svg xmlns="http://www.w3.org/2000/svg" width="' + Math.round(a[0] * r) + '" height="' + Math.round(a[1] * r) +
      '" viewBox="0 0 ' + a[0] + ' ' + a[1] + '">' + body + '</svg>' };
  }
  /** Змінні кольорів, які потрібні рослинам і горам. */
  var SPRITE_VARS = ['trunk', 'leaf1', 'leaf2', 'leaf3', 'lb1', 'lb2', 'pine1', 'pine2', 'birch', 'rock1', 'rock2', 'rock3', 'mt1', 'mt2', 'mt3'];

  /** Рослини: id малюнка → малюнок. */
  var DECAL = {
    pine: function () { return ART.pine(0, false); }, 'pine-s': function () { return ART.pine(0, true); },
    'round-0': function () { return ART.round(0); }, 'round-1': function () { return ART.round(1); },
    birch: function () { return ART.birch(); }, 'bush-0': function () { return ART.bush(0); }, 'bush-1': function () { return ART.bush(1); },
    'rock-0': function () { return ART.rock(0); }, 'rock-2': function () { return ART.rock(2); },
    mushroom: function () { return ART.mushroom(); }, reed: function () { return ART.reed(); }
  };
  function decalId(d) {
    if (d.t === 'pine') return d.snow ? 'pine-s' : 'pine';
    if (d.t === 'round' || d.t === 'bush') return d.t + '-' + (d.v === 1 ? 1 : 0);
    if (d.t === 'rock') return 'rock-' + (d.v === 2 ? 2 : 0);
    return d.t;
  }

  /** SVG-малюнок kind у масштабі s. Для ялинки a — сніг на гілках; для брами a — номер етапу, b — назва місцевості. */
  function art(kind, v, s, a, b) {
    var x = ART[kind](v, a, b);
    return svgOf(x[0], x[1], s || 1, x[2]);
  }

  window.SpravyWorld = {
    TILT: TILT, CAM: CAM, project: project, unproject: unproject, mePoint: mePoint, sprite: sprite, spriteId: spriteId, SPRITE_VARS: SPRITE_VARS, layout: layout, groundSvg: groundSvg, roadPath: roadPath, art: art, skyAt: skyAt,
    zoneOfStep: zoneOfStep, zoneInfo: zoneInfo, rnd: rnd, riverY: riverY
  };
})();
