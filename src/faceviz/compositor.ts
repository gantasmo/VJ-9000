// Ported from the FaceViz / INFINIGHTCapture module (src/rendering/compositor.ts).
// Canvas2D compositor: draws the mirrored camera frame, then gesture-triggered
// effects (fire / melt / warp / bloom) and an optional landmark rig. The only
// change from upstream is resizeCanvas: it now no-ops for an offscreen canvas
// (zero client rect) so an unattached captureStream canvas keeps its set size.
import { pointToCanvas } from "./gestureEngine";
import type { Landmark, MotionFrame, Vec2 } from "./types";

const HAND_CONNECTIONS = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 4],
  [0, 5],
  [5, 6],
  [6, 7],
  [7, 8],
  [0, 9],
  [9, 10],
  [10, 11],
  [11, 12],
  [0, 13],
  [13, 14],
  [14, 15],
  [15, 16],
  [0, 17],
  [17, 18],
  [18, 19],
  [19, 20],
];

const POSE_CONNECTIONS = [
  [11, 12],
  [11, 13],
  [13, 15],
  [12, 14],
  [14, 16],
  [0, 11],
  [0, 12],
];

type CompositorOptions = {
  showRig: boolean;
  effectAmount: number;
  selectedEffect: string;
};

const drawLine = (
  ctx: CanvasRenderingContext2D,
  a: Vec2,
  b: Vec2,
  width: number,
  stroke: string,
  glow = "transparent"
) => {
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = width;
  ctx.strokeStyle = stroke;
  ctx.shadowColor = glow;
  ctx.shadowBlur = glow === "transparent" ? 0 : width * 3;
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
  ctx.restore();
};

const drawPoint = (ctx: CanvasRenderingContext2D, point: Vec2, radius: number, fill: string) => {
  ctx.save();
  ctx.fillStyle = fill;
  ctx.shadowColor = fill;
  ctx.shadowBlur = radius * 2.2;
  ctx.beginPath();
  ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
};

const gradientDisc = (
  ctx: CanvasRenderingContext2D,
  center: Vec2,
  radius: number,
  stops: Array<[number, string]>,
  operation: GlobalCompositeOperation = "screen"
) => {
  const gradient = ctx.createRadialGradient(center.x, center.y, 0, center.x, center.y, radius);
  stops.forEach(([offset, color]) => gradient.addColorStop(offset, color));
  ctx.save();
  ctx.globalCompositeOperation = operation;
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
};

