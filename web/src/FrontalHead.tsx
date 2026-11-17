import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { Anatomy3D } from "../../vendor/chimera/src/ui/render/anatomy3d.ts";
import { Glow } from "../../vendor/chimera/src/ui/render/vector.ts";
import { engine } from "../../vendor/chimera/src/audio/AudioEngine.ts";
import { sameBody } from "../../vendor/chimera/src/ui/body.ts";
import { useStore } from "../../vendor/chimera/src/ui/store.ts";
import { useModel } from "../../vendor/chimera/src/ui/useModel.ts";
import { VoiceModel } from "../../vendor/chimera/src/ui/analysis.ts";

export function FrontalHead() {
  const canvasRef=useRef<HTMLCanvasElement>(null);
  const model=useModel();
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
    let posed:VoiceModel|null=null,pose:{home:THREE.Vector3;target:THREE.Vector3}|null=null,raf=0,last=performance.now();
    const view={azimuth:0,elevation:0,dragging:false,x:0,y:0};
    const down=(e:PointerEvent)=>{view.dragging=true;view.x=e.clientX;view.y=e.clientY;canvas.setPointerCapture(e.pointerId)};
    const move=(e:PointerEvent)=>{if(!view.dragging)return;view.azimuth+=(e.clientX-view.x)*0.01;view.elevation=Math.max(-0.6,Math.min(0.6,view.elevation+(e.clientY-view.y)*0.008));view.x=e.clientX;view.y=e.clientY};
    const up=()=>{view.dragging=false};
    canvas.addEventListener("pointerdown",down);canvas.addEventListener("pointermove",move);canvas.addEventListener("pointerup",up);canvas.addEventListener("pointercancel",up);
    const fit=()=>{
      const {width,height}=canvas.getBoundingClientRect(),dpr=Math.min(2,window.devicePixelRatio||1);
      canvas.width=Math.max(1,Math.round(width*dpr));canvas.height=Math.max(1,Math.round(height*dpr));
      gl.setPixelRatio(dpr);gl.setSize(Math.max(1,width),Math.max(1,height),false);
      head.resize(Math.max(1,width),Math.max(1,height));posed=null;
    };
    const observer=new ResizeObserver(fit);observer.observe(canvas);fit();
    const frame=(now:number)=>{
      const elapsed=Math.min(.5,(now-last)/1000),dt=Math.min(.05,elapsed);last=now;
      const m=model.current,st=useStore.getState();
      const tele=engine.latest&&sameBody(engine.latest.body,st.body)?engine.latest:null;
      if(m){
        if(posed!==m){pose=head.poses(m);posed=m;}
        if(pose){
          const distance=pose.home.distanceTo(pose.target);
          const ce=Math.cos(view.elevation);
          head.camera.position.copy(pose.target).add(new THREE.Vector3(distance*ce*Math.cos(view.azimuth),distance*Math.sin(view.elevation),distance*ce*Math.sin(view.azimuth)));
          head.camera.lookAt(pose.target);
        }
        const artic=tele?VoiceModel.articFromArray(tele.t.artic):st.artic;
        head.face.update(tele,elapsed);
        head.update(m,m.frame(artic),artic,tele,st.view,dt);
        gl.render(head.scene,head.camera);
        ctx.setTransform(1,0,0,1,0,0);ctx.globalCompositeOperation="source-over";
        ctx.drawImage(glCanvas,0,0,canvas.width,canvas.height);
        glow.apply(canvas,ctx,Math.min(2,window.devicePixelRatio||1));
      }
      raf=requestAnimationFrame(frame);
    };
    raf=requestAnimationFrame(frame);
    return()=>{cancelAnimationFrame(raf);observer.disconnect();canvas.removeEventListener("pointerdown",down);canvas.removeEventListener("pointermove",move);canvas.removeEventListener("pointerup",up);canvas.removeEventListener("pointercancel",up);head.dispose();gl.dispose()};
  },[model]);
  return <div className="anatomy">{failed?<div role="alert">3D rendering is unavailable.</div>:null}<canvas ref={canvasRef}/></div>;
}
