import { useEffect, useRef } from 'react';
import { getExternalLevels, getExternalInputs } from './sa3Bridge';

export interface AudioLevels {
  bass: number;
  mid: number;
  high: number;
  volume: number;
}

export function useAudioAnalyzer(isActive: boolean) {
  const analyzerRef = useRef<AnalyserNode | null>(null);
  const dataArrayRef = useRef<Uint8Array | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    let active = true;

    if (isActive) {
      navigator.mediaDevices.getUserMedia({ audio: true, video: false })
        .then(stream => {
          if (!active) {
            stream.getTracks().forEach(t => t.stop());
            return;
          }
          streamRef.current = stream;
          const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
          const ctx = new AudioContextClass();
          audioContextRef.current = ctx;

          const source = ctx.createMediaStreamSource(stream);
          const analyzer = ctx.createAnalyser();
          analyzer.fftSize = 256;
          analyzer.smoothingTimeConstant = 0.6; // smooth it slightly
          source.connect(analyzer);
          
          analyzerRef.current = analyzer;
          dataArrayRef.current = new Uint8Array(analyzer.frequencyBinCount);
        })
        .catch(err => console.error("Audio routing failed. Please allow microphone access:", err));
    }

    return () => {
      active = false;
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
        streamRef.current = null;
      }
      if (audioContextRef.current) {
         audioContextRef.current.close().catch(() => {});
         audioContextRef.current = null;
      }
      analyzerRef.current = null;
    };
  }, [isActive]);

  // Expose an ultra-fast polling function for requestAnimationFrame.
  // Bridge priority: when this app runs INSIDE SA3's VJ tab, the
  // parent window forwards amplitude levels via postMessage (see
  // sa3Bridge.ts) — those reflect SA3's master AnalyserNode and
  // whatever's playing in SA3's global player. We prefer those when
  // available, falling back to the local mic-capture analyzer if not.
  // Standalone behaviour is unchanged: when there's no parent posting
  // messages, getExternalLevels() returns null and the mic path runs
  // exactly as before.
  const getAudioLevels = (): AudioLevels => {
    // Respect SA3-side input mutes. When SA3 has 'audio' off the
    // external bridge is treated as silent; when 'mic' is off the
    // local mic analyser is treated as silent. Either pathway can
    // be independently muted.
    const inputs = getExternalInputs();
    if (inputs.audio) {
      const external = getExternalLevels();
      if (external) return external;
    }

    if (!inputs.mic) {
      return { bass: 0, mid: 0, high: 0, volume: 0 };
    }

    if (!analyzerRef.current || !dataArrayRef.current) {
       return { bass: 0, mid: 0, high: 0, volume: 0 };
    }

    analyzerRef.current.getByteFrequencyData(dataArrayRef.current);
    const data = dataArrayRef.current;
    
    let bassSum = 0, midSum = 0, highSum = 0;
    
    // Frequency bins (128 total)
    for (let i = 0; i < 6; i++) bassSum += data[i]; // Bass
    for (let i = 6; i < 40; i++) midSum += data[i]; // Mids
    for (let i = 40; i < 128; i++) highSum += data[i]; // Highs

    return {
      bass: (bassSum / 6) / 255,
      mid: (midSum / 34) / 255,
      high: (highSum / 88) / 255,
      volume: (bassSum + midSum + highSum) / (128 * 255)
    };
  };

  return { getAudioLevels };
}
