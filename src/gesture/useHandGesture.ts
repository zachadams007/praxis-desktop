/**
 * useHandGesture - gesture navigation (visual / camera only, no OS control).
 *
 * Opens the webcam, runs MediaPipe HandLandmarker (loaded lazily so it never
 * weighs down the initial bundle), then hands each frame to the PURE GestureEngine
 * (smoothing + the gesture state machine) and the premium HandRenderer (the neon
 * overlay). The engine's output drives the SAME camera rig as the pointer/keyboard
 * via cameraApi, plus two discrete view actions on the store:
 *
 *   ✊ fist + move ............ pan (Praxis follows your hand)
 *   ✊ fist + yank back ........ escape to the overview
 *   ✋→✊ grab + twist 180° ..... toggle journey ⇄ brain
 *   🤏 pinch + up/down ......... dolly zoom
 *   🖐 spread / close fingers .. drill into / out of the centered task
 *
 * Everything degrades honestly: no camera, denied permission, or a model that
 * won't load each surface a clear status - the chip is never silently dead.
 *
 * Offline note: WASM + model load from a CDN here. To run fully offline (Tauri,
 * no network) bundle them into /public and point these URLs local.
 */

import { useEffect, useRef, useState } from "react";
import type { HandLandmarker, HandLandmarkerResult } from "@mediapipe/tasks-vision";
import { gestureDolly, gesturePan } from "@/brain/cameraApi";
import { usePraxisStore } from "@/store/usePraxisStore";
import { GestureEngine, GESTURE_TUNABLES, type GestureFrame, type Pose, type Pt } from "./gestureEngine";

const clampNdc = (v: number) => Math.max(-1, Math.min(1, v));
import { HandRenderer } from "./handRender";

export type GestureStatus = "off" | "loading" | "tracking" | "no-camera" | "denied" | "error";

const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

/** Live, low-rate readout for the HUD (the high-rate viz lives on the canvas). */
export interface GestureHud {
  pose: Pose;
  label: string;
}

const waitForLoadedMetadata = (video: HTMLVideoElement) => {
  if (video.readyState >= 1) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener("loadedmetadata", onLoadedMetadata);
      video.removeEventListener("error", onError);
    };
    const onLoadedMetadata = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("Unable to load video metadata"));
    };
    video.addEventListener("loadedmetadata", onLoadedMetadata, { once: true });
    video.addEventListener("error", onError, { once: true });
  });
};

const isAbortError = (e: unknown) => e instanceof DOMException && e.name === "AbortError";

export function useHandGesture(active: boolean) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<GestureStatus>("off");
  const [hud, setHud] = useState<GestureHud>({ pose: "none", label: "" });

  useEffect(() => {
    if (!active) {
      setStatus("off");
      return;
    }
    let stop = false;
    let raf = 0;
    let stream: MediaStream | null = null;
    let attachedVideo: HTMLVideoElement | null = null;
    let landmarker: HandLandmarker | null = null;
    const engine = new GestureEngine();
    const renderer = new HandRenderer();
    let lastPose: Pose = "none";
    let lastLabel = "";

    const dispatch = (frame: GestureFrame) => {
      if (frame.panX || frame.panY) gesturePan(frame.panX, frame.panY);
      if (frame.dolly) gestureDolly(frame.dolly);
      if (frame.action === "drillIn") {
        // the INDEX FINGERTIP (where you aim), amplified about frame-centre → NDC, so a
        // small hand move covers the whole screen and you can reach the top clusters.
        const g = GESTURE_TUNABLES.pointerGain;
        const nx = clampNdc((frame.signals.tipX - 0.5) * 2 * g);
        const ny = clampNdc((0.5 - frame.signals.tipY) * 2 * g);
        usePraxisStore.getState().drillIn({ x: nx, y: ny });
      } else if (frame.action === "drillOut") usePraxisStore.getState().drillOut();
      else if (frame.action === "toggleView") usePraxisStore.getState().toggleViewMode();
      // only re-render the HUD chip when the pose/label actually changes
      if (frame.pose !== lastPose || frame.label !== lastLabel) {
        lastPose = frame.pose;
        lastLabel = frame.label;
        setHud({ pose: frame.pose, label: frame.label });
      }
    };

    const onFrame = (res: HandLandmarkerResult, canvas: HTMLCanvasElement, video: HTMLVideoElement) => {
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      canvas.width = video.videoWidth || 640;
      canvas.height = video.videoHeight || 480;
      const lm = (res.landmarks?.[0] as Pt[] | undefined) ?? null;
      const now = performance.now();
      const frame = engine.update(lm, now);
      renderer.draw(ctx, lm, canvas.width, canvas.height, frame, now);
      dispatch(frame);
    };

    const loop = () => {
      if (stop) return;
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (video && canvas && landmarker && video.readyState >= 2) {
        try {
          onFrame(landmarker.detectForVideo(video, performance.now()), canvas, video);
        } catch {
          /* transient frame error - keep looping */
        }
      }
      raf = requestAnimationFrame(loop);
    };

    const releaseStream = () => {
      attachedVideo?.pause();
      if (attachedVideo) attachedVideo.srcObject = null;
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
      attachedVideo = null;
    };

    const run = async () => {
      setStatus("loading");
      if (!navigator.mediaDevices?.getUserMedia) {
        setStatus("no-camera");
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } });
      } catch (e) {
        setStatus(e instanceof DOMException && e.name === "NotAllowedError" ? "denied" : "no-camera");
        return;
      }
      if (stop) {
        releaseStream();
        return;
      }
      const video = videoRef.current;
      if (!video) {
        releaseStream();
        return;
      }
      attachedVideo = video;
      video.srcObject = stream;
      try {
        await waitForLoadedMetadata(video);
        if (stop) return;
        await video.play();
      } catch (e) {
        releaseStream();
        if (!isAbortError(e) && !stop) setStatus("error");
        return;
      }

      try {
        const vision = await import("@mediapipe/tasks-vision");
        const fileset = await vision.FilesetResolver.forVisionTasks(WASM_URL);
        landmarker = await vision.HandLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
          runningMode: "VIDEO",
          numHands: 1,
        });
      } catch {
        setStatus("error");
        return;
      }
      if (stop) return;
      setStatus("tracking");
      loop();
    };

    run();

    return () => {
      stop = true;
      cancelAnimationFrame(raf);
      landmarker?.close();
      releaseStream();
      engine.reset();
      renderer.reset();
      setHud({ pose: "none", label: "" });
    };
  }, [active]);

  return { videoRef, canvasRef, status, hud };
}
