'use strict';

/* ── LAYER SYSTEM ── */
const layerSystem = (() => {
  let layers = [];
  let activeId = 0, nextId = 1;
  const wrapper = document.getElementById('canvasWrapper');
  const previewCanvas = document.getElementById('previewCanvas');

  function create(name) {
    const id = nextId++;
    const c = document.createElement('canvas');
    c.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;';
    c.width  = wrapper.clientWidth  || window.innerWidth - 528;
    c.height = wrapper.clientHeight || window.innerHeight - 56;
    wrapper.insertBefore(c, previewCanvas);
    const ctx = c.getContext('2d');
    const layer = { id, name: name || `Layer ${id}`, canvas: c, ctx, visible: true, opacity: 1.0 };
    layers.push(layer);
    activeId = id;
    return layer;
  }
  function remove(id) {
    if (layers.length <= 1) { showToast('Need at least one layer'); return; }
    const idx = layers.findIndex(l => l.id === id);
    if (idx < 0) return;
    wrapper.removeChild(layers[idx].canvas);
    layers.splice(idx, 1);
    activeId = layers[Math.min(idx, layers.length-1)].id;
  }
  function getActive() { return layers.find(l => l.id === activeId) || layers[0]; }
  function setActive(id) { activeId = id; }
  function getAll()  { return layers; }
  function resize() {
    const w = wrapper.clientWidth, h = wrapper.clientHeight;
    layers.forEach(l => {
      const snap = l.ctx.getImageData(0, 0, l.canvas.width, l.canvas.height);
      l.canvas.width = w; l.canvas.height = h;
      l.ctx.putImageData(snap, 0, 0);
    });
    previewCanvas.width = w; previewCanvas.height = h;
  }
  function setOpacity(id, val) { const l = layers.find(x => x.id === id); if (l) { l.opacity = val; l.canvas.style.opacity = val; } }
  function setVisibility(id, vis) { const l = layers.find(x => x.id === id); if (l) { l.visible = vis; l.canvas.style.display = vis ? '' : 'none'; } }
  return { create, remove, getActive, setActive, getAll, resize, setOpacity, setVisibility };
})();

const previewCanvas = document.getElementById('previewCanvas');
const previewCtx = previewCanvas.getContext('2d');

/* ── HISTORY ── */
const history = (() => {
  const MAX = 40; let stack = [], cursor = -1;
  function snapshot() {
    const s = layerSystem.getAll().map(l => ({ id: l.id, data: l.ctx.getImageData(0, 0, l.canvas.width, l.canvas.height) }));
    stack = stack.slice(0, cursor + 1); stack.push(s);
    if (stack.length > MAX) stack.shift();
    cursor = stack.length - 1;
  }
  function undo() { if (cursor <= 0) return showToast('Nothing to undo'); cursor--; restore(stack[cursor]); }
  function redo() { if (cursor >= stack.length - 1) return showToast('Nothing to redo'); cursor++; restore(stack[cursor]); }
  function restore(s) { s.forEach(entry => { const l = layerSystem.getAll().find(x => x.id === entry.id); if (l) l.ctx.putImageData(entry.data, 0, 0); }); }
  return { snapshot, undo, redo };
})();

/* ── APPLICATION STATE ── */
const state = {
  tool: 'pen', color: '#00e5ff', size: 10, opacity: 1.0, smoothing: 5, blendMode: 'source-over',
  pinchThreshold: 0.07, handDetected: false, strokeActive: false,
  
  // Smoothing Coordinates
  prevPoint: null, midPoint: null,
  smoothedX: null, smoothedY: null,
  
  // Pan and Zoom
  zoom: 1.0, panX: 0, panY: 0,
  panStartX: null, panStartY: null, panRefX: null, panRefY: null, smoothedMidX: null, smoothedMidY: null,

  shapeStartPt: null, shapePending: false, eraserHoldStart: null, ERASER_WIPE_MS: 2000, camVisible: true,
};

let fpsFrames = 0, fpsLast = performance.now();

/* ── DOM REFS ── */
const video = document.getElementById('webcam'), inkDrop = document.getElementById('inkDrop');
const eraserRing = document.getElementById('eraserRing'), eraserArc = document.getElementById('eraserArc');
const statusPill = document.getElementById('statusPill'), statusText = document.getElementById('statusText');
const fpsCounter = document.getElementById('fps-counter'), loadScreen = document.getElementById('loadScreen');
const pinchFill = document.getElementById('pinchFill'), zoomBadge = document.getElementById('zoomBadge');
const canvasWrapper = document.getElementById('canvasWrapper');

