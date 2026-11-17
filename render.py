
import base64
import gzip
import json
import math
import os
import re
import struct
import threading
import traceback
from pathlib import Path
from queue import Queue

import wasmtime

SR = 48000
SUB = 800
BLOCK = SUB * 8
TAIL = 0.25
LEAD = 0.03
REC = 272
MAX_SCHEDULE = 4000
MAX_PHRASE_SECONDS = 30.0
MAX_REQUEST_SECONDS = 180.0
TELE_HEADER = 16
PARTS = ("soprano", "alto", "tenor", "bass")
PART_BODIES = {"soprano": (1.0, 0.0), "alto": (1.0, 0.0), "tenor": (0.0, 0.0), "bass": (0.0, 0.0)}

CONTROL_KEYS = (
    "jaw", "tbX", "tbY", "ttX", "ttY", "ttCurl", "root", "lipAp", "lipProt", "lipWidth",
    "labiodental", "velum", "larynx", "epilarynx", "ventricular", "lateral", "dorsum",
    "abduction", "closure", "breath", "f0", "vibrato",
)
KEY_INDEX = {k: i for i, k in enumerate(CONTROL_KEYS)}
BODY_MIXES = {"male": {"female": 0.0, "child": 0.0}, "female": {"female": 1.0, "child": 0.0}, "child": {"female": 0.0, "child": 1.0}}


def body_mix(body):
    if isinstance(body, str):
        return dict(BODY_MIXES.get(body, BODY_MIXES["female"]))
    return {"female": float((body or {}).get("female", 0.0)), "child": float((body or {}).get("child", 0.0))}

_engine = wasmtime.Engine()
_module = None
_module_lock = threading.Lock()
_dict_text = None


def _find(*candidates):
    for p in candidates:
        if Path(p).exists():
            return Path(p)
    raise FileNotFoundError(candidates[0])


def module():
    global _module
    with _module_lock:
        if _module is None:
            root = Path(__file__).parent
            wasm = _find("/demo/web/dist/chimera.wasm", root / "web/public/chimera.wasm")
            _module = wasmtime.Module(_engine, wasm.read_bytes())
    return _module


def dictionary():
    global _dict_text
    if _dict_text is None:
        root = Path(__file__).parent
        path = _find("/demo/web/dist/data/cmudict.txt.gz", root / "web/public/data/cmudict.txt.gz")
        _dict_text = gzip.decompress(path.read_bytes()).decode()
    return _dict_text


threading.Thread(target=lambda: (module(), dictionary()), daemon=True).start()


def default_f0(body):
    f = min(1.0, max(0.0, body.get("female", 0.0)))
    c = min(1.0, max(0.0, body.get("child", 0.0)))
    w = ((1 - c) * (1 - f), (1 - c) * f, c)
    return math.exp(sum(wi * math.log(f0) for wi, f0 in zip(w, (110.0, 205.0, 260.0))))


def _tele_block(raw):
    n = (len(raw) - TELE_HEADER * 8) // 8
    return raw[: TELE_HEADER * 8] + struct.pack(
        f"<{n}f", *struct.unpack(f"<{n}d", raw[TELE_HEADER * 8 :])
    )


