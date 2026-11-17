import asyncio
import json
import logging
import math
import os
import threading
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
import jsonschema
import modal
import re

from render import Renderer, error_context

ROOT = Path(__file__).resolve().parent
MODEL = os.environ.get("CHIMERA_DEMO_MODEL", "kimi-k3-1-pro")
ENVIRONMENT = os.environ.get("CHIMERA_DEMO_ENV", "demos")

log = logging.getLogger("chimera")

SYSTEM = (
    "Reply naturally. Call speak once per sentence — each call's "
    "`reply` is that sentence's text and `ipa` its IPA phonetic transcription — spaces between words, "
    "optional \u02c8 primary and \u02cc secondary stress marks before syllables. English phonemes: "
    "vowels i \u026a e\u026a \u025b \u00e6 \u0259 \u025c \u028c u \u028a o\u028a \u0254 \u0251 a\u026a a\u028a \u0254\u026a \u025d, "
    "consonants p b t d k \u0261 m n \u014b f v \u03b8 \u00f0 s z \u0283 \u0292 h t\u0283 d\u0292 l \u0279 j w. "
    "Required controls: intonation (statement/question/flat), rate (0.5-1.8), f0 (Hz), "
    "accent (0-2, stress emphasis), sung, body (male/female/child); set them expressively. "
    "Call sing instead when the user asks for a song, singing or music, or when a sung reply "
    "lands better — once per phrase of lyrics (a breath-bounded line ending in , . ! ?), "
    "keeping bpm, body and vibrato consistent across calls: `lyrics` are the sung words "
    "(~ repeats a vowel onto the next note), `ipa` their IPA transcription as space-separated "
    "syllables aligned with the notes, in the same phoneme alphabet as speak — write it for "
    "every language (Korean, Chinese, etc. too), `bpm` the tempo, `notes` one "
    "[midi, beats] pair per syllable (midi 57-79 sings best), `body` the singer. "
    "When the user asks for harmony, a choir or multiple voices, keep calling choir for each "
    "phrase in sequence until the whole song is sung: `parts` must be exactly four entries "
    "— soprano, alto, tenor, bass — each with that phrase's lyrics and notes on the shared "
    "`bpm`, every part spanning the same beats so the voices "
    "reconverge at each boundary; write legato lines, breaths only where a phrase's text ends. "
    "Compact JSON. No feedback or retries. "
    "Keep each model turn to one short tool call. For sing and choir, use at most "
    "16 notes per part per call; split longer material into successive phrases. "
    "Do not repeat completed phrases. Stop when the user's requested content is complete."
)


def speak_tool():
    return {
        "type": "function",
        "function": {
            "name": "speak",
            "description": "Speak the given IPA phonetic transcription aloud through the CHIMERA vocal-tract synthesizer.",
            "parameters": {
                "type": "object",
                "additionalProperties": False,
                "required": [
                    "reply",
                    "ipa",
                    "intonation",
                    "rate",
                    "f0",
                    "accent",
                    "sung",
                    "body",
                ],
                "properties": {
                    "reply": {"type": "string", "minLength": 1, "maxLength": 200},
                    "ipa": {"type": "string", "minLength": 1, "maxLength": 400},
                    "intonation": {
                        "type": "string",
                        "enum": ["statement", "question", "flat"],
                    },
                    "rate": {"type": "number", "minimum": 0.5, "maximum": 1.8},
                    "f0": {"type": "number", "minimum": 60, "maximum": 400},
                    "accent": {"type": "number", "minimum": 0, "maximum": 2},
                    "sung": {"type": "boolean"},
                    "body": {"type": "string", "enum": ["male", "female", "child"]},
                },
            },
        },
    }


def sing_tool():
    return {
        "type": "function",
        "function": {
            "name": "sing",
            "description": "Sing the given lyrics as a composed melody through the CHIMERA vocal-tract synthesizer.",
            "parameters": {
                "type": "object",
                "additionalProperties": False,
                "required": ["reply", "lyrics", "ipa", "bpm", "notes", "body"],
                "properties": {
                    "reply": {"type": "string", "minLength": 1, "maxLength": 200},
                    "lyrics": {"type": "string", "minLength": 1, "maxLength": 300},
                    "ipa": {"type": "string", "minLength": 1, "maxLength": 600},
                    "bpm": {"type": "number", "minimum": 50, "maximum": 160},
                    "notes": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": MAX_NOTES_PER_PHRASE,
                        "description": "[midi, beats] pairs, one per syllable of lyrics",
                        "items": {
                            "type": "array",
                            "minItems": 2,
                            "maxItems": 2,
                            "items": {"type": "number"},
                        },
                    },
                    "body": {"type": "string", "enum": ["male", "female", "child"]},
                    "vibrato": {"type": "number", "minimum": 0, "maximum": 80},
                },
            },
        },
    }