function showToast(msg) {
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
  document.getElementById('toastContainer').appendChild(t); setTimeout(() => t.remove(), 2400);
}
function setStatus(text, type = 'idle') { statusText.textContent = text; statusPill.className = 'detected drawing erasing'.includes(type) ? type : ''; }

/* ── COORDINATE MAPPING ── */
function getScreenPt(lm) {
  const stage = document.getElementById('stage');
  return { x: (1 - lm.x) * stage.clientWidth, y: lm.y * stage.clientHeight };
}
function toCanvasSpace(pt) {
  return { x: (pt.x - state.panX) / state.zoom, y: (pt.y - state.panY) / state.zoom };
}

/* ── NEW GESTURE ENGINE ── */
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

function detectGesture(lms) {
  const tip = i => lms[i], pip = i => lms[i - 2];
  const fingerUp = i => tip(i).y < pip(i).y;

  const indexUp = fingerUp(8), middleUp = fingerUp(12), ringUp = fingerUp(16), pinkyUp = fingerUp(20);
  const upCount = [indexUp, middleUp, ringUp, pinkyUp].filter(Boolean).length;

  const pinchDist = dist(tip(4), tip(8));
  const palmSize  = dist(lms[0], lms[9]);
  const pinchRatio = pinchDist / palmSize;

  let g = 'hover';
  if (pinchRatio < 0.25) g = 'pinch'; // Move/Pan
  else if (upCount === 0) g = 'fist'; // Pause
  else if (indexUp && upCount === 1) {
    if (pinchRatio < 0.45) g = 'hover'; // Buffer to prevent accidental drawing when unpinching
    else g = 'draw';
  }
  else if (upCount >= 4) g = 'palm'; // Erase

  return { gesture: g, pinchProximity: Math.max(0, 1 - (pinchRatio/0.25)) };
}

/* ── DRAWING ENGINE (WITH GLOW) ── */
function applyCtxStyle(ctx, isPreview = false) {
  ctx.strokeStyle = state.color; ctx.fillStyle = state.color; ctx.lineWidth = state.size;
  ctx.globalAlpha = isPreview ? state.opacity * 0.7 : state.opacity;
  ctx.globalCompositeOperation = state.blendMode; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
}

function drawFreehand(currCanvasPt) {
  const layer = layerSystem.getActive();
  if (!layer.visible) return;

  const s = state.smoothing / 10;
  let curr = currCanvasPt;
  if (state.prevPoint && s > 0) {
    curr = {
      x: state.prevPoint.x + (currCanvasPt.x - state.prevPoint.x) * (1 - s * 0.6),
      y: state.prevPoint.y + (currCanvasPt.y - state.prevPoint.y) * (1 - s * 0.6),
    };
  }

  if (!state.prevPoint) { state.prevPoint = curr; state.midPoint = curr; return; }
  const mid = { x: (state.prevPoint.x + curr.x) / 2, y: (state.prevPoint.y + curr.y) / 2 };

  layer.ctx.lineCap = 'round'; layer.ctx.lineJoin = 'round';
  layer.ctx.globalCompositeOperation = state.blendMode;

  if (state.tool === 'pen' || state.tool === 'brush') {
      // Glow Under-Stroke
      layer.ctx.strokeStyle = state.color;
      layer.ctx.globalAlpha = state.opacity * 0.3;
      layer.ctx.lineWidth = state.size * 2.5;
      layer.ctx.beginPath();
      layer.ctx.moveTo(state.midPoint.x, state.midPoint.y);
      layer.ctx.quadraticCurveTo(state.prevPoint.x, state.prevPoint.y, mid.x, mid.y);
      layer.ctx.stroke();

      // Core Solid Stroke
      layer.ctx.globalAlpha = state.opacity;
      layer.ctx.lineWidth = state.size;
      layer.ctx.stroke();
  } else {
      applyCtxStyle(layer.ctx);
      layer.ctx.beginPath();
      layer.ctx.moveTo(state.midPoint.x, state.midPoint.y);
      layer.ctx.quadraticCurveTo(state.prevPoint.x, state.prevPoint.y, mid.x, mid.y);
      layer.ctx.stroke();
  }

  state.midPoint = mid; state.prevPoint = curr;
}

