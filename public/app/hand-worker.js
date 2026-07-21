let landmarker = null;

initialize().catch((error) => {
  self.postMessage({ type: 'error', message: error?.message || String(error) });
});

self.addEventListener('message', ({ data }) => {
  if (data.type !== 'frame' || !landmarker) {
    data.frame?.close();
    return;
  }

  try {
    const result = landmarker.detectForVideo(data.frame, data.timestamp);
    self.postMessage({
      type: 'result',
      timestamp: data.timestamp,
      generation: data.generation,
      landmarks: result.landmarks,
      worldLandmarks: result.worldLandmarks,
      handedness: result.handedness,
    });
  } catch (error) {
    self.postMessage({ type: 'error', message: error?.message || String(error) });
  } finally {
    data.frame.close();
  }
});

async function initialize() {
  const { FilesetResolver, HandLandmarker } = await import('/vendor/mediapipe/vision_bundle.mjs');
  const vision = await FilesetResolver.forVisionTasks('/vendor/mediapipe/wasm', true);
  landmarker = await HandLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: '/models/hand_landmarker.task' },
    runningMode: 'VIDEO',
    numHands: 2,
  });
  self.postMessage({ type: 'ready' });
}
