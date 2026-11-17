import { useEffect, useRef, useState } from "react";
import { FrontalHead } from "./FrontalHead.tsx";
import { engine } from "../../vendor/chimera/src/audio/AudioEngine.ts";
import { ipaToPhrases, g2p } from "../../vendor/chimera/src/ui/speech.ts";
import { planPhrases, lyricsToSyllables, planSong } from "../../vendor/chimera/src/wasm/engine.ts";
import { useStore } from "../../vendor/chimera/src/ui/store.ts";
import { PRESETS, defaultF0, nearestBody } from "../../vendor/chimera/src/ui/body.ts";
import type { Gesture } from "../../vendor/chimera/src/wasm/types.ts";
import "./style.css";

export function App() {
  useEffect(()=>{void engine.start().catch(()=>{}); void g2p.load().catch(()=>{})},[]);
  const [text,setText] = useState("");
  const [error,setError] = useState("");
  const [reply,setReply] = useState("");
  const [busy,setBusy] = useState(false);
  const turn = useRef(0);
  const submit = async () => {
    const message=text.trim();
    if (!message || busy) return;
    const id=++turn.current;
    setBusy(true); setError(""); setReply(""); setText("");
    let received=false;
    let pendingReply="";
    let playback=Promise.resolve();
    try {
      await engine.start();
      const ctx=engine.ctx;
      if (ctx && ctx.state!=="running") {
        await ctx.resume();
        const silent=ctx.createBuffer(1,1,48000), src=ctx.createBufferSource();
        src.buffer=silent; src.connect(ctx.destination); src.start();
      }
      const response = await fetch("/api/say", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({text:message})});
      if (!response.ok) throw new Error(`Request failed (${response.status})`);
      if (!response.body) throw new Error("stream unavailable");
      const reader=response.body.getReader(), decoder=new TextDecoder(); let buffer=""; let kind="";
      const handle=(event:string,data:string) => {
        const value=JSON.parse(data);
        if(event==="reply") pendingReply=value.text;
        else if(event==="attempt") {
          if(received) throw new Error("Received more than one call");
          received=true;
          setReply(value.tool==="sing"?"":pendingReply);
          const body=value.body&&value.body in PRESETS?PRESETS[value.body as keyof typeof PRESETS]:useStore.getState().body;
          let plan;
          if(value.tool==="sing") {
            const syls=lyricsToSyllables(value.lyrics||"");
            if(!syls.length) throw new Error("No lyrics received");
            const pairs=((value.notes||[]) as unknown[]).filter((n)=>Array.isArray(n)&&n.length===2) as [number,number][];
            const n=Math.min(syls.length,pairs.length);
            if(!n) throw new Error("No melody received");
            const notes=pairs.slice(0,n)
              .map(([m,b],i)=>({midi:m+(nearestBody(body)==="male"?-12:0),beats:b,syl:syls[i]}));
            setReply(syls.slice(0,n).map(s=>s.text+(s.wordEnd?" ":"")).join(""));
            plan=planSong(notes,{body,bpm:value.bpm||90,t0:0.35,vibrato:value.vibrato??35});
          } else {
            if(typeof value.ipa!=="string" || !value.ipa.trim()) throw new Error("No transcription received");
            const phrases=ipaToPhrases(value.ipa);
            if(value.intonation) for(const p of phrases) p.intonation=value.intonation;
            plan=planPhrases(phrases,{body,t0:0,rate:value.rate??1,f0:value.f0??defaultF0(body),accent:value.accent,sung:value.sung});
          }
          engine.schedule({gestures:plan.gestures.map((g:Gesture)=>({...g,targets:{...g.targets}})),segments:plan.segments,end:plan.end});
          const end=plan.end;
          playback=(async()=>{await new Promise<void>(resolve=>setTimeout(resolve,end*1000+50));})().catch(()=>{});
          setTimeout(()=>{if(turn.current===id) setReply("")},end*1000+4000);
        } else if(event==="error") throw new Error(value.message);
      };
      while(true){ const chunk=await reader.read(); if(chunk.done) break; buffer+=decoder.decode(chunk.value,{stream:true}); const parts=buffer.split("\n\n"); buffer=parts.pop()||""; for(const part of parts){for(const line of part.split("\n")){if(line.startsWith("event:")) kind=line.slice(6).trim(); if(line.startsWith("data:")) handle(kind,line.slice(5).trim())}} }
      if(!received) throw new Error("No call received");
    } catch(error) {
      setError(error instanceof Error?error.message:"Request failed");
      setReply("");
    } finally { await playback; setBusy(false); }
  };
  return <main><header>
    <div className="head-meta">
      <a className="eyebrow" href="https://modal.com/library/moonshot/kimi-k3-1-pro" target="_blank" rel="noreferrer">Kimi K3.1 Pro</a>
      <span className="modal-line">Running on <a className="modal-link" href="https://modal.com" target="_blank" rel="noreferrer" aria-label="Modal"><img className="modal-logo" src="/modal-logo.png" alt="Modal"/></a></span>
    </div>
  </header>
    <div className="head-space"><section className="head"><FrontalHead/></section></div>
    <div className="reply" aria-live="polite">{reply?<em>{reply}</em>:null}</div>
    <section className="composer"><input aria-label="Message" value={text} onChange={e=>setText(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")void submit()}} placeholder="Talk to the head..."/><button onClick={()=>void submit()} disabled={busy}>{busy?"…":"Send"}</button></section>
    {error&&<div role="alert" className="speech-error">{error}</div>}
  </main>;
}
