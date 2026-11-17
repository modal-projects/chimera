import { useEffect, useRef, useState } from "react";
import { FrontalHead } from "./FrontalHead.tsx";
import { warmChoir, resumeChoir, suspendChoir, quietChoir, choirLatency, voiceBody, PARTS, type Part } from "./voices.ts";
import { engine } from "../../vendor/chimera/src/audio/AudioEngine.ts";
import { ipaToPhrases, g2p } from "../../vendor/chimera/src/ui/speech.ts";
import { wordSpans } from "../../vendor/chimera/src/ui/words.ts";
import { planPhrases, lyricsToSyllables, planSong } from "../../vendor/chimera/src/wasm/engine.ts";
import { useStore } from "../../vendor/chimera/src/ui/store.ts";
import { PRESETS, defaultF0, nearestBody, sameBody } from "../../vendor/chimera/src/ui/body.ts";
import type { Gesture } from "../../vendor/chimera/src/wasm/types.ts";
import "./style.css";


type VoiceEngine = import("./voices.ts").VoiceEngine;

function ChoirCell({part,voice,delay}:{part:Part;voice:VoiceEngine;delay:number}) {
  const [load,setLoad]=useState(0);
  useEffect(()=>voice.onTelemetry((t)=>setLoad(t.load)),[voice]);
  return <section className="head summon" style={{animationDelay:`${delay*90}ms`}}>
    <FrontalHead audio={voice} body={voiceBody(part)}/>
    <span className={`part-tag${voice.ctx?.state!=="running"?" silent":""}`}>{part}{load>0?` · ${Math.round(load*100)}%`:""}</span>
  </section>;
}

