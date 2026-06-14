'use strict';

/* ════════════════════════════════════════════════════════════════
   LAYER SYSTEM
   Each layer = { id, name, canvas, ctx, visible, opacity }
   The active layer receives all drawing ops.
   Composite order: layers[0] bottom → layers[n] top.
════════════════════════════════════════════════════════════════ */
const layerSystem = (() => {
  let layers = [];
  let activeId = 0;
  let nextId = 1;
  const wrapper = document.getElementById('canvasWrapper');
  const previewCanvas = document.getElementById('previewCanvas');

  function create(name) {
    const id = nextId++;
    const c = document.createElement('canvas');
    c.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;';
    c.width  = wrapper.clientWidth  || window.innerWidth - 528;
    c.height = wrapper.clientHeight || window.innerHeight - 56;
    // Insert before previewCanvas so preview is always on top
    wrapper.insertBefore(c, previewCanvas);
    const ctx = c.getContext('2d');
    ctx.lineCap  = 'round';
    ctx.lineJoin = 'round';
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
    const w = wrapper.clientWidth;
    const h = wrapper.clientHeight;
    layers.forEach(l => {
      const snap = l.ctx.getImageData(0, 0, l.canvas.width, l.canvas.height);
      l.canvas.width  = w;
      l.canvas.height = h;
      l.ctx.putImageData(snap, 0, 0);
      l.ctx.lineCap  = 'round';
      l.ctx.lineJoin = 'round';
    });
    previewCanvas.width  = w;
    previewCanvas.height = h;
  }

  function setOpacity(id, val) {
    const l = layers.find(x => x.id === id);
    if (l) { l.opacity = val; l.canvas.style.opacity = val; }
  }

  function setVisibility(id, vis) {
    const l = layers.find(x => x.id === id);
    if (l) { l.visible = vis; l.canvas.style.display = vis ? '' : 'none'; }
  }

  return { create, remove, getActive, setActive, getAll, resize, setOpacity, setVisibility };
})();

/* resize previewCanvas positioning */
const previewCanvas = document.getElementById('previewCanvas');
previewCanvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;';
const previewCtx = previewCanvas.getContext('2d');

/* ════════════════════════════════════════════════════════════════
   HISTORY (undo/redo per layer)
   Each entry = { layerId, imageData }
════════════════════════════════════════════════════════════════ */
const history = (() => {
  const MAX = 40;
  let stack = [];
  let cursor = -1;

  function snapshot() {
    // Capture ALL layers
    const state = layerSystem.getAll().map(l => ({
      id: l.id,
      data: l.ctx.getImageData(0, 0, l.canvas.width, l.canvas.height)
    }));
    // Trim redo history
    stack = stack.slice(0, cursor + 1);
    stack.push(state);
    if (stack.length > MAX) stack.shift();
    cursor = stack.length - 1;
  }

  function undo() {
    if (cursor <= 0) { showToast('Nothing to undo'); return; }
    cursor--;
    restore(stack[cursor]);
  }

  function redo() {
    if (cursor >= stack.length - 1) { showToast('Nothing to redo'); return; }
    cursor++;
    restore(stack[cursor]);
  }

  function restore(state) {
    state.forEach(entry => {
      const l = layerSystem.getAll().find(x => x.id === entry.id);
      if (l) l.ctx.putImageData(entry.data, 0, 0);
    });
  }

  return { snapshot, undo, redo };
})();

/* ════════════════════════════════════════════════════════════════
   APPLICATION STATE
════════════════════════════════════════════════════════════════ */
const state = {
  tool:       'pen',        // pen | brush | line | rect | circle | arrow | eraser | fill
  color:      '#00e5ff',
  size:       10,
  opacity:    1.0,
  smoothing:  5,
  blendMode:  'source-over',
  pinchThreshold: 0.07,

  // Gesture state
  handDetected:    false,
  gestureMode:     'none',   // none | hover | drawing | erasing | shape-start | shape-end
  prevPoint:       null,
  midPoint:        null,
  strokeActive:    false,

  // Shape drawing (two-point shapes need pinch start + pinch end)
  shapeStartPt:    null,
  shapePending:    false,

  // Eraser hold
  eraserHoldStart: null,
  ERASER_WIPE_MS:  2000,

  // Camera
  camVisible: true,

  // Zoom / pan
  zoom: 1.0,
};