def choir_tool():
    part = {
        "type": "object",
        "additionalProperties": False,
        "required": ["part", "lyrics", "ipa", "notes", "vibrato"],
        "properties": {
            "part": {"type": "string", "enum": ["soprano", "alto", "tenor", "bass"]},
            "lyrics": {"type": "string", "minLength": 1, "maxLength": 300},
            "ipa": {"type": "string", "minLength": 1, "maxLength": 600},
            "notes": {
                "type": "array",
                "minItems": 1,
                "maxItems": MAX_NOTES_PER_PHRASE,
                "description": "[midi, beats] pairs, one per syllable of lyrics",
                "items": {
                    "type": "array",
                    "minItems": 2,
                    "maxItems": 2,
                    "items": {"type": "number"},
                },
            },
            "vibrato": {"type": "number", "minimum": 0, "maximum": 80},
        },
    }
    return {
        "type": "function",
        "function": {
            "name": "choir",
            "description": "Sing a four-part harmony through four CHIMERA vocal-tract synthesizers at once: soprano, alto, tenor and bass, each composed on the shared tempo.",
            "parameters": {
                "type": "object",
                "additionalProperties": False,
                "required": ["reply", "bpm", "parts"],
                "properties": {
                    "reply": {"type": "string", "minLength": 1, "maxLength": 200},
                    "bpm": {"type": "number", "minimum": 50, "maximum": 160},
                    "parts": {
                        "type": "array",
                        "minItems": 4,
                        "maxItems": 4,
                        "items": part,
                    },
                },
            },
        },
    }


PARTS = {"soprano", "alto", "tenor", "bass"}


MAX_NOTES_PER_PHRASE = 16
MAX_HISTORY_MESSAGES = 24

TOOLS = [speak_tool(), sing_tool(), choir_tool()]

TOOL_SCHEMAS = {t["function"]["name"]: t["function"]["parameters"] for t in TOOLS}


_client = None
_endpoint = None
_endpoint_lock = None


async def shared_endpoint():
    global _endpoint
    if _endpoint is None:
        try:
            async with asyncio.timeout(STALL_S):
                async with _endpoint_lock:
                    if _endpoint is None:
                        headers = {
                            "Modal-Routing-Affinity-Key": "demo-" + uuid.uuid4().hex
                        }
                        response = await _client.get("models", headers=headers)
                        response.raise_for_status()
                        _endpoint = Endpoint(
                            _client, response.json()["data"][0]["id"], headers
                        )
        except (TimeoutError, httpx.TimeoutException) as error:
            raise StalledCompletion(
                f"model discovery timed out after {STALL_S:.0f}s"
            ) from error
    return _endpoint


def reset_shared_endpoint():
    global _endpoint
    _endpoint = None


class Endpoint:
    def __init__(self, client, model_id, headers):
        self.client = client
        self.model_id = model_id
        self.headers = headers


class StalledCompletion(Exception):
    pass


class ClientDisconnected(Exception):
    pass


STALL_S = 45.0
MAX_COMPLETION_TOKENS = 4096
SONGISH = re.compile(
    r"(?i)(sing|song|melody|music|tune|hymn|carol|anthem|lullaby|serenade|aria|"
    r"choir|chorus|harmony|opera|ballad|jingle|rap\b|노래|歌|うた|唱)"
)


