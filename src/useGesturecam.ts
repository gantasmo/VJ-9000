import { useEffect, useRef, useState } from 'react';
import { renderFrame } from './faceviz/compositor';
import { analyzeMotion, buildTrackedHand, buildTrackedPose } from './faceviz/gestureEngine';
import type { Handedness, Landmark, MotionFrame, PreviousHandSample } from './faceviz/types';

/**
 * "gesturecam" VJ source — the FaceViz / INFINIGHTCapture engine ported in-process:
 * a webcam runs MediaPipe hand + pose tracking, and the FaceViz Canvas2D compositor
 * draws the mirrored feed plus gesture-triggered effects (fire / melt / warp / bloom)
 * and an optional landmark rig. The composited canvas is captureStream'd and returned
 * as a MediaStream, so it mixes through the CAM<->MEM crossfader and every effect like
 * any other generative source.
 *
 * Self-contained (own webcam + MediaPipe), enabled only while selected. MediaPipe is
 * dynamically imported (kept out of the main bundle); model + WASM are sourced live,
 * matching useGesture. selectedEffect 'auto' lets gestures drive the effects; naming an
 * effect forces it on continuously.
 */
const WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm';
const HAND_MODEL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const POSE_MODEL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task';
const DETECT_MS = 33; // ~30fps detection; the compositor still renders every rAF

export interface GesturecamOptions {
  selectedEffect: string; // 'auto' | 'fire' | 'melt' | 'warp' | 'bloom'
  effectAmount: number; // 0..1.4
  showRig: boolean;
}

export interface GesturecamFeed {
  stream: MediaStream | null;
  state: 'idle' | 'loading' | 'running' | 'error';
  error: string | null;
}

const getHandedness = (result: unknown, index: number): Handedness => {
  const handednesses = (result as { handednesses?: Array<Array<{ categoryName?: string }>> }).handednesses;
  const name = handednesses?.[index]?.[0]?.categoryName;
  if (name === 'Left' || name === 'Right') return name;
  return 'Unknown';
};

export function useGesturecam(enabled: boolean, options: GesturecamOptions): GesturecamFeed {
  const [feed, setFeed] = useState<GesturecamFeed>({ stream: null, state: 'idle', error: null });
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    if (!enabled) {
      setFeed({ stream: null, state: 'idle', error: null });
      return;
    }
    let closed = false;
    let raf = 0;
    let stream: MediaStream | null = null;
    let camStream: MediaStream | null = null;
    // MediaPipe types are loaded dynamically; keep these loosely typed.
    let hand: { detectForVideo: (v: HTMLVideoElement, t: number) => { landmarks: unknown; handednesses?: unknown }; close: () => void } | null = null;
    let pose: { detectForVideo: (v: HTMLVideoElement, t: number) => { landmarks?: unknown }; close: () => void } | null = null;

    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    const canvas = document.createElement('canvas');
    canvas.width = 1280;
    canvas.height = 720;

    const previous = new Map<string, PreviousHandSample>();
    let motion: MotionFrame | null = null;
    let lastVideoTime = -1;
    let lastDetect = 0;
    let lastTs = -1;

    const loop = () => {
      if (closed) return;
      raf = requestAnimationFrame(loop);
      const now = performance.now();
      const ready = video.readyState >= 2 && video.videoWidth > 0;
      if (ready && hand && pose && now - lastDetect >= DETECT_MS && video.currentTime !== lastVideoTime) {
        lastVideoTime = video.currentTime;
        lastDetect = now;
        let ts = now;
        if (ts <= lastTs) ts = lastTs + 1;
        lastTs = ts;
        try {
          const hr = hand.detectForVideo(video, ts);
          const pr = pose.detectForVideo(video, ts);
          const next = new Map<string, PreviousHandSample>();
          const hands = ((hr.landmarks as Landmark[][]) ?? []).map((lm, i) => {
            const handedness = getHandedness(hr, i);
            const key = `${handedness}-${i}`;
            const th = buildTrackedHand(lm, handedness, previous.get(key), ts);
            next.set(key, { wrist: th.wrist, timestamp: ts });
            return th;
          });
          previous.clear();
          next.forEach((v, k) => previous.set(k, v));
          const tp = buildTrackedPose(((pr.landmarks as Landmark[][] | undefined)?.[0]) ?? undefined);
          motion = analyzeMotion(hands, tp, now);
        } catch {
          /* keep last motion */
        }
      } else if (motion) {
        // Between detections, advance the animation clock so effects keep moving.
        motion.timestamp = now;
      }
      renderFrame(canvas, ready ? video : null, motion, optionsRef.current);
    };

    const start = async () => {
      try {
        setFeed((p) => ({ ...p, state: 'loading' }));
        const vision = await import('@mediapipe/tasks-vision');
        const fileset = await vision.FilesetResolver.forVisionTasks(WASM);
        if (closed) return;
        const [handLm, poseLm] = await Promise.all([
          vision.HandLandmarker.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: HAND_MODEL, delegate: 'GPU' },
            runningMode: 'VIDEO',
            numHands: 2,
            minHandDetectionConfidence: 0.45,
            minHandPresenceConfidence: 0.45,
            minTrackingConfidence: 0.45,
          }),
          vision.PoseLandmarker.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: POSE_MODEL, delegate: 'GPU' },
            runningMode: 'VIDEO',
            numPoses: 1,
            minPoseDetectionConfidence: 0.4,
            minPosePresenceConfidence: 0.4,
            minTrackingConfidence: 0.4,
          }),
        ]);
        if (closed) {
          handLm.close();
          poseLm.close();
          return;
        }
        hand = handLm as typeof hand;
        pose = poseLm as typeof pose;
        camStream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
          audio: false,
        });
        if (closed) {
          camStream.getTracks().forEach((t) => t.stop());
          return;
        }
        video.srcObject = camStream;
        await video.play().catch(() => {});
        if (typeof canvas.captureStream === 'function') stream = canvas.captureStream(30);
        setFeed({ stream, state: 'running', error: null });
        raf = requestAnimationFrame(loop);
      } catch (e) {
        if (!closed) setFeed({ stream: null, state: 'error', error: e instanceof Error ? e.message : 'gesturecam failed' });
      }
    };
    void start();

    return () => {
      closed = true;
      cancelAnimationFrame(raf);
      try {
        hand?.close();
        pose?.close();
      } catch {
        /* ignore */
      }
      camStream?.getTracks().forEach((t) => t.stop());
      stream?.getTracks().forEach((t) => t.stop());
      try {
        video.pause();
        video.srcObject = null;
      } catch {
        /* ignore */
      }
    };
  }, [enabled]);

  return feed;
}