/* ════════════════════════════════════════════════════════════════
   DOM REFS
════════════════════════════════════════════════════════════════ */
const video         = document.getElementById('webcam');
const inkDrop       = document.getElementById('inkDrop');
const eraserRing    = document.getElementById('eraserRing');
const eraserArc     = document.getElementById('eraserArc');
const statusPill    = document.getElementById('statusPill');
const statusText    = document.getElementById('statusText');
const loadScreen    = document.getElementById('loadScreen');
const loadStatus    = document.getElementById('loadStatus');
const emptyLabel    = document.getElementById('emptyLabel');
const pinchFill     = document.getElementById('pinchFill');
const zoomBadge     = document.getElementById('zoomBadge');
const layerList     = document.getElementById('layerList');
const canvasWrapper = document.getElementById('canvasWrapper');

/* ════════════════════════════════════════════════════════════════
   TOAST
════════════════════════════════════════════════════════════════ */
const toastContainer = document.getElementById('toastContainer');
function showToast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  toastContainer.appendChild(t);
  setTimeout(() => t.remove(), 2400);
}

/* ════════════════════════════════════════════════════════════════
   STATUS
════════════════════════════════════════════════════════════════ */
function setStatus(text, type = 'idle') {
  statusText.textContent = text;
  statusPill.className = 'detected drawing erasing'.includes(type) ? type : '';
}

/* ════════════════════════════════════════════════════════════════
   COORDINATE MAPPING (mirrored video → canvas)
════════════════════════════════════════════════════════════════ */
function normToCanvas(lm) {
  const stage = document.getElementById('stage');
  return {
    x: (1 - lm.x) * stage.clientWidth,
    y: lm.y * stage.clientHeight,
  };
}

/* ════════════════════════════════════════════════════════════════
   GESTURE HELPERS
════════════════════════════════════════════════════════════════ */
function dist(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y;
  return Math.sqrt(dx*dx + dy*dy);
}
function isFingerUp(lms, tip, pip) { return lms[tip].y < lms[pip].y; }

function detectGesture(lms) {
  const pinchDist = dist(lms[4], lms[8]);
  const pinching  = pinchDist < state.pinchThreshold;

  const indexUp  = isFingerUp(lms, 8, 6);
  const middleUp = isFingerUp(lms, 12, 10);
  const ringUp   = isFingerUp(lms, 16, 14);
  const pinkyUp  = isFingerUp(lms, 20, 18);
  const spread   = dist(lms[8], lms[20]) > 0.25;
  const openPalm = indexUp && middleUp && ringUp && pinkyUp && spread;

  const fist = !indexUp && !middleUp && !ringUp && !pinkyUp;

  // Pinch distance as 0-1 proximity for UI feedback
  const pinchProximity = Math.max(0, Math.min(1, 1 - (pinchDist / 0.15)));

  return { pinching, openPalm, fist, pinchProximity };
}

/* ════════════════════════════════════════════════════════════════
   DRAWING ENGINE
════════════════════════════════════════════════════════════════ */
function applyCtxStyle(ctx, isPreview = false) {
  ctx.strokeStyle = state.color;
  ctx.fillStyle   = state.color;
  ctx.lineWidth   = state.size;
  ctx.globalAlpha = isPreview ? state.opacity * 0.7 : state.opacity;
  ctx.globalCompositeOperation = state.blendMode;
  ctx.lineCap  = 'round';
  ctx.lineJoin = 'round';
}

// Smooth freehand using quadratic Bézier midpoint interpolation
function drawFreehand(curr) {
  const layer = layerSystem.getActive();
  if (!layer.visible) return;

  // Apply smoothing: lerp toward current point
  const s = state.smoothing / 10;
  if (state.prevPoint && s > 0) {
    curr = {
      x: state.prevPoint.x + (curr.x - state.prevPoint.x) * (1 - s * 0.6),
      y: state.prevPoint.y + (curr.y - state.prevPoint.y) * (1 - s * 0.6),
    };
  }

  if (!state.prevPoint) {
    state.prevPoint = curr;
    state.midPoint  = curr;
    return;
  }

  const mid = { x: (state.prevPoint.x + curr.x) / 2, y: (state.prevPoint.y + curr.y) / 2 };

  applyCtxStyle(layer.ctx);
  layer.ctx.beginPath();
  layer.ctx.moveTo(state.midPoint.x, state.midPoint.y);
  layer.ctx.quadraticCurveTo(state.prevPoint.x, state.prevPoint.y, mid.x, mid.y);
  layer.ctx.stroke();

  state.midPoint  = mid;
  state.prevPoint = curr;
}

