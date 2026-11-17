class StreamPlayer extends AudioWorkletProcessor {
  constructor(options = {}) {
    super();
    this.buffered = !!options.processorOptions?.buffered;
    this.ring = new Float32Array(1 << 22);
    this.read = 0;
    this.write = 0;
    this.base = 0;
    this.ratio = 48000 / sampleRate;
    this.started = false;
    this.tick = 0;
    this.epoch = 0;
    this.ended = false;
    this.drained = false;
    this.playing = false;
    this.bufferTarget = 0.25 * 48000;
    this.port.onmessage = (e) => {
      const m = e.data;
      const { reset, pcm, end } = m;
      if (reset) {
        this.read = this.write = this.base = 0;
        this.started = false;
        if (this.buffered) {
          this.epoch = m.epoch;
          this.ended = this.drained = this.playing = false;
          this.bufferTarget = 0.25 * 48000;
        }
        return;
      }
      if (this.buffered && m.epoch !== this.epoch) return;
      if (pcm) {
        const need = this.write - this.read + pcm.length;
        if (need > this.ring.length) {
          let cap = this.ring.length;
          while (cap < need) cap <<= 1;
          const off = this.read | 0, ring = new Float32Array(cap);
          for (let i = off; i < this.write; i++) ring[i - off] = this.ring[i % this.ring.length];
          this.write -= off; this.read -= off; this.base += off; this.ring = ring;
        }
        for (let i = 0; i < pcm.length; i++) this.ring[this.write++ % this.ring.length] = pcm[i];
        if (this.buffered) this.bufferTarget = Math.max(this.bufferTarget, (m.bufferSeconds ?? 0.25) * 48000);
      }
      if (end && this.buffered) this.ended = true;
    };
  }

  postPos() {
    this.port.postMessage({ type: "pos", s: this.base + this.read, epoch: this.epoch, t: currentTime, playing: this.buffered ? this.playing : this.started && this.read < this.write });
  }

  processBuffered(out) {
    const avail = this.write - this.read;
    const was = this.playing;
    if (!this.playing && (avail >= this.bufferTarget || (this.ended && avail > 0))) this.playing = true;
    if (this.playing) {
      for (let i = 0; i < out.length; i++) {
        if (this.read >= this.write) { this.playing = false; out[i] = 0; continue; }
        const i0 = this.read | 0;
        const frac = this.read - i0;
        const a = this.ring[i0 % this.ring.length];
        const b = i0 + 1 < this.write ? this.ring[(i0 + 1) % this.ring.length] : a;
        out[i] = a + (b - a) * frac;
        this.read = Math.min(this.read + this.ratio, this.write);
      }
    } else {
      out.fill(0);
    }
    if (!this.drained && this.ended && this.read >= this.write) {
      this.drained = true;
      this.playing = false;
      this.port.postMessage({ type: "drained", epoch: this.epoch, s: this.base + this.read, t: currentTime, playing: false });
    }
    if (++this.tick % 16 === 0 || this.playing !== was) this.postPos();
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (this.buffered) { this.processBuffered(out); return true; }
    const avail = this.write - this.read;
    if (!this.started && avail > 0.25 * 48000) this.started = true;
    for (let i = 0; i < out.length; i++) {
      if (!this.started || this.read >= this.write) { out[i] = 0; continue; }
      const i0 = this.read | 0;
      const frac = this.read - i0;
      const a = this.ring[i0 % this.ring.length];
      const b = this.ring[(i0 + 1) % this.ring.length];
      out[i] = a + (b - a) * frac;
      this.read += this.ratio;
    }
    if (++this.tick % 16 === 0) this.postPos();
    return true;
  }
}
registerProcessor("stream-player", StreamPlayer);