async def stream_complete(
    endpoint,
    messages,
    tools=None,
    max_tokens=MAX_COMPLETION_TOKENS,
    reasoning="low",
    thinking=None,
    on_call=None,
    force=True,
    stop=None,
    on_state=None,
):
    payload = {
        "model": endpoint.model_id,
        "messages": messages,
        "temperature": 0.6,
        "reasoning_effort": reasoning,
        "stream": True,
        "stream_options": {"include_usage": True},
        "max_tokens": max_tokens,
    }
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "required" if force else "auto"
    if thinking is not None:
        payload["chat_template_kwargs"] = {"thinking": thinking, "enable_thinking": thinking}
    start = time.monotonic()
    first = visible = None
    content, calls, usage, finish = "", {}, {}, None
    emitted = set()
    last_activity = start
    task = asyncio.current_task()
    cancel_reason = None
    phase = "idle"

    def set_phase(state):
        nonlocal phase
        if state != phase:
            phase = state
            if on_state is not None:
                on_state(state)

    async def watch():
        nonlocal cancel_reason
        while True:
            await asyncio.sleep(0.05)
            if stop is not None and stop.is_set():
                cancel_reason = "stop"
            elif time.monotonic() - last_activity > STALL_S:
                cancel_reason = "stall"
            else:
                continue
            task.cancel()
            return

    watcher = asyncio.create_task(watch())
    try:
        async with endpoint.client.stream(
            "POST", "chat/completions", json=payload, headers=endpoint.headers
        ) as response:
            if response.is_error:
                await response.aread()
                response.raise_for_status()
            async for line in response.aiter_lines():
                if not line.startswith("data:"):
                    continue
                raw = line[5:].strip()
                if raw == "[DONE]":
                    break
                chunk = json.loads(raw)
                if chunk.get("error"):
                    raise ValueError(chunk["error"])
                usage = chunk.get("usage") or usage
                for choice in chunk.get("choices", []):
                    delta = choice.get("delta") or {}
                    finish = choice.get("finish_reason") or finish
                    output = delta.get("content") or delta.get("tool_calls")
                    reasoning_delta = (
                        delta.get("reasoning_content") or delta.get("reasoning")
                    )
                    if output or reasoning_delta:
                        last_activity = time.monotonic()
                        if first is None:
                            first = time.monotonic() - start
                    if output:
                        set_phase("responding")
                    elif reasoning_delta:
                        set_phase("thinking")
                    if visible is None and output:
                        visible = time.monotonic() - start
                    content += delta.get("content") or ""
                    for call in delta.get("tool_calls") or []:
                        item = calls.setdefault(
                            call["index"],
                            {"type": "function", "function": {"name": "", "arguments": ""}},
                        )
                        if call.get("id"):
                            item["id"] = call["id"]
                        function = call.get("function") or {}
                        item["function"]["name"] += function.get("name") or ""
                        item["function"]["arguments"] += function.get("arguments") or ""
                        if on_call and call["index"] not in emitted and item.get("id") and item["function"]["name"]:
                            try:
                                json.loads(item["function"]["arguments"])
                            except ValueError:
                                continue
                            emitted.add(call["index"])
                            on_call(
                                call["index"],
                                item["function"]["name"],
                                item["function"]["arguments"],
                                time.monotonic() - start,
                            )
    except asyncio.CancelledError:
        if cancel_reason == "stall":
            raise StalledCompletion(
                f"the model is overloaded — no output for {STALL_S:.0f}s; try again"
            ) from None
        if cancel_reason == "stop":
            raise ClientDisconnected()
        raise
    except httpx.TimeoutException as error:
        raise StalledCompletion(
            f"the model is overloaded — no output for {STALL_S:.0f}s; try again"
        ) from error
    finally:
        watcher.cancel()
        try:
            await watcher
        except asyncio.CancelledError:
            pass
        set_phase("idle")
    if stop is not None and stop.is_set():
        raise ClientDisconnected()
    metrics = {
        "ttft_s": first,
        "output_ttft_s": visible,
        "total_s": time.monotonic() - start,
        "completion_tokens": usage.get("completion_tokens"),
        "reasoning_tokens": usage.get(
            "reasoning_tokens",
            (usage.get("completion_tokens_details") or {}).get("reasoning_tokens"),
        ),
        "finish_reason": finish,
    }
    if finish not in ("stop", "tool_calls", "length"):
        raise ValueError(f"model completion ended abnormally: finish_reason={finish}")
    if finish == "length":
        calls = {
            index: item
            for index, item in calls.items()
            if (on_call is None or index in emitted) and _complete_call(item)
        }
    else:
        for index in sorted(calls):
            item = calls[index]
            function = item.get("function") or {}
            name = function.get("name") or ""
            if not name or not item.get("id"):
                raise ValueError("model returned an incomplete tool call")
            try:
                json.loads(function.get("arguments") or "")
            except ValueError as error:
                raise ValueError(
                    f"model returned malformed arguments for {name}"
                ) from error
    return {
        "choices": [
            {
                "message": {
                    "content": content,
                    "tool_calls": [calls[i] for i in sorted(calls)],
                }
            }
        ],
        "usage": usage,
    }, metrics


