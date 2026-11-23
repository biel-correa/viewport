import { mappedCodeToScancode } from './scancodes.js';

export class RdpCanvasStream {
  constructor(canvasElement, sessionId, streamPort, options = {}) {
    this.canvas = canvasElement;
    // Keep compositor double-buffering / V-Sync enabled (never pass desynchronized: true).
    this.ctx = canvasElement.getContext('2d', { alpha: false });
    this.stagingCanvas = document.createElement('canvas');
    this.stagingCanvas.width = canvasElement.width || options.width || 1920;
    this.stagingCanvas.height = canvasElement.height || options.height || 1080;
    this.stagingCtx = this.stagingCanvas.getContext('2d', { alpha: false });
    this.pendingDirty = null;
    this.presentRaf = null;
    this.sessionId = sessionId;
    this.streamPort = streamPort;
    this.onFpsUpdate = options.onFpsUpdate || null;
    this.onPingUpdate = options.onPingUpdate || null;
    this.onResolutionChange = options.onResolutionChange || null;
    this.swapMouse = Boolean(options.swapMouse);
    this.dynamicResize = options.dynamicResize !== false;
    this.keyMap = options.keyMap || null;
    this.pressedKeys = new Map();

    this.ws = null;
    this.hasRealFrames = false;
    this.remoteWidth = options.width || 1920;
    this.remoteHeight = options.height || 1080;
    this.frameCount = 0;
    this.lastFpsCalcTime = performance.now();
    this.lastMouseX = -1;
    this.lastMouseY = -1;
    this.pendingMouseMove = null;
    this.mouseMoveRaf = null;
    this.resizeTimer = null;
    this.resizeObserver = null;
    this.abortController = new AbortController();

    this.init();
  }

  init() {
    if (this.sessionId && this.streamPort) {
      this.connectWs();
    }
    this.setupInputListeners();
    this.setupResizeObserver();
  }

  connectWs() {
    const wsUrl = `ws://127.0.0.1:${this.streamPort}`;
    try {
      this.ws = new WebSocket(wsUrl);
      this.ws.binaryType = 'arraybuffer';

      this.ws.onopen = () => {
        this.ws.send(JSON.stringify({ session_id: Number(this.sessionId) }));
        if (this.dynamicResize) {
          this.checkViewportResize();
        }
      };

      this.ws.onmessage = (event) => {
        if (typeof event.data === 'string') {
          try {
            const info = JSON.parse(event.data);
            if (info.type === 'info' && info.width && info.height) {
              this.remoteWidth = info.width;
              this.remoteHeight = info.height;
              if (this.stagingCanvas.width !== info.width || this.stagingCanvas.height !== info.height) {
                this.stagingCanvas.width = info.width;
                this.stagingCanvas.height = info.height;
              }
              if (this.canvas.width !== info.width || this.canvas.height !== info.height) {
                this.canvas.width = info.width;
                this.canvas.height = info.height;
              }
            } else if (info.type === 'stats') {
              if (this.onPingUpdate) this.onPingUpdate(info.ping_ms);
            }
          } catch (e) {
            console.error('Invalid JSON message:', e);
          }
        } else if (event.data instanceof ArrayBuffer) {
          this.hasRealFrames = true;
          this.renderFrame(event.data);
        }
      };

      this.ws.onerror = () => {};
      this.ws.onclose = () => {};
    } catch (err) {
      console.warn('WebSocket connection error:', err);
    }
  }

  renderFrame(arrayBuffer) {
    if (arrayBuffer.byteLength < 12) return;
    const view = new DataView(arrayBuffer);
    const fullW = view.getUint16(0, true);
    const fullH = view.getUint16(2, true);
    const rectX = view.getUint16(4, true);
    const rectY = view.getUint16(6, true);
    const rectW = view.getUint16(8, true);
    const rectH = view.getUint16(10, true);

    const expectedBytes = rectW * rectH * 4;
    if (arrayBuffer.byteLength < 12 + expectedBytes || rectW === 0 || rectH === 0) {
      return;
    }

    if (this.stagingCanvas.width !== fullW || this.stagingCanvas.height !== fullH) {
      this.remoteWidth = fullW;
      this.remoteHeight = fullH;
      this.stagingCanvas.width = fullW;
      this.stagingCanvas.height = fullH;
      this.pendingDirty = { left: 0, top: 0, right: fullW, bottom: fullH };
      if (this.onResolutionChange) {
        this.onResolutionChange(fullW, fullH);
      }
    }

    const pixels = new Uint8ClampedArray(arrayBuffer, 12, expectedBytes);
    const imgData = new ImageData(pixels, rectW, rectH);
    this.stagingCtx.putImageData(imgData, rectX, rectY);

    const right = Math.min(fullW, rectX + rectW);
    const bottom = Math.min(fullH, rectY + rectH);
    if (this.pendingDirty) {
      this.pendingDirty.left = Math.min(this.pendingDirty.left, rectX);
      this.pendingDirty.top = Math.min(this.pendingDirty.top, rectY);
      this.pendingDirty.right = Math.max(this.pendingDirty.right, right);
      this.pendingDirty.bottom = Math.max(this.pendingDirty.bottom, bottom);
    } else {
      this.pendingDirty = { left: rectX, top: rectY, right, bottom };
    }

    this.schedulePresent();
  }

