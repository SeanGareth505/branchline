import { Injectable } from '@angular/core';

export type NotifySoundKind = 'review' | 'ready' | 'success' | 'fail' | 'activity';

type AudioContextCtor = typeof AudioContext;

@Injectable({ providedIn: 'root' })
export class SoundService {
  private ctx: AudioContext | null = null;
  private noise: AudioBuffer | null = null;

  unlock(): void {
    const ctx = this.ensure();
    if (!ctx) return;
    if (ctx.state === 'suspended') void ctx.resume();
  }

  play(kind: NotifySoundKind, volume: number): void {
    const ctx = this.ensure();
    if (!ctx) return;
    const gain = Math.max(0, Math.min(1, volume));
    if (gain <= 0) return;
    if (ctx.state === 'suspended') {
      void ctx.resume().then(() => this.playNow(ctx, kind, gain));
      return;
    }
    this.playNow(ctx, kind, gain);
  }

  private ensure(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    const AC =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext;
    if (!AC) return null;
    this.ctx ??= new AC();
    if (this.ctx && !this.noise) this.noise = makeNoise(this.ctx);
    return this.ctx;
  }

  private playNow(ctx: AudioContext, kind: NotifySoundKind, volume: number): void {
    const start = ctx.currentTime + 0.02;
    const master = ctx.createGain();
    master.gain.value = 1;
    master.connect(ctx.destination);
    for (const voice of voicesFor(kind)) {
      startVoice(ctx, master, this.noise, start, voice, volume);
    }
  }
}

interface Voice {
  freq: number;
  at: number;
  dur: number;
  peak: number;
  type: OscillatorType;
  harmonic?: number;
  harmonicPeak?: number;
  filter?: number;
  glideTo?: number;
  noise?: number;
}

function voicesFor(kind: NotifySoundKind): Voice[] {
  switch (kind) {
    case 'review':
      return [
        { freq: 392.0, at: 0, dur: 0.16, peak: 0.2, type: 'triangle', harmonic: 2, harmonicPeak: 0.08, filter: 2600 },
        { freq: 523.25, at: 0.09, dur: 0.2, peak: 0.22, type: 'sine', harmonic: 2, harmonicPeak: 0.1, filter: 3400 },
        { freq: 783.99, at: 0.2, dur: 0.28, peak: 0.1, type: 'sine', filter: 5200 },
      ];
    case 'ready':
      return [
        { freq: 523.25, at: 0, dur: 0.14, peak: 0.16, type: 'sine', harmonic: 2, harmonicPeak: 0.07, filter: 3800 },
        { freq: 659.25, at: 0.08, dur: 0.14, peak: 0.18, type: 'sine', harmonic: 2, harmonicPeak: 0.08, filter: 4200 },
        { freq: 783.99, at: 0.16, dur: 0.16, peak: 0.2, type: 'triangle', harmonic: 2, harmonicPeak: 0.09, filter: 4800 },
        { freq: 1046.5, at: 0.26, dur: 0.32, peak: 0.14, type: 'sine', filter: 6200 },
      ];
    case 'success':
      return [
        { freq: 659.25, at: 0, dur: 0.12, peak: 0.16, type: 'sine', filter: 4200 },
        { freq: 987.77, at: 0.07, dur: 0.22, peak: 0.2, type: 'sine', harmonic: 2, harmonicPeak: 0.08, filter: 5600 },
      ];
    case 'fail':
      return [
        {
          freq: 220,
          at: 0,
          dur: 0.28,
          peak: 0.22,
          type: 'triangle',
          glideTo: 164.81,
          filter: 1400,
          noise: 0.12,
        },
        { freq: 146.83, at: 0.14, dur: 0.26, peak: 0.16, type: 'sine', filter: 900 },
      ];
    case 'activity':
      return [{ freq: 987.77, at: 0, dur: 0.055, peak: 0.09, type: 'sine', filter: 4800 }];
  }
}

function startVoice(
  ctx: AudioContext,
  dest: AudioNode,
  noise: AudioBuffer | null,
  start: number,
  voice: Voice,
  volume: number,
): void {
  const t0 = start + voice.at;
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(voice.filter ?? 4000, t0);
  filter.Q.setValueAtTime(0.65, t0);

  const amp = ctx.createGain();
  amp.gain.setValueAtTime(0.0001, t0);
  amp.gain.exponentialRampToValueAtTime(Math.max(0.0002, volume * voice.peak), t0 + 0.016);
  amp.gain.exponentialRampToValueAtTime(0.0001, t0 + voice.dur);

  const osc = ctx.createOscillator();
  osc.type = voice.type;
  osc.frequency.setValueAtTime(voice.freq, t0);
  if (voice.glideTo) {
    osc.frequency.exponentialRampToValueAtTime(voice.glideTo, t0 + voice.dur * 0.82);
  }
  osc.connect(filter);

  if (voice.harmonic) {
    const overtone = ctx.createOscillator();
    const overGain = ctx.createGain();
    overtone.type = 'sine';
    overtone.frequency.setValueAtTime(voice.freq * voice.harmonic, t0);
    if (voice.glideTo) {
      overtone.frequency.exponentialRampToValueAtTime(voice.glideTo * voice.harmonic, t0 + voice.dur * 0.82);
    }
    overGain.gain.value = voice.harmonicPeak ?? 0.12;
    overtone.connect(overGain);
    overGain.connect(filter);
    overtone.start(t0);
    overtone.stop(t0 + voice.dur + 0.03);
  }

  if (voice.noise && noise) {
    const src = ctx.createBufferSource();
    src.buffer = noise;
    const noiseGain = ctx.createGain();
    const burst = Math.min(0.08, voice.dur * 0.35);
    noiseGain.gain.setValueAtTime(0.0001, t0);
    noiseGain.gain.exponentialRampToValueAtTime(volume * voice.noise, t0 + 0.008);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, t0 + burst);
    const noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = 'bandpass';
    noiseFilter.frequency.value = 1800;
    noiseFilter.Q.value = 0.8;
    src.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(filter);
    src.start(t0);
    src.stop(t0 + burst + 0.02);
  }

  filter.connect(amp);
  amp.connect(dest);
  osc.start(t0);
  osc.stop(t0 + voice.dur + 0.03);
}

function makeNoise(ctx: AudioContext): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * 0.12);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}
