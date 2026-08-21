import { Injectable } from '@angular/core';

export type NotifySoundKind = 'review' | 'ready' | 'success' | 'fail' | 'activity';

type AudioContextCtor = typeof AudioContext;

@Injectable({ providedIn: 'root' })
export class SoundService {
  private ctx: AudioContext | null = null;

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
    return this.ctx;
  }

  private playNow(ctx: AudioContext, kind: NotifySoundKind, volume: number): void {
    const start = ctx.currentTime + 0.02;
    for (const note of notesFor(kind)) {
      const osc = ctx.createOscillator();
      const amp = ctx.createGain();
      osc.type = note.type;
      osc.frequency.setValueAtTime(note.freq, start + note.at);
      amp.gain.setValueAtTime(0.0001, start + note.at);
      amp.gain.exponentialRampToValueAtTime(volume * note.peak, start + note.at + 0.02);
      amp.gain.exponentialRampToValueAtTime(0.0001, start + note.at + note.dur);
      osc.connect(amp);
      amp.connect(ctx.destination);
      osc.start(start + note.at);
      osc.stop(start + note.at + note.dur + 0.02);
    }
  }
}

interface Tone {
  freq: number;
  at: number;
  dur: number;
  peak: number;
  type: OscillatorType;
}

function notesFor(kind: NotifySoundKind): Tone[] {
  switch (kind) {
    case 'review':
      return [
        { freq: 523.25, at: 0, dur: 0.14, peak: 0.22, type: 'triangle' },
        { freq: 659.25, at: 0.12, dur: 0.18, peak: 0.2, type: 'triangle' },
      ];
    case 'ready':
      return [
        { freq: 523.25, at: 0, dur: 0.12, peak: 0.2, type: 'sine' },
        { freq: 659.25, at: 0.1, dur: 0.12, peak: 0.2, type: 'sine' },
        { freq: 783.99, at: 0.2, dur: 0.22, peak: 0.22, type: 'sine' },
      ];
    case 'success':
      return [
        { freq: 880, at: 0, dur: 0.1, peak: 0.16, type: 'sine' },
        { freq: 1174.66, at: 0.08, dur: 0.16, peak: 0.18, type: 'sine' },
      ];
    case 'fail':
      return [
        { freq: 220, at: 0, dur: 0.16, peak: 0.22, type: 'triangle' },
        { freq: 164.81, at: 0.14, dur: 0.22, peak: 0.2, type: 'triangle' },
      ];
    case 'activity':
      return [{ freq: 740, at: 0, dur: 0.07, peak: 0.12, type: 'sine' }];
  }
}
