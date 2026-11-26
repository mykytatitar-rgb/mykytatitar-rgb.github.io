/* Блоковий світ цілі: власний невеликий WebGL-рушій (без бібліотек).
   Світ будується з кроків цілі (gen), поверх — блоки, які людина поставила сама.
   Малюємо лише видимі грані, усе одним буфером і одним викликом; кадр — лише коли щось змінилось.
   Вантажиться ліниво, коли відкривають режим «Будувати» (tasks.js). */
(function () {
  'use strict';

  /** Типи блоків: колір. 1–8 можна ставити й зберігати; 9+ — лише споруди кроків. */
  var COLORS = {
    1: [124, 195, 90], 2: [138, 90, 51], 3: [167, 173, 184], 4: [160, 112, 63], 5: [63, 157, 85],
    6: [208, 100, 74], 7: [245, 183, 49], 8: [159, 216, 240], 9: [255, 122, 47], 10: [198, 202, 216]
  };
  var PALETTE = [[1, 'Трава'], [3, 'Камінь'], [4, 'Дерево'], [5, 'Листя'], [6, 'Цегла'], [8, 'Скло']];
  var W = 21, MID = 10, GAP = 6;

  function key(x, y, z) { return x + ',' + y + ',' + z; }
  function hash(x, y, z) { var h = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453; return h - Math.floor(h); }

  /** Світ із кроків: states — 'done' | 'now' | 'locked' по порядку. Повертає { map, len, steps: [{x,z}], start }. */
  function gen(states) {
    var n = states.length, len = 8 + n * GAP + 10, map = {}, steps = [];
    for (var x = 0; x < W; x++) for (var z = 0; z < len; z++) {
      map[key(x, -2, z)] = 3; map[key(x, -1, z)] = 2;
      map[key(x, 0, z)] = Math.abs(x - MID) <= 1 && z > 1 && z < len - 9 ? 3 : 1;     // кам'яна доріжка
    }
    states.forEach(function (st, i) {
      var z = 6 + i * GAP, x = MID + (i % 2 ? 3 : -3), h = st === 'done' ? 4 : st === 'now' ? 6 : 1;
      steps.push({ x: x, z: z });
      for (var y = 1; y <= h; y++) map[key(x, y, z)] = st === 'done' ? 7 : st === 'now' ? 9 : 10;
    });
    // замок на фініші
    var cz = len - 8;
    for (var dx = -3; dx <= 3; dx++) for (var dz = 0; dz < 6; dz++) {
      var edge = Math.abs(dx) === 3 || dz === 0 || dz === 5;
      if (!edge) continue;
      var hh = (Math.abs(dx) === 3 && (dz === 0 || dz === 5)) ? 6 : 4;
      for (var y2 = 1; y2 <= hh; y2++) if (!(dz === 0 && Math.abs(dx) <= 1 && y2 <= 2)) map[key(MID + dx, y2, cz + dz)] = 6;
    }
    // кілька дерев обабіч
    for (var t = 0; t < len; t += 5) {
      [[2, t + 2], [W - 3, t + 4]].forEach(function (p) {
        if (p[1] >= len - 10 || hash(p[0], 0, p[1]) < 0.35) return;
        for (var y3 = 1; y3 <= 3; y3++) map[key(p[0], y3, p[1])] = 4;
        for (var ax = -1; ax <= 1; ax++) for (var az = -1; az <= 1; az++) map[key(p[0] + ax, 4, p[1] + az)] = 5;
        map[key(p[0], 5, p[1])] = 5;
      });
    }
    return { map: map, len: len, steps: steps };
  }

  /* ---------- рушій ---------- */
  var FACES = [ // нормаль, 4 кути, тінь
    [[0, 1, 0], [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]], 1],
    [[0, -1, 0], [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], 0.5],
    [[1, 0, 0], [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]], 0.86],
    [[-1, 0, 0], [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]], 0.68],
    [[0, 0, 1], [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], 0.78],
    [[0, 0, -1], [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]], 0.74]
  ];
  function mesh(map) {
    var pos = [], col = [];
    Object.keys(map).forEach(function (k) {
      var t = map[k]; if (!t) return;
      var p = k.split(','), x = +p[0], y = +p[1], z = +p[2], c = COLORS[t] || COLORS[3], v = 0.94 + hash(x, y, z) * 0.12;
      FACES.forEach(function (f) {
        if (map[key(x + f[0][0], y + f[0][1], z + f[0][2])]) return;
        var q = f[1], s = f[2] * v;
        [0, 1, 2, 0, 2, 3].forEach(function (i) {
          pos.push(x + q[i][0], y + q[i][1], z + q[i][2]);
          col.push(c[0] / 255 * s, c[1] / 255 * s, c[2] / 255 * s);
        });
      });
    });
    return { pos: new Float32Array(pos), col: new Float32Array(col), n: pos.length / 3 };
  }
  var VS = 'attribute vec3 p;attribute vec3 c;uniform mat4 m;uniform vec3 e;varying vec3 vc;varying float d;' +
    'void main(){vc=c;d=distance(p,e);gl_Position=m*vec4(p,1.0);}';
  var FS = 'precision mediump float;varying vec3 vc;varying float d;uniform vec3 sky;' +
    'void main(){float f=clamp((d-25.0)/70.0,0.0,0.75);gl_FragColor=vec4(mix(vc,sky,f),1.0);}';

  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function norm(a) { var l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

  /** Рушій на полотні. opts: { states, blocks, sky: [r,g,b] 0..1, onHit(cell, prev, remove) }. */
  function create(canvas, opts) {
    var gl = canvas.getContext('webgl', { antialias: true });
    if (!gl) return null;
    function sh(type, src) { var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; }
    var pr = gl.createProgram();
    gl.attachShader(pr, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(pr); gl.useProgram(pr);
    var aP = gl.getAttribLocation(pr, 'p'), aC = gl.getAttribLocation(pr, 'c');
    var uM = gl.getUniformLocation(pr, 'm'), uE = gl.getUniformLocation(pr, 'e'), uS = gl.getUniformLocation(pr, 'sky');
    var bP = gl.createBuffer(), bC = gl.createBuffer(), count = 0;
    gl.enable(gl.DEPTH_TEST); gl.enable(gl.CULL_FACE);
    var world = gen(opts.states), map = {}, own = {};
    var cam = { yaw: -0.6, pitch: 0.62, dist: 22, t: [MID + 0.5, 1, 6] };
    var nowI = opts.states.indexOf('now'), focus = world.steps[nowI < 0 ? world.steps.length - 1 : nowI];
    if (focus) cam.t = [MID + 0.5, 1, focus.z + 0.5];
    var dirty = true, raf = 0;

    function setBlocks(blocks) {
      map = Object.assign({}, world.map); own = {};
      blocks.forEach(function (b) { map[key(b[0], b[1], b[2])] = b[3]; own[key(b[0], b[1], b[2])] = b[3]; });
      var m = mesh(map); count = m.n;
      gl.bindBuffer(gl.ARRAY_BUFFER, bP); gl.bufferData(gl.ARRAY_BUFFER, m.pos, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, bC); gl.bufferData(gl.ARRAY_BUFFER, m.col, gl.STATIC_DRAW);
      redraw();
    }
    function eye() {
      var cp = Math.cos(cam.pitch);
      return [cam.t[0] + Math.sin(cam.yaw) * cp * cam.dist, cam.t[1] + Math.sin(cam.pitch) * cam.dist, cam.t[2] - Math.cos(cam.yaw) * cp * cam.dist];
    }
    function basis() {
      var e = eye(), f = norm(sub(cam.t, e)), r = norm(cross(f, [0, 1, 0])), u = cross(r, f);
      return { e: e, f: f, r: r, u: u };
    }
    var FOV = 50 * Math.PI / 180;
    function matrix() {
      var b = basis(), a = canvas.width / canvas.height, t = 1 / Math.tan(FOV / 2), n = 0.1, fr = 300;
      var V = [b.r[0], b.u[0], -b.f[0], 0, b.r[1], b.u[1], -b.f[1], 0, b.r[2], b.u[2], -b.f[2], 0,
        -dot(b.r, b.e), -dot(b.u, b.e), dot(b.f, b.e), 1];
      var Pm = [t / a, 0, 0, 0, 0, t, 0, 0, 0, 0, (fr + n) / (n - fr), -1, 0, 0, 2 * fr * n / (n - fr), 0];
      var M = new Float32Array(16);
      for (var i = 0; i < 4; i++) for (var j = 0; j < 4; j++) {
        var s = 0; for (var k = 0; k < 4; k++) s += Pm[k * 4 + j] * V[i * 4 + k]; M[i * 4 + j] = s;
      }
      return { M: M, e: b.e };
    }
    function draw() {
      raf = 0; dirty = false;
      var dpr = Math.min(2, window.devicePixelRatio || 1), w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      gl.viewport(0, 0, w, h);
      var sky = opts.sky || [0.75, 0.88, 1];
      gl.clearColor(sky[0], sky[1], sky[2], 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      var m = matrix();
      gl.uniformMatrix4fv(uM, false, m.M); gl.uniform3fv(uE, m.e); gl.uniform3fv(uS, sky);
      gl.bindBuffer(gl.ARRAY_BUFFER, bP); gl.enableVertexAttribArray(aP); gl.vertexAttribPointer(aP, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, bC); gl.enableVertexAttribArray(aC); gl.vertexAttribPointer(aC, 3, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, count);
      if (api.onFrame) api.onFrame();
    }
    function redraw() { dirty = true; if (!raf) raf = requestAnimationFrame(draw); }

    /** Промінь з точки екрана по сітці: перший блок і клітинка перед ним. */
    function pick(cx, cy) {
      var r = canvas.getBoundingClientRect(), b = basis(), a = r.width / r.height, t = Math.tan(FOV / 2);
      var nx = ((cx - r.left) / r.width * 2 - 1) * t * a, ny = (1 - (cy - r.top) / r.height * 2) * t;
      var d = norm([b.f[0] + b.r[0] * nx + b.u[0] * ny, b.f[1] + b.r[1] * nx + b.u[1] * ny, b.f[2] + b.r[2] * nx + b.u[2] * ny]);
      var p = b.e.slice(), c = [Math.floor(p[0]), Math.floor(p[1]), Math.floor(p[2])], prev = null;
      var st = d.map(function (v) { return v > 0 ? 1 : -1; });
      var tMax = [0, 1, 2].map(function (i) { return d[i] ? ((st[i] > 0 ? c[i] + 1 - p[i] : p[i] - c[i]) / Math.abs(d[i])) : Infinity; });
      var tD = d.map(function (v) { return v ? 1 / Math.abs(v) : Infinity; });
      for (var i = 0; i < 260; i++) {
        if (map[key(c[0], c[1], c[2])]) return { cell: c, prev: prev };
        prev = c.slice();
        var ax = tMax[0] < tMax[1] ? (tMax[0] < tMax[2] ? 0 : 2) : (tMax[1] < tMax[2] ? 1 : 2);
        c[ax] += st[ax]; tMax[ax] += tD[ax];
      }
      return null;
    }

    // керування: тягнути — обертати, колесо — ближче/далі, WASD — іти, клік — поставити, Shift/права — прибрати
    var drag = null;
    canvas.addEventListener('pointerdown', function (e) { drag = { x: e.clientX, y: e.clientY, yaw: cam.yaw, pitch: cam.pitch, moved: false, btn: e.button, shift: e.shiftKey }; });
    canvas.addEventListener('pointermove', function (e) {
      if (!drag) return;
      var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 5) drag.moved = true;
      if (!drag.moved) return;
      cam.yaw = drag.yaw + dx * 0.008; cam.pitch = Math.max(0.15, Math.min(1.45, drag.pitch + dy * 0.006)); redraw();
    });
    canvas.addEventListener('pointerup', function (e) {
      var d0 = drag; drag = null;
      if (!d0 || d0.moved) return;
      var hit = pick(e.clientX, e.clientY);
      if (hit && opts.onHit) opts.onHit(hit.cell, hit.prev, d0.btn === 2 || d0.shift, !!own[key(hit.cell[0], hit.cell[1], hit.cell[2])]);
    });
    canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    canvas.addEventListener('wheel', function (e) { e.preventDefault(); cam.dist = Math.max(6, Math.min(70, cam.dist * (e.deltaY > 0 ? 1.1 : 0.9))); redraw(); }, { passive: false });
    function walk(fx, fz) {
      var s = Math.sin(cam.yaw), c = Math.cos(cam.yaw);
      cam.t[0] = Math.max(0, Math.min(W, cam.t[0] + (-s * fz + c * fx)));
      cam.t[2] = Math.max(0, Math.min(world.len, cam.t[2] + (c * fz + s * fx)));
      redraw();
    }
    var api = {
      setBlocks: setBlocks, redraw: redraw, walk: walk, world: world, cam: cam,
      free: function (c) { return !map[key(c[0], c[1], c[2])]; },
      destroy: function () { cancelAnimationFrame(raf); var x = gl.getExtension('WEBGL_lose_context'); if (x) x.loseContext(); },
      faces: function () { return count / 6; }
    };
    setBlocks(opts.blocks || []);
    return api;
  }

  window.SpravyVoxel = { create: create, gen: gen, PALETTE: PALETTE, COLORS: COLORS };
})();
