// WebAudio chimes — no audio files. unlock() must run inside a user gesture (iOS).

const TONES = {
  ready: [
    [784, 0],
    [988, 0.16],
    [1319, 0.32],
  ],
  order: [
    [659, 0],
    [880, 0.14],
  ],
  soft: [[740, 0]],
};

export class Chime {
  constructor() {
    this.ctx = null;
    this.loopTimer = null;
  }

  get unlocked() {
    return Boolean(this.ctx && this.ctx.state === 'running');
  }

  unlock() {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return false;
    // Lets Safari play through the ringer switch where supported.
    if (navigator.audioSession) navigator.audioSession.type = 'playback';
    if (!this.ctx) this.ctx = new AudioCtx();
    if (this.ctx.state === 'suspended') this.ctx.resume();
    const buffer = this.ctx.createBuffer(1, 1, 22050);
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.ctx.destination);
    source.start(0);
    return true;
  }

  play(kind = 'ready') {
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended') this.ctx.resume();
    const t0 = this.ctx.currentTime + 0.02;
    for (const [freq, offset] of TONES[kind] ?? TONES.ready) {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0 + offset);
      gain.gain.exponentialRampToValueAtTime(0.45, t0 + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + offset + 0.7);
      osc.connect(gain).connect(this.ctx.destination);
      osc.start(t0 + offset);
      osc.stop(t0 + offset + 0.75);
    }
  }

  loop(kind, everyMs, onTick) {
    this.stop();
    const tick = () => {
      this.play(kind);
      onTick?.();
    };
    tick();
    this.loopTimer = setInterval(tick, everyMs);
  }

  stop() {
    clearInterval(this.loopTimer);
    this.loopTimer = null;
  }
}
