import { PRESETS, type BodyMix } from "../../vendor/chimera/src/ui/body.ts";
import type { TelemetryMessage } from "../../vendor/chimera/src/worklet/protocol.ts";

export const PART_BODIES = {
  soprano: PRESETS.female,
  alto: PRESETS.female,
  tenor: PRESETS.male,
  bass: PRESETS.male,
} as const;

export type Part = keyof typeof PART_BODIES;
export const PARTS = Object.keys(PART_BODIES) as Part[];

export function voiceBody(part: Part): BodyMix {
  return PART_BODIES[part];
}

const TELE_HEADER = 16;

export function teleMsg(blockB64: string, labelsB64: string, body: BodyMix, beatStep: number, format?: string): TelemetryMessage {
  const bytes = Uint8Array.from(atob(blockB64), (c) => c.charCodeAt(0));
  const head = new Float64Array(bytes.buffer, 0, TELE_HEADER);
  let take: (n: number) => Float32Array;
  if (format === undefined || format === "f64") {
    const all = new Float64Array(bytes.buffer, 0, bytes.byteLength / 8);
    let o = TELE_HEADER;
    take = (n: number) => Float32Array.from(all.subarray(o, (o += n)));
  } else if (format === "f32") {
    const payload = new Float32Array(bytes.buffer, TELE_HEADER * 8);
    let o = 0;
    take = (n: number) => Float32Array.from(payload.subarray(o, (o += n)));
  } else {
    throw new Error(`unknown telemetry format: ${format}`);
  }
  const [phLen, orLen, velumPort, f0, voicing, pLung, outRms, noiseLevel, noiseNode, gate, clock, nArtic, nPh, nOr, nScope, nActive] = head;
  const artic = take(nArtic), phAreas = take(nPh), orAreas = take(nOr), pressureRms = take(nPh + nOr), flow = take(nPh + nOr), glottalArea = take(nScope), glottalFlow = take(nScope);
  const lb = Uint8Array.from(atob(labelsB64), (c) => c.charCodeAt(0));
  const active: string[] = [];
  for (let i = 0; i < Math.min(4, nActive); i++) active.push(new TextDecoder().decode(lb.subarray(i * 25 + 1, i * 25 + 1 + lb[i * 25])));
  return {
    type: "telemetry",
    t: { artic, phAreas, orAreas, phLen, orLen, pressureRms, flow, velumPort, glottalArea, glottalFlow, f0, voicing, pLung, outRms, noiseLevel, noiseNode, gate, clock, active },
    load: 0,
    body,
    nPh,
    nOr,
    beatStep,
  };
}

export function decodePcm(b64: string): Float32Array {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const i16 = new Int16Array(bytes.buffer, 0, bytes.byteLength / 2);
  const out = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) out[i] = i16[i] / 32768;
  return out;
}

export class StreamVoice {
  ctx: AudioContext | null = null;
  latest: TelemetryMessage | null = null;
  private listeners = new Set<(t: TelemetryMessage) => void>();
  private frames: { at: number; msg: TelemetryMessage }[] = [];