// Draw a shape preview on previewCanvas while dragging
function drawShapePreview(start, curr) {
  previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
  applyCtxStyle(previewCtx, true);
  previewCtx.beginPath();

  switch (state.tool) {
    case 'line': {
      previewCtx.moveTo(start.x, start.y);
      previewCtx.lineTo(curr.x, curr.y);
      previewCtx.stroke();
      break;
    }
    case 'rect': {
      const rx = Math.min(start.x, curr.x), ry = Math.min(start.y, curr.y);
      const rw = Math.abs(curr.x - start.x), rh = Math.abs(curr.y - start.y);
      previewCtx.strokeRect(rx, ry, rw, rh);
      break;
    }
    case 'circle': {
      const cx = (start.x + curr.x) / 2, cy = (start.y + curr.y) / 2;
      const rx2 = Math.abs(curr.x - start.x) / 2, ry2 = Math.abs(curr.y - start.y) / 2;
      previewCtx.ellipse(cx, cy, rx2, ry2, 0, 0, Math.PI * 2);
      previewCtx.stroke();
      break;
    }
    case 'arrow': {
      drawArrowOnCtx(previewCtx, start, curr);
      break;
    }
  }
}

// Commit shape to active layer
function commitShape(start, end) {
  const layer = layerSystem.getActive();
  if (!layer.visible) return;
  applyCtxStyle(layer.ctx);
  layer.ctx.beginPath();

  switch (state.tool) {
    case 'line':
      layer.ctx.moveTo(start.x, start.y);
      layer.ctx.lineTo(end.x, end.y);
      layer.ctx.stroke();
      break;
    case 'rect': {
      const rx = Math.min(start.x, end.x), ry = Math.min(start.y, end.y);
      const rw = Math.abs(end.x - start.x), rh = Math.abs(end.y - start.y);
      layer.ctx.strokeRect(rx, ry, rw, rh);
      break;
    }
    case 'circle': {
      const cx = (start.x + end.x) / 2, cy = (start.y + end.y) / 2;
      const rx2 = Math.abs(end.x - start.x) / 2, ry2 = Math.abs(end.y - start.y) / 2;
      layer.ctx.ellipse(cx, cy, rx2, ry2, 0, 0, Math.PI * 2);
      layer.ctx.stroke();
      break;
    }
    case 'arrow':
      drawArrowOnCtx(layer.ctx, start, end);
      break;
  }

  previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
}

function drawArrowOnCtx(ctx, from, to) {
  const headLen = Math.max(state.size * 3, 20);
  const angle   = Math.atan2(to.y - from.y, to.x - from.x);
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x - headLen * Math.cos(angle - Math.PI/6), to.y - headLen * Math.sin(angle - Math.PI/6));
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x - headLen * Math.cos(angle + Math.PI/6), to.y - headLen * Math.sin(angle + Math.PI/6));
  ctx.stroke();
}

// Paint bucket fill (flood fill on active layer)
function floodFill(px, py) {
  const layer  = layerSystem.getActive();
  const imgData = layer.ctx.getImageData(0, 0, layer.canvas.width, layer.canvas.height);
  const data   = imgData.data;
  const w = imgData.width, h = imgData.height;
  const idx = (Math.round(py) * w + Math.round(px)) * 4;

  const sr = data[idx], sg = data[idx+1], sb = data[idx+2], sa = data[idx+3];

  // Parse target fill colour
  const tempC = document.createElement('canvas').getContext('2d');
  tempC.fillStyle = state.color;
  tempC.fillRect(0,0,1,1);
  const [tr,tg,tb] = tempC.getImageData(0,0,1,1).data;

  if (sr===tr && sg===tg && sb===tb) return; // same colour, skip

  const matches = (i) => Math.abs(data[i]-sr)<30 && Math.abs(data[i+1]-sg)<30 && Math.abs(data[i+2]-sb)<30 && Math.abs(data[i+3]-sa)<30;
  const stack = [Math.round(px), Math.round(py)];
  const visited = new Uint8Array(w * h);

  while (stack.length) {
    const x = stack.pop(), y = stack.pop();
    if (x<0||x>=w||y<0||y>=h) continue;
    const i = (y*w+x)*4;
    if (visited[y*w+x] || !matches(i)) continue;
    visited[y*w+x] = 1;
    data[i]=tr; data[i+1]=tg; data[i+2]=tb; data[i+3]=255;
    stack.push(x+1,y, x-1,y, x,y+1, x,y-1);
  }
  layer.ctx.putImageData(imgData, 0, 0);
}