function drawShapePreview(start, curr) {
  previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
  applyCtxStyle(previewCtx, true); previewCtx.beginPath();
  if (state.tool === 'line') { previewCtx.moveTo(start.x, start.y); previewCtx.lineTo(curr.x, curr.y); previewCtx.stroke(); }
  else if (state.tool === 'rect') { previewCtx.strokeRect(Math.min(start.x, curr.x), Math.min(start.y, curr.y), Math.abs(curr.x - start.x), Math.abs(curr.y - start.y)); }
  else if (state.tool === 'circle') { previewCtx.ellipse((start.x+curr.x)/2, (start.y+curr.y)/2, Math.abs(curr.x-start.x)/2, Math.abs(curr.y-start.y)/2, 0, 0, Math.PI*2); previewCtx.stroke(); }
  else if (state.tool === 'arrow') { drawArrowOnCtx(previewCtx, start, curr); }
}

function commitShape(start, end) {
  const layer = layerSystem.getActive(); if (!layer.visible) return;
  applyCtxStyle(layer.ctx); layer.ctx.beginPath();
  if (state.tool === 'line') { layer.ctx.moveTo(start.x, start.y); layer.ctx.lineTo(end.x, end.y); layer.ctx.stroke(); }
  else if (state.tool === 'rect') { layer.ctx.strokeRect(Math.min(start.x, end.x), Math.min(start.y, end.y), Math.abs(end.x - start.x), Math.abs(end.y - start.y)); }
  else if (state.tool === 'circle') { layer.ctx.ellipse((start.x+end.x)/2, (start.y+end.y)/2, Math.abs(end.x-start.x)/2, Math.abs(end.y-start.y)/2, 0, 0, Math.PI*2); layer.ctx.stroke(); }
  else if (state.tool === 'arrow') { drawArrowOnCtx(layer.ctx, start, end); }
  previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
}

function drawArrowOnCtx(ctx, from, to) {
  const head = Math.max(state.size * 3, 20), angle = Math.atan2(to.y - from.y, to.x - from.x);
  ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke(); ctx.beginPath();
  ctx.moveTo(to.x, to.y); ctx.lineTo(to.x - head * Math.cos(angle - Math.PI/6), to.y - head * Math.sin(angle - Math.PI/6));
  ctx.moveTo(to.x, to.y); ctx.lineTo(to.x - head * Math.cos(angle + Math.PI/6), to.y - head * Math.sin(angle + Math.PI/6)); ctx.stroke();
}

function floodFill(px, py) {
  const layer = layerSystem.getActive();
  const imgData = layer.ctx.getImageData(0, 0, layer.canvas.width, layer.canvas.height), data = imgData.data;
  const w = imgData.width, h = imgData.height, idx = (Math.round(py) * w + Math.round(px)) * 4;
  const sr = data[idx], sg = data[idx+1], sb = data[idx+2], sa = data[idx+3];
  const tempC = document.createElement('canvas').getContext('2d'); tempC.fillStyle = state.color; tempC.fillRect(0,0,1,1);
  const [tr,tg,tb] = tempC.getImageData(0,0,1,1).data;
  if (sr===tr && sg===tg && sb===tb) return;
  const matches = i => Math.abs(data[i]-sr)<30 && Math.abs(data[i+1]-sg)<30 && Math.abs(data[i+2]-sb)<30 && Math.abs(data[i+3]-sa)<30;
  const stack = [Math.round(px), Math.round(py)], visited = new Uint8Array(w * h);
  while (stack.length) {
    const x = stack.pop(), y = stack.pop();
    if (x<0||x>=w||y<0||y>=h) continue;
    const i = (y*w+x)*4; if (visited[y*w+x] || !matches(i)) continue;
    visited[y*w+x] = 1; data[i]=tr; data[i+1]=tg; data[i+2]=tb; data[i+3]=255;
    stack.push(x+1,y, x-1,y, x,y+1, x,y-1);
  }
  layer.ctx.putImageData(imgData, 0, 0);
}

