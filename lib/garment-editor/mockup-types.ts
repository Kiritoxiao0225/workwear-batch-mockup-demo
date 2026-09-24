export type ElementType = 'product' | 'logo' | 'text';

export interface GradientStop {
  id: string;
  color: string;
  position: number; // 0–100
}

export interface TextGradient {
  type: 'linear';
  angle: number;
  stops: GradientStop[];
}

export interface FocalPoint {
  x: number;
  y: number;
}

export interface ObjectTransform {
  left: number;
  top: number;
  scaleX: number;
  scaleY: number;
  angle: number;
}

export type ProductFace = 'front' | 'back';

export type MockupPlacement =
  | 'custom'
  | 'left_chest'
  | 'right_chest'
  | 'front_center'
  | 'upper_back'
  | 'back_center';

export interface DecorationRelativeTransform {
  /** Product-local horizontal position. -0.5 is the left edge and 0.5 the right edge. */
  x: number;
  /** Product-local vertical position. -0.5 is the top edge and 0.5 the bottom edge. */
  y: number;
  /** Decoration scale divided by the owning product scale. */
  scaleX: number;
  scaleY: number;
  /** Decoration angle minus the owning product angle, in degrees. */
  angle: number;
}

export interface NormalizedMockupRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MockupGarmentGeometry {
  version: 2;
  /** Tight foreground bounds in source-image normalized coordinates. */
  garmentBounds: NormalizedMockupRegion;
  /** Stable central-torso center in source-image normalized coordinates. */
  bodyCenterX: number;
  /** Stable central-torso width divided by the source-image width. */
  bodyWidth: number;
  /** Chest-height center in source-image normalized coordinates. */
  chestY: number;
  confidence: 'high' | 'medium';
}

export interface CanvasElement {
  id: string;
  type: ElementType;

  // 图片类元素（product、logo）
  image?: string;
  imageRef?: string;

  // 产品图特有
  face?: ProductFace;
  backOfElementId?: string;
  garmentGeometry?: MockupGarmentGeometry;

  // Logo 特有
  originalImage?: string;
  originalImageRef?: string;

  // Logo / 文字共有：定制内容属于哪一件产品，以及相对产品的位置。
  placedOnProductId?: string | null;
  placement?: MockupPlacement;
  relativeTransform?: DecorationRelativeTransform;

  // 文字属性
  text?: string;
  fontFamily?: string;
  fontWeight?: 'normal' | 'bold';
  fontStyle?: 'normal' | 'italic';
  textUnderline?: boolean;
  textAlign?: 'left' | 'center' | 'right';
  textColor?: string;
  textGradient?: TextGradient;
  arcMode?: 'none' | 'up' | 'down';
  arcRadius?: number;
  arcBend?: number;
  letterSpacing?: number;

  // 通用
  transform?: ObjectTransform;
  blendMode?: boolean;
  visible?: boolean;
}

export type MeasurementAxis = 'x' | 'y';

export interface MockupCanvasScale {
  axis: MeasurementAxis;
  firstSceneCoordinate: number;
  secondSceneCoordinate: number;
  distanceCm: number;
}

export interface MockupGuide {
  id: string;
  axis: MeasurementAxis;
  scenePosition: number;
  label: string;
}

export interface MockupDimension {
  id: string;
  guideAId: string;
  guideBId: string;
}

export interface MockupMeasurementState {
  version: 2;
  visible: boolean;
  scale: MockupCanvasScale | null;
  axisOrigins: Record<MeasurementAxis, number | null>;
  guides: MockupGuide[];
  dimensions: MockupDimension[];
}

export interface CustomizationState {
  elements: CanvasElement[];
  measurements?: MockupMeasurementState;
}

export interface CapturedMockupProduct {
  productElementId: string;
  dataUrl: string;
  logoElementIds: string[];
}

export const FONTS = [
  // 文源黑体 (6个)
  { name: '文源黑体Regular', value: '文源黑体Regular' },
  { name: '文源黑体极细', value: '文源黑体极细' },
  { name: '文源黑体细体', value: '文源黑体细体' },
  { name: '文源黑体中细', value: '文源黑体中细' },
  { name: '文源黑体粗体', value: '文源黑体粗体' },
  { name: '文源黑体特粗', value: '文源黑体特粗' },
  // 文源宋体 (6个)
  { name: '文源宋体Regular', value: '文源宋体Regular' },
  { name: '文源宋体极细', value: '文源宋体极细' },
  { name: '文源宋体细体', value: '文源宋体细体' },
  { name: '文源宋体中细', value: '文源宋体中细' },
  { name: '文源宋体粗体', value: '文源宋体粗体' },
  { name: '文源宋体特粗', value: '文源宋体特粗' },
  // 文源圆体 (1个)
  { name: '文源圆体', value: '文源圆体' },
  // 东方大楷 (1个)
  { name: '东方大楷', value: '东方大楷' },
  // 华文新魏 (1个)
  { name: '华文新魏', value: '华文新魏' },
  // 方正仿宋 (1个)
  { name: '方正仿宋', value: '方正仿宋' },
  // 方正大标宋 (1个)
  { name: '方正大标宋', value: '方正大标宋' },
  // 方正大黑 (1个)
  { name: '方正大黑', value: '方正大黑' },
  // 方正楷体 (1个)
  { name: '方正楷体', value: '方正楷体' },
  // 方正综艺简体 (1个)
  { name: '方正综艺简体', value: '方正综艺简体' },
  // 方正行楷 (1个)
  { name: '方正行楷', value: '方正行楷' },
  // 方正黑体 (1个)
  { name: '方正黑体', value: '方正黑体' },
  // 隶书 (1个)
  { name: '隶书', value: '隶书' },
];
