import { useRef, useState } from "react";
import { FrontalHead } from "./FrontalHead.tsx";
import { PARTS, voiceBody, StreamVoice, player, teleMsg, decodePcm, type Part } from "./voices.ts";
import { useStore } from "../../vendor/chimera/src/ui/store.ts";
import { PRESETS } from "../../vendor/chimera/src/ui/body.ts";
import type { BodyName } from "../../vendor/chimera/src/worklet/protocol.ts";
import "./style.css";

function ChoirCell({part,voice,delay,leaving,thinking}:{part:Part;voice:StreamVoice;delay:number;leaving:boolean;thinking:boolean}) {
  return <section className={`head summon${leaving?" dismiss":""}`} style={{animationDelay:`${delay*90}ms`}}>
    <FrontalHead audio={voice} body={voiceBody(part)} thinking={thinking}/>
    <span className={`part-tag${voice.ctx?.state!=="running"?" silent":""}`}>{part}</span>
  </section>;
}

export function App() {
  const [text,setText] = useState("");
  const [error,setError] = useState("");
  const [reply,setReply] = useState("");
  const [busy,setBusy] = useState(false);
  const [chorus,setChorus] = useState<[Part,StreamVoice][]|null>(null);
  const [dismissing,setDismissing] = useState(false);
  const [thinking,setThinking] = useState(false);
  const convo = useRef<{role:"user"|"assistant";content:string}[]>([]);
  const soloRef = useRef<StreamVoice|null>(null);
  const choirRef = useRef<Map<Part,StreamVoice>|null>(null);
  if(!soloRef.current){ soloRef.current=new StreamVoice(); soloRef.current.onTelemetry(msg=>useStore.getState().previewBody(msg.body)); choirRef.current=new Map(PARTS.map((p)=>[p,new StreamVoice()])); }
  const turn = useRef(0);
  const submit = async () => {
    const message=text.trim();
    if (!message || busy) return;
    const id=++turn.current;
    setBusy(true); setError(""); setReply(""); setText(""); setThinking(false); setDismissing(false);
    let pumping=false;
    const abort=new AbortController();
    let audioError:Error|null=null;
    try {
      player.reset();
      await player.start(err=>{audioError=err;abort.abort()});
      const solo=soloRef.current!; solo.ctx=player.ctx; solo.reset();
      const choirVoices=choirRef.current!;
      for(const v of choirVoices.values()){ v.ctx=player.ctx; v.reset(); }
      let chorusLive=chorus!==null;
      const voices=()=>chorusLive?[...choirVoices.values()]:[solo];
      const summonChorus=()=>{
        setDismissing(false);
        setChorus(PARTS.map((p)=>[p,choirVoices.get(p)!] as [Part,StreamVoice]));
        chorusLive=true;
      };
      const leaveChorus=()=>{ if(!chorusLive) return;
        chorusLive=false;
        setDismissing(true);
        window.setTimeout(()=>{if(turn.current===id&&!chorusLive){setChorus(null);setDismissing(false);}},650);
      };
      const nextChoirAt=()=>{ let m: number|null=null; for(const v of choirVoices.values()){ const a=v.nextAt; if(a!==null&&(m===null||a<m)) m=a; } return m; };
      const phraseStart=new Map<number,number>();
      const pendingLines=new Map<number,{at:number;text:string}[]>();
      const choirPhrases=new Set<number>();
      const lines:{at:number;text:string}[]=[];
      const replies:string[]=[];
      let replyTimer=0, dismissTimer=0;
      const response = await fetch("/api/say", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({text:message, history:convo.current, telemetry_format:"f32"}), signal:abort.signal});
      if (!response.ok) throw new Error(`Request failed (${response.status})`);
      if (!response.body) throw new Error("stream unavailable");
      const reader=response.body.getReader(), decoder=new TextDecoder(); let buffer=""; let kind="";
      pumping=true;
      const pumpFrame=()=>{
        const pos=player.audiblePos();
        if(pos<0) return;
        while(lines.length&&lines[0].at<=pos){
          const line=lines.shift()!;
          if(turn.current===id) setReply(line.text);
        }
        const due=pos+0.25, s=solo.nextAt, m=nextChoirAt();
        if(chorusLive&&s!==null&&(m===null||s<m)&&s<=due) leaveChorus();
        else if(!chorusLive&&m!==null&&(s===null||m<s)&&m<=due) summonChorus();
        for(const v of voices()) v.pump(pos);
      };
      (async()=>{ while(pumping){ await new Promise(r=>requestAnimationFrame(r)); if(!pumping) break; pumpFrame(); } })().catch(()=>{});
      const handle=(event:string,data:string) => {
        const value=JSON.parse(data);
        if(event==="attempt") {
          for(const s of [value.reply,value.lyrics]) if(typeof s==="string") replies.push(s);
          for(const p of (value.parts??[]) as {lyrics?:string}[]) if(typeof p.lyrics==="string") replies.push(p.lyrics);
          if(value.tool==="choir"){
            if(typeof value.n==="number") choirPhrases.add(value.n);
            if(!chorusLive&&solo.nextAt===null) summonChorus();
          } else if(value.body) useStore.getState().previewBody(PRESETS[value.body as BodyName]);
        } else if(event==="lines") {
          pendingLines.set(value.n as number,value.lines as {at:number;text:string}[]);
        } else if(event==="audio") {
          const n=value.n as number;
          const off=player.enqueue(n, decodePcm(value.pcm as string), value.sr as number, choirPhrases.has(n));
          if(!phraseStart.has(n)){
            phraseStart.set(n,off);
            for(const l of pendingLines.get(n)??[]) lines.push({at:off+l.at,text:l.text});
            pendingLines.delete(n);
          }
        } else if(event==="tele") {
          const v=value.part?choirVoices.get(value.part as Part):solo;
          const msg=teleMsg(value.block, value.labels, value.body, value.beatStep);
          v?.push(msg, player.offsetOf(value.n as number));
        } else if(event==="model_state") {
          if(turn.current===id) setThinking(value.state==="thinking");
        } else if(event==="error") throw new Error(value.message);
      };
      try {
        while(true){ const chunk=await reader.read(); if(chunk.done) break; buffer+=decoder.decode(chunk.value,{stream:true}); const parts=buffer.split("\n\n"); buffer=parts.pop()||""; for(const part of parts){for(const line of part.split("\n")){if(line.startsWith("event:")) kind=line.slice(6).trim(); if(line.startsWith("data:")) handle(kind,line.slice(5).trim())}} }
      } finally {
        await reader.cancel().catch(()=>{});
      }
      setThinking(false);
      if(!phraseStart.size) throw new Error("No call received");
      await player.finish();
      await player.audibleEnd();
      pumpFrame();
      convo.current.push({role:"user",content:message});
      if(replies.length) convo.current.push({role:"assistant",content:replies.join(" ").slice(0,2000)});
      convo.current.splice(0,Math.max(0,convo.current.length-24));
      clearTimeout(replyTimer); clearTimeout(dismissTimer);
      replyTimer=window.setTimeout(()=>{if(turn.current===id) setReply("")},4000);
      dismissTimer=window.setTimeout(()=>{if(turn.current===id){ player.suspend(); solo.reset(); leaveChorus(); }},6000);
    } catch(error) {
      pumping=false;
      player.reset();
      soloRef.current?.reset();
      for(const v of choirRef.current?.values()??[]) v.reset();
      player.suspend();
      setChorus(null); setDismissing(false);
      const failure=audioError??error;
      setError(failure instanceof Error?failure.message:"Request failed");
      setReply("");
      setText(t=>t||message);
    } finally { setThinking(false); pumping=false; setBusy(false); }
  };
  return <main><header>
    <div className="head-meta">
      <a className="eyebrow" href="https://modal.com/library/moonshot/kimi-k3-1-pro" target="_blank" rel="noreferrer">Kimi K3.1 Pro</a>
      <span className="modal-line">on <a className="modal-link" href="https://modal.com" target="_blank" rel="noreferrer" aria-label="Modal"><img className="modal-logo" src="/modal-logo.png" alt="Modal"/></a></span>
    </div>
  </header>
    <div className={`head-space${chorus?" choir":""}`}>{chorus
      ? chorus.map(([part,voice],i)=><ChoirCell key={part} part={part} voice={voice} delay={i} leaving={dismissing} thinking={thinking}/>
        )
      : <section className="head summon"><FrontalHead audio={soloRef.current??undefined} thinking={thinking}/></section>}</div>
    <div className="reply" aria-live="polite"><em>{reply||" "}</em></div>
    {error&&<div role="alert" className="speech-error">{error}</div>}
  </main>;
}