def _complete_call(item):
    function = item.get("function") or {}
    if not (function.get("name") or "") or not item.get("id"):
        return False
    try:
        json.loads(function.get("arguments") or "")
    except ValueError:
        return False
    return True


def validate(name, arguments):
    args = json.loads(arguments)
    json.dumps(args, allow_nan=False)
    try:
        jsonschema.validate(args, TOOL_SCHEMAS[name])
    except jsonschema.ValidationError as error:
        raise ValueError(error.message) from error
    if name == "choir" and {p["part"] for p in args["parts"]} != PARTS:
        raise ValueError("expected one part each of soprano, alto, tenor, bass")
    if name in ("sing", "choir"):
        note_lists = [args["notes"]] if name == "sing" else [p["notes"] for p in args["parts"]]
        for notes in note_lists:
            for midi, beats in notes:
                if not math.isfinite(midi) or not 0 <= midi <= 127 or not math.isfinite(beats) or beats <= 0:
                    raise ValueError("notes need MIDI in [0, 127] and positive beats")
    return args


async def conversation(messages, endpoint, emit, endpoint_setup_s=0, renderer=None, stop=None):
    start = time.monotonic()
    call_count = 0

    def on_call(index, name, arguments, model_s):
        nonlocal call_count
        args = validate(name, arguments)
        call_count += 1
        emit("attempt", {"n": call_count, "tool": name, "model_s": model_s, **args})
        if renderer is not None:
            renderer.enqueue(call_count, name, args)

    tools = TOOLS
    system = {
        "role": "system",
        "content": SYSTEM + " ".join(t["function"]["description"] for t in tools),
    }
    incoming = list(messages[:-1])
    current = messages[-1]
    groups = []
    content, all_calls = "", []
    ttft_s, output_ttft_s, total_s, tokens = None, None, 0.0, 0
    finish_reason = None
    songish = bool(messages and SONGISH.search(messages[-1].get("content") or ""))

    def trim_groups():
        used = 0
        keep = len(groups)
        for index in range(len(groups) - 1, -1, -1):
            size = len(groups[index])
            if index == len(groups) - 1 or used + size <= MAX_HISTORY_MESSAGES - 1:
                used += size
                keep = index
            else:
                break
        del groups[:keep]

    def window():
        used = sum(len(group) for group in groups)
        remaining = max(0, MAX_HISTORY_MESSAGES - 1 - used)
        selected = incoming[-remaining:] if remaining else []
        return [
            system,
            *selected,
            current,
            *[message for group in groups for message in group],
        ]

    def absorb(timing):
        nonlocal ttft_s, output_ttft_s, total_s, tokens
        offset = total_s
        if ttft_s is None and timing["ttft_s"] is not None:
            ttft_s = offset + timing["ttft_s"]
        if output_ttft_s is None and timing["output_ttft_s"] is not None:
            output_ttft_s = offset + timing["output_ttft_s"]
        total_s += timing["total_s"]
        tokens += timing["completion_tokens"] or 0

    for turn in range(16):
        response, timing = await stream_complete(
            endpoint,
            window(),
            tools,
            max_tokens=MAX_COMPLETION_TOKENS,
            thinking=songish or any(call["function"]["name"] in ("sing", "choir") for call in all_calls),
            on_call=on_call,
            on_state=lambda state: emit(
                "model_state", {"state": state, "turn": turn + 1}
            ),
            force=not all_calls,
            stop=stop,
        )
        absorb(timing)
        finish_reason = timing["finish_reason"]
        message = response["choices"][0]["message"]
        calls = message.get("tool_calls") or []
        if any(c["function"]["name"] not in TOOL_SCHEMAS for c in calls):
            raise ValueError("model must return speak or sing calls")
        if finish_reason == "length":
            emit(
                "model_limit",
                {
                    "_diagnostic": {
                        "stage": "model",
                        "turn": turn + 1,
                        "max_tokens": MAX_COMPLETION_TOKENS,
                        "emitted_calls": len(calls),
                        "finish_reason": finish_reason,
                        "completion_tokens": timing.get("completion_tokens"),
                        "reasoning_tokens": timing.get("reasoning_tokens"),
                    }
                },
            )
        content += message.get("content") or ""
        all_calls += calls
        if calls:
            group = [
                {
                    "role": "assistant",
                    "content": message.get("content"),
                    "tool_calls": calls,
                }
            ]
            for call in calls:
                name = call.get("function", {}).get("name")
                group.append({
                    "role": "tool",
                    "tool_call_id": call.get("id"),
                    "name": name,
                    "content": ("sung" if name in ("sing", "choir") else "spoken")
                    + " — go on with the next phrase, or finish when done",
                })
        elif finish_reason == "length":
            group = []
            if message.get("content"):
                group.append({"role": "assistant", "content": message.get("content")})
            group.append({
                "role": "user",
                "content": "Continue with one short unfinished phrase. Do not repeat completed phrases.",
            })
        elif all_calls:
            break
        else:
            group = [
                {"role": "assistant", "content": message.get("content")},
                {"role": "user", "content": "go on"},
            ]
        groups.append(group)
        trim_groups()
    else:
        raise ValueError("model did not finish within the 16-turn limit")
    if not all_calls:
        raise ValueError("model must return speak or sing calls")
    emit(
        "done",
        {
            "stop_reason": "completed",
            "timing": {
                "endpoint_setup_s": endpoint_setup_s,
                "reply_available_s": total_s,
                "calls": [
                    {
                        "phase": "reply_and_gestures",
                        "ttft_s": ttft_s,
                        "output_ttft_s": output_ttft_s,
                        "total_s": total_s,
                        "completion_tokens": tokens,
                        "finish_reason": finish_reason,
                    }
                ],
                "elapsed_s": time.monotonic() - start + endpoint_setup_s,
            },
        },
    )
    return {"content": content, "tool_calls": all_calls}


