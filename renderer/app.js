'use strict';
const $ = (s, r = document) => r.querySelector(s);
const h = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
};
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const toast = (m) => { const t = h('div', { class: 'toast', text: m }); document.body.append(t); setTimeout(() => t.remove(), 3200); };
const fmt = (s) => { s = Math.max(0, s); const m = Math.floor(s / 60); return m + ':' + (s - m * 60).toFixed(2).padStart(5, '0'); };
let uid = 1; const nid = () => 'c' + (uid++);

// ---------- project model ----------
// tracks: 0 = V2 (overlay and titles), 1 = V1 (main picture), 2 = A1 (extra sound)
const TRACKS = [{ name: 'V2', kind: 'v' }, { name: 'V1', kind: 'v' }, { name: 'A1', kind: 'a' }, { name: 'A2', kind: 'a' }];
const SIZES = { '16:9': [1280, 720], '9:16': [720, 1280], '1:1': [1080, 1080], '4:3': [1024, 768] };
let P = { aspect: '16:9', clips: [] };
let media = {};              // mid -> {mid,fid,name,dur,video,audio,image,w,h}
let sel = null, playhead = 0, playing = false, pxs = 80; // pixels per second
let undoS = [], redoS = [], dirty = false;
const projDur = () => P.clips.reduce((m, c) => Math.max(m, c.start + c.dur), 0);
const snap = () => JSON.stringify(P);
function commit() { undoS.push(snap()); if (undoS.length > 60) undoS.shift(); redoS = []; dirty = true; }
function undo() { if (!undoS.length) return; redoS.push(snap()); P = JSON.parse(undoS.pop()); if (!P.clips.find((c) => c.id === sel)) sel = null; renderAll(); }
function redo() { if (!redoS.length) return; undoS.push(snap()); P = JSON.parse(redoS.pop()); renderAll(); }
const clipOf = (id) => P.clips.find((c) => c.id === id);

// ---------- layout ----------
const app = $('#app');
const toolbar = h('div', { class: 'toolbar' });
const binEl = h('div', { class: 'sidebar', style: 'width:230px;overflow:auto' });
const view = h('canvas', { style: 'max-width:100%;max-height:100%;background:#000;display:block' });
const stage = h('div', { style: 'flex:1;min-height:0;min-width:0;display:flex;align-items:center;justify-content:center;background:#1c1c1c;padding:8px' }, view);
const inspector = h('div', { class: 'sidebar right', style: 'width:240px;overflow:auto' });
const topRow = h('div', { style: 'flex:1;min-height:0;display:flex;min-width:0;overflow:hidden' }, binEl, stage, inspector);
const timeEl = h('div', { style: 'height:230px;min-height:120px;display:flex;border-top:1px solid #444;min-width:0;overflow:hidden' });
const status = h('div', { class: 'status' });
const main = h('div', { class: 'main', style: 'flex:1;min-height:0;min-width:0;width:100%;overflow:hidden;display:flex;flex-direction:column' }, topRow, timeEl);
app.append(toolbar, main, status);
const btn = (label, fn, cls = '') => h('button', { class: 'btn ' + cls, onclick: fn, text: label });

const bPlay = btn('Play', togglePlay, 'primary');
const clock = h('span', { style: 'font-family:Consolas,monospace;min-width:150px;text-align:center', text: '0:00.00 / 0:00.00' });
const aspectSel = h('select', { onchange: (e) => { commit(); P.aspect = e.target.value; renderAll(); } }, ...Object.keys(SIZES).map((k) => h('option', { value: k, text: k })));
toolbar.append(btn('Open project', openProject), btn('Save project', saveProject), h('span', { class: 'sep' }), btn('Import media', importMedia), h('span', { class: 'sep' }), bPlay, btn('Stop', () => { pause(); seek(0); }), clock, h('span', { class: 'sep' }),
  btn('Split', splitAt), btn('Delete', delSel), btn('Undo', undo), btn('Redo', redo), h('span', { class: 'sep' }), aspectSel, h('span', { class: 'grow' }), btn('Export', exportDialog, 'primary'));

