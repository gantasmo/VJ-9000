import React, { useEffect, useRef } from 'react';
import { VJState } from '../types';
import { AudioLevels } from '../useAudioAnalyzer';

interface VideoOutputProps {
  vjState: VJState;
  videoRef: React.RefObject<HTMLVideoElement>;
  getAudioLevels: () => AudioLevels;
}

export function VideoOutput({ vjState, videoRef, getAudioLevels }: VideoOutputProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const recordCanvasRef = useRef<HTMLCanvasElement>(null);
  
  const stateRef = useRef(vjState);
  useEffect(() => {
    stateRef.current = vjState;
  }, [vjState]);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);

  useEffect(() => {
    if (!recordCanvasRef.current) {
        recordCanvasRef.current = document.createElement('canvas');
    }
    
    if (vjState.recording) {
      if (!recordCanvasRef.current) return;
      
      const stream = recordCanvasRef.current.captureStream(30);
      
      // Attempt to mux audio tracks into the recording stream
      const videoEl = videoRef.current;
      if (videoEl) {
          try {
              if (videoEl.srcObject && videoEl.srcObject instanceof MediaStream) {
                  videoEl.srcObject.getAudioTracks().forEach(track => stream.addTrack(track));
              } else {
                 const anyVid = videoEl as any;
                 const capturedStream = anyVid.captureStream ? anyVid.captureStream() : anyVid.mozCaptureStream ? anyVid.mozCaptureStream() : null;
                 if (capturedStream) {
                     capturedStream.getAudioTracks().forEach((track: MediaStreamTrack) => stream.addTrack(track));
                 }
              }
          } catch(e) {
              console.warn("Could not capture audio stream from video", e);
          }
      }

      try {
        // webm is standard for most browsers
        const options = { mimeType: 'video/webm; codecs=vp9' };
        const recorder = new MediaRecorder(stream, options);
        mediaRecorderRef.current = recorder;
        recordedChunksRef.current = [];
        
        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) {
            recordedChunksRef.current.push(e.data);
          }
        };
        
        recorder.onstop = () => {
          const blob = new Blob(recordedChunksRef.current, { type: 'video/webm' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.style.display = 'none';
          a.href = url;
          a.download = `LUMINA_RECORDING_${new Date().getTime()}.webm`;
          document.body.appendChild(a);
          a.click();
          window.URL.revokeObjectURL(url);
          a.remove();
        };
        
        recorder.start();
      } catch (e) {
        console.error('MediaRecorder error', e);
      }
    } else {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
        mediaRecorderRef.current.stop();
      }
    }
  }, [vjState.recording]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;
    
    const ctx = canvas.getContext('2d', { alpha: false }); 
    if (!ctx) return;

    const offCanvas = document.createElement('canvas');
    const offCtx = offCanvas.getContext('2d', { alpha: false });
    
    // For Stereo 3D compositing
    const compostCanvas = document.createElement('canvas');
    const compostCtx = compostCanvas.getContext('2d', { alpha: false });
    
    // For Slit scan / Time displacement / Echo trails
    const slitCanvas = document.createElement('canvas');
    const slitCtx = slitCanvas.getContext('2d', { alpha: true });
    
    // Frame buffer for backskip and time displacement
    const bufferSize = 60;
    const frameBuffer: HTMLCanvasElement[] = [];
    for(let i=0; i<bufferSize; i++) {
        frameBuffer.push(document.createElement('canvas'));
    }
    let frameIndex = 0;

    let animationId: number;
    
    // --- AUTOPILOT Brain State ---
    let apTimer = 0;
    let apState = {
       hue: 0, sat: 150, contrast: 130, bright: 100, feedback: 0,
       kaleido: false, mirrorX: false, mirrorY: false, invert: false, edgeDetect: false,
       pixelate: 0, waveWarp: 0, rgbSplit: 0, glitch: 0,
       tiling: 1, equirect: false, stereoMode: 'none',
       chromaAb: 0, backskip: 0, softEdges: false,
       playbackSpeed: 1, reversePlayback: false, posterizeTime: 60, echoTrails: 0, slitScan: 0, timeDisplace: 0,
       dropCooldown: 0,
    };
    let apTargets = {
       hue: Math.random() * 360, sat: 150, contrast: 130, feedback: 0.5,
       pixelate: 0, waveWarp: 0, rgbSplit: 0, glitch: 0,
       chromaAb: 0, backskip: 0, 
       playbackSpeed: 1, posterizeTime: 60, echoTrails: 0, slitScan: 0, timeDisplace: 0,
    };
    
    let bassSmooth = 0;
    
    // Timecode Tracking
    let lastVideoUpdate = 0;
    let fallbackVideoUpdate = 0;

    const renderLoop = (timestamp: number) => {
      animationId = requestAnimationFrame(renderLoop);
      
      if (!video.videoWidth || video.readyState < 2) return;

      const s = stateRef.current;
      
      const container = canvas.parentElement;
      if (container && (canvas.width !== container.clientWidth || canvas.height !== container.clientHeight)) {
        canvas.width = container.clientWidth;
        canvas.height = container.clientHeight;
      }

      const w = canvas.width;
      const h = canvas.height;
      if (w === 0 || h === 0) return;

      // --- PARAMETER RESOLUTION ---
      let currentGlitch = s.glitch;
      let currentGhost = s.rgbGhost;
      let currentStrobe = s.strobe;
      let currentPixelate = s.pixelate;
      let currentWave = s.waveWarp;
      let currentSplit = s.rgbSplit;
      let currentChromaAb = s.chromaAb;
      let currentBackskip = s.backskip;
      let currentSoft = s.softEdges;
      
      let currentFeedback = s.feedback;
      let currentKaleido = s.kaleidoscope;
      let currentMirrorX = s.mirrorX;
      let currentMirrorY = s.mirrorY;
      let currentTiling = s.tiling;
      let currentEquirect = s.equirect;
      let currentStereo: 'none'|'sbs'|'tb' = s.stereoMode;
      
      let currentHue = s.hue;
      let currentSat = s.saturation;
      let currentContrast = s.contrast;
      let currentBright = s.brightness;
      let currentInvert = s.invert;
      let currentEdge = s.edgeDetect;
      
      let currentPlaybackSpeed = s.playbackSpeed;
      let currentReversePlayback = s.reversePlayback;
      let currentPosterizeTime = s.posterizeTime;
      let currentEchoTrails = s.echoTrails;
      let currentSlitScan = s.slitScan;
      let currentTimeDisplace = s.timeDisplace;
      
      let zoomScale = 1.0;
      let isAudioStrobe = false;
      
      const audio = getAudioLevels();
      const powBass = Math.pow(audio.bass, 3); 
      
      bassSmooth = bassSmooth * 0.9 + powBass * 0.1;
      
      if (s.autoPilot) {
         const { speed, chaos, geo, corrupt, color } = s.apConfig;
         
         const aw = (k: string) => s.apWeights && s.apWeights[k] !== undefined ? s.apWeights[k] : 1.0;
         
         apTimer += (1/60) * speed;
         if (apTimer > 6.0) { // Cycle length modifies via speed naturally
            apTimer = 0;
            apTargets.hue = Math.random() * 360;
            apTargets.sat = 70 + Math.random() * 230 * chaos;
            apTargets.contrast = 100 + Math.random() * 150 * chaos;
            apTargets.feedback = aw('feedback') > 0 && Math.random() > (1 - 0.7*chaos*aw('feedback')) ? Math.random() * 0.95 : 0;
            apTargets.pixelate = aw('pixelate') > 0 && Math.random() > (1 - 0.5*chaos*aw('pixelate')) ? Math.random() * 0.25 * chaos : 0;
            apTargets.waveWarp = aw('waveWarp') > 0 && Math.random() > (1 - 0.6*chaos*aw('waveWarp')) ? Math.random() * 0.4 * chaos : 0;
            apTargets.rgbSplit = aw('rgbSplit') > 0 && Math.random() > (1 - 0.6*chaos*aw('rgbSplit')) ? Math.random() * 0.6 * chaos : 0;
            apTargets.glitch = aw('glitch') > 0 && Math.random() > (1 - 0.4*chaos*aw('glitch')) ? Math.random() * 0.4 : 0;
            
            apTargets.chromaAb = aw('chromaAb') > 0 && Math.random() > (1 - 0.6*chaos*aw('chromaAb')) ? Math.random() * 1.5 * chaos : 0;
            apTargets.backskip = aw('backskip') > 0 && Math.random() > (1 - 0.4*chaos*aw('backskip')) ? Math.random() * 0.8 * chaos : 0;
            
            apTargets.playbackSpeed = aw('playbackSpeed') > 0 && Math.random() > (1 - 0.4*chaos*aw('playbackSpeed')) ? 0.2 + Math.random() * 1.8 : 1;
            apState.reversePlayback = aw('reversePlayback') > 0 && Math.random() > (1 - 0.3*chaos*aw('reversePlayback'));
            apTargets.posterizeTime = aw('posterizeTime') > 0 && Math.random() > (1 - 0.5*chaos*aw('posterizeTime')) ? Math.floor(4 + Math.random() * 26) : 60;
            apTargets.echoTrails = aw('echoTrails') > 0 && Math.random() > (1 - 0.6*chaos*aw('echoTrails')) ? Math.random() * 25 * chaos : 0;
            apTargets.slitScan = aw('slitScan') > 0 && Math.random() > (1 - 0.5*chaos*aw('slitScan')) ? Math.random() * 0.6 * chaos : 0;
            apTargets.timeDisplace = aw('timeDisplace') > 0 && Math.random() > (1 - 0.5*chaos*aw('timeDisplace')) ? Math.random() * 0.6 * chaos : 0;
            apState.softEdges = aw('softEdges') > 0 && Math.random() > 1.0 - (0.5 * aw('softEdges'));
            
            apState.kaleido = aw('kaleido') > 0 && Math.random() > (1 - 0.7*chaos*aw('kaleido'));
            apState.mirrorX = aw('mirrorX') > 0 && Math.random() > 1.0 - (0.6 * aw('mirrorX'));
            apState.mirrorY = aw('mirrorY') > 0 && Math.random() > 1.0 - (0.4 * aw('mirrorY'));
            apState.edgeDetect = aw('edgeDetect') > 0 && Math.random() > (1 - 0.4*chaos*aw('edgeDetect'));
            apState.equirect = aw('equirect') > 0 && Math.random() > (1 - 0.4*chaos*aw('equirect'));
            
            apState.stereoMode = aw('stereoMode') > 0 && Math.random() > (1 - 0.2*chaos*aw('stereoMode')) ? (Math.random() > 0.5 ? 'sbs' : 'tb') : 'none';
            apState.tiling = aw('tiling') > 0 && Math.random() > (1 - 0.5*chaos*aw('tiling')) ? Math.floor(1 + Math.random() * 4 * chaos) : 1;
         }
         
         // Smooth Interpolation
         apState.hue += (apTargets.hue - apState.hue) * 0.05 * speed;
         apState.sat += (apTargets.sat - apState.sat) * 0.05 * speed;
         apState.contrast += (apTargets.contrast - apState.contrast) * 0.05 * speed;
         apState.feedback += (apTargets.feedback - apState.feedback) * 0.05 * speed;
         apState.pixelate += (apTargets.pixelate - apState.pixelate) * 0.05 * speed;
         apState.waveWarp += (apTargets.waveWarp - apState.waveWarp) * 0.05 * speed;
         apState.rgbSplit += (apTargets.rgbSplit - apState.rgbSplit) * 0.05 * speed;
         apState.glitch += (apTargets.glitch - apState.glitch) * 0.1 * speed;
         
         apState.chromaAb += (apTargets.chromaAb - apState.chromaAb) * 0.05 * speed;
         apState.backskip += (apTargets.backskip - apState.backskip) * 0.1 * speed;
         apState.playbackSpeed += (apTargets.playbackSpeed - apState.playbackSpeed) * 0.05 * speed;
         apState.posterizeTime += (apTargets.posterizeTime - apState.posterizeTime) * 0.1 * speed;
         apState.echoTrails += (apTargets.echoTrails - apState.echoTrails) * 0.05 * speed;
         apState.slitScan += (apTargets.slitScan - apState.slitScan) * 0.05 * speed;
         apState.timeDisplace += (apTargets.timeDisplace - apState.timeDisplace) * 0.1 * speed;
         
         // Drop Detection
         let autoPilotDrop = false;
         if (powBass > 0.6 && powBass > bassSmooth * 2.5 && apState.dropCooldown <= 0) {
             autoPilotDrop = true;
             apState.dropCooldown = 1.5;
         }
         if (apState.dropCooldown > 0) apState.dropCooldown -= 1/60;
         
         if (autoPilotDrop) {
            apState.invert = !apState.invert;
            apState.feedback = 0.95; 
            apTargets.feedback = 0;  // rapid drain
            if (Math.random() > 0.5) apState.kaleido = !apState.kaleido;
            if (Math.random() > 0.5) apState.edgeDetect = !apState.edgeDetect;
            if (Math.random() > 0.7) apState.tiling = Math.floor(1 + Math.random() * 4);
            currentStrobe = 1.0;     
            
            apState.waveWarp = 1.0 * chaos; 
            apTargets.waveWarp = 0;
            apState.rgbSplit = 0.8 * chaos;
            apTargets.rgbSplit = 0;
            apState.glitch = 0.8 * chaos;
            apTargets.glitch = 0;
            
            apState.chromaAb = 1.2 * chaos;
            apTargets.chromaAb = 0;
            apState.backskip = 0.9 * chaos;
            apTargets.backskip = 0;
            apState.playbackSpeed = 2.5 * chaos;
            apTargets.playbackSpeed = 1;
            apState.posterizeTime = Math.max(1, 15 - Math.floor(10 * chaos));
            apTargets.posterizeTime = 60;
            apState.reversePlayback = true;
            apState.slitScan = 0.5 * chaos;
            apTargets.slitScan = 0;
            apState.timeDisplace = 0.6 * chaos;
            apTargets.timeDisplace = 0;
            apState.echoTrails = 15 * chaos;
            apTargets.echoTrails = 0;
         }
         
         // Helper to check if autopilot is allowed to control this param
         const am = (key: string) => aw(key) > 0;

         // Apply over user state conditionally
         if (color) {
             if (am('hue')) currentHue = apState.hue;
             if (am('sat')) currentSat = apState.sat;
             if (am('contrast')) currentContrast = apState.contrast;
             if (am('invert')) currentInvert = apState.invert;
             if (am('edgeDetect')) currentEdge = apState.edgeDetect;
         }
         if (geo) {
             if (am('feedback')) currentFeedback = apState.feedback; // counts as geometric time-mapping
             if (am('kaleido')) currentKaleido = apState.kaleido;
             if (am('mirrorX')) currentMirrorX = apState.mirrorX;
             if (am('mirrorY')) currentMirrorY = apState.mirrorY;
             if (am('tiling')) currentTiling = apState.tiling;
             if (am('equirect')) currentEquirect = apState.equirect;
             if (am('stereoMode')) currentStereo = apState.stereoMode as 'none'|'sbs'|'tb';
         }
         if (corrupt) {
             if (am('pixelate')) currentPixelate = Math.max(currentPixelate, apState.pixelate);
             if (am('waveWarp')) currentWave = Math.max(currentWave, apState.waveWarp);
             if (am('rgbSplit')) currentSplit = Math.max(currentSplit, apState.rgbSplit);
             if (am('glitch')) currentGlitch = Math.max(currentGlitch, apState.glitch);
             if (am('chromaAb')) currentChromaAb = Math.max(currentChromaAb, apState.chromaAb);
             if (am('backskip')) currentBackskip = Math.max(currentBackskip, apState.backskip);
             
             if (am('playbackSpeed')) currentPlaybackSpeed *= apState.playbackSpeed;
             if (am('reversePlayback')) currentReversePlayback = currentReversePlayback !== apState.reversePlayback;

             if (am('posterizeTime')) currentPosterizeTime = Math.min(currentPosterizeTime, apState.posterizeTime); // Lower is more intense
             if (am('echoTrails')) currentEchoTrails = Math.max(currentEchoTrails, apState.echoTrails);
             if (am('slitScan')) currentSlitScan = Math.max(currentSlitScan, apState.slitScan);
             if (am('timeDisplace')) currentTimeDisplace = Math.max(currentTimeDisplace, apState.timeDisplace);
             if (am('softEdges')) currentSoft = currentSoft || apState.softEdges;
         }
      }

      if (s.audioReactive) {
         currentGlitch = Math.max(currentGlitch, powBass * 0.9);
         currentGhost = Math.max(currentGhost, powBass * 0.7);
         currentSplit = Math.max(currentSplit, powBass * 0.5);
         currentWave = Math.max(currentWave, powBass * 0.4);
         
         zoomScale = 1.0 + (powBass * 0.25);
         
         if (s.strobe > 0 && powBass > 0.5) {
             isAudioStrobe = true;
         }
         if (currentBackskip > 0 && powBass > 0.8) {
             currentBackskip = Math.max(currentBackskip, 0.8);
         }
      }

      if (s.autoLFO) {
         const now = Date.now() / 1000;
         const bps = s.bpm / 60;
         const phase = (now * bps) % 1.0;
         const decay = Math.max(0, 1.0 - (phase * 4)); 
         
         currentGlitch = Math.max(currentGlitch, decay * 0.85);
         currentGhost = Math.max(currentGhost, decay * 0.95);
      }

      // --- TIMECODE & FRAME BUFFER ---
      currentPlaybackSpeed = Math.max(0.1, Math.min(10.0, currentPlaybackSpeed));
      if (video.playbackRate !== currentPlaybackSpeed) {
          video.playbackRate = currentPlaybackSpeed;
      }
      
      if (currentReversePlayback && currentPlaybackSpeed > 0 && timestamp - fallbackVideoUpdate > 20) {
          try {
             video.currentTime = Math.max(0, video.currentTime - ((timestamp - fallbackVideoUpdate)/1000) * currentPlaybackSpeed * 2);
          } catch(e){}
          fallbackVideoUpdate = timestamp;
      } else if (!currentReversePlayback) {
          fallbackVideoUpdate = timestamp;
      }

      let shouldSampleFrame = true;
      if (currentPosterizeTime < 60) {
          const fpsInterval = 1000 / currentPosterizeTime;
          if (timestamp - lastVideoUpdate < fpsInterval) {
              shouldSampleFrame = false;
          } else {
              lastVideoUpdate = timestamp;
          }
      }

      if (shouldSampleFrame) {
         const fCtx = frameBuffer[frameIndex].getContext('2d', { alpha: false });
         if (frameBuffer[frameIndex].width !== video.videoWidth || frameBuffer[frameIndex].height !== video.videoHeight) {
            frameBuffer[frameIndex].width = video.videoWidth;
            frameBuffer[frameIndex].height = video.videoHeight;
         }
         if (fCtx) fCtx.drawImage(video, 0, 0, video.videoWidth, video.videoHeight);
         frameIndex = (frameIndex + 1) % bufferSize;
      }
      
      const headIndex = (frameIndex - 1 + bufferSize) % bufferSize;

      let sourceVideo: CanvasImageSource = shouldSampleFrame ? video : frameBuffer[headIndex] || video;
      let vidW = video.videoWidth;
      let vidH = video.videoHeight;
      
      if (currentBackskip > 0) {
         let backFrames = Math.floor(currentBackskip * (bufferSize - 1));
         let targetIndex = (headIndex - backFrames + bufferSize) % bufferSize;
         sourceVideo = frameBuffer[targetIndex] || video;
      }
      
      // Time-domain Composite Pass (Slit-scan, Echo, Displace)
      if (currentSlitScan > 0 || currentEchoTrails > 0 || currentTimeDisplace > 0) {
         slitCanvas.width = vidW;
         slitCanvas.height = vidH;
         if (slitCtx && vidH > 0) {
            slitCtx.clearRect(0, 0, vidW, vidH);

            if (currentEchoTrails > 0) {
                const echoCount = Math.floor(currentEchoTrails);
                slitCtx.globalAlpha = 1.0 / (echoCount + 1);
                slitCtx.drawImage(sourceVideo, 0, 0, vidW, vidH);
                for (let i = 1; i <= echoCount; i++) {
                    const tIndex = (headIndex - i + bufferSize) % bufferSize;
                    const srcFrame = frameBuffer[tIndex] || video;
                    slitCtx.drawImage(srcFrame, 0, 0, vidW, vidH);
                }
                slitCtx.globalAlpha = 1.0;
                sourceVideo = slitCanvas;
            }

            if (currentSlitScan > 0) {
                const slitDepth = Math.max(2, Math.floor(currentSlitScan * (bufferSize - 1)));
                const rowHeight = Math.max(1, Math.floor(vidH / slitDepth));
                slitCtx.globalAlpha = 1.0;
                for (let i = 0; i < slitDepth; i++) {
                    const tIndex = (headIndex - i + bufferSize) % bufferSize;
                    const srcFrame = frameBuffer[tIndex] || video;
                    const sy = i * rowHeight;
                    if (sy < vidH) {
                        slitCtx.drawImage(srcFrame, 0, sy, vidW, rowHeight, 0, sy, vidW, rowHeight);
                    }
                }
                sourceVideo = slitCanvas;
            }

            if (currentTimeDisplace > 0) {
                // Time displacement based on vertical position 
                // Alternatively, we displace random horizontal bands based on back-history. 
                // A true time displacement map needs luma analysis, which is too slow for 2D canvas in 60fps.
                // We'll mimic it by interleaving rows from different deep times.
                const zones = 50;
                const rowHeight = Math.max(1, vidH / zones);
                slitCtx.globalAlpha = 1.0;
                for (let i = 0; i < zones; i++) {
                    const displaceAmount = Math.sin(i * 0.5 + Date.now()/1000) * 0.5 + 0.5; // 0 to 1
                    const tOffset = Math.floor(displaceAmount * currentTimeDisplace * (bufferSize - 1));
                    const tIndex = (headIndex - tOffset + bufferSize) % bufferSize;
                    const srcFrame = frameBuffer[tIndex] || video;
                    const sy = i * rowHeight;
                    if (sy < vidH) {
                        slitCtx.drawImage(srcFrame, 0, sy, vidW, rowHeight, 0, sy, vidW, rowHeight);
                    }
                }
                sourceVideo = slitCanvas;
            }
         }
      }

      if (currentPixelate > 0) {
          const scaleFactor = 1.0 - (currentPixelate * 0.96); // 1.0 down to 0.04
          offCanvas.width = Math.max(4, Math.floor(vidW * scaleFactor));
          offCanvas.height = Math.max(4, Math.floor(vidH * scaleFactor));
          if (offCtx) offCtx.drawImage(sourceVideo, 0, 0, offCanvas.width, offCanvas.height);
          sourceVideo = offCanvas;
          vidW = offCanvas.width;
          vidH = offCanvas.height;
          ctx.imageSmoothingEnabled = false;
      } else {
          ctx.imageSmoothingEnabled = true;
      }

      const drawVideoCover = (x: number, y: number, tw: number, th: number) => {
         const imgRatio = vidW / vidH;
         const cRatio = tw / th;
         let dw = tw; let dh = th; let dx = x; let dy = y;
         if (imgRatio > cRatio) {
            dh = th; dw = vidW * (th / vidH); dx = x + (tw - dw) / 2;
         } else {
            dw = tw; dh = vidH * (tw / vidW); dy = y + (th - dh) / 2;
         }
         
         if (currentEquirect) {
            const slivers = 32;
            const slW_src = vidW / slivers;
            const slW_dst = dw / slivers;
            for (let i = 0; i < slivers; i++) {
                const px = (i / (slivers - 1)) * 2 - 1;
                const squeeze = Math.cos(px * Math.PI / 2.2); 
                const projectedH = dh * squeeze;
                const offsetY = dy + (dh - projectedH) / 2;
                ctx.drawImage(sourceVideo, i * slW_src, 0, slW_src, vidH, dx + i * slW_dst, offsetY, slW_dst, projectedH);
            }
         } else {
            ctx.drawImage(sourceVideo, dx, dy, dw, dh);
         }
         
         if (currentSoft) {
            const maskGradX = ctx.createLinearGradient(x, 0, x + tw, 0);
            maskGradX.addColorStop(0, 'rgba(0,0,0,1)');
            maskGradX.addColorStop(0.15, 'rgba(0,0,0,0)');
            maskGradX.addColorStop(0.85, 'rgba(0,0,0,0)');
            maskGradX.addColorStop(1, 'rgba(0,0,0,1)');
            ctx.fillStyle = maskGradX;
            ctx.fillRect(x, y, tw, th);

            const maskGradY = ctx.createLinearGradient(0, y, 0, y + th);
            maskGradY.addColorStop(0, 'rgba(0,0,0,1)');
            maskGradY.addColorStop(0.15, 'rgba(0,0,0,0)');
            maskGradY.addColorStop(0.85, 'rgba(0,0,0,0)');
            maskGradY.addColorStop(1, 'rgba(0,0,0,1)');
            ctx.fillStyle = maskGradY;
            ctx.fillRect(x, y, tw, th);
         }
      };

      // --- FEEDBACK TRAILS ---
      if (currentFeedback > 0) {
         ctx.globalAlpha = 1.0 - currentFeedback;
         ctx.globalCompositeOperation = 'source-over';
         ctx.fillStyle = 'rgba(0,0,0,1)';
         ctx.fillRect(0, 0, w, h);
         ctx.globalAlpha = 1.0 - (currentFeedback * 0.95);
      } else {
         ctx.globalAlpha = 1.0;
         ctx.fillStyle = 'black';
         ctx.fillRect(0, 0, w, h);
      }

      // --- GEOMETRY / KALEIDOSCOPE / TILING ---
      ctx.save();
      
      if (zoomScale > 1.0) {
         ctx.translate(w/2, h/2);
         ctx.scale(zoomScale, zoomScale);
         ctx.translate(-w/2, -h/2);
      }

      const t = Math.floor(currentTiling);
      for(let tx = 0; tx < t; tx++) {
         for(let ty = 0; ty < t; ty++) {
             const bx = (w / t) * tx;
             const by = (h / t) * ty;
             const bw = w / t;
             const bh = h / t;
             
             ctx.save();
             // Translate to local block center for internal transformations
             ctx.translate(bx + bw/2, by + bh/2);
             
             if (currentKaleido) {
                // 4-Quadrant Symmetry Mapping within the tile block
                ctx.save(); ctx.translate(-bw/2, -bh/2); drawVideoCover(0, 0, bw/2, bh/2); ctx.restore(); // TL
                ctx.save(); ctx.translate(bw/2, -bh/2); ctx.scale(-1, 1); drawVideoCover(0, 0, bw/2, bh/2); ctx.restore(); // TR
                ctx.save(); ctx.translate(-bw/2, bh/2); ctx.scale(1, -1); drawVideoCover(0, 0, bw/2, bh/2); ctx.restore(); // BL
                ctx.save(); ctx.translate(bw/2, bh/2); ctx.scale(-1, -1); drawVideoCover(0, 0, bw/2, bh/2); ctx.restore(); // BR
             } else {
                ctx.scale(currentMirrorX ? -1 : 1, currentMirrorY ? -1 : 1);
                ctx.translate(-bw/2, -bh/2);
                drawVideoCover(0, 0, bw, bh);
             }
             ctx.restore();
         }
      }

      ctx.restore();

      // --- PIXEL TEARING (DATAMOSH) ---
      if (currentGlitch > 0) {
        ctx.globalAlpha = 1.0;
        if (Math.random() < currentGlitch) {
          const slices = Math.floor(Math.random() * 12 * currentGlitch) + 1;
          for(let i = 0; i < slices; i++) {
            const srcY = Math.random() * h;
            const sliceH = (Math.random() * 0.3 + 0.02) * h;
            const shiftX = (Math.random() - 0.5) * w * currentGlitch * 2.5;
            ctx.drawImage(canvas, 0, srcY, w, sliceH, shiftX, srcY, w, sliceH);
          }
        }
      }

      // --- GHOSTING (DELAY BUFFER SMEAR) ---
      if (currentGhost > 0) {
         ctx.globalCompositeOperation = 'screen';
         ctx.globalAlpha = 0.5 * currentGhost;
         const shiftX = currentGhost * w * 0.08;
         const shiftY = currentGhost * h * 0.02;
         ctx.drawImage(canvas, shiftX, shiftY, w, h);
         ctx.drawImage(canvas, -shiftX, -shiftY, w, h);
         ctx.globalCompositeOperation = 'source-over';
         ctx.globalAlpha = 1.0;
      }

      // --- STROBE ---
      if (currentStrobe > 0) {
         let shouldStrobe = false;
         if (s.audioReactive) {
            shouldStrobe = isAudioStrobe;
         } else {
            const freq = (currentStrobe * 20) + 1; 
            const period = 1000 / freq;
            if ((Date.now() % period) > (period * 0.5)) {
               shouldStrobe = true;
            }
         }

         if (shouldStrobe) {
            ctx.fillStyle = currentInvert ? 'black' : 'white';
            ctx.globalAlpha = 0.9;
            ctx.fillRect(0, 0, w, h);
            ctx.globalAlpha = 1.0;
         }
      }
      
      // --- FINAL COMPOST & STEREO 3D ROUTING ---
      if (currentStereo !== 'none') {
         if (compostCanvas.width !== w || compostCanvas.height !== h) {
             compostCanvas.width = w; compostCanvas.height = h;
         }
         if (compostCtx) compostCtx.drawImage(canvas, 0, 0); // Snapshot pure render
         
         ctx.fillStyle = 'black';
         ctx.fillRect(0, 0, w, h); // Clear main
         
         if (currentStereo === 'sbs') {
            ctx.drawImage(compostCanvas, 0, 0, w/2, h);
            ctx.drawImage(compostCanvas, w/2, 0, w/2, h);
         } else if (currentStereo === 'tb') {
            ctx.drawImage(compostCanvas, 0, 0, w, h/2);
            ctx.drawImage(compostCanvas, 0, h/2, w, h/2);
         }
      }

      // --- FINAL CSS SVG OPICS ---
      let finalHue = currentHue;
      if (s.autoLFO) {
         const now = Date.now() / 1000;
         finalHue = (currentHue + now * (s.bpm / 60) * 150) % 360;
      }

      let customFilters = '';
      if (currentEdge) customFilters += ' url(#fvj-edge)';
      if (currentWave > 0) {
         customFilters += ' url(#fvj-warp)';
         const disp = document.getElementById('fvj-warp-disp');
         const turb = document.getElementById('fvj-warp-turb');
         if (disp && turb) {
             disp.setAttribute('scale', (currentWave * 150).toString());
             turb.setAttribute('baseFrequency', (0.01 + currentWave * 0.04).toString());
         }
      }
      if (currentSplit > 0 || currentChromaAb > 0) {
         customFilters += ' url(#fvj-rgb)';
         const r = document.getElementById('fvj-rgb-red');
         const b = document.getElementById('fvj-rgb-blue');
         if (r && b) {
             const dx = (currentSplit * 100) + (currentChromaAb * 20);
             const dy = currentChromaAb * 15;
             r.setAttribute('dx', dx.toString());
             r.setAttribute('dy', dy.toString());
             b.setAttribute('dx', (-dx).toString());
             b.setAttribute('dy', (-dy).toString());
         }
      }

      const styleStr = `
        hue-rotate(${Math.floor(finalHue)}deg)
        saturate(${currentSat}%)
        contrast(${currentContrast}%)
        brightness(${currentBright}%)
        ${currentInvert ? 'invert(100%)' : ''}
        ${customFilters}
      `;
      if (canvas.style.filter !== styleStr) {
         canvas.style.filter = styleStr;
      }
      
      // Update record canvas for captureStream with burned-in filters
      if (recordCanvasRef.current) {
          const rCanvas = recordCanvasRef.current;
          if (rCanvas.width !== w || rCanvas.height !== h) {
              rCanvas.width = w;
              rCanvas.height = h;
          }
          const rCtx = rCanvas.getContext('2d', { alpha: false });
          if (rCtx) {
              rCtx.filter = styleStr;
              rCtx.drawImage(canvas, 0, 0);
              rCtx.filter = 'none'; // reset for direct overlay drawing
              
              if (s.scanlines) {
                  rCtx.fillStyle = 'rgba(0,0,0,0.3)';
                  for (let i = 0; i < h; i += 4) {
                      rCtx.fillRect(0, i, w, 2);
                  }
              }
              if (s.crt) {
                  rCtx.fillStyle = 'rgba(255, 255, 255, 0.04)';
                  if (Math.random() > 0.5) {
                      const stripH = Math.random() * 20 + 5;
                      rCtx.fillRect(0, Math.random() * (h - stripH), w, stripH);
                  }
              }
              if (s.vignette) { // match div radial shadow
                  const vigGrad = rCtx.createRadialGradient(w/2, h/2, w*0.35, w/2, h/2, Math.max(w, h)*0.6);
                  vigGrad.addColorStop(0, 'rgba(0,0,0,0)');
                  vigGrad.addColorStop(1, 'rgba(0,0,0,0.85)');
                  rCtx.fillStyle = vigGrad;
                  rCtx.fillRect(0, 0, w, h);
              }
          }
      }
    };

    renderLoop(performance.now());
    return () => cancelAnimationFrame(animationId);
  }, []); 

  return (
    <div className="w-full h-full bg-black flex items-center justify-center overflow-hidden">
      <div 
         className="relative bg-black shadow-2xl overflow-hidden"
         style={
             vjState.aspectRatio === 'free' 
             ? { width: '100%', height: '100%' }
             : { aspectRatio: vjState.aspectRatio.replace(':', '/'), width: '100%', maxHeight: '100%' }
         }
      >
        <svg width="0" height="0" className="absolute pointer-events-none">
          <defs>
          <filter id="fvj-edge">
             <feConvolveMatrix order="3 3" preserveAlpha="true" kernelMatrix="-1 -1 -1 -1 8 -1 -1 -1 -1" />
          </filter>
          <filter id="fvj-warp">
             <feTurbulence id="fvj-warp-turb" type="fractalNoise" baseFrequency="0.01" numOctaves="2" result="noise" />
             <feDisplacementMap id="fvj-warp-disp" in="SourceGraphic" in2="noise" scale="0" xChannelSelector="R" yChannelSelector="G" />
          </filter>
          <filter id="fvj-rgb">
             <feOffset id="fvj-rgb-red" dx="0" dy="0" in="SourceGraphic" result="red-shift" />
             <feOffset id="fvj-rgb-blue" dx="0" dy="0" in="SourceGraphic" result="blue-shift" />
             <feComponentTransfer in="red-shift" result="red-only">
               <feFuncR type="linear" slope="1"/><feFuncG type="linear" slope="0"/><feFuncB type="linear" slope="0"/>
             </feComponentTransfer>
             <feComponentTransfer in="blue-shift" result="blue-only">
               <feFuncR type="linear" slope="0"/><feFuncG type="linear" slope="0"/><feFuncB type="linear" slope="1"/>
             </feComponentTransfer>
             <feComponentTransfer in="SourceGraphic" result="green-only">
               <feFuncR type="linear" slope="0"/><feFuncG type="linear" slope="1"/><feFuncB type="linear" slope="0"/>
             </feComponentTransfer>
             <feBlend mode="screen" in="red-only" in2="green-only" result="rg-blend"/>
             <feBlend mode="screen" in="rg-blend" in2="blue-only" />
          </filter>
        </defs>
      </svg>
      <video ref={videoRef} autoPlay playsInline muted={vjState.sourceType === 'camera'} loop className="hidden" />
      
      {/* Primary Rendering Target */}
      <canvas ref={canvasRef} className="w-full h-full block" />

      {/* Screen Effects Layered Overhead */}
      {vjState.scanlines && (
        <div className="pointer-events-none absolute inset-0 z-10 scanlines-overlay mix-blend-overlay opacity-80"></div>
      )}
      {vjState.crt && (
        <div className="pointer-events-none absolute inset-0 z-10 crt-flicker-overlay"></div>
      )}
      {vjState.vignette && (
        <div className="pointer-events-none absolute inset-0 z-20 shadow-[inset_0_0_250px_rgba(0,0,0,0.9)]"></div>
      )}
      </div>
    </div>
  );
}
