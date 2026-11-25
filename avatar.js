/* Персонаж «Справ» — власник застосунку в мультяшному стилі: світле волосся набік,
   світлі очі, широка усмішка, біла сорочка з комірцем. Чисте SVG, без картинок і мережі.

   SpravyAvatar.svg(mood, size): mood — 'happy' (усмішка), 'cheer' (кулак угору, «так!»),
   'calm' (спокійна усмішка, для вечора й «мало сил»). Повертає рядок SVG. */

(function () {
  'use strict';

  var C = {
    skin: '#f5cfb3', skinShade: '#e8b394', blush: '#f2a28c',
    hair: '#e6c27a', hairDark: '#c99d4f', hairLight: '#f4dc9e',
    eye: '#5b7f9a', eyeDark: '#2f3b46', mouth: '#9a4a3c', teeth: '#ffffff', tongue: '#e0796b',
    shirt: '#ffffff', shirtShade: '#e3e6ee', button: '#5b6270', line: '#3a2f2a'
  };

  function face(mood) {
    var eyes = mood === 'calm'
      ? '<path d="M57 96 q9 -8 18 0" fill="none" stroke="' + C.eyeDark + '" stroke-width="3.4" stroke-linecap="round"/>' +
        '<path d="M101 96 q9 -8 18 0" fill="none" stroke="' + C.eyeDark + '" stroke-width="3.4" stroke-linecap="round"/>'
      : '<ellipse cx="66" cy="96" rx="8.5" ry="9.5" fill="#fff"/><ellipse cx="110" cy="96" rx="8.5" ry="9.5" fill="#fff"/>' +
        '<circle cx="67.5" cy="97" r="6" fill="' + C.eye + '"/><circle cx="111.5" cy="97" r="6" fill="' + C.eye + '"/>' +
        '<circle cx="67.5" cy="97" r="3" fill="' + C.eyeDark + '"/><circle cx="111.5" cy="97" r="3" fill="' + C.eyeDark + '"/>' +
        '<circle cx="70" cy="94" r="2" fill="#fff"/><circle cx="114" cy="94" r="2" fill="#fff"/>';
    var brows = '<path d="M56 82 q10 -6 20 -2" fill="none" stroke="' + C.hairDark + '" stroke-width="3.2" stroke-linecap="round"/>' +
      '<path d="M100 80 q10 -4 20 2" fill="none" stroke="' + C.hairDark + '" stroke-width="3.2" stroke-linecap="round"/>';
    var nose = '<path d="M88 102 q-3 9 1 11" fill="none" stroke="' + C.skinShade + '" stroke-width="2.6" stroke-linecap="round"/>';
    var mouth = mood === 'calm'
      ? '<path d="M74 122 q14 10 28 0" fill="none" stroke="' + C.mouth + '" stroke-width="3.4" stroke-linecap="round"/>'
      // широка усмішка з зубами, як на фото
      : '<path d="M66 117 q22 30 44 0 q-22 6 -44 0z" fill="' + C.mouth + '"/>' +
        '<path d="M68 118 q20 5 40 0 l-2 6 q-18 5 -36 0z" fill="' + C.teeth + '"/>' +
        '<path d="M80 131 q8 5 16 0 q-8 -4 -16 0z" fill="' + C.tongue + '"/>';
    var blush = '<ellipse cx="52" cy="114" rx="9" ry="5" fill="' + C.blush + '" opacity=".4"/>' +
      '<ellipse cx="124" cy="114" rx="9" ry="5" fill="' + C.blush + '" opacity=".4"/>';
    return brows + eyes + nose + blush + mouth;
  }

  function svg(mood, size) {
    mood = mood || 'happy';
    var cheer = mood === 'cheer';
    var sleeve = function (d, w) {
      return '<path d="' + d + '" fill="none" stroke="' + C.shirtShade + '" stroke-width="' + (w + 3) + '" stroke-linecap="round"/>' +
        '<path d="' + d + '" fill="none" stroke="' + C.shirt + '" stroke-width="' + w + '" stroke-linecap="round"/>';
    };
    var armR = cheer
      ? sleeve('M134 172 q20 -8 24 -40', 18) +
        // кулак угору
        '<rect x="147" y="104" width="22" height="24" rx="9" fill="' + C.skin + '"/>' +
        '<path d="M150 112 h16 M150 119 h16" stroke="' + C.skinShade + '" stroke-width="2.2" stroke-linecap="round"/>'
      : sleeve('M136 174 q10 16 8 36', 17) + '<circle cx="144" cy="212" r="9" fill="' + C.skin + '"/>';
    var armL = sleeve('M40 174 q-10 16 -8 36', 17) + '<circle cx="32" cy="212" r="9" fill="' + C.skin + '"/>';
    var body =
      '<path d="M36 220 q0 -60 52 -62 q52 2 52 62 z" fill="' + C.shirt + '" stroke="' + C.shirtShade + '" stroke-width="2"/>' +
      '<path d="M88 160 v60" stroke="' + C.shirtShade + '" stroke-width="2"/>' +
      '<circle cx="92" cy="180" r="2.4" fill="' + C.button + '"/><circle cx="92" cy="198" r="2.4" fill="' + C.button + '"/>' +
      // відкритий комір
      '<path d="M76 150 l12 16 l12 -16 z" fill="' + C.skin + '"/>' +
      '<path d="M66 154 l22 14 l-8 -20 z M110 154 l-22 14 l8 -20 z" fill="' + C.shirt + '" stroke="' + C.shirtShade + '" stroke-width="2" stroke-linejoin="round"/>';
    var head =
      '<rect x="78" y="138" width="20" height="16" rx="6" fill="' + C.skinShade + '"/>' +
      '<ellipse cx="38" cy="102" rx="8" ry="12" fill="' + C.skin + '"/><ellipse cx="138" cy="102" rx="8" ry="12" fill="' + C.skin + '"/>' +
      '<path d="M37 88 q0 -44 51 -44 q51 0 51 44 q0 58 -51 58 q-51 0 -51 -58z" fill="' + C.skin + '"/>' +
      // волосся: коротко з боків, об'ємний верх, чубчик зачесаний набік (праворуч)
      '<path d="M34 92 q-6 -24 6 -42 q16 -24 52 -24 q34 0 46 22 q8 16 2 40 q-4 -14 -10 -20 q-14 4 -30 2 q-18 -3 -26 -12 q-6 14 -24 18 q-10 2 -16 16z" fill="' + C.hair + '"/>' +
      '<path d="M52 44 q24 -18 60 -8 q16 6 22 18 q-20 -12 -44 -8 q-22 4 -38 -2z" fill="' + C.hairLight + '"/>' +
      '<path d="M66 60 q24 4 44 -6" fill="none" stroke="' + C.hairDark + '" stroke-width="2.4" stroke-linecap="round" opacity=".6"/>' +
      '<path d="M44 70 q10 -16 26 -20" fill="none" stroke="' + C.hairDark + '" stroke-width="2.2" stroke-linecap="round" opacity=".5"/>' +
      face(mood);
    var w = size || 120, hgt = Math.round(w * 228 / 176);
    return '<svg class="avatar" viewBox="0 0 176 228" width="' + w + '" height="' + hgt + '" role="img" aria-label="Ви" xmlns="http://www.w3.org/2000/svg">' +
      '<ellipse cx="88" cy="222" rx="56" ry="6" fill="#000" opacity=".12"/>' + armL + body + armR + head + '</svg>';
  }

  window.SpravyAvatar = { svg: svg };
})();
