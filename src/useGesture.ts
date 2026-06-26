import { useEffect, useRef } from 'react';
import type { PoseLandmarker } from '@mediapipe/tasks-vision';
import { sendPose } from './sa3Bridge';

/**
 * Body-pose control source. When enabled, opens a webcam and runs MediaPipe
 * PoseLandmarker (lite, GPU delegate) on it, reducing the 33 landmarks to six
 * normalized 0..1 control scalars that are forwarded to theDAW over the sa3Bridge
 * (`sa3-vj/pose`). theDAW's poseControlSource republishes them on the same XR
 * control bus DJ uses, so a gesture can drive a target with no per-control wiring.
 *
 * This is control data only (no pixels); the gesturecam visual source and the
 * body-segmentation/AR paths are separate, later steps. MediaPipe is dynamically
 * imported so it stays out of the main bundle until gesture control is turned on.
 * Model + WASM are sourced live (HARD RULE 1): model URL from the Google AI Edge
 * pose_landmarker table, WASM pinned to the installed @mediapipe/tasks-vision.
 */
const WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm';
const MODEL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task';
const DETECT_MS = 50; // ~20fps detection (decoupled from the render loop)

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

export function useGesture(enabled: boolean): void {
  const rafRef = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    let closed = false;
    let stream: MediaStream | null = null;
    let landmarker: PoseLandmarker | null = null;
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    let lastTs = -1;
    let lastDetect = 0;

    const loop = (): void => {
      rafRef.current = requestAnimationFrame(loop);
      if (closed || !landmarker) return;
      if (video.readyState < 2 || !video.videoWidth) return;
      const now = performance.now();
      if (now - lastDetect < DETECT_MS) return;
      lastDetect = now;
      // detectForVideo needs a strictly increasing timestamp.
      let ts = now;
      if (ts <= lastTs) ts = lastTs + 1;
      lastTs = ts;
      let res;
      try {
        res = landmarker.detectForVideo(video, ts);
      } catch {
        return;
      }
      const lm = res?.landmarks?.[0];
      if (!lm || lm.length < 25) return;
      // Normalized image coords: x right, y down. 33-point topology.
      const lw = lm[15];
      const rw = lm[16]; // wrists
      const ls = lm[11];
      const rs = lm[12]; // shoulders
      const lh = lm[23];
      const rh = lm[24]; // hips
      const cx = (ls.x + rs.x + lh.x + rh.x) / 4;
      const cy = (ls.y + rs.y + lh.y + rh.y) / 4;
      sendPose({
        handLeft: clamp01(1 - lw.y), // hand raised -> 1
        handRight: clamp01(1 - rw.y),
        armSpan: clamp01(Math.hypot(lw.x - rw.x, lw.y - rw.y) / 0.9),
        bodyX: clamp01(cx), // 0 = frame left, 1 = frame right
        bodyY: clamp01(1 - cy), // jump -> 1, crouch -> 0
        lean: clamp01(0.5 + (rs.y - ls.y) * 2), // shoulder tilt -> lean
      });
    };

    const start = async (): Promise<void> => {
      try {
        const vision = await import('@mediapipe/tasks-vision');
        const fileset = await vision.FilesetResolver.forVisionTasks(WASM);
        if (closed) return;
        landmarker = await vision.PoseLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: MODEL, delegate: 'GPU' },
          runningMode: 'VIDEO',
          numPoses: 1,
        });
        if (closed) {
          landmarker.close();
          landmarker = null;
          return;
        }
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 640 }, height: { ideal: 480 } },
          audio: false,
        });
        if (closed) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        video.srcObject = stream;
        await video.play().catch(() => {});
        loop();
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[gesture] init failed', e);
      }
    };
    void start();

    return () => {
      closed = true;
      cancelAnimationFrame(rafRef.current);
      try {
        landmarker?.close();
      } catch {
        /* ignore */
      }
      stream?.getTracks().forEach((t) => t.stop());
      try {
        video.pause();
        video.srcObject = null;
      } catch {
        /* ignore */
      }
    };
  }, [enabled]);
}