// Eraser on active layer
function eraseAt(pt) {
  const layer = layerSystem.getActive();
  const r = Math.max(state.size * 2.5, 24);
  layer.ctx.save();
  layer.ctx.globalCompositeOperation = 'destination-out';
  layer.ctx.beginPath();
  layer.ctx.arc(pt.x, pt.y, r, 0, Math.PI*2);
  layer.ctx.fillStyle = 'rgba(0,0,0,1)';
  layer.ctx.fill();
  layer.ctx.restore();
}

/* ════════════════════════════════════════════════════════════════
   INK DROP CURSOR
════════════════════════════════════════════════════════════════ */
function updateInkDrop(pt, mode) {
  if (mode === 'none') { inkDrop.style.display = 'none'; return; }
  inkDrop.style.display = 'block';
  inkDrop.style.left = pt.x + 'px';
  inkDrop.style.top  = pt.y + 'px';

  if (mode === 'hover') {
    const s = Math.max(12, state.size * 0.7);
    inkDrop.style.width  = s + 'px';
    inkDrop.style.height = s + 'px';
    inkDrop.style.background = state.color;
    inkDrop.style.boxShadow  = `0 0 14px 4px ${state.color}88`;
    inkDrop.style.opacity    = '0.7';
    inkDrop.style.borderRadius = '50%';
    inkDrop.style.border = 'none';
    inkDrop.style.transform = 'translate(-50%,-50%) scale(1)';
  } else if (mode === 'drawing') {
    const s = Math.max(14, state.size);
    inkDrop.style.width  = s + 'px';
    inkDrop.style.height = s + 'px';
    inkDrop.style.background = state.color;
    inkDrop.style.boxShadow  = `0 0 22px 8px ${state.color}bb`;
    inkDrop.style.opacity    = '1';
    inkDrop.style.borderRadius = '50%';
    inkDrop.style.border = 'none';
    inkDrop.style.transform = 'translate(-50%,-50%) scale(1.15)';
  } else if (mode === 'erasing') {
    const r = Math.max(state.size * 2.5, 24) * 2;
    inkDrop.style.width  = r + 'px';
    inkDrop.style.height = r + 'px';
    inkDrop.style.background = 'transparent';
    inkDrop.style.border = '2px solid rgba(255,82,82,0.7)';
    inkDrop.style.boxShadow  = '0 0 12px 2px rgba(255,82,82,0.4)';
    inkDrop.style.opacity    = '1';
    inkDrop.style.borderRadius = '50%';
    inkDrop.style.transform = 'translate(-50%,-50%) scale(1)';
  } else if (mode === 'shape') {
    inkDrop.style.width  = '20px';
    inkDrop.style.height = '20px';
    inkDrop.style.background = state.color;
    inkDrop.style.boxShadow  = `0 0 18px 6px ${state.color}99`;
    inkDrop.style.opacity    = '0.9';
    inkDrop.style.borderRadius = '4px';
    inkDrop.style.transform = 'translate(-50%,-50%) rotate(45deg) scale(0.85)';
  }
}

/* ════════════════════════════════════════════════════════════════
   ERASER WIPE RING
════════════════════════════════════════════════════════════════ */
const CIRC = 2 * Math.PI * 34;
function updateEraserRing(pt, frac) {
  if (frac <= 0) { eraserRing.style.display = 'none'; return; }
  eraserRing.style.display = 'block';
  eraserRing.style.left    = pt.x + 'px';
  eraserRing.style.top     = pt.y + 'px';
  eraserArc.style.strokeDashoffset = CIRC * (1 - frac);
}

/* ════════════════════════════════════════════════════════════════
   MEDIAPIPE RESULTS HANDLER (60FPS)
════════════════════════════════════════════════════════════════ */
let webcamReady = false;

