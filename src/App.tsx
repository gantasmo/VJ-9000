import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { VJState, VideoClip, DEFAULT_VJ_STATE } from './types';
import { useLibraryPool, type PoolItem } from './useLibraryPool';
import { useMedia } from './useMedia';
import { useQuestCast } from './useQuestCast';
import { useQuestStitch } from './useQuestStitch';
import { useAkvj } from './useAkvj';
import { useAkvj3d } from './useAkvj3d';
import { useDepthCloud } from './useDepthCloud';
import { useCymatics } from './useCymatics';
import { useSpectra } from './useSpectra';
import { useShader } from './useShader';
import { useAsciiline } from './useAsciiline';
import { useGesture } from './useGesture';
import { useAudioAnalyzer } from './useAudioAnalyzer';
import { backendBase } from './libraryUpload';
import { useMidi } from './useMidi';
import { VideoOutput } from './components/VideoOutput';
import { ClipGrid } from './components/ClipGrid';
import { LibraryPool } from './components/LibraryPool';
import { Waveform } from './components/Waveform';
import { SourcePreview } from './components/SourcePreview';
import { ControlDeck } from './components/VJControls';
import { ResizeHandle } from './components/ResizeHandle';
import { MidiPanel } from './components/MidiPanel';
import { routeFiles, VJ_FILE_ACCEPT } from './fileRouter';
import { uploadMediaToLibrary } from './libraryUpload';
import {
  subscribeToLoadSet,
  subscribeToLoadTrack,
  subscribeToMidi,
  subscribeToControlSet,
  subscribeToControlRequests,
  subscribeToCamera,
  subscribeToOpenMidiMap,
  sendControlManifest,
  sendControlChanged,
  sendCameraState,
  sendSetLoaded,
  ExternalLoadItem,
} from './sa3Bridge';
import {
  CONTROL_MANIFEST,
  snapshotControlValues,
  coerceControlValue,
  readControlValue,
} from './controlManifest';
import { setActiveAudioController } from './audioRouting';
import { AlertTriangle, Film, X as XIcon, ChevronRight, ChevronLeft, PanelRightOpen, PanelRightClose, PanelLeftClose } from 'lucide-react';

const LOCAL_STORAGE_KEY = 'gantasmo_veejay_state_2';

const loadSavedState = (): VJState => {
  if (typeof window === 'undefined') return DEFAULT_VJ_STATE;
  try {
    const saved = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);

      // Clean up dynamic or temporary runtime attributes to avoid bad states
      parsed.recording = false;
      parsed.layoutMode = 'standard'; // Always reset back to standard to prevent being trapped on refresh

      // Drop session-only blob URLs which won't survive refresh.
      if (parsed.clipUrl && parsed.clipUrl.startsWith('blob:')) {
        parsed.clipUrl = null;
        parsed.clipLabel = null;
        parsed.clipKind = null;
        parsed.activeClipId = null;
      }
      if (parsed.imageUrl && parsed.imageUrl.startsWith('blob:')) {
        parsed.imageUrl = null;
        parsed.imageLabel = null;
      }

      // MIGRATION: Fix old default saturation/contrast values
      if (parsed.saturation === 150) parsed.saturation = 100;
      if (parsed.contrast === 130) parsed.contrast = 100;

      if (parsed.videoBucket) {
        parsed.videoBucket = parsed.videoBucket.filter((c: any) => c && c.url && !c.url.startsWith('blob:'));
      } else {
        parsed.videoBucket = [];
      }

      return { ...DEFAULT_VJ_STATE, ...parsed };
    }
  } catch (e) {
    console.error('Failed to parse VJ state from localStorage:', e);
  }
  return DEFAULT_VJ_STATE;
};

