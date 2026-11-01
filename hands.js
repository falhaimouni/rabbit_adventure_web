// Browser hand tracking. The gesture maths is a direct port of hand_tracking.py;
// the camera and MediaPipe now run on the visitor's own device (getUserMedia + WASM).
import { CFG } from './logic.js';

const HAND_CONNECTIONS = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10],
  [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [0, 17], [17, 18], [18, 19], [19, 20]];

const hypot = Math.hypot;

/** Recognize straight fingers geometrically, regardless of hand rotation. */
export function fingerExtended(hand, base, joint, tip, aspect) {
  const a = [(hand[base].x - hand[joint].x) * aspect, hand[base].y - hand[joint].y];
  const b = [(hand[tip].x - hand[joint].x) * aspect, hand[tip].y - hand[joint].y];
  const lengths = hypot(...a) * hypot(...b);
  if (lengths < 1e-6) return false;
  const cosine = (a[0] * b[0] + a[1] * b[1]) / lengths;
  return cosine < -0.65 && hypot(...b) > hypot(...a) * 0.45;
}

/** Smooth a pointing vector and debounce turns; stop gestures act immediately. */
export class GestureController {
  constructor() { this.reset(); }
  reset() {
    this.vector = null; this.lastAt = 0;
    this.direction = this.candidate = null; this.candidateAt = 0;
  }
  update(hand, timestamp, aspect = 4 / 3) {
    if (!hand) { this.reset(); return [null, 'No hand', null]; }
    const extended = [5, 9, 13, 17].map((base) => fingerExtended(hand, base, base + 1, base + 3, aspect));
    if (!extended[0] || extended[1] || extended[2] || extended[3]) {
      this.reset();
      return [null, extended.some(Boolean) ? 'Open hand / rest' : 'Fist / rest', null];
    }
    const dx = (hand[8].x - hand[5].x) * aspect;
    const dy = hand[8].y - hand[5].y;
    const length = hypot(dx, dy);
    if (length < 0.025) { this.reset(); return [null, 'Point across the camera', null]; }
    const vector = [dx / length, dy / length];
    if (this.vector === null || timestamp - this.lastAt > CFG.TRACKING_STALE_MS) {
      this.reset();
      this.vector = vector;
    } else {
      const alpha = 1 - Math.exp(-Math.max(1, timestamp - this.lastAt) / CFG.GESTURE_SMOOTHING_MS);
      this.vector = this.vector.map((old, i) => old + alpha * (vector[i] - old));
    }
    this.lastAt = timestamp;
    const [x, y] = this.vector;
    let horizontal = Math.abs(x) > Math.abs(y);
    // Keep the current axis near diagonals instead of flickering between turns.
    if ((this.direction === 'left' || this.direction === 'right') && Math.abs(y) < Math.abs(x) * CFG.GESTURE_AXIS_HYSTERESIS) horizontal = true;
    else if ((this.direction === 'up' || this.direction === 'down') && Math.abs(x) < Math.abs(y) * CFG.GESTURE_AXIS_HYSTERESIS) horizontal = false;
    const candidate = horizontal ? (x > 0 ? 'right' : 'left') : (y > 0 ? 'down' : 'up');
    if (candidate !== this.candidate) { this.candidate = candidate; this.candidateAt = timestamp; }
    if (timestamp - this.candidateAt >= CFG.GESTURE_SETTLE_MS) this.direction = candidate;
    return [this.direction, 'Pointing', this.vector];
  }
}

const EMPTY = { direction: null, resultAt: 0, status: 'off', landmarks: [], gesture: 'No hand', vector: null };

function friendlyError(err) {
  const name = err && err.name;
  if (!window.isSecureContext) return 'Camera needs HTTPS';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Camera permission denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No camera found';
  if (name === 'NotReadableError') return 'Camera is in use by another app';
  return 'Hand tracking unavailable';
}

export class HandTracker {
  constructor() {
    this.video = document.createElement('video');
    this.video.muted = true; this.video.playsInline = true;
    this.video.setAttribute('playsinline', ''); this.video.setAttribute('muted', '');
    this.gestures = new GestureController();
    this.state = { ...EMPTY };
    this.landmarker = null; this.stream = null; this.raf = 0; this.running = false;
    this.lastVideoTime = -1; this.lastTs = 0; this.lastDetect = 0;
  }

  get active() { return this.running; }