function onResults(results) {
  if (!webcamReady) return;

  if (!results.multiHandLandmarks?.length) {
    // No hand
    state.handDetected = false;
    state.prevPoint = null;
    state.midPoint  = null;
    state.strokeActive   = false;
    state.shapePending   = false;
    state.eraserHoldStart = null;
    eraserRing.style.display = 'none';
    updateInkDrop(null, 'none');
    setStatus('No hand detected', 'idle');
    pinchFill.style.width = '0%';
    return;
  }

  state.handDetected = true;
  emptyLabel.style.display = 'none';

  const lms  = results.multiHandLandmarks[0];
  const tip  = normToCanvas(lms[8]);  // index finger tip
  const { pinching, openPalm, fist, pinchProximity } = detectGesture(lms);

  // Update pinch proximity bar
  pinchFill.style.width = (pinchProximity * 100) + '%';
  pinchFill.style.background = pinchProximity > 0.8 ? 'var(--magenta)' : 'var(--cyan)';

  const isTwoPointTool = ['line','rect','circle','arrow'].includes(state.tool);

  /* ── FIST: cancel pending shape ── */
  if (fist && state.shapePending) {
    state.shapePending  = false;
    state.shapeStartPt  = null;
    previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
    showToast('Shape cancelled');
    updateInkDrop(tip, 'hover');
    setStatus('Shape cancelled', 'idle');
    return;
  }

  /* ── OPEN PALM: Eraser mode ── */
  if (openPalm) {
    if (state.strokeActive) {
      history.snapshot();
      state.strokeActive = false;
    }
    state.prevPoint = null;
    state.midPoint  = null;

    if (state.tool !== 'eraser') {
      eraseAt(tip);
    }

    updateInkDrop(tip, 'erasing');
    setStatus('Erasing ✦', 'erasing');

    if (!state.eraserHoldStart) state.eraserHoldStart = Date.now();
    const elapsed  = Date.now() - state.eraserHoldStart;
    const fraction = Math.min(elapsed / state.ERASER_WIPE_MS, 1);
    updateEraserRing(tip, fraction);

    if (fraction >= 1) {
      history.snapshot();
      const layer = layerSystem.getActive();
      layer.ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
      state.eraserHoldStart = null;
      showToast('Layer wiped');
    }
    return;
  }

  state.eraserHoldStart = null;
  eraserRing.style.display = 'none';

  /* ── PINCHING ── */
  if (pinching) {

    /* Eraser tool */
    if (state.tool === 'eraser') {
      if (!state.strokeActive) { history.snapshot(); state.strokeActive = true; }
      eraseAt(tip);
      updateInkDrop(tip, 'erasing');
      setStatus('Erasing', 'erasing');
      return;
    }

    /* Fill tool */
    if (state.tool === 'fill') {
      if (!state.strokeActive) {
        history.snapshot();
        floodFill(tip.x, tip.y);
        state.strokeActive = true;
        showToast('Fill applied');
      }
      updateInkDrop(tip, 'drawing');
      setStatus('Filling', 'drawing');
      return;
    }

    /* Two-point shape tools (line, rect, circle, arrow) */
    if (isTwoPointTool) {
      if (!state.shapePending) {
        // First pinch: record start point
        state.shapeStartPt = { ...tip };
        state.shapePending  = true;
        history.snapshot();
        showToast('Shape started — aim at end point, pinch again');
        updateInkDrop(tip, 'shape');
        setStatus('Shape: aim end point', 'drawing');
      } else {
        // Second pinch: commit shape
        commitShape(state.shapeStartPt, tip);
        state.shapePending = false;
        state.shapeStartPt = null;
        showToast('Shape placed');
        updateInkDrop(tip, 'hover');
        setStatus('Shape placed ✦', 'detected');
      }
      return;
    }

    /* Freehand: pen / brush */
    if (!state.strokeActive) {
      history.snapshot();
      state.strokeActive = true;
      state.prevPoint = null;
      state.midPoint  = null;
    }
    drawFreehand(tip);
    updateInkDrop(tip, 'drawing');
    setStatus('Drawing ✦', 'drawing');

  } else {
    /* ── HOVER ── */
    if (state.strokeActive && !isTwoPointTool) {
      state.strokeActive = false;
      state.prevPoint    = null;
      state.midPoint     = null;
    }

    // While shape pending, show live preview
    if (state.shapePending && state.shapeStartPt) {
      drawShapePreview(state.shapeStartPt, tip);
      updateInkDrop(tip, 'shape');
      setStatus('Shape preview — pinch to place', 'drawing');
      return;
    }

    updateInkDrop(tip, 'hover');
    setStatus('Hand detected ✦', 'detected');
  }
}