  onTelemetry(l: (t: TelemetryMessage) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  push(msg: TelemetryMessage, offset: number): void {
    this.frames.push({ at: offset + msg.t.clock - 0.03, msg });
  }

  get nextAt(): number | null {
    return this.frames[0]?.at ?? null;
  }

  pump(pos: number): void {
    while (this.frames.length && this.frames[0].at <= pos + 0.02) {
      this.latest = this.frames.shift()!.msg;
      for (const l of this.listeners) l(this.latest);
    }
  }

  reset(): void {
    this.frames = [];
    this.latest = null;
  }
}

export const player = {
  ctx: null as AudioContext | null,
  node: null as AudioWorkletNode | null,
  queuedSec: 0,
  lastPos: null as { s: number; t: number; playing: boolean } | null,
  track: [] as { s: number; t: number; playing: boolean }[],
  onError: null as null | ((e: Error) => void),
  chunkOffset: new Map<number, number>(),
  epoch: 0,
  drainedEpoch: -1,
  pending: null as null | { epoch: number; promise: Promise<void>; resolve: () => void; reject: (e: unknown) => void },

  async start(onError?: (e: Error) => void): Promise<void> {
    this.onError = onError ?? null;
    if (this.ctx && this.node && this.ctx.state !== "closed") {
      await this.ctx.resume();
      return;
    }
    this.ctx = null;
    this.node = null;
    const ctx = new AudioContext();
    let node: AudioWorkletNode | null = null;
    let failed = false;
    try {
      await ctx.audioWorklet.addModule("/stream-player.js?v=2");
      node = new AudioWorkletNode(ctx, "stream-player", { processorOptions: { buffered: true } });
      node.connect(ctx.destination);
      node.port.onmessage = (e) => {
        if (this.node !== node) return;
        const m = e.data as { type: string; epoch?: number; s?: number; t?: number; playing?: boolean };
        if (m.epoch !== this.epoch) return;
        let checkpoint: { s: number; t: number; playing: boolean } | null = null;
        if (m.type === "pos" && m.s != null) {
          checkpoint = { s: m.s / 48000, t: m.t ?? ctx.currentTime, playing: m.playing !== false };
        } else if (m.type === "drained") {
          this.drainedEpoch = this.epoch;
          checkpoint = { s: (m.s ?? 0) / 48000, t: m.t ?? ctx.currentTime, playing: false };
          const p = this.pending;
          if (p) { this.pending = null; p.resolve(); }
        }
        if (checkpoint) {
          this.lastPos = checkpoint;
          this.track.push(checkpoint);
          if (this.track.length > 1000) this.track.splice(0, this.track.length - 1000);
        }
      };
      node.addEventListener("processorerror", () => {
        failed = true;
        node?.disconnect();
        void ctx.close().catch(() => {});
        if (this.node === node) {
          const error = new Error("audio processor error");
          const p = this.pending;
          this.pending = null;
          p?.reject(error);
          this.node = null;
          this.ctx = null;
          this.onError?.(error);
        }
      });
      node.port.postMessage({ reset: true, epoch: this.epoch });
      await ctx.resume();
      if (failed) throw new Error("audio processor error");
    } catch (error) {
      node?.disconnect();
      await ctx.close().catch(() => {});
      throw error;
    }
    this.ctx = ctx;
    this.node = node;
    this.track = [];
  },

  suspend(): void {
    void this.ctx?.suspend();
  },

  resume(): void {
    void this.ctx?.resume();
  },

  enqueue(n: number, samples: Float32Array, sr: number, choir = false): number {
    if (!this.node) throw new Error("audio player unavailable");
    if (!this.chunkOffset.has(n)) this.chunkOffset.set(n, this.queuedSec);
    const off = this.chunkOffset.get(n)!;
    this.queuedSec += samples.length / sr;
    this.node.port.postMessage({ pcm: samples, epoch: this.epoch, bufferSeconds: choir ? 0.5 : 0.25 });
    return off;
  },

  pos(): number {
    if (!this.ctx || !this.lastPos) return -1;
    const s = this.lastPos.playing ? this.lastPos.s + Math.max(0, this.ctx.currentTime - this.lastPos.t) : this.lastPos.s;
    return Math.min(s, this.queuedSec);
  },

  audiblePos(): number {
    const ctx = this.ctx;
    if (!ctx || !this.track.length) return -1;
    const t = ctx.currentTime - playerLatency();
    const track = this.track;
    let lo = 0, hi = track.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (track[mid].t <= t) lo = mid + 1; else hi = mid;
    }
    const cp = track[lo - 1] ?? track[0];
    const s = cp.playing ? cp.s + Math.max(0, t - cp.t) : cp.s;
    return Math.min(Math.max(s, 0), this.queuedSec);
  },

  audibleEnd(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, playerLatency() * 1000));
  },

  end(): number {
    return this.queuedSec;
  },

  offsetOf(n: number): number {
    return this.chunkOffset.get(n) ?? this.queuedSec;
  },

  finish(): Promise<void> {
    if (!this.node) return Promise.reject(new Error("audio player unavailable"));
    if (this.drainedEpoch === this.epoch) return Promise.resolve();
    if (this.pending?.epoch === this.epoch) return this.pending.promise;
    let resolve!: () => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
    this.pending = { epoch: this.epoch, promise, resolve, reject };
    this.node.port.postMessage({ end: true, epoch: this.epoch });
    return promise;
  },

  reset(): void {
    this.epoch += 1;
    const p = this.pending;
    this.pending = null;
    p?.resolve();
    if (this.node) this.node.port.postMessage({ reset: true, epoch: this.epoch });
    this.queuedSec = 0;
    this.lastPos = null;
    this.track = [];
    this.chunkOffset.clear();
    this.drainedEpoch = -1;
  },
};

export function playerLatency(): number {
  const c = player.ctx;
  return c ? (c.baseLatency ?? 0) + (c.outputLatency ?? 0) : 0;
}