  schedulePresent() {
    if (this.presentRaf !== null) return;
    this.presentRaf = requestAnimationFrame(() => this.presentPendingFrame());
  }

  presentPendingFrame() {
    this.presentRaf = null;
    if (!this.pendingDirty) return;

    const fullW = this.stagingCanvas.width;
    const fullH = this.stagingCanvas.height;
    let { left, top, right, bottom } = this.pendingDirty;
    this.pendingDirty = null;

    if (this.canvas.width !== fullW || this.canvas.height !== fullH) {
      this.canvas.width = fullW;
      this.canvas.height = fullH;
      left = 0;
      top = 0;
      right = fullW;
      bottom = fullH;
    }

    const w = right - left;
    const h = bottom - top;
    if (w > 0 && h > 0) {
      this.ctx.drawImage(this.stagingCanvas, left, top, w, h, left, top, w, h);
    }

    this.frameCount++;
    const now = performance.now();
    if (now - this.lastFpsCalcTime >= 1000) {
      const fps = Math.round((this.frameCount * 1000) / (now - this.lastFpsCalcTime));
      if (this.onFpsUpdate) this.onFpsUpdate(fps);
      this.frameCount = 0;
      this.lastFpsCalcTime = now;
    }
  }

  /**
   * Aligns raw CSS pixel dimensions to valid RDP display dimensions (even width & height, 200..=8192).
   */
  static normalizeResolution(rawWidth, rawHeight) {
    const w = Math.max(200, Math.min(8192, Math.floor(rawWidth / 4) * 4));
    const h = Math.max(200, Math.min(8192, Math.floor(rawHeight / 2) * 2));
    return { width: w, height: h };
  }