/* ════════════════════════════════════════════════════════════════
   MEDIAPIPE INIT
════════════════════════════════════════════════════════════════ */
async function initMediaPipe() {
  const hands = new Hands({
    locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1646424915/${f}`,
  });
  hands.setOptions({
    maxNumHands: 1,
    modelComplexity: 1,
    minDetectionConfidence: 0.7,
    minTrackingConfidence: 0.6,
  });
  hands.onResults(onResults);

  loadStatus.textContent = 'Requesting camera…';
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false,
  });

  video.srcObject = stream;

  loadStatus.textContent = 'Loading hand model…';
  const camera = new Camera(video, {
    onFrame: async () => { await hands.send({ image: video }); },
    width: 1280, height: 720,
  });
  camera.start();

  video.addEventListener('playing', () => {
    // Resize all canvases to match stage
    layerSystem.resize();
    previewCanvas.width  = document.getElementById('stage').clientWidth;
    previewCanvas.height = document.getElementById('stage').clientHeight;
    webcamReady = true;
    video.classList.add('visible');
    loadScreen.classList.add('out');
    setTimeout(() => { loadScreen.style.display = 'none'; }, 750);
    renderLayerUI();
    history.snapshot(); // initial blank snapshot
  }, { once: true });

  window.addEventListener('beforeunload', () => stream.getTracks().forEach(t => t.stop()));
}

/* ════════════════════════════════════════════════════════════════
   LAYER UI RENDERER
════════════════════════════════════════════════════════════════ */
function renderLayerUI() {
  layerList.innerHTML = '';
  const layers = layerSystem.getAll().slice().reverse(); // top layer first in UI
  const active = layerSystem.getActive();

  layers.forEach(layer => {
    const item = document.createElement('div');
    item.className = 'layer-item' + (layer.id === active.id ? ' active' : '');
    item.dataset.id = layer.id;

    // Thumb
    const thumb = document.createElement('div');
    thumb.className = 'layer-thumb';
    const thumbC = document.createElement('canvas');
    thumbC.width  = 72; thumbC.height = 56;
    const tc = thumbC.getContext('2d');
    tc.drawImage(layer.canvas, 0, 0, 72, 56);
    thumb.appendChild(thumbC);

    // Name
    const name = document.createElement('div');
    name.className = 'layer-name';
    name.textContent = layer.name;

    // Visibility toggle
    const visBtn = document.createElement('button');
    visBtn.className = 'layer-vis-btn';
    visBtn.title = layer.visible ? 'Hide layer' : 'Show layer';
    visBtn.innerHTML = layer.visible
      ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`
      : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;

    visBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      layerSystem.setVisibility(layer.id, !layer.visible);
      renderLayerUI();
    });

    item.appendChild(thumb);
    item.appendChild(name);
    item.appendChild(visBtn);

    item.addEventListener('click', () => {
      layerSystem.setActive(layer.id);
      const op = Math.round(layer.opacity * 100);
      document.getElementById('layerOpacitySlider').value = op;
      document.getElementById('layerOpacityVal').textContent = op + '%';
      renderLayerUI();
    });

    layerList.appendChild(item);
  });
}

/* ════════════════════════════════════════════════════════════════
   ZOOM SYSTEM
════════════════════════════════════════════════════════════════ */
function applyZoom() {
  canvasWrapper.style.transform = `scale(${state.zoom})`;
  zoomBadge.textContent = Math.round(state.zoom * 100) + '%';
  document.getElementById('zoomResetBtn').textContent = Math.round(state.zoom * 100) + '%';
}

/* ════════════════════════════════════════════════════════════════
   EXPORT
════════════════════════════════════════════════════════════════ */
function exportCanvas(format = 'png') {
  const layers = layerSystem.getAll();
  const first = layers[0];
  const out = document.createElement('canvas');
  out.width  = first.canvas.width;
  out.height = first.canvas.height;
  const octx = out.getContext('2d');

  if (format === 'jpg') {
    octx.fillStyle = '#181820';
    octx.fillRect(0, 0, out.width, out.height);
  }

  layers.forEach(l => {
    if (!l.visible) return;
    octx.globalAlpha = l.opacity;
    octx.drawImage(l.canvas, 0, 0);
  });
  octx.globalAlpha = 1;

  const ext  = format === 'jpg' ? 'jpeg' : 'png';
  const link = document.createElement('a');
  link.download = `airpen-${Date.now()}.${format === 'jpg' ? 'jpg' : 'png'}`;
  link.href = out.toDataURL(`image/${ext}`, 0.95);
  link.click();
  showToast(`Exported as ${format.toUpperCase()}`);
}

