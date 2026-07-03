// Ported from the FaceViz / INFINIGHTCapture module (src/tracking/gestureEngine.ts).
// Pure analysis: turns MediaPipe hand + pose landmarks into tracked hands/pose
// and a per-frame gesture state (face cover, hands up, pinch, open palm, fast
// motion). No MediaPipe import here — the caller runs detection and feeds these.
import type {
  GestureState,
  Handedness,
  Landmark,
  MotionFrame,
  PreviousHandSample,
  TrackedHand,
  TrackedPose,
  Vec2,
} from "./types";

const HAND_TIP_INDICES = [4, 8, 12, 16, 20];
const HAND_ROOT_INDICES = [2, 5, 9, 13, 17];
const POSE_NOSE = 0;
const POSE_LEFT_SHOULDER = 11;
const POSE_RIGHT_SHOULDER = 12;
const POSE_LEFT_WRIST = 15;
const POSE_RIGHT_WRIST = 16;

const distance = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);

const averagePoint = (points: Vec2[]): Vec2 => {
  if (!points.length) {
    return { x: 0.5, y: 0.5 };
  }

  return {
    x: points.reduce((total, point) => total + point.x, 0) / points.length,
    y: points.reduce((total, point) => total + point.y, 0) / points.length,
  };
};

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

export const pointToCanvas = (point: Vec2, width: number, height: number): Vec2 => ({
  x: (1 - point.x) * width,
  y: point.y * height,
});

export const buildTrackedPose = (landmarks?: Landmark[]): TrackedPose | undefined => {
  if (!landmarks?.length) {
    return undefined;
  }

  return {
    landmarks,
    nose: landmarks[POSE_NOSE],
    leftShoulder: landmarks[POSE_LEFT_SHOULDER],
    rightShoulder: landmarks[POSE_RIGHT_SHOULDER],
    leftWrist: landmarks[POSE_LEFT_WRIST],
    rightWrist: landmarks[POSE_RIGHT_WRIST],
  };
};

export const buildTrackedHand = (
  landmarks: Landmark[],
  handedness: Handedness,
  previous?: PreviousHandSample,
  timestamp = performance.now()
): TrackedHand => {
  const wrist = landmarks[0] ?? { x: 0.5, y: 0.5 };
  const centroid = averagePoint(landmarks);
  const tipSpread =
    HAND_TIP_INDICES.reduce((total, index) => total + distance(wrist, landmarks[index] ?? wrist), 0) /
    HAND_TIP_INDICES.length;
  const rootSpread =
    HAND_ROOT_INDICES.reduce((total, index) => total + distance(wrist, landmarks[index] ?? wrist), 0) /
    HAND_ROOT_INDICES.length;
  const openness = clamp01((tipSpread - rootSpread * 0.9) * 5.2);
  const pinchDistance = distance(landmarks[4] ?? wrist, landmarks[8] ?? wrist);
  const pinch = clamp01(1 - pinchDistance / 0.09);
  const deltaSeconds = previous ? Math.max(0.001, (timestamp - previous.timestamp) / 1000) : 1;
  const velocity = previous ? clamp01(distance(wrist, previous.wrist) / deltaSeconds / 1.7) : 0;

  return {
    handedness,
    landmarks,
    centroid,
    wrist,
    openness,
    pinch,
    velocity,
  };
};

export const analyzeMotion = (hands: TrackedHand[], pose: TrackedPose | undefined, timestamp: number): MotionFrame => {
  const shoulderLineY =
    pose?.leftShoulder && pose.rightShoulder ? (pose.leftShoulder.y + pose.rightShoulder.y) / 2 : undefined;
  const handsUp =
    shoulderLineY !== undefined &&
    hands.some((hand) => hand.wrist.y < shoulderLineY - 0.12 || hand.centroid.y < shoulderLineY - 0.16);
  const faceCover =
    Boolean(pose?.nose) &&
    hands.some((hand) => {
      const nearNose = hand.landmarks.filter((point) => pose?.nose && distance(point, pose.nose) < 0.12).length;
      return nearNose >= 3 || (pose?.nose ? distance(hand.centroid, pose.nose) < 0.13 : false);
    });
  const pinch = hands.some((hand) => hand.pinch > 0.64);
  const openPalm = hands.some((hand) => hand.openness > 0.56);
  const fastMotion = hands.some((hand) => hand.velocity > 0.36);
  const neutral = !handsUp && !faceCover && !pinch && !openPalm && !fastMotion;
  const gestures: GestureState = {
    handsUp,
    faceCover,
    pinch,
    openPalm,
    fastMotion,
    neutral,
  };
  const landmarkCount = hands.reduce((total, hand) => total + hand.landmarks.length, pose?.landmarks.length ?? 0);
  const confidence = clamp01((hands.length ? 0.46 : 0) + (pose ? 0.36 : 0) + Math.min(0.18, landmarkCount / 360));

  return {
    timestamp,
    hands,
    pose,
    gestures,
    confidence,
    landmarkCount,
    dominantIntent: getDominantIntent(gestures),
  };
};

export const getDominantIntent = (gestures: GestureState) => {
  if (gestures.faceCover) return "Face ignition";
  if (gestures.handsUp) return "Lift melt";
  if (gestures.pinch) return "Pinch warp";
  if (gestures.fastMotion) return "Velocity trails";
  if (gestures.openPalm) return "Palm bloom";
  return "Neutral stance";
};
