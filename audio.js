// Tiny synthesized audio cues (ported from effects.py). No audio files needed.
const NOTES = { collect: [659, 880], win: [523, 659, 784, 1047], lost: [330, 262, 196] };

export class Sound {
  constructor() { this.ctx = null; this.muted = false; }

  /** Must be called from a user gesture (iOS/Safari keep audio locked until then). */
  unlock() {
    try {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        this.ctx = new AC();
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
    } catch (e) { /* audio is optional */ }
  }

  play(name) {
    const ctx = this.ctx;
    if (this.muted || !ctx || ctx.state !== 'running' || !NOTES[name]) return;
    const dur = 0.095;
    let t = ctx.currentTime + 0.01;
    for (const pitch of NOTES[name]) {
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.type = 'sine'; osc.frequency.value = pitch;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.linearRampToValueAtTime(0.09, t + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(t); osc.stop(t + dur + 0.02);
      t += dur;
    }
  }
}
