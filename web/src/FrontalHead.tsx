import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { Anatomy3D } from "../../vendor/chimera/src/ui/render/anatomy3d.ts";
import { Glow } from "../../vendor/chimera/src/ui/render/vector.ts";
import { engine } from "../../vendor/chimera/src/audio/AudioEngine.ts";
import { player } from "./voices.ts";
import type { TelemetryMessage } from "../../vendor/chimera/src/worklet/protocol.ts";
import { sameBody } from "../../vendor/chimera/src/ui/body.ts";
import type { BodyMix } from "../../vendor/chimera/src/wasm/types.ts";
import { useStore } from "../../vendor/chimera/src/ui/store.ts";
import { getModel } from "../../vendor/chimera/src/ui/useModel.ts";
import { VoiceModel } from "../../vendor/chimera/src/ui/analysis.ts";

export function FrontalHead({ audio = engine, body, thinking = false }: { audio?: { latest: TelemetryMessage | null }; body?: BodyMix; thinking?: boolean }) {
  const canvasRef=useRef<HTMLCanvasElement>(null);
  const storeBody=useStore((s)=>s.body),started=useStore((s)=>s.started);
  const model=useRef<VoiceModel|null>(null);
  model.current=getModel(body??storeBody,started?engine.sampleRate:48000);
  const thinkingRef=useRef(thinking);
  thinkingRef.current=thinking;
  const [failed,setFailed]=useState(false);
  useEffect(()=>{
    const canvas=canvasRef.current!,ctx=canvas.getContext("2d")!;
    const glCanvas=document.createElement("canvas");
    let gl:THREE.WebGLRenderer;
    try { gl=new THREE.WebGLRenderer({canvas:glCanvas,antialias:true,alpha:false,powerPreference:"high-performance"}); }
    catch { setFailed(true);return; }
    gl.outputColorSpace=THREE.LinearSRGBColorSpace;
    gl.setClearColor(0x000000,1);
    const head=new Anatomy3D(),glow=new Glow();
    head.centred=true;
    let posed:VoiceModel|null=null,pose:{home:THREE.Vector3;target:THREE.Vector3}|null=null,raf=0,last=performance.now(),idle=false,headH0=0;
    const view={azimuth:0,elevation:0,dragging:false,x:0,y:0};
    const move=(e:PointerEvent)=>{if(!view.dragging)return;view.azimuth+=(e.clientX-view.x)*0.01;view.elevation=Math.max(-0.6,Math.min(0.6,view.elevation+(e.clientY-view.y)*0.008));view.x=e.clientX;view.y=e.clientY};
    const up=()=>{view.dragging=false};
    const think={eye:0,tilt:0},motionMQ=matchMedia("(prefers-reduced-motion: reduce)");let reduced=motionMQ.matches;
    const fit=()=>{
      const {width,height}=canvas.getBoundingClientRect(),dpr=Math.min(2,window.devicePixelRatio||1);
      canvas.width=Math.max(1,Math.round(width*dpr));canvas.height=Math.max(1,Math.round(height*dpr));
      gl.setPixelRatio(dpr);gl.setSize(Math.max(1,width),Math.max(1,height),false);
      head.resize(Math.max(1,width),Math.max(1,height));posed=null;
    };
    const observer=new ResizeObserver(fit);observer.observe(canvas);fit();
    const frame=(now:number)=>{
      const elapsed=Math.min(.5,(now-last)/1000),dt=Math.min(.05,elapsed);last=now;
      reduced=motionMQ.matches;
      const want=thinkingRef.current&&!view.dragging?1:0,k=reduced?1:1-Math.exp(-elapsed*12);
      think.eye+=(want-think.eye)*k;
      const pc=player.ctx,pos=player.audiblePos(),sounding=!!(pc&&pc.state==="running"&&pos>=0&&pos<player.end());
      const wantTilt=want&&!sounding?1:0;
      think.tilt+=(wantTilt-think.tilt)*k;
      const m=model.current,st=useStore.getState();
      const tele=audio.latest&&sameBody(audio.latest.body,body??st.body)?audio.latest:null;
      if(!tele&&!view.dragging){idle=!idle;if(idle){raf=requestAnimationFrame(frame);return;}}
      else idle=false;
      if(m){
        if(posed!==m){
          pose=head.poses(m);posed=m;
          const hh=(head as unknown as {restFor(m:VoiceModel):{head:{y0:number;y1:number}}}).restFor(m).head;
          if(!headH0) headH0=hh.y1-hh.y0;
          pose.home.sub(pose.target).multiplyScalar((hh.y1-hh.y0)/headH0).add(pose.target);
        }
        if(pose){
          const distance=pose.home.distanceTo(pose.target);
          const ce=Math.cos(view.elevation);
          head.camera.position.copy(pose.target).add(new THREE.Vector3(distance*ce*Math.cos(view.azimuth),distance*Math.sin(view.elevation),distance*ce*Math.sin(view.azimuth)));
          head.camera.lookAt(pose.target);
        }
        const artic=tele?VoiceModel.articFromArray(tele.t.artic):st.artic;
        head.face.update(tele,elapsed);
        const tilt=think.tilt*(reduced?0.04:0.04*(1+0.2*Math.sin(now*0.0007)));
        head.face.tilt+=tilt;
        head.update(m,m.frame(artic),artic,tele,st.view,dt);
        head.face.tilt-=tilt;
        gl.render(head.scene,head.camera);
        ctx.setTransform(1,0,0,1,0,0);ctx.globalCompositeOperation="source-over";
        ctx.drawImage(glCanvas,0,0,canvas.width,canvas.height);
        glow.apply(canvas,ctx,Math.min(2,window.devicePixelRatio||1));
      }
      raf=requestAnimationFrame(frame);
    };
    raf=requestAnimationFrame(frame);
  },[model,audio,body]);
  return <div className="anatomy">{failed?<div role="alert">3D rendering is unavailable.</div>:null}<canvas ref={canvasRef} role="img" aria-label="Animated vocal-tract head"/></div>;
}