const drawFireFace = (ctx: CanvasRenderingContext2D, motion: MotionFrame, width: number, height: number, amount: number) => {
  if (!motion.pose?.nose) return;
  const nose = pointToCanvas(motion.pose.nose, width, height);
  const t = motion.timestamp / 1000;
  gradientDisc(ctx, nose, 120 * amount, [
    [0, `rgba(255, 244, 146, ${0.52 * amount})`],
    [0.25, `rgba(255, 92, 32, ${0.42 * amount})`],
    [0.63, `rgba(228, 18, 72, ${0.18 * amount})`],
    [1, "rgba(0, 0, 0, 0)"],
  ]);

  ctx.save();
  ctx.globalCompositeOperation = "screen";
  for (let i = 0; i < 28; i += 1) {
    const phase = t * (1.4 + (i % 7) * 0.17) + i * 1.9;
    const x = nose.x + Math.sin(phase) * (24 + (i % 6) * 8) * amount;
    const y = nose.y - 28 - ((i * 17 + t * 80) % 120) * amount;
    const radius = 10 + ((i * 11) % 24);
    const alpha = 0.08 + ((i % 5) / 18);
    ctx.fillStyle = `rgba(255, ${80 + (i % 5) * 32}, 32, ${alpha * amount})`;
    ctx.beginPath();
    ctx.ellipse(x, y, radius * 0.62, radius * 1.4, Math.sin(phase), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
};

const drawHandMelt = (ctx: CanvasRenderingContext2D, motion: MotionFrame, width: number, height: number, amount: number) => {
  ctx.save();
  ctx.globalCompositeOperation = "screen";
  motion.hands.forEach((hand, handIndex) => {
    hand.landmarks.forEach((landmark, index) => {
      if (![4, 8, 12, 16, 20].includes(index)) return;
      const point = pointToCanvas(landmark, width, height);
      const length = (70 + hand.velocity * 160 + index * 4) * amount;
      const hue = handIndex === 0 ? 178 : 48;
      const gradient = ctx.createLinearGradient(point.x, point.y, point.x, point.y + length);
      gradient.addColorStop(0, `hsla(${hue}, 100%, 64%, ${0.42 * amount})`);
      gradient.addColorStop(1, `hsla(${hue + 28}, 100%, 50%, 0)`);
      ctx.strokeStyle = gradient;
      ctx.lineWidth = 10;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(point.x, point.y);
      ctx.bezierCurveTo(
        point.x + Math.sin(motion.timestamp / 280 + index) * 24,
        point.y + length * 0.28,
        point.x - Math.cos(motion.timestamp / 340 + index) * 20,
        point.y + length * 0.74,
        point.x,
        point.y + length
      );
      ctx.stroke();
    });
  });
  ctx.restore();
};

const drawPinchWarp = (ctx: CanvasRenderingContext2D, motion: MotionFrame, width: number, height: number, amount: number) => {
  motion.hands.forEach((hand) => {
    if (hand.pinch < 0.24) return;
    const thumb = hand.landmarks[4];
    const index = hand.landmarks[8];
    if (!thumb || !index) return;
    const center = pointToCanvas(
      {
        x: (thumb.x + index.x) / 2,
        y: (thumb.y + index.y) / 2,
      },
      width,
      height
    );
    const strength = hand.pinch * amount;
    gradientDisc(ctx, center, 96 * strength, [
      [0, `rgba(154, 255, 244, ${0.36 * strength})`],
      [0.45, `rgba(81, 134, 255, ${0.2 * strength})`],
      [1, "rgba(0, 0, 0, 0)"],
    ]);

    ctx.save();
    ctx.globalCompositeOperation = "screen";
    ctx.strokeStyle = `rgba(204, 255, 246, ${0.48 * strength})`;
    ctx.lineWidth = 2;
    for (let i = 0; i < 7; i += 1) {
      ctx.beginPath();
      ctx.arc(center.x, center.y, 18 + i * 13, motion.timestamp / 600 + i, Math.PI * 1.5 + motion.timestamp / 700 + i);
      ctx.stroke();
    }
    ctx.restore();
  });
};

const drawPalmBloom = (ctx: CanvasRenderingContext2D, motion: MotionFrame, width: number, height: number, amount: number) => {
  motion.hands.forEach((hand) => {
    if (hand.openness < 0.38) return;
    const center = pointToCanvas(hand.centroid, width, height);
    gradientDisc(ctx, center, 130 * hand.openness * amount, [
      [0, `rgba(177, 255, 185, ${0.22 * hand.openness * amount})`],
      [0.5, `rgba(72, 255, 201, ${0.2 * amount})`],
      [1, "rgba(0, 0, 0, 0)"],
    ]);
  });
};

const drawRig = (ctx: CanvasRenderingContext2D, motion: MotionFrame, width: number, height: number) => {
  if (motion.pose?.landmarks) {
    POSE_CONNECTIONS.forEach(([start, end]) => {
      const a = motion.pose?.landmarks[start];
      const b = motion.pose?.landmarks[end];
      if (!a || !b) return;
      drawLine(ctx, pointToCanvas(a, width, height), pointToCanvas(b, width, height), 4, "rgba(54, 238, 247, 0.9)", "#36eef7");
    });
  }

  motion.hands.forEach((hand) => {
    HAND_CONNECTIONS.forEach(([start, end]) => {
      const a = hand.landmarks[start];
      const b = hand.landmarks[end];
      if (!a || !b) return;
      const stroke = hand.handedness === "Left" ? "rgba(255, 218, 88, 0.94)" : "rgba(130, 255, 188, 0.94)";
      drawLine(ctx, pointToCanvas(a, width, height), pointToCanvas(b, width, height), 3, stroke, stroke);
    });

    hand.landmarks.forEach((landmark, index) => {
      const point = pointToCanvas(landmark, width, height);
      drawPoint(ctx, point, [4, 8, 12, 16, 20].includes(index) ? 4.5 : 2.8, index === 0 ? "#ffffff" : "#f8f16a");
    });
  });
};

const drawIdleStage = (ctx: CanvasRenderingContext2D, width: number, height: number) => {
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, "#07100e");
  gradient.addColorStop(0.5, "#0c1213");
  gradient.addColorStop(1, "#130b12");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  ctx.save();
  ctx.globalAlpha = 0.36;
  ctx.strokeStyle = "#1c3532";
  ctx.lineWidth = 1;
  for (let x = 0; x < width; x += 42) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  for (let y = 0; y < height; y += 42) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }
  ctx.restore();
};

const resizeCanvas = (canvas: HTMLCanvasElement) => {
  const rect = canvas.getBoundingClientRect();
  // Offscreen canvas (captureStream source, not in the DOM): keep its set size.
  if (rect.width < 1 || rect.height < 1) return;
  const ratio = canvas.classList.contains("output-canvas") ? 1 : window.devicePixelRatio || 1;
  const width = Math.max(2, Math.floor(rect.width * ratio));
  const height = Math.max(2, Math.floor(rect.height * ratio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
};

export const renderFrame = (
  canvas: HTMLCanvasElement,
  video: HTMLVideoElement | null,
  motion: MotionFrame | null,
  options: CompositorOptions
) => {
  resizeCanvas(canvas);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const width = canvas.width;
  const height = canvas.height;
  ctx.clearRect(0, 0, width, height);

  if (video?.videoWidth && video.videoHeight) {
    ctx.save();
    ctx.translate(width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, width, height);
    ctx.restore();
  } else {
    drawIdleStage(ctx, width, height);
  }

  ctx.fillStyle = "rgba(4, 8, 8, 0.08)";
  ctx.fillRect(0, 0, width, height);

  if (!motion) {
    return;
  }

  const gestureAmount = Math.max(0.22, options.effectAmount);
  if (motion.gestures.faceCover || options.selectedEffect === "fire") {
    drawFireFace(ctx, motion, width, height, gestureAmount);
  }
  if (motion.gestures.handsUp || motion.gestures.fastMotion || options.selectedEffect === "melt") {
    drawHandMelt(ctx, motion, width, height, gestureAmount);
  }
  if (motion.gestures.pinch || options.selectedEffect === "warp") {
    drawPinchWarp(ctx, motion, width, height, gestureAmount);
  }
  if (motion.gestures.openPalm || options.selectedEffect === "bloom") {
    drawPalmBloom(ctx, motion, width, height, gestureAmount);
  }
  if (options.showRig) {
    drawRig(ctx, motion, width, height);
  }
};

export const landmarkToUniform = (landmark: Landmark | undefined) => {
  if (!landmark) return [0.5, 0.5, 0] as const;
  return [landmark.x, landmark.y, landmark.z ?? 0] as const;
};