class Voice:

    def __init__(self, body):
        self.store = wasmtime.Store(_engine)
        inst = wasmtime.Instance(self.store, module(), [])
        self.ex = inst.exports(self.store)
        self.mem = self.ex["memory"]
        self.h = self.ex["engine_new"](self.store, float(SR))
        self.body = body_mix(body)
        self.ex["engine_set_body"](self.store, self.h, self.body["female"], self.body["child"])
        self.call("g2pLoad", {"text": dictionary()})

    def call(self, fn, args):
        b = json.dumps({"fn": fn, **args}).encode()
        p = self.ex["chimera_alloc"](self.store, len(b))
        self.mem.write(self.store, b, p)
        status = self.ex["chimera_call"](self.store, p, len(b))
        self.ex["chimera_free"](self.store, p, len(b))
        out = bytes(
            self.mem.read(
                self.store,
                self.ex["chimera_result_ptr"](self.store),
                self.ex["chimera_result_ptr"](self.store) + self.ex["chimera_result_len"](self.store),
            )
        )
        v = json.loads(out)
        if status != 0:
            raise ValueError(f"engine {fn}: {v.get('error')}")
        return v

    def schedule(self, gestures, lead):
        gestures = gestures[:MAX_SCHEDULE]
        buf = bytearray(len(gestures) * REC)
        for i, g in enumerate(gestures):
            o = i * REC
            head = (g.get("t0"), g.get("t1"), g.get("rampIn"), g.get("rampOut"),
                    g.get("strength"), g.get("speed"), g.get("releaseHold"), g.get("tag"))
            struct.pack_into("<8d", buf, o, *(x if x is not None else math.nan for x in head))
            struct.pack_into("<22d", buf, o + 64, *([math.nan] * 22))
            for k, v in (g.get("targets") or {}).items():
                if k in KEY_INDEX and v is not None:
                    struct.pack_into("<d", buf, o + 64 + 8 * KEY_INDEX[k], v)
        self.mem.write(self.store, bytes(buf), self.ex["engine_records"](self.store, self.h))
        return self.ex["engine_schedule"](self.store, self.h, len(gestures), lead, 1)

    def render(self, n=BLOCK):
        p = self.ex["engine_render"](self.store, self.h, n)
        return struct.unpack(f"<{n}f", bytes(self.mem.read(self.store, p, p + n * 4)))

    def clock(self):
        return self.ex["engine_clock"](self.store, self.h)

    def tele(self, telemetry_format="f64"):
        p = self.ex["engine_telemetry"](self.store, self.h)
        hdr = struct.unpack("<16d", bytes(self.mem.read(self.store, p, p + TELE_HEADER * 8)))
        total = TELE_HEADER + int(hdr[11]) + 3 * int(hdr[12] + hdr[13]) + 2 * int(hdr[14])
        block = bytes(self.mem.read(self.store, p, p + total * 8))
        lp = self.ex["engine_tele_labels"](self.store, self.h)
        labels = bytes(self.mem.read(self.store, lp, lp + 100))
        return {
            "block": base64.b64encode(_tele_block(block) if telemetry_format == "f32" else block).decode(),
            "labels": base64.b64encode(labels).decode(),
            "body": dict(self.body),
            "beatStep": self.ex["engine_beat_step"](self.store, self.h),
            "format": telemetry_format,
        }


def plan_speak(voice, args):
    phrases = [
        {"segments": voice.call("tokenizeIpa", {"text": approx_ipa(p)}), "intonation": args.get("intonation") or "statement", "pause": 0.3}
        for p in re.split(r"[|?!]+|\.(?=\s|$)", args["ipa"])
        if p.strip()
    ]
    if not phrases:
        raise ValueError("no phrases in ipa")
    options = {
        "body": voice.body, "t0": 0, "rate": args.get("rate") or 1,
        "f0": args.get("f0") or default_f0(voice.body),
        "accent": args.get("accent"), "sung": args.get("sung"),
    }
    plan = voice.call("planPhrases", {"phrases": phrases, "options": options})
    counts = [len(voice.call("planPhrases", {"phrases": [p], "options": options})["segments"]) for p in phrases]
    sentences = [s.strip() for s in re.findall(r"[^.!?\n]+[.!?]*", args.get("reply", "")) if s.strip()]
    segments = plan["segments"]
    lines = []
    if len(sentences) == len(phrases):
        offset = 0
        for text, count in zip(sentences, counts):
            lines.append({"at": segments[offset]["t0"], "text": text})
            offset += count
    else:
        lines.append({"at": segments[0]["t0"] if segments else 0, "text": args.get("reply", "")})
    return plan, lines