// ---------- media bin ----------
const MFILTERS = [['Video, audio and images', ['mp4', 'mkv', 'mov', 'webm', 'avi', 'm4v', 'mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'png', 'jpg', 'jpeg', 'bmp', 'webp', 'gif']], ['All files', ['*']]];
const IMG = /\.(png|jpe?g|bmp|webp)$/i;
async function importMedia() {
  const files = await window.host.openFiles({ read: false, multi: true, filters: MFILTERS });
  for (const f of files) await addMedia(f);
  renderBin();
}
async function addMedia(f, mid) {
  const p = await window.host.probe(f.id); const j = p && p.json;
  if (!j) { toast('Cannot read ' + f.name); return null; }
  const v = (j.streams || []).find((s) => s.codec_type === 'video'), a = (j.streams || []).find((s) => s.codec_type === 'audio');
  const image = IMG.test(f.name) || (v && !a && !(parseFloat(j.format && j.format.duration) > 0.2) && /image|png|mjpeg|bmp|webp/.test(j.format.format_name || ''));
  const dur = image ? 5 : parseFloat((j.format && j.format.duration) || (v && v.duration) || (a && a.duration)) || 0;
  if (!dur) { toast('No playable length in ' + f.name); return null; }
  const m = { mid: mid || nid(), fid: f.id, name: f.name, size: f.size, dur, video: !!v, audio: !!a && !image, image, w: v ? v.width : 0, h: v ? v.height : 0 };
  media[m.mid] = m; return m;
}
function renderBin() {
  binEl.textContent = '';
  binEl.append(h('h3', { text: 'Media' }));
  const list = Object.values(media);
  if (!list.length) binEl.append(h('div', { class: 'muted', style: 'font-size:12px;line-height:1.6', text: 'Import videos, sounds or pictures, then double-click one to add it to the timeline.' }));
  for (const m of list) {
    const missing = !m.fid;
    binEl.append(h('div', { class: 'list-item', style: 'padding:6px 8px;border:1px solid #444;border-radius:5px;margin-bottom:6px;cursor:pointer;font-size:12px', title: 'Double-click to add to the timeline', ondblclick: () => addToTimeline(m) },
      h('div', { style: 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis', text: m.name }),
      h('div', { class: 'muted', text: (m.image ? 'Picture' : m.video ? 'Video' : 'Sound') + ' · ' + fmt(m.dur) + (missing ? ' · missing' : '') }),
      h('div', { style: 'margin-top:4px' }, btn('Add', () => addToTimeline(m)))));
  }
  if (list.some((m) => !m.fid)) binEl.append(btn('Locate missing files', relink, 'primary'));
}
function addToTimeline(m) {
  if (!m.fid) { toast('Locate the missing file first'); return; }
  commit();
  const track = m.video ? 1 : 2; const end = P.clips.filter((c) => c.track === track).reduce((x, c) => Math.max(x, c.start + c.dur), 0);
  const c = { id: nid(), track, mid: m.mid, start: end, in: 0, dur: m.dur, vol: 1, speed: 1, fadeIn: 0, fadeOut: 0, fit: 'fit', opacity: 1 };
  P.clips.push(c); sel = c.id; renderAll();
}
async function importSrt() {
  const f = (await window.host.openFiles({ read: true, filters: [['Subtitles', ['srt']]] }))[0]; if (!f) return;
  const txt = new TextDecoder().decode(f.data).replace(/^﻿/, '').replace(/\r/g, '');
  const tm = /(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)/; const sec = (a, b, c2, d) => +a * 3600 + +b * 60 + +c2 + +('0.' + d);
  const cues = [];
  for (const blk of txt.split(/\n\s*\n/)) {
    const lines = blk.split('\n'); const i = lines.findIndex((l) => tm.test(l)); if (i < 0) continue; const g = lines[i].match(tm);
    const start = sec(g[1], g[2], g[3], g[4]), end = sec(g[5], g[6], g[7], g[8]); const text = cleanText(lines.slice(i + 1).join(' ').replace(/<[^>]*>/g, ''));
    if (text && end > start) cues.push({ start, dur: end - start, text }); if (cues.length >= 2000) break;
  }
  if (!cues.length) { toast('No subtitles found in that file'); return; }
  commit(); for (const q of cues) P.clips.push({ id: nid(), track: 0, kind: 'text', text: q.text, size: 44, pos: 'bottom', color: 'white', start: q.start, dur: q.dur, in: 0, vol: 1, speed: 1, fadeIn: 0, fadeOut: 0 });
  toast('Added ' + cues.length + ' subtitles'); renderAll();
}
function addText() {
  commit(); const c = { id: nid(), track: 0, kind: 'text', start: playhead, in: 0, dur: 3, text: 'Your title', size: 56, pos: 'bottom', color: 'white', speed: 1, vol: 1, fadeIn: 0, fadeOut: 0 };
  P.clips.push(c); sel = c.id; renderAll();
}

// ---------- preview engine ----------
const els = new Map(); // clip id -> media element
const imgs = new Map();
function elFor(c) {
  const m = media[c.mid]; if (!m || !m.fid) return null;
  if (m.image) { let i = imgs.get(m.mid); if (!i) { i = new Image(); i.src = 'lkmedia://' + m.fid + '/f'; imgs.set(m.mid, i); i.onload = () => drawFrame(); } return i; }
  let e = els.get(c.id);
  if (!e) { e = document.createElement(m.video ? 'video' : 'audio'); e.preload = 'auto'; e.src = 'lkmedia://' + m.fid + '/f'; e.addEventListener('seeked', () => { if (!playing) drawFrame(); }); e.addEventListener('loadeddata', () => { if (!playing) drawFrame(); }); els.set(c.id, e); }
  return e;
}
const active = (c, t) => t >= c.start && t < c.start + c.dur;
function sizeView() {
  const [W, H] = SIZES[P.aspect]; const r = stage.getBoundingClientRect(); const maxW = Math.max(100, r.width - 16), maxH = Math.max(100, r.height - 16);
  const sc = Math.min(maxW / W, maxH / H); const cw = Math.round(W * sc), ch = Math.round(H * sc);
  if (view.width !== cw || view.height !== ch) { view.width = cw; view.height = ch; }
}
const kfAt = (c, t) => { const p = clamp((t - c.start) / c.dur, 0, 1); return { z: 1 + ((c.kz || 1) - 1) * p, x: (c.kx || 0) * p, y: (c.ky || 0) * p }; };
const trQ = (c, t) => (c.tr && c.tr !== 'none') ? clamp((t - c.start) / (c.trd || 0.5), 0, 1) : 1;
function drawFrame() {
  sizeView(); const [W, H] = SIZES[P.aspect]; const ctx = view.getContext('2d'); const k = view.height / H;
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, view.width, view.height);
  const vis = P.clips.filter((c) => c.track <= 1 && active(c, playhead)).sort((a, b) => b.track - a.track); // V1 first, V2 over it
  for (const c of vis) {
    ctx.globalAlpha = clamp((c.opacity ?? 1) * fadeGain(c, playhead), 0, 1);
    if (c.kind === 'text') {
      ctx.font = '600 ' + Math.round(c.size * k) + 'px "Segoe UI", sans-serif'; ctx.fillStyle = c.color === 'black' ? '#000' : c.color === 'gray' ? '#aaa' : '#fff';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; const y = c.pos === 'top' ? view.height * 0.12 : c.pos === 'center' ? view.height / 2 : view.height * 0.88;
      ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = 4 * k; ctx.fillText(c.text, view.width / 2, y, view.width * 0.94); ctx.shadowBlur = 0; continue;
    }
    const e = elFor(c), m = media[c.mid]; if (!e || !m) continue;
    const w = e.videoWidth || e.naturalWidth || m.w, hh = e.videoHeight || e.naturalHeight || m.h; if (!w || !hh || (e.readyState !== undefined && e.readyState < 2)) continue;
    const s = c.fit === 'fill' ? Math.max(view.width / w, view.height / hh) : Math.min(view.width / w, view.height / hh);
    const kf = kfAt(c, playhead), q = trQ(c, playhead); let dx = 0, sz = 1;
    if (c.tr === 'dissolve') ctx.globalAlpha *= q; else if (c.tr === 'slide') dx = -(1 - q) * view.width; else if (c.tr === 'zoom') { sz = 0.5 + 0.5 * q; ctx.globalAlpha *= q; }
    const fl = []; if (c.bright) fl.push('brightness(' + (1 + c.bright) + ')'); if (c.contrast != null && c.contrast !== 1) fl.push('contrast(' + c.contrast + ')'); if (c.sat != null && c.sat !== 1) fl.push('saturate(' + c.sat + ')'); if (c.blur) fl.push('blur(' + (c.blur * k) + 'px)'); if (c.gray) fl.push('grayscale(1)');
    ctx.filter = fl.length ? fl.join(' ') : 'none';
    const dw = w * s * kf.z * sz, dh = hh * s * kf.z * sz;
    ctx.drawImage(e, (view.width - dw) / 2 + kf.x * view.width + dx, (view.height - dh) / 2 + kf.y * view.height, dw, dh);
    ctx.filter = 'none';
  }
  ctx.globalAlpha = 1;
  clock.textContent = fmt(playhead) + ' / ' + fmt(projDur());
  drawPlayhead();
}
function fadeGain(c, t) { const l = t - c.start; let g = 1; if (c.fadeIn > 0 && l < c.fadeIn) g = Math.min(g, l / c.fadeIn); const r = c.start + c.dur - t; if (c.fadeOut > 0 && r < c.fadeOut) g = Math.min(g, r / c.fadeOut); return g; }
let t0 = 0, p0 = 0;
function syncMedia(seekAll) {
  for (const c of P.clips) {
    if (c.kind === 'text') continue; const m = media[c.mid]; if (!m || m.image) continue;
    const a = active(c, playhead); const e = els.get(c.id) || (a ? elFor(c) : null); if (!e) continue;
    if (!a) { if (!e.paused) e.pause(); continue; }
    const want = c.in + (playhead - c.start) * c.speed;
    e.playbackRate = c.speed; e.volume = clamp(c.vol * fadeGain(c, playhead), 0, 1);
    if (seekAll || Math.abs(e.currentTime - want) > 0.3) { try { e.currentTime = want; } catch (_) {} }
    if (playing && e.paused) e.play().catch(() => {}); else if (!playing && !e.paused) e.pause();
  }
}
function togglePlay() { playing ? pause() : play(); }
function play() { const d = projDur(); if (!d) return; if (playhead >= d - 0.02) playhead = 0; playing = true; bPlay.textContent = 'Pause'; t0 = performance.now(); p0 = playhead; syncMedia(true); requestAnimationFrame(loop); }
function pause() { playing = false; bPlay.textContent = 'Play'; for (const e of els.values()) e.pause(); drawFrame(); }
function loop() {
  if (!playing) return; playhead = p0 + (performance.now() - t0) / 1000; const d = projDur();
  if (playhead >= d) { playhead = d; pause(); return; }
  syncMedia(false); drawFrame(); requestAnimationFrame(loop);
}
function seek(t) { playhead = clamp(t, 0, Math.max(projDur(), 0)); if (playing) { t0 = performance.now(); p0 = playhead; } syncMedia(true); drawFrame(); }

// ---------- timeline ----------
const LABEL_W = 44;
let tlScroll = null, tlInner = null, phEl = null;
function renderTimeline() {
  const prevScroll = tlScroll ? tlScroll.scrollLeft : 0;
  timeEl.textContent = '';
  const total = Math.max(projDur() + 10, 30), width = Math.ceil(total * pxs);
  const labels = h('div', { style: 'width:' + LABEL_W + 'px;flex:none;border-right:1px solid #444;padding-top:24px' }, ...TRACKS.map((t) => h('div', { style: 'height:52px;display:flex;align-items:center;justify-content:center;font-size:11px;color:#999;border-bottom:1px solid #333', text: t.name })));
  const ruler = h('div', { style: 'position:relative;height:24px;border-bottom:1px solid #444;cursor:pointer;background:#2b2b2b', onpointerdown: (e) => rulerDrag(e) });
  const step = [0.5, 1, 2, 5, 10, 30, 60].find((s) => s * pxs > 70) || 60;
  for (let t = 0; t <= total; t += step) ruler.append(h('div', { style: 'position:absolute;left:' + t * pxs + 'px;top:0;height:24px;border-left:1px solid #555;padding-left:3px;font-size:10px;color:#999;pointer-events:none', text: fmt(t).replace(/\.00$/, '') }));
  const rows = TRACKS.map((_, ti) => {
    const row = h('div', { style: 'position:relative;height:52px;border-bottom:1px solid #333;width:' + width + 'px', dataset: { track: ti } });
    for (const c of P.clips.filter((x) => x.track === ti)) row.append(clipEl(c));
    return row;
  });
  phEl = h('div', { style: 'position:absolute;top:0;bottom:0;width:1px;background:#fff;pointer-events:none;z-index:5' });
  tlInner = h('div', { style: 'position:relative;width:' + width + 'px;min-height:100%' }, ruler, ...rows, phEl);
  tlInner.addEventListener('pointerdown', (e) => { if (e.target === tlInner || e.target.dataset.track !== undefined) { sel = null; renderInspector(); markSel(); } });
  tlScroll = h('div', { style: 'flex:1;min-width:0;overflow:auto;position:relative' }, tlInner);
  tlScroll.addEventListener('wheel', (e) => { if (e.ctrlKey) { e.preventDefault(); pxs = clamp(pxs * (e.deltaY < 0 ? 1.2 : 0.83), 10, 400); renderTimeline(); } }, { passive: false });
  timeEl.append(labels, tlScroll); tlScroll.scrollLeft = prevScroll;
  drawPlayhead();
}
function drawPlayhead() { if (phEl) phEl.style.left = playhead * pxs + 'px'; }
function rulerDrag(e) {
  const r = tlInner.getBoundingClientRect(); const mv = (ev) => { seek((ev.clientX - r.left) / pxs); }; mv(e);
  const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
  window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
}
const peaksC = new Map(), thumbC = new Map();
function getPeaks(m) {
  if (peaksC.has(m.mid)) return peaksC.get(m.mid); peaksC.set(m.mid, null);
  Promise.resolve(window.host.peaks(m.fid, 800)).then((p) => { if (Array.isArray(p)) { peaksC.set(m.mid, p); renderTimeline(); } }).catch(() => {});
  return null;
}
function getThumbs(m) {
  if (thumbC.has(m.mid)) return thumbC.get(m.mid); thumbC.set(m.mid, null);
  const N = 12;
  if (m.image) { const i = new Image(); i.src = 'lkmedia://' + m.fid + '/f'; i.onload = () => { thumbC.set(m.mid, [i]); renderTimeline(); }; return null; }
  const v = document.createElement('video'); v.muted = true; v.preload = 'auto'; v.src = 'lkmedia://' + m.fid + '/f'; const out = []; let k = 0;
  const step = () => { if (k >= N) { thumbC.set(m.mid, out); renderTimeline(); v.removeAttribute('src'); return; } v.currentTime = Math.min(Math.max(0, m.dur - 0.05), (k + 0.5) / N * m.dur); };
  v.addEventListener('seeked', () => { const c2 = document.createElement('canvas'); c2.height = 40; c2.width = Math.round(40 * (v.videoWidth || 16) / (v.videoHeight || 9)) || 71; try { c2.getContext('2d').drawImage(v, 0, 0, c2.width, c2.height); } catch (_) {} out.push(c2); k++; step(); });
  v.addEventListener('loadeddata', step);
  return null;
}
function clipArt(c, m, wpx) {
  const cw = Math.min(Math.ceil(wpx), 3000); if (cw < 8) return null;
  const cv = h('canvas', { width: cw, height: 42, style: 'position:absolute;left:0;top:0;width:' + wpx + 'px;height:42px;pointer-events:none' }); const g = cv.getContext('2d');
  const len = c.dur * c.speed;
  if (m.video || m.image) {
    const th = getThumbs(m);
    if (th && th.length) {
      const tw = th[0].width ? Math.max(20, 42 * (th[0].width / (th[0].height || 40))) : 60;
      for (let x = 0; x < cw; x += tw) {
        let im = th[0]; if (!m.image) { const src = c.in + (x / cw) * len; im = th[clamp(Math.floor(src / (m.dur || 1) * th.length), 0, th.length - 1)]; }
        g.drawImage(im, x, 0, tw, 42);
      }
      g.fillStyle = 'rgba(0,0,0,.35)'; g.fillRect(0, 0, cw, 42);
    }
  }
  if (m.audio && !m.video) {
    const pk = getPeaks(m);
    if (pk && pk.length) {
      g.fillStyle = 'rgba(255,255,255,.75)';
      for (let x = 0; x < cw; x += 2) { const src = c.in + (x / cw) * len; const v = pk[clamp(Math.floor(src / (m.dur || 1) * pk.length), 0, pk.length - 1)] || 0; const hh2 = Math.max(1, v * 36); g.fillRect(x, 21 - hh2 / 2, 1.5, hh2); }
    }
  }
  return cv;
}
function clipEl(c) {
  const m = media[c.mid]; const name = c.kind === 'text' ? c.text : (m ? m.name : '?');
  const tone = c.kind === 'text' ? '#6e6e6e' : c.track >= 2 ? '#5a5a5a' : '#7a7a7a';
  const wpx = Math.max(4, c.dur * pxs);
  const cv = (m && m.fid && c.kind !== 'text') ? clipArt(c, m, wpx) : null;
  const el = h('div', { class: 'clip', dataset: { id: c.id }, title: name, style: 'position:absolute;top:4px;height:42px;left:' + c.start * pxs + 'px;width:' + wpx + 'px;background:' + tone + ';border:1px solid #999;border-radius:4px;overflow:hidden;font-size:11px;color:#fff;padding:3px 8px;box-sizing:border-box;white-space:nowrap;cursor:grab;' + (m && !m.fid ? 'opacity:.45;' : ''), onpointerdown: (e) => clipDown(e, c) },
    cv,
    h('div', { style: 'pointer-events:none;overflow:hidden;text-overflow:ellipsis;position:relative;text-shadow:0 1px 2px #000', text: name }),
    h('div', { class: 'h l', style: 'position:absolute;left:0;top:0;bottom:0;width:6px;cursor:ew-resize;background:rgba(255,255,255,.25)' }),
    h('div', { class: 'h r', style: 'position:absolute;right:0;top:0;bottom:0;width:6px;cursor:ew-resize;background:rgba(255,255,255,.25)' }));
  if (c.id === sel) el.style.outline = '2px solid #fff';
  return el;
}
function markSel() { for (const e of tlInner.querySelectorAll('.clip')) e.style.outline = e.dataset.id === sel ? '2px solid #fff' : 'none'; }
function snapPoints(skip) { const pts = [0, playhead]; for (const c of P.clips) if (c.id !== skip) { pts.push(c.start, c.start + c.dur); } return pts; }
function snapTo(v, pts) { const tol = 8 / pxs; let best = v, bd = tol; for (const p of pts) { const d = Math.abs(p - v); if (d < bd) { bd = d; best = p; } } return best; }
function clipDown(e, c) {
  e.preventDefault(); sel = c.id; markSel(); renderInspector();
  const mode = e.target.classList.contains('l') ? 'l' : e.target.classList.contains('r') ? 'r' : 'move';
  const startX = e.clientX, o = { ...c }, m = media[c.mid]; const pts = snapPoints(c.id); let moved = false; const el = e.currentTarget;
  const maxSrc = m && !m.image ? m.dur : Infinity; let committed = false;
  const mv = (ev) => {
    const dx = (ev.clientX - startX) / pxs; if (!moved && Math.abs(ev.clientX - startX) < 3) return; moved = true; if (!committed) { commit(); committed = true; }
    if (mode === 'move') {
      const raw = o.start + dx, s1 = snapTo(raw, pts), s2 = snapTo(raw + c.dur, pts) - c.dur; c.start = Math.max(0, Math.abs(s1 - raw) <= Math.abs(s2 - raw) ? s1 : s2);
      const rowY = ev.clientY; const rows = [...tlInner.querySelectorAll('[data-track]')]; const hit = rows.find((r) => { const b = r.getBoundingClientRect(); return rowY >= b.top && rowY < b.bottom; });
      if (hit) { const ti = +hit.dataset.track; const ok = c.kind === 'text' ? ti === 0 : (m && (TRACKS[ti].kind === 'a' ? !m.video : m.video)); if (ok) c.track = ti; }
    } else if (mode === 'l') {
      let ns = snapTo(o.start + dx, pts); ns = clamp(ns, Math.max(0, o.start - o.in / o.speed), o.start + o.dur - 0.1); const d = ns - o.start; c.start = ns; c.dur = o.dur - d; c.in = o.in + d * o.speed;
    } else {
      let ne = snapTo(o.start + o.dur + dx, pts); let nd = Math.max(0.1, ne - o.start); if (isFinite(maxSrc)) nd = Math.min(nd, (maxSrc - o.in) / o.speed); c.dur = nd;
    }
    renderTimeline(); renderInspector(false);
  };
  const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); if (moved) { renderAll(); } else { seek(playhead); } };
  window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
}

// ---------- editing ----------
function splitAt() {
  const t = playhead; const cands = P.clips.filter((c) => active(c, t) && t > c.start + 0.05 && t < c.start + c.dur - 0.05 && (!sel || c.id === sel || !clipOf(sel) || !active(clipOf(sel), t)));
  if (!cands.length) { toast('Put the playhead inside a clip first'); return; }
  commit();
  for (const c of cands) { const d = t - c.start; const b = { ...c, id: nid(), start: t, dur: c.dur - d, in: c.in + d * c.speed, fadeIn: 0 }; c.dur = d; c.fadeOut = 0; P.clips.push(b); }
  renderAll();
}
function delSel() { if (!sel) { toast('Select a clip first'); return; } commit(); P.clips = P.clips.filter((c) => c.id !== sel); const e = els.get(sel); if (e) { e.pause(); e.removeAttribute('src'); els.delete(sel); } sel = null; renderAll(); }
function closeGaps() { commit(); for (const t of [0, 1, 2, 3]) { let x = 0; for (const c of P.clips.filter((c) => c.track === t).sort((a, b) => a.start - b.start)) { c.start = x; x += c.dur; } } renderAll(); }

// ---------- inspector ----------
function renderInspector(full = true) {
  const c = sel && clipOf(sel);
  if (!full && inspector.dataset.sel === sel) { const tb = inspector.querySelector('[data-k=time]'); if (tb && c) tb.textContent = 'Start ' + fmt(c.start) + '\nLength ' + fmt(c.dur); return; }
  inspector.dataset.sel = sel || ''; inspector.textContent = '';
  if (!c) { inspector.append(h('h3', { text: 'Clip' }), h('div', { class: 'muted', style: 'font-size:12px;line-height:1.7;white-space:pre-line', text: 'Select a clip to change it.\n\nSpace: play or pause\nS: split at playhead\nDelete: remove clip\nCtrl+wheel on the timeline: zoom\nDrag a clip to move it, drag its edges to trim.' }), h('h3', { text: 'Add' }), btn('Title text', addText), h('div', { style: 'height:6px' }), btn('Import subtitles (.srt)', importSrt), h('div', { style: 'height:6px' }), btn('Close gaps', closeGaps)); return; }
  const m = media[c.mid]; const isText = c.kind === 'text'; const num = (label, key, min, max, step, after) => h('label', { class: 'field' }, label, h('input', { type: 'number', value: +(+c[key]).toFixed(3), min, max, step, onchange: (e) => { commit(); c[key] = clamp(+e.target.value || 0, min, max); if (after) after(); renderAll(); } }));
  inspector.append(h('h3', { text: isText ? 'Title' : (m ? m.name : 'Clip') }), h('div', { 'data-k': 'time', class: 'muted', style: 'font-size:12px;white-space:pre-line;margin-bottom:8px', text: 'Start ' + fmt(c.start) + '\nLength ' + fmt(c.dur) }));
  if (isText) {
    inspector.append(h('label', { class: 'field' }, 'Text', h('input', { type: 'text', value: c.text, maxlength: 120, onchange: (e) => { commit(); c.text = cleanText(e.target.value) || 'Title'; renderAll(); } })),
      num('Size', 'size', 12, 300, 2), h('label', { class: 'field' }, 'Position', h('select', { onchange: (e) => { commit(); c.pos = e.target.value; renderAll(); } }, ...['top', 'center', 'bottom'].map((v) => h('option', { value: v, text: v[0].toUpperCase() + v.slice(1), selected: c.pos === v })))),
      h('label', { class: 'field' }, 'Color', h('select', { onchange: (e) => { commit(); c.color = e.target.value; renderAll(); } }, ...[['white', 'White'], ['gray', 'Light gray'], ['black', 'Black']].map(([v, t]) => h('option', { value: v, text: t, selected: c.color === v })))));
  } else {
    if (m && m.video) inspector.append(h('label', { class: 'field' }, 'Fit to frame', h('select', { onchange: (e) => { commit(); c.fit = e.target.value; renderAll(); } }, h('option', { value: 'fit', text: 'Fit (show all)', selected: c.fit !== 'fill' }), h('option', { value: 'fill', text: 'Fill (crop)', selected: c.fit === 'fill' }))), num('Opacity', 'opacity', 0.05, 1, 0.05));
    if (m && (m.video || m.image)) {
      const numd = (label, key, def, min, max, step) => h('label', { class: 'field' }, label, h('input', { type: 'number', value: +(+(c[key] ?? def)).toFixed(3), min, max, step, onchange: (e) => { commit(); c[key] = clamp(Number.isFinite(+e.target.value) ? +e.target.value : def, min, max); renderAll(); } }));
      const sel2 = (label, val, opts, set) => h('label', { class: 'field' }, label, h('select', { onchange: (e) => { commit(); set(e.target.value); renderAll(); } }, ...opts.map(([v, t]) => h('option', { value: v, text: t, selected: val === v }))));
      inspector.append(h('h3', { text: 'Effects' }), numd('Brightness', 'bright', 0, -1, 1, 0.05), numd('Contrast', 'contrast', 1, 0, 2, 0.05), numd('Saturation', 'sat', 1, 0, 3, 0.05), numd('Blur', 'blur', 0, 0, 20, 1),
        sel2('Black and white', c.gray ? '1' : '0', [['0', 'Off'], ['1', 'On']], (v) => { c.gray = v === '1'; }),
        h('h3', { text: 'Motion' }), numd('End zoom', 'kz', 1, 0.5, 3, 0.05), numd('End pan X', 'kx', 0, -1, 1, 0.05), numd('End pan Y', 'ky', 0, -1, 1, 0.05),
        h('h3', { text: 'Transition in' }), sel2('Type', c.tr || 'none', [['none', 'None'], ['dissolve', 'Dissolve'], ['slide', 'Slide in'], ['zoom', 'Zoom in']], (v) => { c.tr = v; }), numd('Duration (s)', 'trd', 0.5, 0.1, 3, 0.1));
    }
    if (!m || m.audio) inspector.append(num('Volume', 'vol', 0, 2, 0.05));
    if (m && !m.image) inspector.append(h('label', { class: 'field' }, 'Speed', h('select', { onchange: (e) => { commit(); const ns = +e.target.value; const srcLen = c.dur * c.speed; c.speed = ns; c.dur = Math.max(0.1, Math.min(srcLen / ns, (m.dur - c.in) / ns)); renderAll(); } }, ...[0.5, 0.75, 1, 1.25, 1.5, 2].map((v) => h('option', { value: v, text: v + 'x', selected: c.speed === v })))));
  }
  inspector.append(num('Fade in (s)', 'fadeIn', 0, Math.max(0, c.dur / 2), 0.1), num('Fade out (s)', 'fadeOut', 0, Math.max(0, c.dur / 2), 0.1), h('div', { style: 'height:8px' }), btn('Split here', splitAt), h('span', { style: 'margin-left:6px' }), btn('Delete clip', delSel));
}
const cleanText = (s) => String(s).replace(/[\\'":%,;\[\]{}=\u0000-\u001f]/g, '').replace(/http|tcp|udp/gi, (x) => x[0] + ' ' + x.slice(1)).trim().slice(0, 120);

function renderAll() {
  aspectSel.value = P.aspect; renderBin(); renderInspector(); renderTimeline(); seek(Math.min(playhead, projDur()));
  status.textContent = ''; status.append(h('span', { text: (dirty ? 'Edited' : 'Ready') }), h('span', { class: 'grow' }), h('span', { text: P.clips.length + ' clips' }), h('span', { text: 'Length ' + fmt(projDur()) }), h('span', { text: SIZES[P.aspect].join(' x ') }));
}
new ResizeObserver(() => drawFrame()).observe(stage);

// ---------- project files ----------
async function saveProject() {
  const dest = await window.host.saveFile({ name: 'Project.cutout', filters: [['Cutout project', ['cutout']]] }); if (!dest) return;
  const data = { v: 1, P, media: Object.fromEntries(Object.values(media).map((m) => [m.mid, { mid: m.mid, name: m.name, size: m.size, dur: m.dur, video: m.video, audio: m.audio, image: m.image, w: m.w, h: m.h }])) };
  await window.host.writeFile(dest.id, new TextEncoder().encode(JSON.stringify(data)));
  dirty = false; toast('Saved ' + dest.name); renderAll();
}
async function openProject() {
  if (dirty && !confirm('Discard unsaved changes?')) return;
  const f = (await window.host.openFiles({ read: true, filters: [['Cutout project', ['cutout']]] }))[0]; if (!f) return;
  try {
    const d = JSON.parse(new TextDecoder().decode(f.data)); if (!d || !d.P || !Array.isArray(d.P.clips)) throw new Error('bad');
    pause(); for (const e of els.values()) { e.removeAttribute('src'); } els.clear(); imgs.clear();
    P = { aspect: SIZES[d.P.aspect] ? d.P.aspect : '16:9', clips: d.P.clips.map(sanitizeClip).filter(Boolean) };
    media = {}; for (const m of Object.values(d.media || {})) media[String(m.mid)] = { mid: String(m.mid), fid: null, name: String(m.name || 'file').slice(0, 200), size: +m.size || 0, dur: +m.dur || 0, video: !!m.video, audio: !!m.audio, image: !!m.image, w: +m.w || 0, h: +m.h || 0 };
    uid = 1 + Math.max(0, ...P.clips.map((c) => +String(c.id).slice(1) || 0), ...Object.keys(media).map((k) => +k.slice(1) || 0));
    undoS = []; redoS = []; sel = null; playhead = 0; dirty = false; renderAll();
    if (Object.values(media).some((m) => !m.fid)) { toast('Locate the media files used by this project'); await relink(); }
  } catch (_) { toast('This is not a valid Cutout project'); }
}
function sanitizeClip(c) {
  if (!c || typeof c !== 'object') return null; const n = (v, d, a, b) => clamp(Number.isFinite(+v) ? +v : d, a, b);
  const o = { id: String(c.id || nid()).replace(/[^a-z0-9]/gi, ''), track: n(c.track, 1, 0, 3) | 0, bright: n(c.bright, 0, -1, 1), contrast: n(c.contrast, 1, 0, 2), sat: n(c.sat, 1, 0, 3), blur: n(c.blur, 0, 0, 20), gray: !!c.gray, kz: n(c.kz, 1, 0.5, 3), kx: n(c.kx, 0, -1, 1), ky: n(c.ky, 0, -1, 1), tr: ['dissolve', 'slide', 'zoom'].includes(c.tr) ? c.tr : 'none', trd: n(c.trd, 0.5, 0.1, 3), start: n(c.start, 0, 0, 1e5), in: n(c.in, 0, 0, 1e5), dur: n(c.dur, 1, 0.05, 1e5), vol: n(c.vol, 1, 0, 2), speed: [0.5, 0.75, 1, 1.25, 1.5, 2].includes(+c.speed) ? +c.speed : 1, fadeIn: n(c.fadeIn, 0, 0, 1e4), fadeOut: n(c.fadeOut, 0, 0, 1e4), fit: c.fit === 'fill' ? 'fill' : 'fit', opacity: n(c.opacity, 1, 0.05, 1) };
  if (c.kind === 'text') { o.kind = 'text'; o.track = 0; o.text = cleanText(c.text) || 'Title'; o.size = n(c.size, 56, 12, 300); o.pos = ['top', 'center', 'bottom'].includes(c.pos) ? c.pos : 'bottom'; o.color = ['white', 'gray', 'black'].includes(c.color) ? c.color : 'white'; } else o.mid = String(c.mid);
  return o;
}
async function relink() {
  const files = await window.host.openFiles({ read: false, multi: true, filters: MFILTERS });
  for (const f of files) { const m = Object.values(media).find((x) => !x.fid && x.name.toLowerCase() === f.name.toLowerCase()); if (m) { const fresh = await addMedia(f, m.mid); if (fresh) media[m.mid] = { ...fresh, mid: m.mid }; } }
  const left = Object.values(media).filter((m) => !m.fid).length; if (left) toast(left + ' file(s) still missing'); renderAll();
}

// ---------- export ----------
const RES = { '480p': 480, '720p': 720, '1080p': 1080 };
function exportDialog() {
  if (!P.clips.length) { toast('Add something to the timeline first'); return; }
  if (P.clips.some((c) => c.kind !== 'text' && !(media[c.mid] && media[c.mid].fid))) { toast('Locate the missing media first'); return; }
  const res = h('select', {}, ...Object.keys(RES).map((k) => h('option', { value: k, text: k, selected: k === '720p' }))), fmtS = h('select', {}, h('option', { value: 'mp4', text: 'MP4 (H.264)' }), h('option', { value: 'webm', text: 'WebM (VP9)' }), h('option', { value: 'gif', text: 'GIF (no sound)' }));
  const q = h('select', {}, h('option', { value: '28', text: 'Small file' }), h('option', { value: '23', text: 'Balanced', selected: true }), h('option', { value: '18', text: 'High quality' }));
  const back = h('div', { class: 'modal-back' }, h('div', { class: 'modal' }, h('h2', { text: 'Export video' }), h('label', { class: 'field' }, 'Size', res), h('label', { class: 'field' }, 'Format', fmtS), h('label', { class: 'field' }, 'Quality', q),
    h('div', { class: 'row', style: 'justify-content:flex-end;margin-top:8px' }, btn('Cancel', () => back.remove()), btn('Export', () => { back.remove(); doExport(RES[res.value], fmtS.value, q.value); }, 'primary'))));
  document.body.append(back);
}
const f3 = (x) => (+x).toFixed(3);
function buildExport(outH, kind, crf) {
  const [bw, bh] = SIZES[P.aspect]; const sc = outH / Math.min(bw, bh); const W = Math.round(bw * sc / 2) * 2, H = Math.round(bh * sc / 2) * 2; const fps = kind === 'gif' ? 12 : 30; const T = projDur();
  const args = ['-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:r=${fps}:d=${f3(T)}`, '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo'];
  const inputs = [], idxOf = new Map();
  const useMedia = (mid, image, dur) => { if (idxOf.has(mid)) return idxOf.get(mid); inputs.push(media[mid].fid); const i = inputs.length - 1; idxOf.set(mid, i + 2); if (image) args.push('-loop', '1', '-framerate', String(fps)); args.push('-i', `{in${i}}`); return i + 2; };
  // register inputs in a first pass so -i order is stable
  const ordered = [...P.clips].filter((c) => c.kind !== 'text').sort((a, b) => a.start - b.start);
  for (const c of ordered) useMedia(c.mid, media[c.mid].image);
  const fc = []; let base = '[0:v]'; let n = 0; const aLabels = ['[1:a]'];
  const vclips = P.clips.filter((c) => c.track <= 1).sort((a, b) => (b.track - a.track) || (a.start - b.start));
  for (const c of vclips) {
    const S = f3(c.start), E = f3(c.start + c.dur); const o = `[v${n}]`;
    if (c.kind === 'text') {
      const yy = c.pos === 'top' ? 'h*0.08' : c.pos === 'center' ? '(h-text_h)/2' : 'h-text_h-h*0.08'; const col = c.color === 'black' ? 'black' : c.color === 'gray' ? '0xbbbbbb' : 'white';
      let txt = cleanText(c.text); if (!txt) continue;
      let alpha = ''; if (c.fadeIn > 0 || c.fadeOut > 0) alpha = `:alpha='min(1,min(if(gt(${f3(c.fadeIn)},0),(t-${S})/${f3(Math.max(0.01, c.fadeIn))},1),if(gt(${f3(c.fadeOut)},0),(${E}-t)/${f3(Math.max(0.01, c.fadeOut))},1)))'`;
      fc.push(`${base}drawtext=fontfile={font}:text='${txt}':fontsize=${Math.round(c.size * sc)}:fontcolor=${col}:borderw=${Math.max(1, Math.round(2 * sc))}:bordercolor=black@0.6:x=(w-text_w)/2:y=${yy}:enable='between(t,${S},${E})'${alpha}${o}`);
      base = o; n++; continue;
    }
    const m = media[c.mid]; const ix = idxOf.get(c.mid); const l = `[c${n}]`;
    const src = c.in, len = c.dur * c.speed;
    let chain = m.image ? `[${ix}:v]trim=duration=${f3(c.dur)},setpts=PTS-STARTPTS+${S}/TB` : `[${ix}:v]trim=start=${f3(src)}:end=${f3(src + len)},setpts=(PTS-STARTPTS)/${c.speed}+${S}/TB`;
    chain += `,fps=${fps},` + (c.fit === 'fill' ? `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}` : `scale=${W}:${H}:force_original_aspect_ratio=decrease`) + ',setsar=1,format=yuva420p';
    const ef = []; if (c.bright || (c.contrast != null && c.contrast !== 1) || (c.sat != null && c.sat !== 1) || c.gray) ef.push(`eq=brightness=${f3(c.bright || 0)}:contrast=${f3(c.contrast ?? 1)}:saturation=${c.gray ? 0 : f3(c.sat ?? 1)}`);
    if (c.blur > 0) ef.push(`gblur=sigma=${f3(Math.max(0.1, c.blur * sc))}`);
    if (ef.length) chain = chain.replace(',format=yuva420p', ',' + ef.join(',') + ',format=yuva420p');
    const Dd = f3(c.dur), TRD = f3(c.trd || 0.5), pr = `clip((t-${S})/${Dd},0,1)`, qe = `clip((t-${S})/${TRD},0,1)`, hasKz = Math.abs((c.kz || 1) - 1) > 0.001, zoomT = c.tr === 'zoom';
    if (hasKz || zoomT) { let Z = '1'; if (hasKz) Z = `(1+(${f3(c.kz)}-1)*${pr})`; if (zoomT) Z += `*(0.5+0.5*${qe})`; chain += `,scale=w='max(2,trunc(iw*${Z}/2)*2)':h='max(2,trunc(ih*${Z}/2)*2)':eval=frame`; }
    if (c.tr === 'dissolve') chain += `,fade=t=in:st=${S}:d=${TRD}:alpha=1`;
    let ox = '(W-w)/2', oy = '(H-h)/2'; if (c.kx) ox += `+${f3(c.kx)}*W*${pr}`; if (c.ky) oy += `+${f3(c.ky)}*H*${pr}`; if (c.tr === 'slide') ox += `-(1-${qe})*W`;
    if (c.fadeIn > 0) chain += `,fade=t=in:st=${S}:d=${f3(c.fadeIn)}:alpha=1`; if (c.fadeOut > 0) chain += `,fade=t=out:st=${f3(c.start + c.dur - c.fadeOut)}:d=${f3(c.fadeOut)}:alpha=1`;
    if ((c.opacity ?? 1) < 1) chain += `,colorchannelmixer=aa=${f3(c.opacity)}`;
    fc.push(chain + l);
    fc.push(`${base}${l}overlay=x='${ox}':y='${oy}':enable='between(t,${S},${E})':eof_action=pass:format=auto${o}`); base = o; n++;
  }
  let a = 0;
  if (kind !== 'gif') for (const c of P.clips) {
    const m = media[c.mid]; if (c.kind === 'text' || !m || !m.audio) continue; const ix = idxOf.get(c.mid); const src = c.in, len = c.dur * c.speed; const l = `[a${a++}]`;
    let ch = `[${ix}:a]atrim=start=${f3(src)}:end=${f3(src + len)},asetpts=PTS-STARTPTS`; if (c.speed !== 1) ch += `,atempo=${c.speed}`;
    ch += `,volume=${f3(c.vol)}`; if (c.fadeIn > 0) ch += `,afade=t=in:st=0:d=${f3(c.fadeIn)}`; if (c.fadeOut > 0) ch += `,afade=t=out:st=${f3(Math.max(0, c.dur - c.fadeOut))}:d=${f3(c.fadeOut)}`;
    const ms = Math.round(c.start * 1000); ch += `,aresample=48000,aformat=channel_layouts=stereo,adelay=${ms}|${ms}`; fc.push(ch + l); aLabels.push(l);
  }
  const hasA = kind !== 'gif'; if (hasA) fc.push(`${aLabels.join('')}amix=inputs=${aLabels.length}:duration=longest:normalize=0,atrim=duration=${f3(T)}[aout]`);
  if (kind === 'gif') { fc.push(`${base}split[g1][g2];[g1]palettegen[pg];[g2][pg]paletteuse[vout]`); } else fc.push(`${base}format=yuv420p[vout]`);
  args.push('-filter_complex', fc.join(';'), '-map', '[vout]'); if (hasA) args.push('-map', '[aout]');
  if (kind === 'mp4') args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', crf, '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart');
  else if (kind === 'webm') args.push('-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', String(+crf + 7), '-deadline', 'realtime', '-cpu-used', '6', '-row-mt', '1', '-c:a', 'libopus', '-b:a', '160k');
  else args.push('-loop', '0');
  args.push('-t', f3(T), '{out}');
  return { args, inputs, dur: T };
}
async function doExport(outH, kind, crf, destOverride) {
  const dest = destOverride || await window.host.saveFile({ name: 'Video.' + kind, filters: [[kind.toUpperCase(), [kind]]] }); if (!dest) return null;
  pause(); const { args, inputs, dur } = buildExport(outH, kind, crf);
  const prog = h('div', { class: 'progress' }, h('div', { style: 'width:0%' })); const label = h('div', { class: 'muted', text: 'Exporting... 0%' });
  const back = h('div', { class: 'modal-back' }, h('div', { class: 'modal' }, h('h2', { text: 'Exporting' }), label, prog, h('div', { class: 'row', style: 'justify-content:flex-end;margin-top:8px' }, btn('Cancel', () => window.host.cancel()))));
  document.body.append(back);
  window.host.onProgress((p) => { const pc = Math.min(100, Math.round((p.t / dur) * 100)); prog.firstChild.style.width = pc + '%'; label.textContent = 'Exporting... ' + pc + '%'; });
  try { const r = await window.host.run({ args, inputs, out: dest.id, duration: dur }); back.remove(); toast('Saved ' + dest.name); return r; }
  catch (e) { back.remove(); toast('Export failed: ' + String(e.message || e).split('\n').pop().slice(0, 100)); return null; }
}

// ---------- keys ----------
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input,textarea,select')) return; const k = e.key.toLowerCase();
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (k === 's' && !e.ctrlKey) splitAt();
  else if (e.ctrlKey && k === 's') { e.preventDefault(); saveProject(); }
  else if (e.ctrlKey && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if (e.ctrlKey && k === 'y') { e.preventDefault(); redo(); }
  else if (e.key === 'Delete' || e.key === 'Backspace') delSel();
  else if (e.key === 'ArrowLeft') seek(playhead - (e.shiftKey ? 1 : 1 / 30));
  else if (e.key === 'ArrowRight') seek(playhead + (e.shiftKey ? 1 : 1 / 30));
  else if (e.key === 'Home') seek(0); else if (e.key === 'End') seek(projDur());
});
window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
renderAll(); setTimeout(drawFrame, 50);