function eraseAt(pt) {
  const layer = layerSystem.getActive(); const r = Math.max(state.size * 2.5, 24);
  layer.ctx.save(); layer.ctx.globalCompositeOperation = 'destination-out'; layer.ctx.beginPath();
  layer.ctx.arc(pt.x, pt.y, r, 0, Math.PI*2); layer.ctx.fillStyle = 'rgba(0,0,0,1)'; layer.ctx.fill(); layer.ctx.restore();
}

/* ── UI HELPERS ── */
function updateInkDrop(pt, mode) {
  if (mode === 'none') { inkDrop.style.display = 'none'; return; }
  inkDrop.style.display = 'block'; inkDrop.style.left = pt.x + 'px'; inkDrop.style.top = pt.y + 'px';
  if (mode === 'hover') { const s = Math.max(12, state.size*0.7); inkDrop.style.width=s+'px'; inkDrop.style.height=s+'px'; inkDrop.style.background=state.color; inkDrop.style.boxShadow=`0 0 14px 4px ${state.color}88`; inkDrop.style.opacity='0.7'; inkDrop.style.border='none'; inkDrop.style.transform='translate(-50%,-50%) scale(1)'; }
  else if (mode === 'drawing') { const s = Math.max(14, state.size); inkDrop.style.width=s+'px'; inkDrop.style.height=s+'px'; inkDrop.style.background=state.color; inkDrop.style.boxShadow=`0 0 22px 8px ${state.color}bb`; inkDrop.style.opacity='1'; inkDrop.style.border='none'; inkDrop.style.transform='translate(-50%,-50%) scale(1.15)'; }
  else if (mode === 'erasing') { const r = Math.max(state.size*2.5, 24)*2; inkDrop.style.width=r+'px'; inkDrop.style.height=r+'px'; inkDrop.style.background='transparent'; inkDrop.style.border='2px solid rgba(255,82,82,0.7)'; inkDrop.style.boxShadow='0 0 12px 2px rgba(255,82,82,0.4)'; inkDrop.style.transform='translate(-50%,-50%) scale(1)'; }
  else if (mode === 'shape') { inkDrop.style.width='20px'; inkDrop.style.height='20px'; inkDrop.style.background=state.color; inkDrop.style.boxShadow=`0 0 18px 6px ${state.color}99`; inkDrop.style.opacity='0.9'; inkDrop.style.borderRadius='4px'; inkDrop.style.transform='translate(-50%,-50%) rotate(45deg) scale(0.85)'; }
}
function updateEraserRing(pt, frac) {
  if (frac <= 0) { eraserRing.style.display = 'none'; return; }
  eraserRing.style.display = 'block'; eraserRing.style.left = pt.x + 'px'; eraserRing.style.top = pt.y + 'px';
  eraserArc.style.strokeDashoffset = (2 * Math.PI * 34) * (1 - frac);
}