/* ════════════════════════════════════════════════════════════════
   BRUSH PREVIEW UPDATER
════════════════════════════════════════════════════════════════ */
function updateBrushPreview() {
  const dot = document.getElementById('brushPreviewDot');
  const s = Math.min(state.size, 44);
  dot.style.width  = s + 'px';
  dot.style.height = s + 'px';
  dot.style.background = state.color;
  dot.style.opacity    = state.opacity;
  dot.style.boxShadow  = `0 0 ${s/2}px ${state.color}66`;
}

/* ════════════════════════════════════════════════════════════════
   ACTIVE COLOUR DISPLAY UPDATER
════════════════════════════════════════════════════════════════ */
function updateActiveColorDisplay() {
  document.getElementById('activeColorSwatch').style.background = state.color;
  document.getElementById('activeColorHex').textContent = state.color.toUpperCase();
}

/* ════════════════════════════════════════════════════════════════
   TOOL ACTIVATION
════════════════════════════════════════════════════════════════ */
function setTool(name) {
  state.tool = name;
  document.querySelectorAll('.tool-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tool === name);
  });
  showToast(`Tool: ${name.charAt(0).toUpperCase() + name.slice(1)}`);
  // If switching away from two-point tool, cancel pending
  if (!['line','rect','circle','arrow'].includes(name)) {
    state.shapePending = false;
    state.shapeStartPt = null;
    previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
  }
}

/* ════════════════════════════════════════════════════════════════
   UI EVENT WIRING
════════════════════════════════════════════════════════════════ */

// Tool buttons
document.querySelectorAll('.tool-btn').forEach(btn => {
  btn.addEventListener('click', () => setTool(btn.dataset.tool));
});

// Colour swatches
document.querySelectorAll('.swatch').forEach(s => {
  s.addEventListener('click', () => {
    document.querySelectorAll('.swatch').forEach(x => x.classList.remove('active'));
    s.classList.add('active');
    state.color = s.dataset.color;
    updateBrushPreview();
    updateActiveColorDisplay();
  });
});

// Custom colour picker
const customColorBtn   = document.getElementById('customColorBtn');
const customColorInput = document.getElementById('customColorInput');
customColorBtn.addEventListener('click', () => customColorInput.click());
customColorInput.addEventListener('input', () => {
  state.color = customColorInput.value;
  document.querySelectorAll('.swatch').forEach(s => s.classList.remove('active'));
  updateBrushPreview();
  updateActiveColorDisplay();
});

// Size slider
document.getElementById('sizeSlider').addEventListener('input', e => {
  state.size = parseInt(e.target.value);
  document.getElementById('sizeVal').textContent = state.size;
  updateBrushPreview();
});

// Opacity slider
document.getElementById('opacitySlider').addEventListener('input', e => {
  state.opacity = parseInt(e.target.value) / 100;
  document.getElementById('opacityVal').textContent = e.target.value + '%';
  updateBrushPreview();
});

// Smoothing slider
document.getElementById('smoothSlider').addEventListener('input', e => {
  state.smoothing = parseInt(e.target.value);
  document.getElementById('smoothVal').textContent = e.target.value;
});

// Blend mode
document.getElementById('blendSelect').addEventListener('change', e => {
  state.blendMode = e.target.value;
});

// Pinch sensitivity slider
document.getElementById('pinchSlider').addEventListener('input', e => {
  state.pinchThreshold = parseInt(e.target.value) / 100;
  document.getElementById('pinchVal').textContent = e.target.value;
});

// Undo / Redo
document.getElementById('undoBtn').addEventListener('click', () => { history.undo(); renderLayerUI(); });
document.getElementById('redoBtn').addEventListener('click', () => { history.redo(); renderLayerUI(); });

// Clear active layer
document.getElementById('clearBtn').addEventListener('click', () => {
  history.snapshot();
  const l = layerSystem.getActive();
  l.ctx.clearRect(0, 0, l.canvas.width, l.canvas.height);
  renderLayerUI();
  showToast('Layer cleared');
});

