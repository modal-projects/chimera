import workletUrl from "../../vendor/chimera/src/worklet/processor.ts?worker&url";
import { chimeraModule } from "../../vendor/chimera/src/wasm/chimera.ts";
import { PRESETS } from "../../vendor/chimera/src/ui/body.ts";
import type { BodyMix, Gesture, PlannedSegment } from "../../vendor/chimera/src/wasm/types.ts";
import type { FromWorklet, TelemetryMessage, ToWorklet } from "../../vendor/chimera/src/worklet/protocol.ts";

export const PART_BODIES = {
  soprano: PRESETS.female,
  alto: PRESETS.female,
  tenor: PRESETS.male,
  bass: PRESETS.male,
} as const;

export type Part = keyof typeof PART_BODIES;
export const PARTS = Object.keys(PART_BODIES) as Part[];

const CHOIR_RATE = 16000;

export class VoiceEngine {
  ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private master: GainNode | null = null;
  latest: TelemetryMessage | null = null;
  private latestAt = 0;
  load = 0;
  private listeners = new Set<(t: TelemetryMessage) => void>();
  private speakId = 0;

  voiceClock(): number | null {
    if (!this.latest) return null;
    return this.latest.t.clock + Math.min(0.25, (performance.now() - this.latestAt) / 1000);
  }

  attach(ctx: AudioContext): void {
    this.ctx = ctx;
    const node = new AudioWorkletNode(ctx, "chimera", { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: { module: chimeraModule() } });
    this.node = node;
    const master = ctx.createGain();
    master.gain.value = 0.5;
    this.master = master;
    node.connect(master).connect(ctx.destination);
    node.port.onmessage = (e: MessageEvent<FromWorklet>) => {
      const m = e.data;
      if (m.type === "telemetry") {
        this.latest = m;
        this.latestAt = performance.now();
        this.load = m.load;
        for (const l of this.listeners) l(m);
      }
    };
  }

  onTelemetry(l: (t: TelemetryMessage) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  schedule(plan: { gestures: Gesture[]; segments: PlannedSegment[]; end: number }): void {
    this.send({ type: "schedule", ...plan, id: ++this.speakId, replace: true });
  }

  scheduleGestures(gestures: Gesture[], lead = 0.03): void {
    this.send({ type: "schedule", gestures, segments: [], end: 0, id: ++this.speakId, replace: false, lead });
  }

  setBody(body: BodyMix): void {
    this.send({ type: "body", body });
  }

  setVolume(v: number): void {
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }

  tap(dest: AudioNode): void {
    this.master?.connect(dest);
  }

  private send(m: ToWorklet): void {
    this.node?.port.postMessage(m);
  }
}

let voices: Map<Part, VoiceEngine> | null = null;
const pairCtxs: AudioContext[] = [];

const PAIRING: Part[][] = [
  ["soprano", "alto"],
  ["tenor", "bass"],
];

export async function warmChoir(): Promise<Map<Part, VoiceEngine>> {
  if (!voices) {
    const ctxs = PAIRING.map(() => new AudioContext({ latencyHint: 0.25, sampleRate: CHOIR_RATE }));
    pairCtxs.push(...ctxs);
    for (const c of ctxs) await c.audioWorklet.addModule(workletUrl);
    voices = new Map(PARTS.map((p) => [p, new VoiceEngine()]));
    PAIRING.forEach((group, i) => group.forEach((p) => voices!.get(p)!.attach(ctxs[i])));
    for (const c of ctxs) await c.resume();
    for (const c of ctxs) await c.suspend();
    (globalThis as Record<string, unknown>).__chimeraChoir = voices;
  }
  return voices;
}

export async function resumeChoir(): Promise<Map<Part, VoiceEngine>> {
  await Promise.all(pairCtxs.map((c) => c.resume()));
  return voices ?? new Map();
}

export function suspendChoir(): void {
  for (const c of pairCtxs) void c.suspend();
}

export function quietChoir(): void {
  for (const v of voices?.values() ?? []) v.setVolume(0);
}

export function choirLatency(): number {
  return Math.max(0, ...pairCtxs.map((c) => (c.baseLatency ?? 0) + (c.outputLatency ?? 0)));
}

export function voiceBody(part: Part): BodyMix {
  return PART_BODIES[part];
}