/* ── MAIN RESULTS LOOP (60FPS) ── */
let webcamReady = false;
function onResults(results) {
  if (!webcamReady) return;

  // Track FPS
  fpsFrames++; const now = performance.now();
  if (now - fpsLast > 1000) { fpsCounter.textContent = Math.round(fpsFrames * 1000 / (now - fpsLast)) + ' fps'; fpsFrames = 0; fpsLast = now; }

  if (!results.multiHandLandmarks?.length) {
    state.handDetected = false; state.prevPoint = null; state.midPoint = null; state.strokeActive = false;
    state.shapePending = false; state.eraserHoldStart = null; eraserRing.style.display = 'none';
    updateInkDrop(null, 'none'); setStatus('No hand detected', 'idle'); pinchFill.style.width = '0%';
    return;
  }

  state.handDetected = true; document.getElementById('emptyLabel').style.display = 'none';
  const lms = results.multiHandLandmarks[0];
  const { gesture, pinchProximity } = detectGesture(lms);
  
  pinchFill.style.width = (pinchProximity * 100) + '%';
  pinchFill.style.background = pinchProximity > 0.8 ? 'var(--magenta)' : 'var(--cyan)';

  const rawScreen = getScreenPt(lms[8]); // Index tip

  // Jitter Smoothing (EMA)
  if (state.smoothedX === null) { state.smoothedX = rawScreen.x; state.smoothedY = rawScreen.y; } 
  else { state.smoothedX = 0.45 * rawScreen.x + 0.55 * state.smoothedX; state.smoothedY = 0.45 * rawScreen.y + 0.55 * state.smoothedY; }

  const tipScreen = { x: state.smoothedX, y: state.smoothedY };
  const tipCanvas = toCanvasSpace(tipScreen);
  const isTwoPointTool = ['line','rect','circle','arrow'].includes(state.tool);

  // 1. FIST: Cancel / Pause
  if (gesture === 'fist') {
    if (state.shapePending) {
      state.shapePending = false; state.shapeStartPt = null;
      previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
      showToast('Shape cancelled');
    }
    updateInkDrop(tipScreen, 'none'); setStatus('Paused ✊', 'idle');
    state.strokeActive = false; state.prevPoint = null; state.midPoint = null;
  }

  // 2. PINCH: Pan Canvas
  else if (gesture === 'pinch') {
    const thumbSc = getScreenPt(lms[4]), indexSc = getScreenPt(lms[8]);
    const midX = (thumbSc.x + indexSc.x) / 2, midY = (thumbSc.y + indexSc.y) / 2;

    if (state.panStartX !== null) {
      state.smoothedMidX = 0.3 * midX + 0.7 * state.smoothedMidX;
      state.smoothedMidY = 0.3 * midY + 0.7 * state.smoothedMidY;
      state.panX += state.smoothedMidX - state.panRefX;
      state.panY += state.smoothedMidY - state.panRefY;
      state.panRefX = state.smoothedMidX; state.panRefY = state.smoothedMidY;
      applyZoom();
    } else {
      state.panStartX = midX; state.panStartY = midY;
      state.panRefX = midX; state.panRefY = midY;
      state.smoothedMidX = midX; state.smoothedMidY = midY;
    }
    updateInkDrop(tipScreen, 'hover'); setStatus('Panning Canvas 🤏', 'drawing');
    state.strokeActive = false; state.prevPoint = null;
  }

  // 3. PALM: Erase
  else if (gesture === 'palm') {
    if (state.strokeActive) { history.snapshot(); state.strokeActive = false; }
    state.prevPoint = null; state.midPoint = null;
    if (state.tool !== 'eraser') eraseAt(tipCanvas);
    
    updateInkDrop(tipScreen, 'erasing'); setStatus('Erasing ✋', 'erasing');
    if (!state.eraserHoldStart) state.eraserHoldStart = Date.now();
    const frac = Math.min((Date.now() - state.eraserHoldStart) / state.ERASER_WIPE_MS, 1);
    updateEraserRing(tipScreen, frac);

    if (frac >= 1) {
      history.snapshot();
      const layer = layerSystem.getActive();
      layer.ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
      state.eraserHoldStart = null; showToast('Layer wiped');
    }
  }

  // 4. DRAW (Index Up)
  else if (gesture === 'draw') {
    state.eraserHoldStart = null; eraserRing.style.display = 'none';

    if (state.tool === 'eraser') {
      if (!state.strokeActive) { history.snapshot(); state.strokeActive = true; }
      eraseAt(tipCanvas); updateInkDrop(tipScreen, 'erasing'); setStatus('Erasing', 'erasing');
    }
    else if (state.tool === 'fill') {
      if (!state.strokeActive) { history.snapshot(); floodFill(tipCanvas.x, tipCanvas.y); state.strokeActive = true; showToast('Fill applied'); }
      updateInkDrop(tipScreen, 'drawing'); setStatus('Filling', 'drawing');
    }
    else if (isTwoPointTool) {
      if (!state.shapePending) {
        state.shapeStartPt = { ...tipCanvas }; state.shapePending = true; history.snapshot();
        showToast('Aim shape. Raise 2 fingers to place, or form a Fist to cancel.');
        updateInkDrop(tipScreen, 'shape'); setStatus('Shape started ☝️', 'drawing');
      } else {
        drawShapePreview(state.shapeStartPt, tipCanvas); updateInkDrop(tipScreen, 'shape'); setStatus('Aiming shape ☝️', 'drawing');
      }
    } else {
      // Freehand
      if (!state.strokeActive) { history.snapshot(); state.strokeActive = true; state.prevPoint = null; state.midPoint = null; }
      drawFreehand(tipCanvas); updateInkDrop(tipScreen, 'drawing'); setStatus('Drawing ☝️', 'drawing');
    }
  }

  // 5. HOVER (2 Fingers)
  else {
    state.eraserHoldStart = null; eraserRing.style.display = 'none';
    if (state.strokeActive && !isTwoPointTool) { state.strokeActive = false; state.prevPoint = null; state.midPoint = null; }

    if (isTwoPointTool && state.shapePending && state.shapeStartPt) {
      commitShape(state.shapeStartPt, tipCanvas);
      state.shapePending = false; state.shapeStartPt = null;
      showToast('Shape placed'); updateInkDrop(tipScreen, 'hover'); setStatus('Shape placed ✦', 'detected');
    } else {
      updateInkDrop(tipScreen, 'hover'); setStatus('Hovering ✌️', 'detected');
    }
  }

  if (gesture !== 'pinch') state.panStartX = null;
}

