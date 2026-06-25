/**
 * Monocular depth-estimation worker for the "depthcloud" VJ source.
 *
 * Runs Depth-Anything-V2-small (onnx-community) via transformers.js, on WebGPU
 * (fp16) when available and WebAssembly otherwise, OFF the main thread so the VJ
 * render loop never stalls. Receives downscaled RGBA frames and returns a single-
 * channel relative depth map; the hook unprojects it through the SAME
 * AkvjCloudRenderer as the Kinect cloud.
 *
 * Model id + pipeline API verified against the live HuggingFace docs (not pinned
 * from memory): pipeline('depth-estimation', 'onnx-community/depth-anything-v2-small').
 */
import { pipeline, env, RawImage } from '@huggingface/transformers';

env.allowLocalModels = false; // fetch the model from the HF CDN

const ctx: any = self;
const MODEL_ID = 'onnx-community/depth-anything-v2-small';

let estimator: any = null;
let loading = false;
let curPrecision = 'auto';

// Map the user's precision choice to a transformers.js dtype.
const dtypeFor = (p: string): string => (p === 'fp32' ? 'fp32' : p === 'q8' ? 'q8' : 'fp16');

async function ensure(precision: string): Promise<void> {
  if (estimator || loading) return;
  loading = true;
  const progress_callback = (p: any) => ctx.postMessage({ type: 'progress', progress: p });
  // WebGPU runs the chosen dtype; the wasm fallback prefers q8 on 'auto' since
  // full precision on wasm exhausts the heap ("Array buffer allocation failed").
  const webgpuDtype = dtypeFor(precision);
  const wasmDtype = precision === 'auto' ? 'q8' : dtypeFor(precision);
  try {
    estimator = await pipeline('depth-estimation', MODEL_ID, {
      device: 'webgpu',
      dtype: webgpuDtype as any,
      progress_callback,
    });
    ctx.postMessage({ type: 'ready', backend: `webgpu-${webgpuDtype}` });
  } catch (e: any) {
    try {
      estimator = await pipeline('depth-estimation', MODEL_ID, {
        dtype: wasmDtype as any,
        progress_callback,
      });
      ctx.postMessage({ type: 'ready', backend: `wasm-${wasmDtype}` });
    } catch (e2: any) {
      ctx.postMessage({ type: 'error', message: String(e2?.message ?? e ?? 'pipeline init failed') });
    }
  } finally {
    loading = false;
  }
}

ctx.onmessage = async (ev: MessageEvent) => {
  const msg: any = ev.data;
  if (!msg) return;
  if (msg.type === 'init') {
    curPrecision = msg.precision || 'auto';
    await ensure(curPrecision);
    return;
  }
  if (msg.type !== 'frame') return;
  if (!estimator) {
    await ensure(curPrecision);
    if (!estimator) return;
  }
  try {
    const img = new RawImage(new Uint8ClampedArray(msg.data), msg.width, msg.height, 4);
    const out: any = await estimator(img);
    const depth = out?.depth ?? out;
    const data: Uint8Array = depth.data;
    const copy = data.slice(); // standalone buffer we can transfer
    ctx.postMessage(
      { type: 'depth', data: copy.buffer, width: depth.width, height: depth.height, channels: depth.channels ?? 1 },
      [copy.buffer],
    );
  } catch (e: any) {
    ctx.postMessage({ type: 'error', message: String(e?.message ?? e) });
  }
};