IPA_VOWELS = {
    "i", "y", "ɨ", "ʉ", "ɯ", "u", "ɪ", "ʏ", "ʊ", "e", "ø", "ɘ", "ɵ", "ɤ", "o",
    "ə", "ɛ", "œ", "ɜ", "ɞ", "ʌ", "ɔ", "æ", "ɐ", "a", "ɶ", "ɑ", "ɒ", "ɝ", "ɚ",
    "aɪ", "aʊ", "ɔɪ", "eɪ", "oʊ",
}
LYRIC_PUNCT = ".,;:!?…、。！？"
IPA_APPROX = [("ʍ", "w"), ("ɓ", "b"), ("ɗ", "d"), ("ʄ", "ɟ"), ("ɠ", "g"), ("ʛ", "ɢ"), ("ʘ", "p")]


def approx_ipa(text):
    for a, b in IPA_APPROX:
        text = text.replace(a, b)
    return text


def ipa_syllables_spaced(voice, ipa_text, lyric_text):
    segs = [s for s in voice.call("tokenizeIpa", {"text": approx_ipa(ipa_text)}) if s["ipa"] != "_"]
    vowels = [i for i, s in enumerate(segs) if s["ipa"] in IPA_VOWELS]
    if not vowels:
        return []
    if "~" in lyric_text:
        raise ValueError("phoneme-spaced IPA with melisma requires syllable-spaced IPA groups")
    text = re.sub(r"\s+", " ", lyric_text.replace("~", "")).strip()
    phrase_end = lyric_text.rstrip().endswith(tuple(LYRIC_PUNCT))
    syls = []
    for j, v in enumerate(vowels):
        onset = segs[:v] if j == 0 else segs[vowels[j - 1] + 1:v][-1:]
        coda = segs[v + 1:vowels[j + 1] - 1] if j + 1 < len(vowels) else segs[v + 1:]
        syls.append({"text": text if j == 0 else "~", "onset": onset, "nucleus": segs[v], "coda": coda,
                     "wordEnd": True, "phraseEnd": j == len(vowels) - 1 and phrase_end})
    return syls


def ipa_syllables(voice, ipa_text, lyric_text):
    words = [w for w in re.split(r"\s+", lyric_text.strip()) if w]
    toks = ipa_text.split()
    streams = [voice.call("tokenizeIpa", {"text": approx_ipa(tok)}) for tok in toks]
    if any(tok != "~" and not any(s["ipa"] in IPA_VOWELS for s in stream) for tok, stream in zip(toks, streams)):
        return ipa_syllables_spaced(voice, ipa_text, lyric_text)
    syls = []
    for i, stream in enumerate(streams):
        word = words[i] if i < len(words) else ""
        if word == "~" and syls:
            prev = syls[-1]
            syls.append({"text": "~", "onset": [], "nucleus": prev["nucleus"], "coda": [],
                         "melisma": True, "wordEnd": prev["wordEnd"], "phraseEnd": False})
            continue
        segs = stream
        vowels = [k for k, s in enumerate(segs) if s["ipa"] in IPA_VOWELS]
        if not vowels:
            continue
        phrase_end = word.endswith(tuple(LYRIC_PUNCT))
        text = word.rstrip(LYRIC_PUNCT).rstrip("~") or "~"
        parts = []
        start = 0
        for n, v in enumerate(vowels):
            end = len(segs)
            if n + 1 < len(vowels):
                between = vowels[n + 1] - v - 1
                end = vowels[n + 1] - (between - 1 if between >= 2 else 0)
            parts.append({"onset": segs[start:v], "nucleus": segs[v], "coda": segs[v + 1:end]})
            start = end
        for n, p in enumerate(parts):
            last = n == len(parts) - 1
            syls.append({"text": text if n == 0 else "~", "onset": p["onset"], "nucleus": p["nucleus"],
                         "coda": p["coda"], "wordEnd": last, "phraseEnd": phrase_end and last})
    return syls