/* ── CAMERA / INIT ── */
async function initMediaPipe() {
  const hands = new Hands({ locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1646424915/${f}` });
  hands.setOptions({ maxNumHands: 1, modelComplexity: 1, minDetectionConfidence: 0.7, minTrackingConfidence: 0.6 });
  hands.onResults(onResults);

  document.getElementById('loadStatus').textContent = 'Requesting camera…';
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
  video.srcObject = stream;

  document.getElementById('loadStatus').textContent = 'Loading hand model…';
  const camera = new Camera(video, { onFrame: async () => { await hands.send({ image: video }); }, width: 1280, height: 720 });
  camera.start();

  video.addEventListener('playing', () => {
    layerSystem.resize(); previewCanvas.width = document.getElementById('stage').clientWidth; previewCanvas.height = document.getElementById('stage').clientHeight;
    webcamReady = true; video.classList.add('visible');
    document.getElementById('loadScreen').classList.add('out'); setTimeout(() => { document.getElementById('loadScreen').style.display = 'none'; }, 750);
    renderLayerUI(); history.snapshot();
  }, { once: true });
}

/* ── UI BINDINGS ── */
function renderLayerUI() {
  const layerList = document.getElementById('layerList'); layerList.innerHTML = '';
  const layers = layerSystem.getAll().slice().reverse(), active = layerSystem.getActive();
  layers.forEach(layer => {
    const item = document.createElement('div'); item.className = 'layer-item' + (layer.id === active.id ? ' active' : ''); item.dataset.id = layer.id;
    const thumb = document.createElement('div'); thumb.className = 'layer-thumb';
    const thumbC = document.createElement('canvas'); thumbC.width = 72; thumbC.height = 56;
    thumbC.getContext('2d').drawImage(layer.canvas, 0, 0, 72, 56); thumb.appendChild(thumbC);
    
    const name = document.createElement('div'); name.className = 'layer-name'; name.textContent = layer.name;
    const visBtn = document.createElement('button'); visBtn.className = 'layer-vis-btn'; visBtn.innerHTML = layer.visible ? `👁️` : `🙈`;
    visBtn.addEventListener('click', (e) => { e.stopPropagation(); layerSystem.setVisibility(layer.id, !layer.visible); renderLayerUI(); });
    
    item.appendChild(thumb); item.appendChild(name); item.appendChild(visBtn);
    item.addEventListener('click', () => { layerSystem.setActive(layer.id); document.getElementById('layerOpacitySlider').value = Math.round(layer.opacity * 100); document.getElementById('layerOpacityVal').textContent = Math.round(layer.opacity * 100) + '%'; renderLayerUI(); });
    layerList.appendChild(item);
  });
}

function changeZoom(newZoom, targetX = null, targetY = null) {
  const stage = document.getElementById('stage');
  const cx = targetX ?? stage.clientWidth / 2, cy = targetY ?? stage.clientHeight / 2;
  const canvasX = (cx - state.panX) / state.zoom, canvasY = (cy - state.panY) / state.zoom;
  
  state.zoom = newZoom;
  state.panX = cx - canvasX * state.zoom;
  state.panY = cy - canvasY * state.zoom;
  applyZoom();
}

function applyZoom() {
  canvasWrapper.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
  document.getElementById('zoomBadge').textContent = Math.round(state.zoom * 100) + '%';
  document.getElementById('zoomResetBtn').textContent = Math.round(state.zoom * 100) + '%';
}

function updateBrushPreview() {
  const dot = document.getElementById('brushPreviewDot'), s = Math.min(state.size, 44);
  dot.style.width = s+'px'; dot.style.height = s+'px'; dot.style.background = state.color;
  dot.style.opacity = state.opacity; dot.style.boxShadow = `0 0 ${s/2}px ${state.color}66`;
}

function setTool(name) {
  state.tool = name; document.querySelectorAll('.tool-btn').forEach(b => b.classList.toggle('active', b.dataset.tool === name)); showToast(`Tool: ${name}`);
  if (!['line','rect','circle','arrow'].includes(name)) { state.shapePending = false; state.shapeStartPt = null; previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height); }
}

document.querySelectorAll('.tool-btn').forEach(btn => btn.addEventListener('click', () => setTool(btn.dataset.tool)));
document.querySelectorAll('.swatch').forEach(s => s.addEventListener('click', () => { document.querySelectorAll('.swatch').forEach(x => x.classList.remove('active')); s.classList.add('active'); state.color = s.dataset.color; updateBrushPreview(); document.getElementById('activeColorSwatch').style.background = state.color; document.getElementById('activeColorHex').textContent = state.color.toUpperCase(); }));

document.getElementById('sizeSlider').addEventListener('input', e => { state.size = parseInt(e.target.value); document.getElementById('sizeVal').textContent = state.size; updateBrushPreview(); });
document.getElementById('opacitySlider').addEventListener('input', e => { state.opacity = parseInt(e.target.value) / 100; document.getElementById('opacityVal').textContent = e.target.value + '%'; updateBrushPreview(); });
document.getElementById('smoothSlider').addEventListener('input', e => { state.smoothing = parseInt(e.target.value); document.getElementById('smoothVal').textContent = e.target.value; });
document.getElementById('blendSelect').addEventListener('change', e => { state.blendMode = e.target.value; });

document.getElementById('undoBtn').addEventListener('click', () => { history.undo(); renderLayerUI(); });
document.getElementById('redoBtn').addEventListener('click', () => { history.redo(); renderLayerUI(); });
document.getElementById('clearBtn').addEventListener('click', () => { history.snapshot(); const l = layerSystem.getActive(); l.ctx.clearRect(0, 0, l.canvas.width, l.canvas.height); renderLayerUI(); showToast('Layer cleared'); });
document.getElementById('clearAllBtn').addEventListener('click', () => { history.snapshot(); layerSystem.getAll().forEach(l => l.ctx.clearRect(0, 0, l.canvas.width, l.canvas.height)); renderLayerUI(); showToast('All layers cleared'); });

document.getElementById('zoomInBtn').addEventListener('click', () => changeZoom(Math.min(state.zoom + 0.25, 4)));
document.getElementById('zoomOutBtn').addEventListener('click', () => changeZoom(Math.max(state.zoom - 0.25, 0.25)));
document.getElementById('zoomResetBtn').addEventListener('click', () => { state.zoom = 1; state.panX = 0; state.panY = 0; applyZoom(); });

document.getElementById('stage').addEventListener('wheel', e => {
  e.preventDefault();
  const rect = document.getElementById('stage').getBoundingClientRect();
  changeZoom(Math.max(0.25, Math.min(4, state.zoom + (e.deltaY < 0 ? 0.1 : -0.1))), e.clientX - rect.left, e.clientY - rect.top);
}, { passive: false });

document.getElementById('addLayerBtn').addEventListener('click', () => { layerSystem.create(); renderLayerUI(); showToast('New layer added'); });
document.getElementById('delLayerBtn').addEventListener('click', () => { layerSystem.remove(layerSystem.getActive().id); renderLayerUI(); showToast('Layer deleted'); });

document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.key === 'z') { e.preventDefault(); history.undo(); renderLayerUI(); }
  if (ctrl && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); history.redo(); renderLayerUI(); }
  const map = { p:'pen', b:'brush', l:'line', r:'rect', c:'circle', a:'arrow', e:'eraser', g:'fill' };
  if (!ctrl && map[e.key.toLowerCase()]) setTool(map[e.key.toLowerCase()]);
});

window.addEventListener('resize', () => {
  layerSystem.resize();
  previewCanvas.width = document.getElementById('stage').clientWidth; previewCanvas.height = document.getElementById('stage').clientHeight;
});

(async () => {
  layerSystem.create('Layer 1'); renderLayerUI(); updateBrushPreview();
  try { await initMediaPipe(); } catch (err) { document.getElementById('loadStatus').textContent = '⚠️ Camera access denied.'; document.getElementById('loadStatus').style.color = '#ff5252'; document.querySelector('.load-spinner').style.display = 'none'; }
})();