// Ported from the FaceViz / INFINIGHTCapture module (src/tracking/types.ts).
// The gesture-tracking data model: landmarks -> tracked hands/pose -> gesture
// state -> a per-frame MotionFrame the compositor draws from.
export type Vec2 = {
  x: number;
  y: number;
};

export type Landmark = Vec2 & {
  z?: number;
  visibility?: number;
};

export type Handedness = "Left" | "Right" | "Unknown";

export type TrackedHand = {
  handedness: Handedness;
  landmarks: Landmark[];
  centroid: Vec2;
  wrist: Vec2;
  openness: number;
  pinch: number;
  velocity: number;
};

export type TrackedPose = {
  landmarks: Landmark[];
  nose?: Vec2;
  leftShoulder?: Vec2;
  rightShoulder?: Vec2;
  leftWrist?: Vec2;
  rightWrist?: Vec2;
};

export type GestureState = {
  handsUp: boolean;
  faceCover: boolean;
  pinch: boolean;
  openPalm: boolean;
  fastMotion: boolean;
  neutral: boolean;
};

export type MotionFrame = {
  timestamp: number;
  hands: TrackedHand[];
  pose?: TrackedPose;
  gestures: GestureState;
  confidence: number;
  landmarkCount: number;
  dominantIntent: string;
};

export type PreviousHandSample = {
  wrist: Vec2;
  timestamp: number;
};