export default function App() {
  const [vjState, setVjState] = useState<VJState>(() => loadSavedState());
  const [routerError, setRouterError] = useState<string | null>(null);
  const [lastSeenCc, setLastSeenCc] = useState<{ cc: number; value: number; channel: number } | null>(null);
  // MIDI mapper open state — controlled here so the SA3 host header can open it
  // over the postMessage bridge (the mapper "moved up" to the host toolbar).
  const [midiPanelOpen, setMidiPanelOpen] = useState(false);
  const pendingSa3PlayRef = useRef<Window | null>(null);
  const clipResumeMapRef = useRef<Record<string, number>>({});
  // Right-hand control deck collapse (standard layout only). Lets the user
  // reclaim the full width for the visualizer without leaving standard mode.
  const [controlsCollapsed, setControlsCollapsed] = useState(false);
  // ── Control-sync echo guard ──────────────────────────────────────
  // When the SA3 host writes a control into VJState we must NOT echo that same
  // change back to the host (it would fight the host's own fader). We stamp the
  // keys the host just set; the diff-emitter skips them for one tick. We also
  // keep the last-emitted snapshot so we only post controls that actually moved.
  const hostWroteRef = useRef<Set<string>>(new Set());
  const lastSentRef = useRef<Record<string, number | boolean>>({});

  const { getAudioLevels, getAudioSpectrum } = useAudioAnalyzer(vjState.audioReactive);

  // Direct Quest source (ADB/scrcpy relay decoded in-app via WebCodecs). Only
  // boots while the user has the QUEST sub-source selected.
  const questFeed = useQuestCast(
    vjState.sourceType === 'camera' && vjState.cameraSource === 'quest',
    vjState.questView ?? 'full',
  );

  // Clean Quest STITCH source — the stitched passthrough RenderTexture streamed
  // on its own (separate from delinQuest, which mirrors the whole headset display).
  const stitchFeed = useQuestStitch(
    vjState.sourceType === 'camera' && vjState.cameraSource === 'queststitch',
  );

  // Cymatics generative source — theDAW's reflective black-chrome visual,
  // audio-reactive, mixable through the CAM↔MEM crossfader + all effects.
  const cymaticsFeed = useCymatics(
    vjState.sourceType === 'camera' && vjState.cameraSource === 'cymatics',
    vjState.cymaticsMode ?? 'orb',
    getAudioLevels,
  );

  // AKVJ source — a Unity desktop visual (e.g. the Azure-Kinect depth VFX app)
  // streamed in over the akvj backend bridge as MJPEG. Only boots while selected.
  const akvjFeed = useAkvj(
    vjState.sourceType === 'camera' && vjState.cameraSource === 'akvj',
  );

  // Native Kinect source — the headless pyk4a sidecar streams depth + colour and
  // this renders the point cloud in three.js (no Unity). Auto-spawns the sidecar
  // via POST /api/akvj/start while selected.
  // Shared global cloud controls for KINECT + DEPTH (speed/orbit/size/density/
  // brightness/bloom/wind/trails/distance).
  const akvjParams = {
    spin: vjState.akvjSpin ?? 0,
    speed: vjState.akvjSpeed ?? 1,
    size: vjState.akvjSize ?? 1,
    density: vjState.akvjDensity ?? 1,
    bright: vjState.akvjBright ?? 1,
    bloom: vjState.akvjBloom ?? 0.5,
    wind: vjState.akvjWind ?? 0,
    trails: vjState.akvjTrails ?? 0,
    distance: vjState.akvjDistance ?? 1,
    renderFps: vjState.akvjRenderFps ?? 60,
  };

  const akvj3dFeed = useAkvj3d(
    vjState.sourceType === 'camera' && vjState.cameraSource === 'akvj3d',
    getAudioLevels,
    vjState.akvjMode ?? 'points',
    akvjParams,
  );

  // Monocular-depth source — turns the loaded clip (else the webcam) into a live
  // point cloud via in-browser Depth-Anything, through the same renderer/styles.
  const depthCloudFeed = useDepthCloud(
    vjState.sourceType === 'camera' && vjState.cameraSource === 'depthcloud',
    getAudioLevels,
    vjState.akvjMode ?? 'points',
    akvjParams,
    vjState.clipUrl ?? null,
    { precision: vjState.depthPrecision ?? 'auto', res: vjState.depthRes ?? 320, fps: vjState.depthFps ?? 8 },
  );

  // SPECTRA-RIDER source — a 3D audio spectrogram-terrain visual, fed the VJ's
  // own audio (a 128-bin spectrum when available, else the 4 master bands).
  // Mixable through the CAM↔MEM crossfader + all effects like any other source.
  const spectraSettings = {
    sensitivity: vjState.spectraSensitivity ?? 1,
    smoothing: vjState.spectraSmoothing ?? 0.65,
    noiseGate: vjState.spectraNoiseGate ?? 0.06,
    heightMulti: vjState.spectraHeight ?? 1,
    energyImpact: vjState.spectraEnergy ?? 1,
  };
  const spectraFeed = useSpectra(
    vjState.sourceType === 'camera' && vjState.cameraSource === 'spectra',
    getAudioSpectrum,
    getAudioLevels,
    vjState.spectraMode ?? 'dynamic',
    vjState.spectraTheme ?? 'mel-spectrogram',
    spectraSettings,
    vjState.spectraAutoRotate ?? true,
  );

  // Generic GLSL shader source — a fullscreen atzedent-style fragment shader
  // (yotta seeds the library) rendered as a generative source, its camera scrub
  // accelerated by the VJ's live audio energy. Mixable like any other source.
  const shaderFeed = useShader(
    vjState.sourceType === 'camera' && vjState.cameraSource === 'shader',
    getAudioLevels,
    vjState.shaderId ?? 'yotta',
    vjState.shaderAudioDrive ?? 1,
  );

  // ASCII source — the upstream frame (loaded clip, else webcam) re-rendered as
  // live GPU ASCII glyphs (a port of ASCILINE). Mixable like any other source.
  const asciiSettings = {
    cols: vjState.asciiCols ?? 160,
    mono: vjState.asciiMono ?? false,
    accent: vjState.asciiAccent ?? '#00ff41',
  };
  const asciilineFeed = useAsciiline(
    vjState.sourceType === 'camera' && vjState.cameraSource === 'asciiline',
    getAudioLevels,
    vjState.clipUrl ?? null,
    asciiSettings,
  );

  // Body-pose control: webcam MediaPipe pose -> six scalars forwarded to theDAW's
  // control bus. Control data only (no stream), runs alongside any visual source.
  useGesture(vjState.gestureControl ?? false);

  const { videoRef, cameraVideoRef, clipVideoRef, error, isInitializing } = useMedia(
    vjState.sourceType,
    vjState.clipUrl,
    vjState.cameraSource ?? 'device',
    vjState.cameraDeviceId,
    vjState.cameraReinit ?? 0,
    questFeed.stream,
    cymaticsFeed.stream,
    stitchFeed.stream,
    akvjFeed.stream,
    akvj3dFeed.stream,
    depthCloudFeed.stream,
    spectraFeed.stream,
    shaderFeed.stream,
    asciilineFeed.stream,
  );

  // SA3 → VJ playback commands. The PlayerFooter in SA3 sends
  // { type: 'sa3-vj/playback', action: 'play' | 'pause' } when the
  // user clicks the main Play/Pause button while on the VJ tab. We
  // forward that to the actual <video> element here. After the
  // play/pause settles we echo back the resulting state so SA3's UI
  // shows the right icon.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const d = event.data;
      if (!d || typeof d !== 'object') return;
      if (d.type !== 'sa3-vj/playback') return;
      const video = videoRef.current;
      const echo = (state: 'playing' | 'paused', detail?: string) => {
        try {
          (event.source as Window | null)?.postMessage(
            { type: 'sa3-vj/playback-state', state, detail },
            '*',
          );
        } catch { /* parent not reachable; ignore */ }
      };
      if (d.action === 'play') {
        if (!video) {
          echo('paused', 'video element unavailable');
          return;
        }
        if (vjState.sourceType === 'clip' && !vjState.clipUrl && vjState.videoBucket.length > 0) {
          const fallback = vjState.videoBucket.find((clip) => clip.id === vjState.activeClipId) ?? vjState.videoBucket[0];
          pendingSa3PlayRef.current = event.source as Window | null;
          setVjState((prev) => ({
            ...prev,
            sourceType: 'clip',
            activeClipId: fallback.id,
            clipUrl: fallback.url,
            clipLabel: fallback.name,
            clipKind: fallback.kind ?? 'video',
          }));
          return;
        }
        if (vjState.sourceType === 'clip' && !vjState.clipUrl) {
          echo('paused', 'no clip loaded');
          return;
        }
        video.play().then(() => echo('playing')).catch((err) => {
          echo('paused', err instanceof Error ? err.message : String(err));
        });
      } else if (d.action === 'pause') {
        pendingSa3PlayRef.current = null;
        if (!video) {
          echo('paused', 'video element unavailable');
          return;
        }
        video.pause();
        echo('paused');
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [videoRef, vjState.activeClipId, vjState.clipUrl, vjState.sourceType, vjState.videoBucket]);

  useEffect(() => {
    if (!pendingSa3PlayRef.current || !vjState.clipUrl) return;
    const source = pendingSa3PlayRef.current;
    const video = videoRef.current;
    if (!video) return;
    const echo = (state: 'playing' | 'paused', detail?: string) => {
      try {
        source.postMessage({ type: 'sa3-vj/playback-state', state, detail }, '*');
      } catch { /* parent not reachable; ignore */ }
    };
    const playAfterSrcSettles = () => {
      video.play().then(() => echo('playing')).catch((err) => {
        echo('paused', err instanceof Error ? err.message : String(err));
      });
    };
    if (video.readyState >= 2) playAfterSrcSettles();
    else video.addEventListener('loadeddata', playAfterSrcSettles, { once: true });
    pendingSa3PlayRef.current = null;
    return () => video.removeEventListener('loadeddata', playAfterSrcSettles);
  }, [videoRef, vjState.clipUrl]);

  // Stable identity so the memoized ControlDeck doesn't re-render on unrelated
  // App updates. setVjState is itself stable, so no deps are needed.
  const updateState = useCallback((updates: Partial<VJState>) => {
    setVjState((prev) => ({ ...prev, ...updates }));
  }, []);

  // Library pool — the shared SA3 media library, browsable inside the VJ. Only
  // fetched in the standard layout (where the pool browser is shown).
  const pool = useLibraryPool(vjState.layoutMode === 'standard');
  const stagedIds = useMemo(
    () => new Set(vjState.videoBucket.map((c) => c.id)),
    [vjState.videoBucket],
  );

  // Stage a pool item into the banks. Video/audio append to the bucket as a
  // reference (no copy) and go live; an image becomes the backdrop slot. Already
  // staged → just re-activate it. Matches the load-track ingest id scheme so a
  // DJ→VJ hand-off of the same track collapses to one entry.
  const stagePoolItem = useCallback((item: PoolItem) => {
    if (item.kind === 'image') {
      updateState({ imageUrl: item.url, imageLabel: item.name });
      return;
    }
    const name = item.name.length > 25 ? `${item.name.slice(0, 21)}...` : item.name;
    setVjState((prev) => {
      const base = {
        activeClipId: item.id,
        clipUrl: item.url,
        clipLabel: name,
        clipKind: 'video' as const,
        sourceType: 'clip' as const,
        sourceBlend: 1,
      };
      if (prev.videoBucket.some((c) => c.id === item.id)) {
        return { ...prev, ...base };
      }
      const clip: VideoClip = { id: item.id, name, url: item.url, kind: 'video' };
      return { ...prev, videoBucket: [...prev.videoBucket, clip], ...base };
    });
  }, [updateState]);

  // Stage a pool item into a SPECIFIC bank slot (drag-drop onto a cell). New
  // items are inserted at the dropped position; an already-staged item moves
  // there. Index is clamped so a drop past the end appends.
  const stagePoolItemAt = useCallback((item: PoolItem, index: number) => {
    if (item.kind === 'image') {
      updateState({ imageUrl: item.url, imageLabel: item.name });
      return;
    }
    const name = item.name.length > 25 ? `${item.name.slice(0, 21)}...` : item.name;
    setVjState((prev) => {
      const bucket = prev.videoBucket.slice();
      const existing = bucket.findIndex((c) => c.id === item.id);
      const clip: VideoClip =
        existing >= 0 ? bucket.splice(existing, 1)[0] : { id: item.id, name, url: item.url, kind: 'video' };
      const target = Math.max(0, Math.min(index, bucket.length));
      bucket.splice(target, 0, clip);
      return {
        ...prev,
        videoBucket: bucket,
        activeClipId: clip.id,
        clipUrl: clip.url,
        clipLabel: clip.name,
        clipKind: 'video',
        sourceType: 'clip',
        sourceBlend: 1,
      };
    });
  }, [updateState]);

  // Reorder an already-staged clip to a specific slot (drag a bank cell).
  const moveClipToIndex = useCallback((clipId: string, index: number) => {
    setVjState((prev) => {
      const bucket = prev.videoBucket.slice();
      const from = bucket.findIndex((c) => c.id === clipId);
      if (from < 0) return prev;
      const [clip] = bucket.splice(from, 1);
      const target = Math.max(0, Math.min(index, bucket.length));
      bucket.splice(target, 0, clip);
      return { ...prev, videoBucket: bucket };
    });
  }, []);

  const unstagePoolItem = useCallback((id: string) => {
    setVjState((prev) => {
      const filtered = prev.videoBucket.filter((c) => c.id !== id);
      const patch: Partial<VJState> = { videoBucket: filtered };
      if (id === prev.activeClipId) {
        patch.activeClipId = filtered[0]?.id ?? null;
        patch.clipUrl = filtered[0]?.url ?? null;
      }
      return { ...prev, ...patch };
    });
  }, []);

  // Auto-default the live source to QUEST when an ADB device (Quest) is
  // connected at load. Checked once on mount; only overrides the plain
  // 'device' camera default — a deliberate screen/cymatics choice or a clip is
  // left alone.
  const questAutoChecked = useRef(false);
  useEffect(() => {
    if (questAutoChecked.current) return;
    questAutoChecked.current = true;
    let cancelled = false;
    let attempts = 0;
    const check = async () => {
      if (cancelled) return;
      attempts += 1;
      try {
        const res = await fetch(`${backendBase()}/api/questcast/devices`);
        const body = await res.json();
        const hasDevice =
          Array.isArray(body?.devices) &&
          body.devices.some((d: { state?: string }) => (d?.state ?? 'device') === 'device');
        if (hasDevice) {
          setVjState((prev) => {
            if (prev.sourceType === 'camera' && (prev.cameraSource ?? 'device') === 'device') {
              return { ...prev, cameraSource: 'quest', sourceBlend: 0, cameraReinit: (prev.cameraReinit ?? 0) + 1 };
            }
            return prev;
          });
          return;
        }
      } catch {
        /* backend / adb not up yet */
      }
      // adb + the backend can take a few seconds to enumerate the headset after
      // boot, so retry a handful of times before giving up on Quest as default.
      if (!cancelled && attempts < 6) setTimeout(() => void check(), 1800);
    };
    void check();
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Control sync: SA3 SLIDE tab ⇄ VJ controls ────────────────────
  // (1) Host → VJ: apply inbound control-set writes (range/toggle), marking
  //     each key so the diff-emitter below doesn't echo it back.
  // (2) Host handshake: answer request-controls with the manifest + a live
  //     snapshot so the SLIDE tab can build matching lanes at current values.
  useEffect(() => {
    const unsubSet = subscribeToControlSet(({ key, value }) => {
      const coerced = coerceControlValue(key, value);
      if (coerced === null) return;
      hostWroteRef.current.add(key);
      lastSentRef.current[key] = coerced; // host value is now the known state
      setVjState((prev) => ({ ...prev, [key]: coerced }) as VJState);
    });
    const unsubReq = subscribeToControlRequests(() => {
      setVjState((prev) => {
        const values = snapshotControlValues(prev);
        lastSentRef.current = { ...values };
        sendControlManifest(CONTROL_MANIFEST, values);
        return prev; // read-only snapshot
      });
    });
    return () => { unsubSet(); unsubReq(); };
  }, []);

  // SA3 host header → open the MIDI mapping panel (the mapper button moved "up"
  // to the host toolbar; this opens the same panel over the bridge).
  useEffect(() => subscribeToOpenMidiMap(() => setMidiPanelOpen(true)), []);

  // SA3 VJ toolbar → camera on/off. Flip the source between the live camera and
  // the clip/memory buffer (the CAM↔MEM crossfader's two ends).
  useEffect(() => {
    const unsub = subscribeToCamera((on) => {
      setVjState((prev) => ({
        ...prev,
        sourceType: on ? 'camera' : 'clip',
        sourceBlend: on ? 0 : 1,
      }));
    });
    return unsub;
  }, []);

  // Echo the live camera state whenever the source (or its getUserMedia error)
  // changes, so the SA3 toolbar button stays honest even when the source is
  // switched from inside the VJ app (its own controls / the MIDI crossfader).
  useEffect(() => {
    sendCameraState(vjState.sourceType === 'camera', error);
  }, [vjState.sourceType, error]);

  // (3) VJ → Host: whenever VJState changes, emit control-changed for any
  //     manifest control whose value differs from what we last sent — EXCEPT
  //     keys the host just wrote (those are skipped once, then cleared).
  useEffect(() => {
    const skip = hostWroteRef.current;
    for (const entry of CONTROL_MANIFEST) {
      const current = readControlValue(vjState, entry.key);
      if (skip.has(entry.key)) {
        lastSentRef.current[entry.key] = current;
        continue;
      }
      if (lastSentRef.current[entry.key] !== current) {
        lastSentRef.current[entry.key] = current;
        sendControlChanged(entry.key, current);
      }
    }
    hostWroteRef.current = new Set();
  }, [vjState]);

  const normalizeIncomingClip = (item: ExternalLoadItem): VideoClip | null => {
    const rawUrl = typeof item.url === 'string' ? item.url.trim() : '';
    if (!rawUrl) return null;
    const rawKind = typeof item.kind === 'string' ? item.kind.toLowerCase() : '';
    if (rawKind === 'image') return null;
    const kind: VideoClip['kind'] = rawKind === 'audio' ? 'audio' : 'video';
    const label =
      (typeof item.label === 'string' && item.label.trim()) ||
      (typeof item.name === 'string' && item.name.trim()) ||
      (typeof item.title === 'string' && item.title.trim()) ||
      'Imported clip';
    const key =
      (typeof item.entryId === 'string' && item.entryId) ||
      (typeof item.id === 'string' && item.id) ||
      rawUrl;
    return {
      id: `sa3-${key}`,
      name: label.length > 25 ? `${label.slice(0, 21)}...` : label,
      url: rawUrl,
      kind,
    };
  };

  // Web MIDI integration. Mapped CCs / notes patch VJState directly;
  // audio analysis (mic / SA3 parent bridge) still flows independently
  // through useAudioAnalyzer — both drive the visualizer simultaneously.
  const midi = useMidi({
    onCcChange: (cc, value, channel) => setLastSeenCc({ cc, value, channel }),
    onParamChange: (key, value) => {
      setVjState((prev) => ({ ...prev, [key]: value }));
    },
  });

  // Keep the audio-react routes in sync with the active controller, so the same
  // device reloads BOTH its MIDI map (useMidi) and its audio-react config.
  useEffect(() => {
    setActiveAudioController(midi.activeController);
  }, [midi.activeController]);

  useEffect(() => {
    try {
      const stateToSave: any = { ...vjState };
      if (stateToSave.videoBucket) {
        stateToSave.videoBucket = stateToSave.videoBucket.filter(
          (c: VideoClip) => c && c.url && !c.url.startsWith('blob:'),
        );
      }
      if (stateToSave.clipUrl && stateToSave.clipUrl.startsWith('blob:')) {
        stateToSave.clipUrl = DEFAULT_VJ_STATE.clipUrl;
        stateToSave.clipLabel = null;
        stateToSave.clipKind = null;
        stateToSave.activeClipId = DEFAULT_VJ_STATE.activeClipId;
      }
      if (stateToSave.imageUrl && stateToSave.imageUrl.startsWith('blob:')) {
        stateToSave.imageUrl = null;
        stateToSave.imageLabel = null;
      }
      localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(stateToSave));
    } catch (e) {
      console.error('Failed to persist VJState changes to localStorage:', e);
    }
  }, [vjState]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && vjState.layoutMode === 'fullscreen') {
        updateState({ layoutMode: 'standard' });
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [vjState.layoutMode]);

  // SA3 host -> sidecar set/track ingestion. Incoming set entries are
  // appended to the same archive bucket used by local imports, and we
  // activate the most recently loaded clip so DJ->VJ handoff is immediate.
  useEffect(() => {
    const ingest = (items: ExternalLoadItem[]): number => {
      const incoming = items.map(normalizeIncomingClip).filter((c): c is VideoClip => c !== null);
      if (incoming.length === 0) return 0;
      setVjState((prev) => {
        const dedup = new Map(prev.videoBucket.map((clip) => [clip.id, clip]));
        for (const clip of incoming) dedup.set(clip.id, clip);
        const merged = Array.from(dedup.values());
        const activate = incoming[incoming.length - 1];
        return {
          ...prev,
          videoBucket: merged,
          activeClipId: activate.id,
          clipUrl: activate.url,
          clipLabel: activate.name,
          clipKind: activate.kind ?? 'video',
          sourceType: 'clip',
          sourceBlend: 1,
        };
      });
      return incoming.length;
    };

    const unsubSet = subscribeToLoadSet((payload) => {
      sendSetLoaded(ingest(payload.items ?? []), payload.name ?? null);
    });
    const unsubTrack = subscribeToLoadTrack((payload) => {
      sendSetLoaded(ingest(payload.item ? [payload.item] : []), payload.name ?? null);
    });
    return () => {
      unsubSet();
      unsubTrack();
    };
  }, []);

  // Preserve playback position per clip, so switching clips and returning
  // resumes from last position instead of restarting from 0 every time.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onTimeUpdate = () => {
      const id = vjState.activeClipId;
      if (!id || !Number.isFinite(video.currentTime)) return;
      clipResumeMapRef.current[id] = video.currentTime;
    };
    video.addEventListener('timeupdate', onTimeUpdate);
    return () => {
      video.removeEventListener('timeupdate', onTimeUpdate);
    };
  }, [videoRef, vjState.activeClipId]);

  useEffect(() => {
    const id = vjState.activeClipId;
    if (!id || !vjState.clipUrl) return;
    const resumeAt = clipResumeMapRef.current[id];
    if (typeof resumeAt !== 'number' || resumeAt <= 0) return;
    const video = videoRef.current;
    if (!video) return;
    const restore = () => {
      try {
        const maxStart = Number.isFinite(video.duration) && video.duration > 0
          ? Math.max(0, video.duration - 0.05)
          : Number.POSITIVE_INFINITY;
        video.currentTime = Math.min(resumeAt, maxStart);
      } catch {
        /* some streams reject random seek; ignore */
      }
    };
    if (video.readyState >= 1) restore();
    else video.addEventListener('loadedmetadata', restore, { once: true });
    return () => video.removeEventListener('loadedmetadata', restore);
  }, [videoRef, vjState.activeClipId, vjState.clipUrl]);

  // Host MIDI shortcuts for live set control:
  // - CC1 (mod wheel) maps to CAM↔MEM crossfader
  // - Note C3 (48) selects previous clip
  // - Note D3 (50) selects next clip
  useEffect(() => {
    const moveActive = (dir: -1 | 1) => {
      setVjState((prev) => {
        if (prev.videoBucket.length === 0) return prev;
        const currentIdx = prev.videoBucket.findIndex((c) => c.id === prev.activeClipId);
        const startIdx = currentIdx >= 0 ? currentIdx : 0;
        const nextIdx = (startIdx + dir + prev.videoBucket.length) % prev.videoBucket.length;
        const chosen = prev.videoBucket[nextIdx];
        return {
          ...prev,
          activeClipId: chosen.id,
          clipUrl: chosen.url,
          clipLabel: chosen.name,
          clipKind: chosen.kind ?? 'video',
          sourceType: 'clip',
          sourceBlend: 1,
        };
      });
    };

    const unsub = subscribeToMidi((msg) => {
      const [status, data1, data2] = msg.data;
      const command = status & 0xf0;
      if (command === 0xb0) {
        // CC 1 = crossfader
        if (data1 === 1) {
          const blend = Math.max(0, Math.min(1, (Number(data2) || 0) / 127));
          setVjState((prev) => ({
            ...prev,
            sourceBlend: blend,
            sourceType: blend < 0.5 ? 'camera' : 'clip',
          }));
        }
      } else if (command === 0x90 && data2 > 0) {
        if (data1 === 48) moveActive(-1);
        if (data1 === 50) moveActive(1);
      }
    });
    return unsub;
  }, []);

  useEffect(() => {
    if (vjState.layoutMode === 'fullscreen') {
      const elem = document.documentElement;
      if (elem.requestFullscreen) {
        elem.requestFullscreen().catch(() => {});
      }
    } else {
      if (document.fullscreenElement && document.exitFullscreen) {
        document.exitFullscreen().catch(() => {});
      }
    }
  }, [vjState.layoutMode]);

  // Listen for native exit fullscreen (like physical ESC key press handled by browser)
  useEffect(() => {
     const handleFullscreenChange = () => {
         if (!document.fullscreenElement && vjState.layoutMode === 'fullscreen') {
             updateState({ layoutMode: 'standard' });
         }
     };
     document.addEventListener('fullscreenchange', handleFullscreenChange);
     return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, [vjState.layoutMode]);

  const resetState = () => setVjState(DEFAULT_VJ_STATE);

  const handleAutopilotSwitchClip = () => {
    setVjState((prev) => {
      if (prev.videoBucket.length <= 1) return prev;
      const choices = prev.videoBucket.filter(c => c.id !== prev.activeClipId);
      if (choices.length === 0) return prev;
      const index = Math.floor(Math.random() * choices.length);
      const chosen = choices[index];
      return {
        ...prev,
        activeClipId: chosen.id,
        clipUrl: chosen.url,
        clipLabel: chosen.name,
        clipKind: chosen.kind ?? 'video',
      };
    });
  };

  // Auto-advance: when the current clip ends, hop to the next entry
  // in the bucket. Polls the underlying <video> for 'ended' since
  // useMedia owns the ref and we don't want to plumb listeners up.
  useEffect(() => {
    if (!vjState.playlistAutoAdvance || vjState.videoBucket.length < 2) return;
    const id = window.setInterval(() => {
      const v = document.querySelector('video');
      if (v && v.ended) {
        setVjState((prev) => {
          if (prev.videoBucket.length === 0) return prev;
          const currentIdx = prev.videoBucket.findIndex(c => c.id === prev.activeClipId);
          const nextIdx = (currentIdx + 1) % prev.videoBucket.length;
          const chosen = prev.videoBucket[nextIdx];
          return {
            ...prev,
            activeClipId: chosen.id,
            clipUrl: chosen.url,
            clipLabel: chosen.name,
            clipKind: chosen.kind ?? 'video',
          };
        });
      }
    }, 250);
    return () => window.clearInterval(id);
  }, [vjState.playlistAutoAdvance, vjState.videoBucket.length, vjState.activeClipId]);

  /** Multi-file router entry point used by the welcome-state file
   *  picker, the controls deck picker, and the drop handler. Detects
   *  video / audio / image per file. Audio/video clips append to the
   *  bucket; images set the backdrop. Rejects unsupported types with
   *  a soft error banner instead of crashing the renderer. */
  const handleFiles = (filesList: FileList | File[] | null) => {
    if (!filesList) return;
    const files = Array.from(filesList);
    if (files.length === 0) return;

    const { newClips, imagePatch, autoReactive, errors, clipFiles, imageFile } = routeFiles(files);

    if (errors.length > 0) {
      const first = errors[0];
      setRouterError(
        `${errors.length} file${errors.length === 1 ? '' : 's'} skipped — unsupported type (e.g. ${first.mime || '?'} / ${first.name}). Use video / audio / image.`,
      );
      window.setTimeout(() => setRouterError(null), 4500);
    } else {
      setRouterError(null);
    }

    if (newClips.length === 0 && !imagePatch) return;

    setVjState((prev) => {
      const next: VJState = { ...prev };
      if (imagePatch) {
        Object.assign(next, imagePatch);
      }
      if (newClips.length > 0) {
        next.videoBucket = [...prev.videoBucket, ...newClips];
        const activate = newClips[newClips.length - 1];
        next.activeClipId = activate.id;
        next.clipUrl = activate.url;
        next.clipLabel = activate.name;
        next.clipKind = activate.kind ?? 'video';
        next.sourceType = 'clip';
        if (autoReactive) next.audioReactive = true;
      }
      return next;
    });

    // Persist video clips + an image backdrop to the library so the cue
    // survives a reload. The blob URLs above are instant preview; once an
    // upload lands we swap in the stable /api/library/media/<id> URL and
    // revoke the blob. Audio clips stay session-only (not library media).
    void persistImports(clipFiles, imageFile);
  };

  /** Upload originals to the library and swap blob URLs for stable ones.
   *  Best-effort: a failed upload keeps the session blob (works until
   *  reload) so a backend hiccup never loses the clip mid-set. */
  const persistImports = async (
    clipFiles: Array<{ clipId: string; file: File }>,
    imageFile: File | null,
  ) => {
    for (const { clipId, file } of clipFiles) {
      try {
        const up = await uploadMediaToLibrary(file);
        let staleBlob: string | null = null;
        setVjState((prev) => {
          const existing = prev.videoBucket.find((c) => c.id === clipId);
          if (!existing) return prev; // removed before the upload finished
          if (existing.url.startsWith('blob:')) staleBlob = existing.url;
          const videoBucket = prev.videoBucket.map((c) =>
            c.id === clipId ? { ...c, url: up.mediaUrl } : c,
          );
          const patch: Partial<VJState> =
            prev.activeClipId === clipId ? { clipUrl: up.mediaUrl } : {};
          return { ...prev, videoBucket, ...patch };
        });
        // Revoke after the swap settles so the active <video> has already
        // re-pointed at the stable URL (avoids a decode-error flash).
        if (staleBlob) {
          const dead = staleBlob;
          window.setTimeout(() => {
            try { URL.revokeObjectURL(dead); } catch { /* already gone */ }
          }, 2000);
        }
      } catch (e) {
        console.warn('VJ: library persist failed; keeping session clip:', e);
      }
    }

    if (imageFile) {
      try {
        const up = await uploadMediaToLibrary(imageFile);
        let staleBlob: string | null = null;
        setVjState((prev) => {
          if (prev.imageUrl && prev.imageUrl.startsWith('blob:')) staleBlob = prev.imageUrl;
          return { ...prev, imageUrl: up.mediaUrl };
        });
        if (staleBlob) {
          const dead = staleBlob;
          window.setTimeout(() => {
            try { URL.revokeObjectURL(dead); } catch { /* already gone */ }
          }, 2000);
        }
      } catch (e) {
        console.warn('VJ: image persist failed; keeping session backdrop:', e);
      }
    }
  };

  // Shared prop bundle so the deck can render twice in the 3-column shell (left
  // 'composition' + right 'browser') without duplicating its long prop list.
  const controlDeckProps = {
    state: vjState,
    updateState,
    reset: resetState,
    hasCameraError: !!error && vjState.sourceType === 'camera',
    questState: questFeed.state, questError: questFeed.error, questFps: questFeed.fps, questLog: questFeed.log,
    stitchState: stitchFeed.state, stitchError: stitchFeed.error, stitchFps: stitchFeed.fps, stitchLog: stitchFeed.log,
    akvjState: akvjFeed.state, akvjError: akvjFeed.error, akvjFps: akvjFeed.fps, akvjLog: akvjFeed.log,
    akvj3dState: akvj3dFeed.state, akvj3dError: akvj3dFeed.error, akvj3dFps: akvj3dFeed.fps, akvj3dLog: akvj3dFeed.log,
    akvj3dSensorState: akvj3dFeed.sidecarState, akvj3dSensorLabel: akvj3dFeed.sidecarLabel,
    depthState: depthCloudFeed.state, depthBackend: depthCloudFeed.backend, depthProgress: depthCloudFeed.progress, depthFps: depthCloudFeed.fps, depthError: depthCloudFeed.error, depthLog: depthCloudFeed.log,
  };

  return (
    <div
      className="w-full h-screen flex flex-col bg-black text-white overflow-hidden font-sans"
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }}
      onDrop={(e) => {
        e.preventDefault();
        handleFiles(e.dataTransfer.files);
      }}
    >

      {/* Full-width audio scope pinned at the very top of the standard layout,
          above the video banks. */}
      {vjState.layoutMode === 'standard' && (
        <div className="shrink-0 h-9 w-full border-b border-zinc-800 bg-[#07070b]">
          <Waveform getAudioLevels={getAudioLevels} />
        </div>
      )}

      {/* Full-width clip-grid banks strip — spans the top above the three
          columns (collapsible; ClipGrid owns its own collapse + height). */}
      {vjState.layoutMode === 'standard' && (
        <div className="shrink-0 w-full border-b border-zinc-800">
          <ClipGrid
            state={vjState}
            updateState={updateState}
            onFiles={handleFiles}
            onStagePoolItem={stagePoolItem}
            onStagePoolItemAt={stagePoolItemAt}
            onMoveClipToIndex={moveClipToIndex}
          />
        </div>
      )}

      {/* Body row: left composition column + centered output + right browser
          column, each drag-resizable and collapsible. */}
      <div className="flex flex-1 min-h-0 w-full">

      {/* Left COMPOSITION column (3-column shell): the deck's header + effect
          decks + autopilot + sync bus. Drag-resizable width, collapsible. */}
      {vjState.layoutMode === 'standard' && !vjState.leftPanelCollapsed && (
        <aside
          className="relative z-30 shrink-0 border-r border-zinc-800 bg-[#111] overflow-hidden flex flex-col"
          style={{ width: vjState.vjLeftW ?? 320 }}
        >
          <div className="flex items-center justify-end px-1 py-0.5 border-b border-zinc-800 shrink-0">
            <button
              type="button"
              onClick={() => updateState({ leftPanelCollapsed: true })}
              className="p-1 rounded text-zinc-500 hover:text-white hover:bg-zinc-800"
              title="Collapse composition column"
              aria-label="Collapse composition column"
              aria-expanded
            >
              <PanelLeftClose className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="flex-1 min-h-0 overflow-hidden">
            <ControlDeck region="composition" {...controlDeckProps} />
          </div>
        </aside>
      )}
      {vjState.layoutMode === 'standard' && !vjState.leftPanelCollapsed && (
        <ResizeHandle
          orientation="vertical"
          title="Resize composition column"
          onDrag={(d) => updateState({ vjLeftW: Math.max(220, Math.min(560, (vjState.vjLeftW ?? 320) + d)) })}
        />
      )}
      {vjState.layoutMode === 'standard' && vjState.leftPanelCollapsed && (
        <button
          type="button"
          onClick={() => updateState({ leftPanelCollapsed: false })}
          className="relative z-30 w-6 shrink-0 border-r border-zinc-800 bg-[#111] text-zinc-500 hover:text-cyan-300 flex items-center justify-center"
          title="Expand composition column"
          aria-label="Expand composition column"
          aria-expanded={false}
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      )}

      {/* Center column: Resolume-style output monitor. In standard mode the left
          column wraps just <main>; in other modes it becomes `display:contents`
          so <main> stays a direct flex child and split/preview/fullscreen keep
          working. */}
      <div className={vjState.layoutMode === 'standard' ? 'flex flex-col flex-1 min-w-0 min-h-0' : 'contents'}>
      {/* Master Visualizer Component */}
      <main
        onDoubleClick={() => {
          if (vjState.layoutMode === 'fullscreen') updateState({ layoutMode: 'standard' });
        }}
        title={vjState.layoutMode === 'fullscreen' ? 'Double click to exit fullscreen' : ''}
        className={`
          ${vjState.layoutMode === 'fullscreen' ? 'fixed inset-0 z-50' : 'relative'}
          ${vjState.layoutMode === 'split' ? 'w-1/2 flex-none' : ''}
          ${vjState.layoutMode === 'preview' ? 'w-1/4 flex-none' : ''}
          ${vjState.layoutMode === 'standard' ? 'flex-1' : ''}
          cursor-crosshair bg-black transition-all duration-500
        `}
      >
        {/* Image backdrop layer — sits BEHIND the WebGL canvas so the
            visualizer's effects still compose on top of it. Visible
            only when the user has loaded an image via the file router. */}
        {vjState.imageUrl && (
          <div
            className="absolute inset-0 bg-center bg-no-repeat bg-contain z-0 pointer-events-none"
            style={{ backgroundImage: `url(${vjState.imageUrl})` }}
          />
        )}

        <VideoOutput
           vjState={vjState}
           videoRef={videoRef as any}
           cameraVideoRef={cameraVideoRef as any}
           clipVideoRef={clipVideoRef as any}
           getAudioLevels={getAudioLevels}
           onAutopilotSwitchClip={handleAutopilotSwitchClip}
        />

        {/* "Now loaded" pills — show what file is currently feeding
            the renderer. Image gets its own dismiss button so the
            user can clear it without affecting the audio/video clip. */}
        {(vjState.clipUrl || vjState.imageUrl) && (
          <div className="absolute top-2 left-2 z-30 flex flex-col gap-1 pointer-events-none">
            {vjState.clipUrl && (
              <div className="flex items-center gap-1.5 px-2 py-1 bg-black/60 backdrop-blur-sm border border-cyan-500/40 rounded text-[10px] font-mono uppercase tracking-widest text-cyan-200 pointer-events-auto">
                <span className="text-cyan-400">{vjState.clipKind === 'audio' ? 'AUDIO' : 'VIDEO'}</span>
                <span className="text-zinc-300 truncate max-w-60">{vjState.clipLabel || '—'}</span>
                <button
                  className="text-zinc-500 hover:text-rose-300"
                  onClick={() => updateState({ clipUrl: null, clipLabel: null, clipKind: null, activeClipId: null })}
                  title="Eject clip"
                >
                  <XIcon className="w-2.5 h-2.5" />
                </button>
              </div>
            )}
            {vjState.imageUrl && (
              <div className="flex items-center gap-1.5 px-2 py-1 bg-black/60 backdrop-blur-sm border border-purple-500/40 rounded text-[10px] font-mono uppercase tracking-widest text-purple-200 pointer-events-auto">
                <span className="text-purple-400">IMAGE</span>
                <span className="text-zinc-300 truncate max-w-60">{vjState.imageLabel || '—'}</span>
                <button
                  className="text-zinc-500 hover:text-rose-300"
                  onClick={() => updateState({ imageUrl: null, imageLabel: null })}
                  title="Eject image"
                >
                  <XIcon className="w-2.5 h-2.5" />
                </button>
              </div>
            )}
          </div>
        )}

        {routerError && (
          <div className="absolute top-2 right-2 z-40 px-3 py-2 bg-rose-950/80 border border-rose-500/50 rounded text-[10px] font-mono uppercase tracking-widest text-rose-200 pointer-events-none">
            {routerError}
          </div>
        )}

        {/* MIDI overlay — top-right pill that expands into the mapper.
            Sits above the rest of the canvas overlays. */}
        <MidiPanel
          supported={midi.supported}
          ready={midi.ready}
          error={midi.error}
          inputs={midi.inputs}
          mappings={midi.mappings}
          learning={midi.learning}
          setLearning={midi.setLearning}
          setMapping={midi.setMapping}
          resetMappings={midi.resetMappings}
          lastSeenCc={lastSeenCc}
          open={midiPanelOpen}
          onOpenChange={setMidiPanelOpen}
        />

        {isInitializing && (
          <div className="absolute inset-0 flex items-center justify-center flex-col gap-4 text-zinc-400 text-sm bg-black z-30">
            <div className="w-7 h-7 border-2 border-zinc-600 border-t-transparent rounded-full animate-spin"></div>
            Loading…
          </div>
        )}

        {vjState.sourceType === 'clip' && !vjState.clipUrl && !vjState.imageUrl && !isInitializing && (
          <div className="absolute inset-0 flex items-center justify-center flex-col text-zinc-500 font-mono text-center p-8 bg-zinc-950 z-30">
            <div className="relative overflow-hidden">
              <button className="flex items-center gap-2 px-5 py-3 text-xs lowercase tracking-widest border border-dashed border-zinc-700 bg-black/40 text-zinc-400 hover:bg-purple-950/20 hover:border-purple-500 hover:text-purple-300 transition-colors rounded-sm cursor-pointer">
                <Film className="w-4 h-4 opacity-70" />
                media not found. click or drop here to add
              </button>
              <input
                type="file"
                accept={VJ_FILE_ACCEPT}
                multiple
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                onChange={(e) => {
                  handleFiles(e.target.files);
                  e.target.value = '';
                }}
              />
            </div>
          </div>
        )}

        {error && vjState.sourceType === 'camera' && !isInitializing && (
           <div className="absolute inset-0 flex items-center justify-center flex-col text-center p-8 bg-zinc-950 z-30 gap-3">
            <AlertTriangle className="w-7 h-7 text-zinc-500" />
            <p className="text-sm text-zinc-300 max-w-sm leading-relaxed">{error}</p>
          </div>
        )}

        {vjState.layoutMode === 'fullscreen' && (
           <button
             onClick={(e) => { e.stopPropagation(); updateState({ layoutMode: 'standard' }); }}
             className="absolute top-4 right-4 bg-black/50 text-white/50 hover:text-white hover:bg-black/80 px-4 py-2 rounded border border-white/10 opacity-0 hover:opacity-100 transition-opacity flex items-center gap-2 group cursor-pointer z-50 text-xs tracking-widest font-mono font-bold"
           >
              ESC / DOUBLE CLICK / CLICK TO EXIT FULLSCREEN
           </button>
        )}
      </main>
      </div>{/* end left column */}

      {/* Collapsed right panel: a thin rail with an expand handle (standard mode). */}
      {vjState.layoutMode === 'standard' && vjState.rightPanelCollapsed && (
        <aside className="relative z-40 w-8 shrink-0 border-l border-cyan-900/40 bg-[#111] flex flex-col items-center pt-2">
          <button
            type="button"
            onClick={() => updateState({ rightPanelCollapsed: false })}
            className="p-1 rounded text-cyan-300 hover:text-white hover:bg-cyan-900/40"
            title="Expand control panel"
            aria-label="Expand control panel"
            aria-expanded={false}
          >
            <PanelRightOpen className="w-4 h-4" />
          </button>
          <span className="mt-2 text-[8px] font-mono uppercase tracking-widest text-zinc-600 [writing-mode:vertical-rl]">Controls</span>
        </aside>
      )}

      {/* Right BROWSER column divider (3-column shell). */}
      {vjState.layoutMode === 'standard' && !vjState.rightPanelCollapsed && (
        <ResizeHandle
          orientation="vertical"
          title="Resize browser column"
          onDrag={(d) => updateState({ vjRightW: Math.max(260, Math.min(680, (vjState.vjRightW ?? 360) - d)) })}
        />
      )}

      {/* Controller Bus — right BROWSER column (sources + library + effects). */}
      <aside
         style={vjState.layoutMode === 'standard' && !vjState.rightPanelCollapsed ? { width: vjState.vjRightW ?? 360 } : undefined}
         className={`
           ${vjState.layoutMode === 'fullscreen' ? 'translate-x-full absolute right-0 opacity-0 pointer-events-none' : 'relative'}
           ${vjState.layoutMode === 'split' ? 'w-1/2 flex-none' : ''}
           ${vjState.layoutMode === 'preview' ? 'flex-1' : ''}
           ${vjState.layoutMode === 'standard' ? (vjState.rightPanelCollapsed ? 'hidden' : 'flex-none') : ''}
           flex flex-col z-40 shadow-[-10px_0_30px_rgba(0,0,0,0.8)] border-l border-cyan-900/40 transition-all duration-500 bg-[#111] overflow-hidden
         `}
      >
        {vjState.layoutMode === 'standard' && (
          <div className="flex items-center justify-between px-2 py-1 border-b border-zinc-800">
            <span className="text-[9px] font-mono uppercase tracking-widest text-zinc-500">Controls</span>
            <button
              type="button"
              onClick={() => updateState({ rightPanelCollapsed: true })}
              className="p-1 rounded text-zinc-500 hover:text-white hover:bg-zinc-800"
              title="Collapse control panel"
              aria-label="Collapse control panel"
              aria-expanded
            >
              <PanelRightClose className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
        {/* Library Pool — the media browser, moved into the right column. Drag a
            clip straight onto a bank slot up top. */}
        {vjState.layoutMode === 'standard' && (
          <LibraryPool
            items={pool.items}
            loading={pool.loading}
            error={pool.error}
            refresh={pool.refresh}
            stagedIds={stagedIds}
            onStage={stagePoolItem}
            onUnstage={unstagePoolItem}
            collapsed={!!vjState.poolCollapsed}
            onToggleCollapse={() => updateState({ poolCollapsed: !vjState.poolCollapsed })}
          />
        )}
        {/* Live source monitor — reuses the already-decoded Quest/Cymatics
            stream (no second decode). */}
        {vjState.layoutMode === 'standard' && vjState.sourceType === 'camera' && vjState.cameraSource === 'quest' && questFeed.stream && (
          <SourcePreview stream={questFeed.stream} label="Quest" />
        )}
        {vjState.layoutMode === 'standard' && vjState.sourceType === 'camera' && vjState.cameraSource === 'queststitch' && stitchFeed.stream && (
          <SourcePreview stream={stitchFeed.stream} label="Quest Stitch" />
        )}
        {vjState.layoutMode === 'standard' && vjState.sourceType === 'camera' && vjState.cameraSource === 'cymatics' && cymaticsFeed.stream && (
          <SourcePreview stream={cymaticsFeed.stream} label="Cymatics" />
        )}
        {vjState.layoutMode === 'standard' && vjState.sourceType === 'camera' && vjState.cameraSource === 'akvj' && akvjFeed.stream && (
          <SourcePreview stream={akvjFeed.stream} label="AKVJ" />
        )}
        {vjState.layoutMode === 'standard' && vjState.sourceType === 'camera' && vjState.cameraSource === 'akvj3d' && akvj3dFeed.stream && (
          <SourcePreview stream={akvj3dFeed.stream} label="KINECT" />
        )}
        {vjState.layoutMode === 'standard' && vjState.sourceType === 'camera' && vjState.cameraSource === 'depthcloud' && depthCloudFeed.stream && (
          <SourcePreview stream={depthCloudFeed.stream} label="DEPTH" />
        )}
        {vjState.layoutMode === 'standard' && vjState.sourceType === 'camera' && vjState.cameraSource === 'spectra' && spectraFeed.stream && (
          <SourcePreview stream={spectraFeed.stream} label="SPECTRA" />
        )}
        {vjState.layoutMode === 'standard' && vjState.sourceType === 'camera' && vjState.cameraSource === 'shader' && shaderFeed.stream && (
          <SourcePreview stream={shaderFeed.stream} label="SHADER" />
        )}
        {vjState.layoutMode === 'standard' && vjState.sourceType === 'camera' && vjState.cameraSource === 'asciiline' && asciilineFeed.stream && (
          <SourcePreview stream={asciilineFeed.stream} label="ASCII" />
        )}
        <div className="flex-1 min-h-0 overflow-hidden">
        <ControlDeck
          region={vjState.layoutMode === 'standard' ? 'browser' : 'all'}
          state={vjState}
          updateState={updateState}
          reset={resetState}
          hasCameraError={!!error && vjState.sourceType === 'camera'}
          questState={questFeed.state}
          questError={questFeed.error}
          questFps={questFeed.fps}
          questLog={questFeed.log}
          stitchState={stitchFeed.state}
          stitchError={stitchFeed.error}
          stitchFps={stitchFeed.fps}
          stitchLog={stitchFeed.log}
          akvjState={akvjFeed.state}
          akvjError={akvjFeed.error}
          akvjFps={akvjFeed.fps}
          akvjLog={akvjFeed.log}
          akvj3dState={akvj3dFeed.state}
          akvj3dError={akvj3dFeed.error}
          akvj3dFps={akvj3dFeed.fps}
          akvj3dLog={akvj3dFeed.log}
          akvj3dSensorState={akvj3dFeed.sidecarState}
          akvj3dSensorLabel={akvj3dFeed.sidecarLabel}
          depthState={depthCloudFeed.state}
          depthBackend={depthCloudFeed.backend}
          depthProgress={depthCloudFeed.progress}
          depthFps={depthCloudFeed.fps}
          depthError={depthCloudFeed.error}
          depthLog={depthCloudFeed.log}
        />
        </div>
      </aside>

      </div>
    </div>
  );
}