// Clear all layers
document.getElementById('clearAllBtn').addEventListener('click', () => {
  history.snapshot();
  layerSystem.getAll().forEach(l => l.ctx.clearRect(0, 0, l.canvas.width, l.canvas.height));
  renderLayerUI();
  showToast('All layers cleared');
});

// Export
document.getElementById('exportBtn').addEventListener('click', () => exportCanvas('png'));
document.getElementById('exportJpgBtn').addEventListener('click', () => exportCanvas('jpg'));

// Add layer
document.getElementById('addLayerBtn').addEventListener('click', () => {
  layerSystem.create();
  renderLayerUI();
  showToast('New layer added');
});

// Delete layer
document.getElementById('delLayerBtn').addEventListener('click', () => {
  layerSystem.remove(layerSystem.getActive().id);
  renderLayerUI();
  showToast('Layer deleted');
});

// Layer opacity
document.getElementById('layerOpacitySlider').addEventListener('input', e => {
  const val = parseInt(e.target.value) / 100;
  document.getElementById('layerOpacityVal').textContent = e.target.value + '%';
  layerSystem.setOpacity(layerSystem.getActive().id, val);
});

// Zoom
document.getElementById('zoomInBtn').addEventListener('click', () => {
  state.zoom = Math.min(state.zoom + 0.25, 4);
  applyZoom();
});
document.getElementById('zoomOutBtn').addEventListener('click', () => {
  state.zoom = Math.max(state.zoom - 0.25, 0.25);
  applyZoom();
});
document.getElementById('zoomResetBtn').addEventListener('click', () => {
  state.zoom = 1;
  applyZoom();
});

// Mouse-wheel zoom on stage
document.getElementById('stage').addEventListener('wheel', e => {
  e.preventDefault();
  const delta = e.deltaY < 0 ? 0.1 : -0.1;
  state.zoom = Math.max(0.25, Math.min(4, state.zoom + delta));
  applyZoom();
}, { passive: false });

// Camera toggle
document.getElementById('camToggle').addEventListener('click', () => {
  state.camVisible = !state.camVisible;
  video.style.opacity = state.camVisible ? '1' : '0';
  document.getElementById('camToggle').textContent = state.camVisible ? '📷 Hide cam' : '📷 Show cam';
});

/* ════════════════════════════════════════════════════════════════
   KEYBOARD SHORTCUTS
════════════════════════════════════════════════════════════════ */
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  const ctrl = e.ctrlKey || e.metaKey;

  if (ctrl && e.key === 'z') { e.preventDefault(); history.undo(); renderLayerUI(); }
  if (ctrl && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); history.redo(); renderLayerUI(); }
  if (ctrl && e.key === 's') { e.preventDefault(); exportCanvas('png'); }

  const map = { p:'pen', b:'brush', l:'line', r:'rect', c:'circle', a:'arrow', e:'eraser', g:'fill' };
  if (!ctrl && map[e.key.toLowerCase()]) setTool(map[e.key.toLowerCase()]);

  if (!ctrl && e.key === '=') { state.zoom = Math.min(state.zoom + 0.25, 4); applyZoom(); }
  if (!ctrl && e.key === '-') { state.zoom = Math.max(0.25, state.zoom - 0.25); applyZoom(); }
  if (!ctrl && e.key === '0') { state.zoom = 1; applyZoom(); }
});

/* ════════════════════════════════════════════════════════════════
   WINDOW RESIZE
════════════════════════════════════════════════════════════════ */
window.addEventListener('resize', () => {
  layerSystem.resize();
  const stage = document.getElementById('stage');
  previewCanvas.width  = stage.clientWidth;
  previewCanvas.height = stage.clientHeight;
});

/* ════════════════════════════════════════════════════════════════
   BOOT SEQUENCE
════════════════════════════════════════════════════════════════ */
(async () => {
  // Create initial layer
  layerSystem.create('Layer 1');
  renderLayerUI();
  updateBrushPreview();
  updateActiveColorDisplay();

  try {
    await initMediaPipe();
  } catch (err) {
    console.error(err);
    loadStatus.textContent = '⚠️ Camera access denied — please allow camera and reload.';
    loadStatus.style.color = '#ff5252';
    document.querySelector('.load-spinner').style.display = 'none';
  }
})();