  sendResize(rawWidth, rawHeight) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const { width, height } = RdpCanvasStream.normalizeResolution(rawWidth, rawHeight);
    if (Math.abs(width - this.remoteWidth) < 4 && Math.abs(height - this.remoteHeight) < 4) {
      return;
    }
    this.ws.send(JSON.stringify({ type: 'resize', width, height }));
  }

  checkViewportResize() {
    if (!this.dynamicResize) return;
    const container = this.canvas.parentElement;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    if (rect.width >= 200 && rect.height >= 200) {
      this.sendResize(rect.width, rect.height);
    }
  }

  setupResizeObserver() {
    const container = this.canvas.parentElement;
    if (!container || typeof ResizeObserver === 'undefined') return;

    this.resizeObserver = new ResizeObserver((entries) => {
      if (!this.dynamicResize) return;
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width < 200 || height < 200) continue;

        if (this.resizeTimer) clearTimeout(this.resizeTimer);
        this.resizeTimer = setTimeout(() => {
          this.sendResize(width, height);
        }, 220);
      }
    });

    this.resizeObserver.observe(container);
  }

  getRemoteCoords(e) {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 };

    // Account for object-fit: contain letterboxing if any exists during transition
    const canvasAspect = this.remoteWidth / this.remoteHeight;
    const rectAspect = rect.width / rect.height;

    let renderW = rect.width;
    let renderH = rect.height;
    let offsetX = 0;
    let offsetY = 0;

    if (rectAspect > canvasAspect) {
      renderW = rect.height * canvasAspect;
      offsetX = (rect.width - renderW) / 2;
    } else {
      renderH = rect.width / canvasAspect;
      offsetY = (rect.height - renderH) / 2;
    }

    const relX = e.clientX - rect.left - offsetX;
    const relY = e.clientY - rect.top - offsetY;

    const scaleX = this.remoteWidth / renderW;
    const scaleY = this.remoteHeight / renderH;

    const x = Math.min(Math.max(0, Math.round(relX * scaleX)), this.remoteWidth - 1);
    const y = Math.min(Math.max(0, Math.round(relY * scaleY)), this.remoteHeight - 1);

    return { x, y };
  }

  resolveMouseButton(domButton) {
    if (this.swapMouse) {
      if (domButton === 0) return 'right';
      if (domButton === 2) return 'left';
    }
    return domButton === 2 ? 'right' : domButton === 1 ? 'middle' : 'left';
  }

  sendCtrlAltDel() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const seq = [
      { scancode: 0x1D, extended: false }, // Left Ctrl
      { scancode: 0x38, extended: false }, // Left Alt
      { scancode: 0x53, extended: true }   // Delete (Extended)
    ];
    seq.forEach((k) => {
      this.ws.send(JSON.stringify({ type: 'key', scancode: k.scancode, extended: k.extended, down: true }));
    });
    seq.slice().reverse().forEach((k) => {
      this.ws.send(JSON.stringify({ type: 'key', scancode: k.scancode, extended: k.extended, down: false }));
    });
  }

  setupInputListeners() {
    const sig = { signal: this.abortController.signal };

    this.canvas.addEventListener('mousemove', (e) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      const { x, y } = this.getRemoteCoords(e);
      if (x === this.lastMouseX && y === this.lastMouseY) return;
      this.pendingMouseMove = { x, y };

      if (!this.mouseMoveRaf) {
        this.mouseMoveRaf = requestAnimationFrame(() => {
          this.mouseMoveRaf = null;
          if (!this.pendingMouseMove || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
          const pos = this.pendingMouseMove;
          this.pendingMouseMove = null;
          this.lastMouseX = pos.x;
          this.lastMouseY = pos.y;
          this.ws.send(JSON.stringify({ type: 'mousemove', x: pos.x, y: pos.y }));
        });
      }
    }, sig);

    this.canvas.addEventListener('mousedown', (e) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      const { x, y } = this.getRemoteCoords(e);
      this.lastMouseX = x;
      this.lastMouseY = y;
      const button = this.resolveMouseButton(e.button);
      this.ws.send(JSON.stringify({ type: 'mousebutton', button, down: true, x, y }));
    }, sig);

    this.canvas.addEventListener('mouseup', (e) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      const { x, y } = this.getRemoteCoords(e);
      const button = this.resolveMouseButton(e.button);
      this.ws.send(JSON.stringify({ type: 'mousebutton', button, down: false, x, y }));
    }, sig);

    this.canvas.addEventListener('wheel', (e) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      e.preventDefault();
      const { x, y } = this.getRemoteCoords(e);
      const delta = Math.round(e.deltaY * -1);
      this.ws.send(JSON.stringify({ type: 'wheel', x, y, delta }));
    }, { passive: false, signal: this.abortController.signal });

    this.canvas.addEventListener('keydown', (e) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      e.preventDefault();
      e.stopPropagation();
      const sc = mappedCodeToScancode(e.code, this.keyMap);
      if (sc) {
        this.pressedKeys.set(e.code, sc);
        this.ws.send(JSON.stringify({
          type: 'key',
          scancode: sc.scancode,
          extended: sc.extended,
          down: true
        }));
      }
    }, sig);

    this.canvas.addEventListener('keyup', (e) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      e.preventDefault();
      e.stopPropagation();
      const sc = this.pressedKeys.get(e.code) || mappedCodeToScancode(e.code, this.keyMap);
      this.pressedKeys.delete(e.code);
      if (sc) {
        this.ws.send(JSON.stringify({
          type: 'key',
          scancode: sc.scancode,
          extended: sc.extended,
          down: false
        }));
      }
    }, sig);

    this.canvas.addEventListener('blur', () => this.releaseAllPressedKeys(), sig);
  }

  releaseAllPressedKeys() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.pressedKeys.clear();
      return;
    }
    for (const sc of this.pressedKeys.values()) {
      this.ws.send(JSON.stringify({
        type: 'key',
        scancode: sc.scancode,
        extended: sc.extended,
        down: false
      }));
    }
    this.pressedKeys.clear();
  }

  destroy() {
    this.releaseAllPressedKeys();
    if (this.resizeTimer) {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = null;
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    if (this.mouseMoveRaf) {
      cancelAnimationFrame(this.mouseMoveRaf);
      this.mouseMoveRaf = null;
    }
    if (this.presentRaf !== null) {
      cancelAnimationFrame(this.presentRaf);
      this.presentRaf = null;
    }
    this.abortController.abort();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
