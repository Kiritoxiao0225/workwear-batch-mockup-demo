// Layout coordinates stay fixed while the outlined vector master supplies native HD pixels.
export const WPS_COMPOSITOR_VERSION = 'sharp-catalog-framed-compositor-v5-vector-frame';
export const CONFIRMATION_FRAME = {
  version: 'ant-shirt-confirmation-frame-v2',
  assetPath: 'brand/ant-shirt/confirmation-frame-v2.png',
  width: 1084,
  height: 767,
  garmentArea: { left: 48, top: 94, width: 988, height: 526 },
  faceGap: 36,
} as const;

// Keep template coordinates separate from delivery pixels. Recompose from the
// original garment at this size; never enlarge an already flattened preview.
export const CONFIRMATION_OUTPUT = {
  scale: 3,
  width: CONFIRMATION_FRAME.width * 3,
  height: CONFIRMATION_FRAME.height * 3,
} as const;