  async start() {
    if (this.running) return;
    this.running = true;
    this.state = { ...EMPTY, status: 'Starting camera' };
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw Object.assign(new Error('no mediaDevices'), { name: 'NotFoundError' });
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
      });
      if (!this.running) { this.stopStream(); return; }
      this.video.srcObject = this.stream;
      await this.video.play();
      const vision = await import('./vendor/vision_bundle.mjs');
      const files = await vision.FilesetResolver.forVisionTasks('./vendor/wasm');
      const make = (delegate) => vision.HandLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath: './assets/hand_landmarker.task', delegate },
        runningMode: 'VIDEO', numHands: 1,
        minHandDetectionConfidence: 0.6, minHandPresenceConfidence: 0.6, minTrackingConfidence: 0.6,
      });
      try { this.landmarker = await make('GPU'); } catch (e) { this.landmarker = await make('CPU'); }
      if (!this.running) { this.landmarker.close(); this.landmarker = null; this.stopStream(); return; }
      this.state = { ...EMPTY, status: 'Camera active' };
      this.loop();
    } catch (err) {
      console.warn('Hand tracking failed:', err);
      this.state = { ...EMPTY, status: friendlyError(err) };
      this.running = false;
      this.stopStream();
      if (this.landmarker) { try { this.landmarker.close(); } catch (e) { /* ignore */ } this.landmarker = null; }
    }
  }

  loop = () => {
    if (!this.running || !this.landmarker) return;
    this.raf = requestAnimationFrame(this.loop);
    const v = this.video, now = performance.now();
    // ~30 detections per second is plenty and keeps phones cool.
    if (v.readyState < 2 || v.currentTime === this.lastVideoTime || now - this.lastDetect < 28) return;
    this.lastVideoTime = v.currentTime; this.lastDetect = now;
    const ts = Math.max(Math.round(now), this.lastTs + 1);
    this.lastTs = ts;
    let result;
    try { result = this.landmarker.detectForVideo(v, ts); } catch (e) { return; }
    const aspect = v.videoWidth && v.videoHeight ? v.videoWidth / v.videoHeight : 4 / 3;
    // The preview is mirrored like a selfie, so mirror x for the logic too.
    const raw = result.landmarks && result.landmarks[0];
    const hand = raw ? raw.map((p) => ({ x: 1 - p.x, y: p.y })) : null;
    const [direction, gesture, vector] = this.gestures.update(hand, ts, aspect);
    this.state = {
      direction, gesture, vector, status: 'Camera active', resultAt: performance.now(),
      landmarks: hand ? hand.map((p) => [p.x, p.y]) : [],
    };
  };

  /** Latest tracking state; stale results never keep the rabbit moving. */
  snapshot(now = performance.now()) {
    const s = this.state;
    if (s.status !== 'Camera active' || !s.resultAt || now - s.resultAt > CFG.TRACKING_STALE_MS) {
      return { ...s, direction: null, landmarks: [], vector: null,
        gesture: s.status === 'Camera active' ? 'No hand' : s.status };
    }
    return s;
  }

  /** Draw the mirrored camera with the hand skeleton; returns the state shown. */
  drawPreview(canvas) {
    const state = this.snapshot();
    const v = this.video;
    const g = canvas.getContext('2d');
    if (state.status !== 'Camera active' || v.readyState < 2) return { state, drawn: false };
    const aspect = v.videoWidth / v.videoHeight || 4 / 3;
    const w = 320, h = Math.round(320 / aspect);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    g.save(); g.translate(w, 0); g.scale(-1, 1); g.drawImage(v, 0, 0, w, h); g.restore();
    const color = state.direction ? 'rgb(90,240,120)' : 'rgb(0,210,255)';
    if (state.landmarks.length) {
      const pts = state.landmarks.map(([x, y]) => [x * w, y * h]);
      g.strokeStyle = color; g.lineWidth = 3; g.lineCap = 'round';
      for (const [a, b] of HAND_CONNECTIONS) { g.beginPath(); g.moveTo(...pts[a]); g.lineTo(...pts[b]); g.stroke(); }
      g.fillStyle = '#fff';
      for (const p of pts) { g.beginPath(); g.arc(p[0], p[1], 4, 0, Math.PI * 2); g.fill(); }
      if (state.vector) {
        const [ox, oy] = pts[5], [vx, vy] = state.vector, ex = ox + vx * 90 * w / 640, ey = oy + vy * 90 * w / 640;
        g.strokeStyle = color; g.fillStyle = color; g.lineWidth = 5;
        g.beginPath(); g.moveTo(ox, oy); g.lineTo(ex, ey); g.stroke();
        const ang = Math.atan2(ey - oy, ex - ox);
        g.beginPath(); g.moveTo(ex, ey);
        g.lineTo(ex - 16 * Math.cos(ang - 0.45), ey - 16 * Math.sin(ang - 0.45));
        g.lineTo(ex - 16 * Math.cos(ang + 0.45), ey - 16 * Math.sin(ang + 0.45));
        g.closePath(); g.fill();
        g.lineWidth = 3; g.beginPath(); g.arc(pts[8][0], pts[8][1], 9, 0, Math.PI * 2); g.stroke();
      }
    }
    return { state, drawn: true };
  }

  stopStream() {
    if (this.stream) { this.stream.getTracks().forEach((t) => t.stop()); this.stream = null; }
    this.video.srcObject = null;
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    if (this.landmarker) { try { this.landmarker.close(); } catch (e) { /* ignore */ } this.landmarker = null; }
    this.stopStream();
    this.gestures.reset();
    this.state = { ...EMPTY };
  }
}
