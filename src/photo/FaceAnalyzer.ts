import wasmLoaderPath from "@mediapipe/tasks-vision/vision_wasm_internal.js?url";
import wasmBinaryPath from "@mediapipe/tasks-vision/vision_wasm_internal.wasm?url";
import { canvasOf, type Point } from "./PhotoTransform";
import type { FaceLandmarker } from "@mediapipe/tasks-vision";

/** Loaded for a selected/default face; image bytes never leave this browser. */
export class FaceAnalyzer {
  private detector?: Promise<FaceLandmarker>;

  private load() {
    if (!this.detector) {
      this.detector = import("@mediapipe/tasks-vision").then(({ FaceLandmarker }) =>
        FaceLandmarker.createFromOptions({ wasmLoaderPath, wasmBinaryPath }, {
          baseOptions: { modelAssetPath: `${import.meta.env.BASE_URL}models/face_landmarker.task`, delegate: "CPU" },
          runningMode: "IMAGE", numFaces: 4,
          outputFaceBlendshapes: false, outputFacialTransformationMatrixes: false,
        }),
      ).catch((error) => { this.detector = undefined; throw error; });
    }
    return this.detector;
  }

  async detect(source: HTMLCanvasElement, cancelled: () => boolean = () => false): Promise<Point[][]> {
    const detector = await this.load();
    if (cancelled()) throw new Error("Photo analysis cancelled");
    const ratio = Math.min(1, 1024 / Math.max(source.width, source.height));
    const sample = canvasOf(Math.max(1, Math.round(source.width * ratio)), Math.max(1, Math.round(source.height * ratio)));
    const context = sample.getContext("2d")!;
    // Flatten transparency only in the analysis sample; the displayed photo/mask stays untouched.
    context.fillStyle = "#ffffff"; context.fillRect(0, 0, sample.width, sample.height);
    context.drawImage(source, 0, 0, sample.width, sample.height);
    // A single synchronous inference on a bounded image during startup or photo editing.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    if (cancelled()) throw new Error("Photo analysis cancelled");
    return detector.detect(sample).faceLandmarks.map((face) =>
      face.map(({ x, y }) => ({ x: x * source.width, y: y * source.height })),
    );
  }

  destroy() {
    void this.detector?.then((detector) => detector.close()).catch(() => {});
    this.detector = undefined;
  }
}