_LOG_STAGES = {"render_setup", "endpoint", "model", "render"}
_LOG_FINISH = {"stop", "length", "tool_calls", "content_filter", "function_call"}


def _is_count(value):
    return type(value) is int and value >= 0


async def event_stream(
    text, history, endpoint_factory, telemetry_format="f64", request_id=None
):
    events = asyncio.Queue()
    loop = asyncio.get_running_loop()
    messages = [{"role": m.role, "content": m.content} for m in history][
        -MAX_HISTORY_MESSAGES:
    ]
    messages.append({"role": "user", "content": text})
    started = threading.Event()
    stop = threading.Event()
    request_id = request_id or uuid.uuid4().hex
    request_start = time.monotonic()
    last_turn = None
    tools_by_n = {}

    def _log_event(level, event_name, diagnostic, data=None):
        record = {
            "event": event_name,
            "request_id": request_id,
            "elapsed_s": round(time.monotonic() - request_start, 3),
        }
        diag = diagnostic if isinstance(diagnostic, dict) else {}
        if diag.get("stage") in _LOG_STAGES:
            record["stage"] = diag["stage"]
        if isinstance(diag.get("error_type"), str):
            record["error_type"] = diag["error_type"]
        frames = diag.get("frames")
        if isinstance(frames, list):
            record["frames"] = frames
        turn = diag.get("turn")
        if not _is_count(turn):
            turn = last_turn
        if _is_count(turn):
            record["turn"] = turn
        for key in (
            "max_tokens",
            "emitted_calls",
            "completion_tokens",
            "reasoning_tokens",
        ):
            value = diag.get(key)
            if _is_count(value):
                record[key] = value
        if diag.get("finish_reason") in _LOG_FINISH:
            record["finish_reason"] = diag["finish_reason"]
        if data:
            n = data.get("n")
            if _is_count(n):
                record["n"] = n
                tool = tools_by_n.get(n)
                if tool is None:
                    tool = data.get("tool")
                if isinstance(tool, str) and tool in TOOL_SCHEMAS:
                    record["tool"] = tool
            if data.get("part") in PARTS:
                record["part"] = data["part"]
        getattr(log, level)(json.dumps(record, allow_nan=False))

    def emit(kind, data):
        nonlocal last_turn
        if kind == "model_limit":
            _log_event("warning", "model_limit", data.get("_diagnostic"))
            return
        if kind == "model_state":
            turn = data.get("turn")
            if _is_count(turn):
                last_turn = turn
        elif kind == "attempt":
            n = data.get("n")
            tool = data.get("tool")
            if _is_count(n) and isinstance(tool, str) and tool in TOOL_SCHEMAS:
                tools_by_n[n] = tool
        if kind != "model_state":
            started.set()
        payload = data
        if kind == "error":
            _log_event("error", "request_error", data.get("_diagnostic"), data)
            payload = {
                key: value for key, value in data.items() if key != "_diagnostic"
            }
            payload["request_id"] = request_id
        loop.call_soon_threadsafe(
            events.put_nowait,
            f"event: {kind}\ndata: {json.dumps(payload, allow_nan=False)}\n\n",
        )

    async def work():
        renderer = None
        stage = "render_setup"
        try:
            renderer = Renderer(emit, stop, telemetry_format=telemetry_format)
            for attempt in range(2):
                start = time.monotonic()
                try:
                    stage = "endpoint"
                    endpoint = await endpoint_factory()
                    stage = "model"
                    await conversation(
                        messages, endpoint, emit,
                        endpoint_setup_s=time.monotonic() - start,
                        renderer=renderer, stop=stop,
                    )
                    break
                except (StalledCompletion, httpx.HTTPError):
                    if attempt or started.is_set():
                        raise
                    reset_shared_endpoint()
        except ClientDisconnected:
            pass
        except Exception as error:
            detail = f"{type(error).__name__}: {error}"
            if isinstance(error, httpx.HTTPStatusError):
                detail += " response=" + error.response.text[:2000]
            if isinstance(error, StalledCompletion):
                detail = str(error)
            emit(
                "error",
                {
                    "message": detail,
                    "_diagnostic": {"stage": stage, **error_context(error)},
                },
            )
        finally:
            if renderer is not None:
                await asyncio.to_thread(renderer.finish)
            await asyncio.sleep(0)
            events.put_nowait(None)

    work_task = asyncio.create_task(work())
    try:
        while True:
            try:
                item = await asyncio.wait_for(events.get(), 15)
            except TimeoutError:
                yield ": keepalive\n\n"
                continue
            if item is None:
                return
            yield item
    finally:
        stop.set()
        work_task.cancel()
        try:
            await work_task
        except BaseException:
            pass


