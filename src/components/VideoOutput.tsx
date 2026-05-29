import React, { useEffect, useRef } from 'react';
import { VJState } from '../types';
import { AudioLevels } from '../useAudioAnalyzer';

interface VideoOutputProps {
  vjState: VJState;
  videoRef: React.RefObject<HTMLVideoElement>;
  getAudioLevels: () => AudioLevels;
  onAutopilotSwitchClip?: () => void;
}

export function VideoOutput({ vjState, videoRef, getAudioLevels, onAutopilotSwitchClip }: VideoOutputProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const recordCanvasRef = useRef<HTMLCanvasElement>(null);
  
  const stateRef = useRef(vjState);
  useEffect(() => {
    stateRef.current = vjState;
  }, [vjState]);

  const onSwitchClipRef = useRef(onAutopilotSwitchClip);
  useEffect(() => {
    onSwitchClipRef.current = onAutopilotSwitchClip;
  }, [onAutopilotSwitchClip]);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);

  useEffect(() => {
    if (!recordCanvasRef.current) {
        recordCanvasRef.current = document.createElement('canvas');
    }
    
    let active = true;
    let localMicStream: MediaStream | null = null;
    let audioCtx: AudioContext | null = null;
    
    const startRecording = async () => {
      if (!recordCanvasRef.current) return;
      // Lock the record canvas to the user-selected quality height
      // and derive width from the live display canvas's aspect so
      // the file matches what they see. The render loop's recordCanvas
      // branch (further down) detects a recording in progress and
      // uses scaled drawImage instead of auto-resizing.
      const qualityHeights: Record<string, number> = { '720p': 720, '1080p': 1080, '4K': 2160 };
      const targetH = qualityHeights[vjState.recordQuality ?? '1080p'] ?? 1080;
      const liveCanvas = canvasRef.current;
      const aspect = liveCanvas && liveCanvas.height > 0
        ? liveCanvas.width / liveCanvas.height
        : 16 / 9;
      recordCanvasRef.current.width = Math.round(targetH * aspect);
      recordCanvasRef.current.height = targetH;
      const stream = recordCanvasRef.current.captureStream(30);
      
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      audioCtx = new AudioContextClass();
      const dest = audioCtx.createMediaStreamDestination();
      let hasAudio = false;

      // 1. Try Video Audio (if clip audio is on, or if camera has audio)
      const videoEl = videoRef.current;
      if (videoEl && !videoEl.muted) {
          try {
              if (videoEl.srcObject && videoEl.srcObject instanceof MediaStream) {
                  const tracks = (videoEl.srcObject as MediaStream).getAudioTracks();
                  if (tracks.length > 0) {
                      const source = audioCtx.createMediaStreamSource(videoEl.srcObject as MediaStream);
                      source.connect(dest);
                      hasAudio = true;
                  }
              } else {
                 const anyVid = videoEl as any;
                 const capturedStream = anyVid.captureStream ? anyVid.captureStream() : anyVid.mozCaptureStream ? anyVid.mozCaptureStream() : null;
                 if (capturedStream && capturedStream.getAudioTracks().length > 0) {
                     const source = audioCtx.createMediaStreamSource(capturedStream);
                     source.connect(dest);
                     hasAudio = true;
                 }
              }
          } catch(e) {
              console.warn("Could not capture audio stream from video", e);
          }
      }

      // 2. Try Mic Audio explicitly if we don't have video audio (e.g. they want to record the live set music)
      if (!hasAudio || vjState.audioReactive) {
         try {
             localMicStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
             if (localMicStream && localMicStream.getAudioTracks().length > 0) {
                 const source = audioCtx.createMediaStreamSource(localMicStream);
                 source.connect(dest);
                 hasAudio = true;
             }
         } catch(e) {
             console.warn("Could not get mic access for recording", e);
         }
      }

      if (!active) {
         // Cleanup if recording stopped while we were waiting for mic
         if (localMicStream) localMicStream.getTracks().forEach(t => t.stop());
         if (audioCtx) audioCtx.close();
         return;
      }

      if (hasAudio) {
         dest.stream.getAudioTracks().forEach(track => stream.addTrack(track));
      }

      try {
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
    };

    if (vjState.recording) {
      startRecording();
    } else {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
        mediaRecorderRef.current.stop();
      }
      if (localMicStream) {
          localMicStream.getTracks().forEach(t => t.stop());
      }
      if (audioCtx) {
          audioCtx.close().catch(() => {});
      }
    }
    
    return () => {
       active = false;
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
       hue: 0, sat: 100, contrast: 100, bright: 100, feedback: 0,
       kaleido: false, mirrorX: false, mirrorY: false, invert: false, edgeDetect: false,
       pixelate: 0, waveWarp: 0, rgbSplit: 0, glitch: 0,
       tiling: 1, equirect: false, stereoMode: 'none',
       chromaAb: 0, backskip: 0, softEdges: false,
       playbackSpeed: 1, reversePlayback: false, posterizeTime: 60, echoTrails: 0, slitScan: 0, timeDisplace: 0,
       dropCooldown: 0,
    };
    let apTargets = {
       cycleLength: 6.0,
       hue: Math.random() * 360, sat: 100, contrast: 100, feedback: 0.5,
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
         const { speed, chaos, geo, corrupt, color, timecode } = s.apConfig;
         
         const aw = (k: string) => s.apWeights && s.apWeights[k] !== undefined ? s.apWeights[k] : 1.0;
         
         // 1. DYNAMIC TRIGGER SIGNAL CALCULATION
         let activeTriggerLevel = 0.0;
         const timeMs = performance.now();
         const timeRamp = 0.5 + 0.5 * Math.sin(timeMs * 0.001 * speed);
         const rawChaosSignal = 0.5 + 0.5 * Math.sin(timeMs * 0.002) * Math.cos(timeMs * 0.0007);
         
         switch(s.apTriggerSource) {
            case 'volume':
               activeTriggerLevel = s.audioReactive ? Math.min(1.0, audio.volume * 5.0) : timeRamp;
               break;
            case 'bass':
               activeTriggerLevel = s.audioReactive ? Math.min(1.0, audio.bass * 2.5) : Math.pow(timeRamp, 1.5);
               break;
            case 'mid-high':
               activeTriggerLevel = s.audioReactive ? Math.min(1.0, (audio.mid + audio.high) * 2.5) : Math.abs(Math.sin(timeMs * 0.0015));
               break;
            case 'time':
               activeTriggerLevel = timeRamp;
               break;
            case 'chaos':
               activeTriggerLevel = Math.max(0, Math.min(1, rawChaosSignal + (Math.random() - 0.5) * chaos));
               break;
            case 'mixed':
            default:
               if (s.audioReactive) {
                  activeTriggerLevel = Math.min(1.0, (audio.volume * 2.0 + audio.bass * 2.0) / 2.0);
               } else {
                  activeTriggerLevel = 0.4 * timeRamp + 0.6 * rawChaosSignal;
               }
               break;
         }

         // 2. RAMPS & OPTIONAL SIGNAL TRANSLATIONS
         let modScalar = activeTriggerLevel;
         if (s.apRampType === 'none') {
            modScalar = 1.0;
         } else if (s.apRampType === 'exponential') {
            modScalar = Math.pow(activeTriggerLevel, 2.0);
         } else if (s.apRampType === 'sigmoid') {
            modScalar = 1.0 / (1.0 + Math.exp(-((activeTriggerLevel - 0.5) * 10.0)));
         }

         // 3. SENSITIVITY ATTENUATION / SYSTEM SUBDUE
         let gateFactor = 1.0;
         let timerSpeedMultiplier = 1.0;
         
         if (activeTriggerLevel < s.apSensitivity) {
            const ratio = s.apSensitivity > 0 ? (activeTriggerLevel / s.apSensitivity) : 0;
            // Scale smoothly down to subdued minimum
            gateFactor = s.apSubdueDepth + (1.0 - s.apSubdueDepth) * ratio;
            timerSpeedMultiplier = ratio;
            
            // If we are below half of the threshold, fully pause trigger cycle and switching
            if (ratio < 0.5) {
               timerSpeedMultiplier = 0.0;
            }
         }

         const apIntensityMultiplier = s.apModulateIntensity ? (gateFactor * modScalar) : gateFactor;
         const isSubdued = gateFactor < 0.25;
         
         apTimer += (1/60) * speed * timerSpeedMultiplier;
         if (apTimer > apTargets.cycleLength && s.autoSwitchClips && onSwitchClipRef.current) {
            setTimeout(() => {
               onSwitchClipRef.current?.();
            }, 0);
         }
         if (apTimer > apTargets.cycleLength) { 
            apTimer = 0;
            // Variable cycle length based on chaos (3s to 12s roughly)
            apTargets.cycleLength = 3.0 + Math.random() * 6.0 * (1.5 - chaos * 0.5);

            // Tasteful FX Selection - pick 1 or 2 focal effects per cycle
            const focalFX = Math.random();
            const fxLevel = Math.random() * chaos + 0.1; // Ensure somewhat visible if selected

            // --- Reset all targets back to baseline to prevent messy overlap ---
            apTargets.pixelate = 0;
            apTargets.waveWarp = 0;
            apTargets.rgbSplit = 0;
            apTargets.glitch = 0;
            apTargets.chromaAb = 0;
            apTargets.backskip = 0;
            apTargets.playbackSpeed = 1;
            apTargets.posterizeTime = 60;
            apTargets.echoTrails = 0;
            apTargets.slitScan = 0;
            apTargets.timeDisplace = 0;
            apTargets.feedback = 0;
            
            // Turn off most booleans
            apState.kaleido = false;
            apState.mirrorX = false;
            apState.mirrorY = false;
            apState.edgeDetect = false;
            apState.equirect = false;
            apState.stereoMode = 'none';
            apState.tiling = 1;
            apState.reversePlayback = false;
            apState.invert = false;
            
            // Gently drift colors over time instead of frantic jumping
            apTargets.hue = (apState.hue + 30 + Math.random() * 120) % 360; 
            apTargets.sat = 90 + Math.random() * 210 * chaos;
            apTargets.contrast = 100 + Math.random() * 150 * chaos;

            // Group 1: Geometry / Space (20%)
            if (focalFX < 0.20) {
               if (aw('kaleido') > 0 && Math.random() > 0.4) apState.kaleido = true;
               else if (aw('tiling') > 0 && Math.random() > 0.3) apState.tiling = Math.floor(1 + Math.random() * 3 * fxLevel);
               if (aw('waveWarp') > 0) apTargets.waveWarp = 0.15 * fxLevel * aw('waveWarp');
            } 
            // Group 2: Temporal Smear / Stutter (20%)
            else if (focalFX < 0.40) {
               if (aw('posterizeTime') > 0) apTargets.posterizeTime = Math.floor(8 + Math.random() * 20); // Not too low
               if (aw('echoTrails') > 0) apTargets.echoTrails = 8 * fxLevel * aw('echoTrails');
            } 
            // Group 3: Spatial Distortion (20%)
            else if (focalFX < 0.60) {
               if (aw('pixelate') > 0) apTargets.pixelate = 0.15 * fxLevel * aw('pixelate');
               if (aw('timeDisplace') > 0) apTargets.timeDisplace = 0.3 * fxLevel * aw('timeDisplace');
            } 
            // Group 4: Digital Corruption (20%)
            else if (focalFX < 0.80) {
               if (aw('chromaAb') > 0) apTargets.chromaAb = 0.8 * fxLevel * aw('chromaAb');
               if (aw('rgbSplit') > 0) apTargets.rgbSplit = 0.3 * fxLevel * aw('rgbSplit');
               if (aw('glitch') > 0 && Math.random() > 0.5) apTargets.glitch = 0.2 * fxLevel * aw('glitch');
            } 
            // Group 5: Playback Manipulation (20%)
            else {
               if (aw('playbackSpeed') > 0) apTargets.playbackSpeed = 0.4 + Math.random() * 1.6 * fxLevel;
               if (aw('reversePlayback') > 0 && Math.random() > 0.6) apState.reversePlayback = true;
               if (aw('backskip') > 0 && Math.random() > 0.5) apTargets.backskip = 0.4 * fxLevel * aw('backskip');
               if (aw('slitScan') > 0 && Math.random() > 0.5) apTargets.slitScan = 0.3 * fxLevel * aw('slitScan');
            }
            
            // Global independent tasteful sprinkles
            if (aw('feedback') > 0 && Math.random() > 0.8) apTargets.feedback = Math.random() * 0.85 * fxLevel * aw('feedback');
            if (aw('edgeDetect') > 0 && chaos > 0.7 && Math.random() > 0.85) apState.edgeDetect = true;
            if (aw('mirrorX') > 0 && Math.random() > 0.85) apState.mirrorX = true;
            if (aw('mirrorY') > 0 && Math.random() > 0.85) apState.mirrorY = true;
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
             apState.dropCooldown = 1.0 + Math.random() * 2.0; // Dynamic drop cooldown
         }
         // Decrease cooldown strictly based on actual time, so drops aren't suppressed if subdued
         if (apState.dropCooldown > 0) apState.dropCooldown -= 1/60;
         
         if (autoPilotDrop && !isSubdued) { // Only do massive drops if not highly subdued
            if (s.autoSwitchClips && Math.random() < 0.6 && onSwitchClipRef.current) {
               setTimeout(() => {
                  onSwitchClipRef.current?.();
               }, 0);
            }
            apTimer = apTargets.cycleLength - 0.2; // Force a new cycle soon after the drop hits to resolve it
            currentStrobe = 1.0; 
            
            // Tasteful Drops - Choose 1 Major Effect Type for the Drop rather than blasting all of them
            const dropStyle = Math.random();
            const hit = chaos; // Intensity of drop
            
            // Reset state to avoid crossover mess during drops
            apTargets.waveWarp = 0; apTargets.rgbSplit = 0; apTargets.glitch = 0;
            apTargets.chromaAb = 0; apTargets.backskip = 0; apTargets.slitScan = 0; 
            apTargets.timeDisplace = 0; apTargets.echoTrails = 0; apTargets.playbackSpeed = 1;

            if (dropStyle < 0.20 && aw('feedback') > 0) {
               // Heavy Reverb / Delay drop
               apState.feedback = 0.95 * aw('feedback'); 
               apTargets.feedback = 0; 
               if (aw('echoTrails') > 0) {
                   apState.echoTrails = 12 * hit * aw('echoTrails');
                   apTargets.echoTrails = 0;
               }
            } else if (dropStyle < 0.40 && aw('chromaAb') > 0) {
               // Aggressive Color Invert & Zoom
               if (aw('invert') > 0) apState.invert = !apState.invert;
               if (aw('edgeDetect') > 0 && Math.random() > 0.5) apState.edgeDetect = true;
               apState.chromaAb = 1.5 * hit * aw('chromaAb');
               apTargets.chromaAb = 0;
            } else if (dropStyle < 0.60 && (aw('glitch') > 0 || aw('rgbSplit') > 0)) {
               // Glitch & Tape Stop
               if (aw('glitch') > 0) { apState.glitch = 0.8 * hit * aw('glitch'); apTargets.glitch = 0; }
               if (aw('rgbSplit') > 0) { apState.rgbSplit = 0.8 * hit * aw('rgbSplit'); apTargets.rgbSplit = 0; }
               if (aw('playbackSpeed') > 0) apState.playbackSpeed = 3.0 * hit * aw('playbackSpeed');
            } else if (dropStyle < 0.80 && aw('kaleido') > 0) {
               // Geo Shatter
               apState.kaleido = true;
               if (aw('tiling') > 0) apState.tiling = Math.floor(1 + Math.random() * 3);
               if (aw('waveWarp') > 0) { apState.waveWarp = 0.8 * hit * aw('waveWarp'); apTargets.waveWarp = 0; }
            } else {
               // Time Smear 
               if (aw('slitScan') > 0) { apState.slitScan = 0.6 * hit * aw('slitScan'); apTargets.slitScan = 0; }
               if (aw('timeDisplace') > 0) { apState.timeDisplace = 0.7 * hit * aw('timeDisplace'); apTargets.timeDisplace = 0; }
               if (aw('reversePlayback') > 0) apState.reversePlayback = true;
            }
         }
         
         // Helper to check if autopilot is allowed to control this param
         const am = (key: string) => aw(key) > 0;

         // Apply over user state conditionally
         if (color) {
             if (am('hue')) currentHue = apState.hue;
             if (am('sat')) currentSat = apState.sat;
             if (am('contrast')) currentContrast = apState.contrast;
             if (am('invert')) currentInvert = isSubdued ? false : apState.invert;
             if (am('edgeDetect')) currentEdge = isSubdued ? false : apState.edgeDetect;
         }
         if (geo) {
             if (am('feedback')) currentFeedback = apState.feedback * apIntensityMultiplier;
             if (am('kaleido')) currentKaleido = isSubdued ? false : apState.kaleido;
             if (am('mirrorX')) currentMirrorX = isSubdued ? false : apState.mirrorX;
             if (am('mirrorY')) currentMirrorY = isSubdued ? false : apState.mirrorY;
             if (am('tiling')) currentTiling = isSubdued ? 1 : apState.tiling;
             if (am('equirect')) currentEquirect = isSubdued ? false : apState.equirect;
             if (am('stereoMode')) currentStereo = isSubdued ? 'none' : (apState.stereoMode as 'none'|'sbs'|'tb');
         }
         if (corrupt) {
             if (am('pixelate')) currentPixelate = Math.max(currentPixelate, apState.pixelate * apIntensityMultiplier);
             if (am('waveWarp')) currentWave = Math.max(currentWave, apState.waveWarp * apIntensityMultiplier);
             if (am('rgbSplit')) currentSplit = Math.max(currentSplit, apState.rgbSplit * apIntensityMultiplier);
             if (am('glitch')) currentGlitch = Math.max(currentGlitch, apState.glitch * apIntensityMultiplier);
             if (am('chromaAb')) currentChromaAb = Math.max(currentChromaAb, apState.chromaAb * apIntensityMultiplier);
             if (am('backskip')) currentBackskip = Math.max(currentBackskip, apState.backskip * apIntensityMultiplier);
         }
         if (timecode) {
             if (am('playbackSpeed')) {
                const targetSpeed = isSubdued ? 1.0 : apState.playbackSpeed;
                currentPlaybackSpeed *= (1.0 + (targetSpeed - 1.0) * apIntensityMultiplier);
             }
             if (am('reversePlayback')) currentReversePlayback = isSubdued ? false : (currentReversePlayback !== apState.reversePlayback);

             if (am('posterizeTime')) {
                const posterizeDelta = 60 - apState.posterizeTime;
                currentPosterizeTime = Math.min(currentPosterizeTime, Math.round(60 - posterizeDelta * apIntensityMultiplier));
             }
             if (am('echoTrails')) currentEchoTrails = Math.max(currentEchoTrails, Math.round(apState.echoTrails * apIntensityMultiplier));
             if (am('slitScan')) currentSlitScan = Math.max(currentSlitScan, apState.slitScan * apIntensityMultiplier);
             if (am('timeDisplace')) currentTimeDisplace = Math.max(currentTimeDisplace, apState.timeDisplace * apIntensityMultiplier);
             if (am('softEdges')) currentSoft = currentSoft || (isSubdued ? false : apState.softEdges);
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
      
      // Update record canvas for captureStream with burned-in filters.
      // When a take is in progress the dims are locked to the chosen
      // recordQuality (set in startRecording); otherwise we mirror
      // the live canvas. The drawImage scales source → record dims.
      if (recordCanvasRef.current) {
          const rCanvas = recordCanvasRef.current;
          if (!s.recording && (rCanvas.width !== w || rCanvas.height !== h)) {
              rCanvas.width = w;
              rCanvas.height = h;
          }
          const rCtx = rCanvas.getContext('2d', { alpha: false });
          if (rCtx) {
              rCtx.filter = styleStr;
              rCtx.drawImage(canvas, 0, 0, rCanvas.width, rCanvas.height);
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
      <video ref={videoRef} autoPlay playsInline muted={vjState.sourceType === 'camera' || !vjState.clipAudio} loop className="hidden" crossOrigin="anonymous" />
      
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