def plan_sing(voice, lyrics, notes, bpm, vibrato, ipa=None):
    pairs = [n for n in notes if isinstance(n, list) and len(n) == 2]
    if not pairs:
        raise ValueError("no notes")
    syls = ipa_syllables(voice, ipa, lyrics) if ipa else voice.call("lyricsToSyllables", {"text": lyrics})
    if not syls:
        syls = [{"text": "mm", "onset": [], "nucleus": {"ipa": "m", "stress": 1}, "coda": [],
                 "wordEnd": True, "phraseEnd": i == len(pairs) - 1} for i in range(len(pairs))]
    octave = -12 if voice.body["female"] < 0.5 and voice.body["child"] < 0.5 else 0
    seq = [{"midi": pairs[i % len(pairs)][0] + octave, "beats": pairs[i % len(pairs)][1], "syl": s}
           for i, s in enumerate(syls)]
    plan = voice.call("planSong", {"notes": seq, "options": {"body": voice.body, "bpm": bpm or 90, "t0": 0.35, "vibrato": vibrato if vibrato is not None else 35}})
    text = re.sub(r"\s+", " ", lyrics.replace("~", "")).strip()
    return plan, [{"at": 0.35, "text": text}] if text else []


def _emit_audio(emit, n, block, gain):
    pcm = struct.pack(f"<{BLOCK}h", *(max(-32768, min(32767, int(x * gain * 32767))) for x in block))
    emit("audio", {"n": n, "sr": SR, "pcm": base64.b64encode(pcm).decode()})