export function App() {
  useEffect(()=>{void engine.start().catch(()=>{}); void g2p.load().catch(()=>{})},[]);
  const [text,setText] = useState("");
  const [error,setError] = useState("");
  const [reply,setReply] = useState("");
  const [busy,setBusy] = useState(false);
  const [chorus,setChorus] = useState<[Part,VoiceEngine][]|null>(null);
  const turn = useRef(0);
  const submit = async () => {
    const message=text.trim();
    if (!message || busy) return;
    const id=++turn.current;
    setBusy(true); setError(""); setReply(""); setText("");
    let attempts=0;
    let queueEnd=0;
    let playback=Promise.resolve();
    let choirChain=Promise.resolve();
    let choirFrontier=0;
    let chorusLive=false;
    let songEnd=0;
    let replyTimer=0;
    let dismissTimer=0;
    try {
      const choirPending=warmChoir();
      choirPending.catch(()=>{});
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
        if(event==="attempt") {
          attempts++;
          let plan;
          const lines:{at:number;text:string}[]=[];
          if(value.tool==="choir") {
            const parts=(value.parts||[]) as {part:string;lyrics:string;notes:[number,number][];vibrato?:number}[];
            const wanted=parts.filter((p): p is typeof p&{part:Part}=>PARTS.includes(p.part as Part));
            if(wanted.length!==4) throw new Error(`Expected four voices, got ${wanted.length}`);
            const bpm=value.bpm||90;
            const spb=60/bpm;
            const plans=new Map<Part,{plan:ReturnType<typeof planSong>;syls:ReturnType<typeof lyricsToSyllables>}>();
            let end=0;
            for(const p of wanted){
              const syls=lyricsToSyllables(p.lyrics||"");
              if(!syls.length) throw new Error(`No lyrics for ${p.part}`);
              const pairs=(p.notes||[]).filter((n)=>Array.isArray(n)&&n.length===2);
              if(!pairs.length) throw new Error(`No melody for ${p.part}`);
              const body=voiceBody(p.part);
              const notes=syls.map((s,j)=>{const [m,b]=pairs[j%pairs.length]; return {midi:m+(nearestBody(body)==="male"?-12:0),beats:b,syl:s};});
              const plan=planSong(notes,{body,bpm,t0:0.35,vibrato:p.vibrato??35});
              end=Math.max(end,plan.end);
              plans.set(p.part,{plan,syls});
              if(p.part==="soprano") {
                let cur="",at=0.35;
                for(const [j,s] of syls.entries()){
                  if(!cur) lines.push({at,text:""});
                  cur+=s.text+(s.wordEnd?" ":"");
                  at+=notes[j].beats*spb;
                  if(s.phraseEnd||j===syls.length-1){ lines[lines.length-1].text=cur.trimEnd(); cur=""; }
                }
              }
            }
            choirChain=choirChain.then(async ()=>{
              const choir=await choirPending;
              if(!chorusLive){
                setChorus(PARTS.map((p)=>[p,choir.get(p)!] as [Part,VoiceEngine]));
                await resumeChoir();
                quietChoir();
                void engine.ctx?.suspend();
                for(const p of PARTS){
                  const voice=choir.get(p)!;
                  voice.setBody(voiceBody(p));
                  voice.setVolume(0.5);
                }
                chorusLive=true;
              }
              const clock=(p:Part)=>choir.get(p)!.voiceClock()??0;
              const latency=choirLatency();
              let captionLead=0.03;
              if(!choirFrontier){
                for(const [p,{plan}] of plans){
                  choir.get(p)!.schedule(plan);
                }
                choirFrontier=Math.max(...PARTS.map(clock))+0.03+end;
              } else {
                choirFrontier=Math.max(choirFrontier,Math.max(...PARTS.map(clock))+0.05);
                for(const [p,{plan}] of plans){
                  const voice=choir.get(p)!;
                  const lead=Math.max(0.03,choirFrontier-clock(p));
                  voice.scheduleGestures(plan.gestures,lead);
                  if(p==="soprano") captionLead=lead;
                }
                choirFrontier+=end;
              }
              for(const l of lines) setTimeout(()=>{if(turn.current===id) setReply(l.text)},(captionLead+l.at+latency)*1000);
              clearTimeout(replyTimer); clearTimeout(dismissTimer);
              replyTimer=window.setTimeout(()=>{if(turn.current===id) setReply("")},(captionLead+end+latency)*1000+4000);
              dismissTimer=window.setTimeout(()=>{if(turn.current===id){ suspendChoir(); void engine.ctx?.resume(); setChorus(null); chorusLive=false; }},(captionLead+end+latency)*1000+6000);
              songEnd=captionLead+end+latency;
            }).catch((e)=>{ if(turn.current===id) setError(e instanceof Error?e.message:"Choir failed"); });
            playback=choirChain.then(()=>new Promise<void>(resolve=>setTimeout(resolve,songEnd*1000+50)));
            return;
          }
          const body=value.body&&value.body in PRESETS?PRESETS[value.body as keyof typeof PRESETS]:useStore.getState().body;
          if(!sameBody(useStore.getState().body, body)) useStore.getState().setBody(body);
          if(value.tool==="sing") {
            const syls=lyricsToSyllables(value.lyrics||"");
            if(!syls.length) throw new Error("No lyrics received");
            const pairs=((value.notes||[]) as unknown[]).filter((n)=>Array.isArray(n)&&n.length===2) as [number,number][];
            if(!pairs.length) throw new Error("No melody received");
            const notes=syls
              .map((s,i)=>{const [m,b]=pairs[i%pairs.length]; return {midi:m+(nearestBody(body)==="male"?-12:0),beats:b,syl:s};});
            const spb=60/(value.bpm||90);
            let cur="",at=0.35;
            for(const [i,s] of syls.entries()){
              if(!cur) lines.push({at,text:""});
              cur+=s.text+(s.wordEnd?" ":"");
              at+=notes[i].beats*spb;
              if(s.phraseEnd||i===syls.length-1){ lines[lines.length-1].text=cur.trimEnd(); cur=""; }
            }
            plan=planSong(notes,{body,bpm:value.bpm||90,t0:0.35,vibrato:value.vibrato??35});
          } else {
            if(typeof value.ipa!=="string" || !value.ipa.trim()) throw new Error("No transcription received");
            const phrases=ipaToPhrases(value.ipa);
            if(value.intonation) for(const p of phrases) p.intonation=value.intonation;
            plan=planPhrases(phrases,{body,t0:0,rate:value.rate??1,f0:value.f0??defaultF0(body),accent:value.accent,sung:value.sung});
            const spans=wordSpans(phrases,plan);
            const sentences=((value.reply||"") as string).match(/[^.!?\n]+[.!?]*/g)?.map((s:string)=>s.trim()).filter(Boolean)||[];
            let wi=0;
            for(const s of sentences){
              lines.push({at:spans[Math.min(wi,spans.length-1)]?.t0??0,text:s});
              wi+=s.split(/\s+/).length;
            }
            if(!lines.length) lines.push({at:0,text:value.reply||""});
          }
          const gestures=plan.gestures.map((g:Gesture)=>({...g,targets:{...g.targets}}));
          const clock=engine.voiceClock()||0;
          queueEnd=Math.max(queueEnd,clock);
          const lead=Math.max(0.03,queueEnd-clock);
          if(attempts===1) engine.schedule({gestures,segments:plan.segments,end:plan.end});
          else engine.scheduleGestures(gestures,lead);
          queueEnd=clock+lead+plan.end;
          for(const l of lines) setTimeout(()=>{if(turn.current===id) setReply(l.text)},(lead+l.at)*1000);
          playback=(async()=>{await new Promise<void>(resolve=>setTimeout(resolve,(queueEnd-clock)*1000+50));})().catch(()=>{});
          setTimeout(()=>{if(turn.current===id) setReply("")},(queueEnd-clock)*1000+4000);
        } else if(event==="error") throw new Error(value.message);
      };
      while(true){ const chunk=await reader.read(); if(chunk.done) break; buffer+=decoder.decode(chunk.value,{stream:true}); const parts=buffer.split("\n\n"); buffer=parts.pop()||""; for(const part of parts){for(const line of part.split("\n")){if(line.startsWith("event:")) kind=line.slice(6).trim(); if(line.startsWith("data:")) handle(kind,line.slice(5).trim())}} }
      if(!attempts) throw new Error("No call received");
    } catch(error) {
      setError(error instanceof Error?error.message:"Request failed");
      setReply("");
      setText(t=>t||message);
    } finally { await playback; setBusy(false); }
  };
  return <main><header>
    <div className="head-meta">
      <a className="eyebrow" href="https://modal.com/library/moonshot/kimi-k3-1-pro" target="_blank" rel="noreferrer">Kimi K3.1 Pro</a>
      <span className="modal-line">on <a className="modal-link" href="https://modal.com" target="_blank" rel="noreferrer" aria-label="Modal"><img className="modal-logo" src="/modal-logo.png" alt="Modal"/></a></span>
    </div>
  </header>
    <div className={`head-space${chorus?" choir":""}`}>{chorus
      ? chorus.map(([part,voice],i)=><ChoirCell key={part} part={part} voice={voice} delay={i}/>
        )
      : <section className="head"><FrontalHead/></section>}</div>
    <div className="reply" aria-live="polite">{reply?<em>{reply}</em>:null}</div>
    <section className="composer"><input aria-label="Message" value={text} onChange={e=>setText(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")void submit()}} placeholder="Talk to the head..." maxLength={500} enterKeyHint="send"/><button onClick={()=>void submit()} disabled={busy}>{busy?"…":"Send"}</button></section>
    {error&&<div role="alert" className="speech-error">{error}</div>}
  </main>;
}
