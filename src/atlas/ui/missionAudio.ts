/** Optional sound for the guided mission, synthesised in the browser: no audio files, no network, no licensing.
 * It is created only from a user gesture (Begin Mission), is silent until then, and every essential message is also on screen,
 * so the mission is complete with the sound off. Cues are triggered by the director's beats and never by scientific state. */

type Wave = OscillatorType;

export class MissionAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private ambience: { stop: () => void } | null = null;
  private muted: boolean;

  constructor(muted: boolean) { this.muted = muted; }

  get available(): boolean { return typeof AudioContext !== 'undefined'; }
  get running(): boolean { return this.ctx?.state === 'running'; }
  get isMuted(): boolean { return this.muted; }

  /** Must be called from a click/keypress. Safe to call repeatedly. */
  async start(): Promise<void> {
    if (!this.available) return;
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.55;
      const limiter = this.ctx.createDynamicsCompressor();
      limiter.threshold.value = -18; limiter.ratio.value = 6;
      this.master.connect(limiter).connect(this.ctx.destination);
      this.ambience = this.buildAmbience();
    }
    if (this.ctx.state === 'suspended') { try { await this.ctx.resume(); } catch { /* blocked: stays silent */ } }
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(muted ? 0 : 0.55, this.ctx.currentTime, 0.08);
  }

  /** Pausing the mission pauses the sound with it. */
  pause(): void { void this.ctx?.suspend(); }
  async resume(): Promise<void> { if (this.ctx && this.ctx.state === 'suspended') { try { await this.ctx.resume(); } catch { /* ignore */ } } }

  dispose(): void {
    this.ambience?.stop(); this.ambience = null;
    void this.ctx?.close(); this.ctx = null; this.master = null;
  }

  // ---- synthesis -------------------------------------------------------------------------------------------------------------------------
  private buildAmbience(): { stop: () => void } {
    const ctx = this.ctx!, out = this.master!;
    const bus = ctx.createGain(); bus.gain.value = 0.085; bus.connect(out);
    const oscs: OscillatorNode[] = [];
    for (const [f, d] of [[55, 0], [82.6, 3], [110.4, -4], [164.8, 5]] as const) {
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f; o.detune.value = d;
      const g = ctx.createGain(); g.gain.value = f < 100 ? 0.5 : 0.18;
      o.connect(g).connect(bus); o.start(); oscs.push(o);
    }
    // Slow breathing on the whole bed, plus a faint filtered-noise wind.
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.07;
    const lfoGain = ctx.createGain(); lfoGain.gain.value = 0.03; lfo.connect(lfoGain).connect(bus.gain); lfo.start(); oscs.push(lfo);
    const buffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < data.length; i += 1) { last = last * 0.985 + (Math.random() * 2 - 1) * 0.015; data[i] = last * 6; }
    const noise = ctx.createBufferSource(); noise.buffer = buffer; noise.loop = true;
    const filter = ctx.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 380;
    const ng = ctx.createGain(); ng.gain.value = 0.5;
    noise.connect(filter).connect(ng).connect(bus); noise.start();
    return { stop: () => { oscs.forEach(o => { try { o.stop(); } catch { /* already stopped */ } }); try { noise.stop(); } catch { /* already stopped */ } } };
  }

  private tone(freq: number, dur: number, gain: number, when = 0, type: Wave = 'sine', slideTo?: number, attack = 0.012): void {
    const ctx = this.ctx, out = this.master;
    if (!ctx || !out) return;
    const t = ctx.currentTime + when;
    const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + attack); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(out); o.start(t); o.stop(t + dur + 0.05);
  }
  private chime(freqs: readonly number[], gain = 0.07, gap = 0.09, dur = 0.9): void { freqs.forEach((f, i) => { this.tone(f, dur, gain, i * gap, 'sine'); this.tone(f * 2, dur * 0.6, gain * 0.25, i * gap, 'sine'); }); }

  /** Plays the named cue. Unknown names are ignored. Does nothing while muted or before start(). */
  cue(name: string): void {
    if (!this.ctx || this.muted || this.ctx.state !== 'running') return;
    const N = { C4: 261.6, G4: 392, C5: 523.3, E5: 659.3, G5: 784, B5: 987.8, A4: 440, D5: 587.3, F5: 698.5, E4: 329.6, A3: 220, E3: 164.8 };
    switch (name) {
      case 'boot': this.tone(110, 1.6, 0.05, 0, 'sine', 330, 0.3); break;
      case 'scan-0': this.tone(240, 1.1, 0.05, 0, 'sine', 960, 0.2); break;
      case 'scan-1': this.chime([N.E5, N.B5], 0.06); break;
      case 'scan-2': this.tone(98, 0.5, 0.08); this.chime([N.G5], 0.04, 0, 0.7); break;
      case 'ack': this.chime([N.G5], 0.055); break;
      case 'fold-0': for (let i = 0; i < 4; i += 1) this.tone(92 + i * 2, 0.45, 0.04, i * 0.18, 'triangle'); break;
      case 'fold-1': this.chime([N.D5, N.A4], 0.055); break;
      case 'fold-2': this.chime([N.G5], 0.045); break;
      case 'leave': this.tone(660, 1.4, 0.04, 0, 'sine', 220, 0.1); break;
      case 'lens-0': this.tone(70, 1.5, 0.05, 0, 'sine', 55, 0.3); break;
      case 'lens-1': this.chime([N.C5, N.E5, N.G5], 0.05, 0.14, 1.6); break;
      case 'lens-2': this.chime([N.C5], 0.04, 0, 1.4); break;
      case 'compare': case 'cmp-0': this.tone(520, 0.12, 0.04); break;
      case 'cmp-1': this.tone(620, 0.12, 0.04); break;
      case 'cmp-2': this.tone(300, 0.9, 0.05, 0, 'triangle', 340); this.tone(318, 0.9, 0.04, 0, 'triangle', 360); break;
      case 'change': this.tone(310, 1.0, 0.045, 0, 'triangle', 330); this.tone(328, 1.0, 0.04, 0, 'triangle', 352); break;
      case 'changed': this.tone(82, 1.1, 0.09); this.chime([N.A4, N.E5], 0.045, 0.2, 1.2); break;
      case 'measure': for (let i = 0; i < 5; i += 1) this.tone(700 + i * 40, 0.08, 0.025, i * 0.28); break;
      case 'predict': this.chime([N.C5, N.E5, N.G5, N.C5 * 2], 0.05, 0.16, 1.4); break;
      case 'arrive': this.chime([N.G5, N.E5], 0.06, 0.1, 1.0); break;
      case 'match': this.chime([N.C5, N.G5, N.C5 * 2], 0.06, 0.07, 1.4); break;
      case 'miss': this.tone(220, 1.3, 0.06, 0, 'triangle', 164); this.tone(233, 1.3, 0.04, 0, 'triangle', 174); break;
      case 'abstain': this.chime([N.A3, N.E3], 0.07, 0.35, 1.6); break;
      case 'rise': this.tone(130, 2.2, 0.05, 0, 'sine', 260, 0.8); break;
      case 'decision-0': this.chime([N.D5, N.A4], 0.05, 0.3, 1.4); break;
      case 'decision-1': this.chime([N.E5], 0.045, 0, 1.1); break;
      case 'decision-2': this.chime([N.G5, N.D5], 0.05, 0.12, 1.1); break;
      case 'decision-3': this.tone(110, 1.4, 0.06); this.chime([N.A4], 0.04, 0, 1.2); break;
      case 'finale': this.chime([N.C4, N.G4, N.C5], 0.07, 0.45, 2.4); this.tone(65.4, 3, 0.07, 0, 'sine'); break;
      default: break;
    }
  }
}

/** Sound is on by default after Begin Mission (a user gesture); ?sound=0 and the mute control keep the mission silent. */
export function initialMute(): boolean {
  try {
    const q = new URLSearchParams(location.search).get('sound');
    if (q === '0' || q === 'off') return true;
    if (q === '1' || q === 'on') return false;
    return localStorage.getItem('atlas-mission-sound') === 'off';
  } catch { return false; }
}
export function persistMute(muted: boolean): void { try { localStorage.setItem('atlas-mission-sound', muted ? 'off' : 'on'); } catch { /* storage unavailable */ } }