def _render_voice(voice, plan, n, part, emit, stop=None, telemetry_format="f64"):
    off = voice.schedule(plan["gestures"], LEAD)
    end = off + plan["end"] + TAIL
    while voice.clock() < end:
        if stop is not None and stop.is_set():
            return
        block = []
        for i in range(BLOCK // SUB):
            block += voice.render(SUB)
            if i % 2 == 0:
                emit("tele", {"n": n, "part": part, **voice.tele(telemetry_format=telemetry_format)})
        yield block


class BudgetExceeded(ValueError):
    pass


def _plan_seconds(end):
    if not math.isfinite(end) or end < 0:
        raise ValueError(f"invalid plan end {end}")
    return math.ceil((end + LEAD + TAIL) * SR / BLOCK) * BLOCK / SR


def _solo(job, emit, stop=None, reserve=None, telemetry_format="f64"):
    voice = Voice(job["args"].get("body") or "female")
    plan, lines = plan_sing(voice, job["args"]["lyrics"], job["args"]["notes"], job["args"].get("bpm"), job["args"].get("vibrato"), job["args"].get("ipa")) \
        if job["name"] == "sing" else plan_speak(voice, job["args"])
    duration = _plan_seconds(plan["end"])
    if duration > MAX_PHRASE_SECONDS:
        raise BudgetExceeded(f"phrase duration {duration:.2f}s exceeds the {MAX_PHRASE_SECONDS:.0f}s limit")
    if reserve is not None:
        reserve(duration)
    emit("lines", {"n": job["n"], "lines": [{"at": l["at"] + LEAD, "text": l["text"]} for l in lines]})
    for block in _render_voice(voice, plan, job["n"], None, emit, stop, telemetry_format=telemetry_format):
        _emit_audio(emit, job["n"], block, 0.8)


def _choir(job, emit, stop=None, reserve=None, telemetry_format="f64"):
    args = job["args"]
    wanted = {p["part"]: p for p in args["parts"] if p.get("part") in PARTS}
    plans = {}
    voices = {}
    for part in PARTS:
        v = Voice({"female": PART_BODIES[part][0], "child": PART_BODIES[part][1]})
        plans[part], lines = plan_sing(v, wanted[part]["lyrics"], wanted[part]["notes"], args.get("bpm"), wanted[part].get("vibrato"), wanted[part].get("ipa"))
        if part == "soprano":
            emit("lines", {"n": job["n"], "lines": [{"at": l["at"] + LEAD, "text": l["text"]} for l in lines]})
        voices[part] = v
    duration = max(_plan_seconds(plans[p]["end"]) for p in PARTS)
    if duration > MAX_PHRASE_SECONDS:
        raise BudgetExceeded(f"phrase duration {duration:.2f}s exceeds the {MAX_PHRASE_SECONDS:.0f}s limit")
    if reserve is not None:
        reserve(duration)
    mix_q = Queue()

    def worker(part):
        try:
            for i, block in enumerate(_render_voice(voices[part], plans[part], job["n"], part, emit, stop, telemetry_format=telemetry_format)):
                mix_q.put((part, i, block))
            mix_q.put((part, -1, None))
        except Exception as e:
            mix_q.put((part, -1, e))

    for part in PARTS:
        threading.Thread(target=worker, args=(part,), daemon=True).start()

    bufs = {p: {} for p in PARTS}
    ended = set()
    seq = 0
    while True:
        while not all(p in ended or seq in bufs[p] for p in PARTS):
            part, i, blk = mix_q.get()
            if i < 0:
                ended.add(part)
                if blk is not None and isinstance(blk, Exception):
                    emit(
                        "error",
                        {
                            "n": job["n"],
                            "part": part,
                            "message": str(blk),
                            "_diagnostic": {"stage": "render", **error_context(blk)},
                        },
                    )
                continue
            bufs[part][i] = blk
        if all(p in ended for p in PARTS) and not any(bufs[p] for p in PARTS):
            return
        mix = [0.0] * BLOCK
        for p in PARTS:
            blk = bufs[p].pop(seq, None)
            if blk is not None:
                for j, x in enumerate(blk):
                    mix[j] += x * 0.5
        _emit_audio(emit, job["n"], mix, 0.5 * 0.8)
        seq += 1


def error_context(error):
    return {
        "error_type": type(error).__name__,
        "frames": [
            {
                "file": Path(frame.filename).name,
                "function": frame.name,
                "line": frame.lineno,
            }
            for frame in traceback.extract_tb(error.__traceback__)
        ],
    }


class Renderer:

    def __init__(self, emit, stop=None, telemetry_format="f64"):
        self.emit = emit
        self.stop = stop
        self.telemetry_format = telemetry_format
        self.jobs = Queue()
        self.remaining = MAX_REQUEST_SECONDS
        self.worker = threading.Thread(target=self._run, daemon=True)
        self.worker.start()

    def enqueue(self, n, name, args):
        self.jobs.put({"n": n, "name": name, "args": args})

    def finish(self):
        self.jobs.put(None)
        self.worker.join(timeout=300)

    def reserve(self, seconds):
        if seconds > self.remaining:
            raise BudgetExceeded(
                f"request audio budget exhausted: {seconds:.2f}s phrase exceeds "
                f"{self.remaining:.2f}s of {MAX_REQUEST_SECONDS:.0f}s remaining"
            )
        self.remaining -= seconds

    def _run(self):
        while True:
            job = self.jobs.get()
            if job is None:
                return
            if self.stop is not None and self.stop.is_set():
                return
            try:
                if job["name"] == "choir":
                    _choir(job, self.emit, self.stop, self.reserve, telemetry_format=self.telemetry_format)
                else:
                    _solo(job, self.emit, self.stop, self.reserve, telemetry_format=self.telemetry_format)
            except Exception as e:
                self.emit(
                    "error",
                    {
                        "n": job["n"],
                        "message": f"render: {type(e).__name__}: {e}",
                        "_diagnostic": {"stage": "render", **error_context(e)},
                    },
                )
                if isinstance(e, BudgetExceeded):
                    if self.stop is not None:
                        self.stop.set()
                    return