def create_web(endpoint_factory=None, static_dir=None):
    from typing import Literal

    from fastapi import FastAPI
    from fastapi.responses import StreamingResponse
    from fastapi.staticfiles import StaticFiles
    from pydantic import BaseModel, Field

    class Message(BaseModel):
        role: Literal["user", "assistant"]
        content: str = Field(min_length=1, max_length=2000)

    class Say(BaseModel):
        text: str = Field(min_length=1, max_length=500)
        history: list[Message] = Field(default=[], max_length=40)
        telemetry_format: Literal["f64", "f32"] = "f64"

    @asynccontextmanager
    async def lifespan(_app):
        global _client, _endpoint, _endpoint_lock
        if endpoint_factory is not None:
            yield
            return
        _client = httpx.AsyncClient(
            base_url=f"https://modal-labs-{ENVIRONMENT}--ep-{MODEL}-server.us-west.modal.direct/v1/",
            headers={
                "Modal-Key": os.environ["MODAL_PROXY_KEY"],
                "Modal-Secret": os.environ["MODAL_PROXY_SECRET"],
            },
            timeout=STALL_S,
        )
        _endpoint = None
        _endpoint_lock = asyncio.Lock()
        try:
            await shared_endpoint()
        except Exception:
            pass
        try:
            yield
        finally:
            await _client.aclose()
            _client = None
            _endpoint = None
            _endpoint_lock = None

    web = FastAPI(lifespan=lifespan)

    @web.post("/api/say")
    async def say(body: Say):
        request_id = uuid.uuid4().hex
        return StreamingResponse(
            event_stream(
                body.text,
                body.history,
                endpoint_factory or shared_endpoint,
                telemetry_format=body.telemetry_format,
                request_id=request_id,
            ),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "X-Accel-Buffering": "no",
                "X-Request-ID": request_id,
            },
        )

    if static_dir:
        web.mount("/", StaticFiles(directory=static_dir, html=True), name="static")
    return web


image = (
    modal.Image.debian_slim(python_version="3.13")
    .uv_sync(uv_project_dir=str(ROOT), extra_options="--no-dev")
    .workdir("/demo")
    .env({"CHIMERA_DEMO_MODEL": MODEL, "CHIMERA_DEMO_ENV": ENVIRONMENT})
)
if (ROOT / "web/dist").exists():
    image = image.add_local_dir(ROOT / "web/dist", "/demo/web/dist", copy=True)
image = image.add_local_file(ROOT / "render.py", "/demo/render.py", copy=True)


app = modal.App("chimera-demo")


@app.cls(image=image, secrets=[modal.Secret.from_name("chimera-demo-endpoints")], timeout=1800, min_containers=1, cpu=4.0)
@modal.concurrent(max_inputs=8)
class Server:
    @modal.asgi_app(requires_proxy_auth=False, custom_domains=["voice.modal.dev"])
    def serve(self):
        return create_web(static_dir=Path("/demo/web/dist"))
