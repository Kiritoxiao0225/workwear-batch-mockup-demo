/**
 * 电商主图: what the page and /api/listing exchange. The page was built against these first (on the
 * local demo data in ./demo); the server answers in the same shapes.
 */
import type { CoverPeople } from './templates';
import type { Task } from './category';
import type { Check, Counts, Draft, Reuse, SortedPoint } from './draft';
import type { PlaceId, Sell } from './scene';
import type { Box, Layout, ZoneKind } from './templates';
import type { Wear } from './wear';

/** square: round one is made (white-background, cast, SKU and 1:1 images); the 3:4 and 2:3 images wait for 「出竖版」. */
export type Status = 'uploading' | 'planning' | 'materials' | 'writing' | 'generating' | 'square' | 'done' | 'failed';
export type Summary = {
  id: string; name: string; layout: string; status: Status; error: string | null; images: number; cover: string | null;
  slots: number; made: number; broken: number; created_at: string; updated_at: string;
  /** Rounds started: 1 after 「开始出图」, 2 after 「出竖版」. */
  round: 0 | 1 | 2;
  counts?: Counts;
  /** When the uploaded images were cleared (SOURCE_KEEP_DAYS after the last image): no more copies then. */
  sources_cleared_at?: string | null;
  /** 「只删图片」 (10-28): the pictures went to the 回收站, the plan and copy stayed. */
  images_cleared_at?: string | null;
  /** Its 「点图修改」 (10-25): being made, new images waiting to be adopted, failures not yet seen to. */
  edits?: { running: number; ready: number; failed: number };
};
export type Sorted = { id: string; kind: string; color: string; front: boolean; detail: string; text: boolean; logo: boolean; same: string;
  /** Who is in the picture (男 / 女 / 男女 / 多人) and whether a face is clear enough to draw from; missing on material sorted before 10-11. */
  person?: string; face?: boolean;
  /** 主体 / 内胆 / 配件 / 组合 / 不确定, and the colours of the garments on it; missing on material sorted before 10-16. */
  role?: string; colorsSeen?: string[];
  /** The liner the image shows (wear.ts INNERS) and its colour; missing on material sorted before 10-21. */
  inner?: string; innerColor?: string };
export type Materials = {
  /** The AI's call on the category and why; its look at the kinds of point the material does not mention; its headings for each kind of image. */
  category: string; categoryWhy?: string; checks?: Check[]; titles?: Partial<Record<Task, string[]>>;
  /** The AI's grouping of the points into themes (material sorted 2026-10-12 only); no longer used. */
  themes?: unknown[];
  /** The AI's pick of the master, where the cover is shot and the point it acts out, with why (none on material sorted before 2026-10-12). */
  look?: { master: string; place?: PlaceId; sell?: Sell; why: string } | null;
  /** How the jacket is worn and the SKU versions its material shows (wear.ts); none on material sorted before 10-21. */
  wear?: Wear | null;
  sorted: { images: Sorted[]; colors: { name: string; hex: string; from: string[] }[]; points: SortedPoint[]; notes: string[] };
  chosen: { colors: { name: string; hex: string; pick: string | null; candidates: string[] }[]; parts: { part: string; pick: string | null; candidates: string[] }[] };
  duplicates: [string, string][]; images: { label: string; assetId: string }[];
  /** A copy (「再出一套」): its number, which moves the plan's seed, and the images it carries over. */
  variant?: number; reuse?: Reuse;
  /** A copy's shop (10-22): the one its first product used, until its plan names another. */
  shop?: string;
  /** 「再出一套」 (11-01): the cover asked for in its dialog, who is on it and whether an 一体 jacket is worn open; none: the master's and the first product's. */
  cover?: { people?: CoverPeople; open?: boolean };
};
export type Source = { id: string; label: string; name: string; path: string; shape: string };

/** What a finished main image says, kept with each version. */
export type Words = { title: string; sub: string; tags: string[]; cells: { point: string | null; proof: string; caption: string }[] };
/**
 * One thing found on a finished image, where it really is (the model places things roughly, so the
 * layout's boxes are not used): the words read off it, and which zone of the plan it is, if any
 * ("card2"). Things the model added on its own have no zone.
 */
export type Element = { id: string; kind: ZoneKind | 'other'; box: Box; text?: string; zone?: string; label?: string };
/** One image a slot has had; `change` is what was asked for it, `job` the redraw that made it. */
export type Version = { id: string; words: Words | null; change?: string; elements?: Element[]; job?: string };
export type SlotState = {
  slot: string; status: 'queued' | 'running' | 'succeeded' | 'failed'; error: string | null; image: string | null;
  history: Version[]; words: Words | null; task?: Task; colors?: string[];
  /** Queued again after a passing failure (10-22): how many times, and (as `error`) what went wrong last; `retryAt` when it is tried next. */
  retries?: number; retryAt?: string;
  /**
   * The latest 「点图修改」 on this image: the model redraws the current image as asked (and after a
   * reference image, if any). The result joins the history without replacing the image; 「采用」
   * makes it current through `current`.
   */
  redraw?: Redraw;
};
/**
 * A 「点图修改」 as the page shows it (10-25): what was asked and when (`at`; `done` once finished),
 * `ahead` images waiting before a queued one, `asset` the new image. `open`: it still waits for the
 * user (being made, a new image not adopted, or a failure), until a version is adopted or kept.
 */
export type Redraw = {
  job: string; status: 'queued' | 'running' | 'succeeded' | 'failed'; error: string | null;
  ask?: string; at?: string; done?: string; open?: boolean; ahead?: number; retries?: number; retryAt?: string; asset?: string;
};
export type Detail = Omit<Summary, "slots"> & { plan: Draft | null; materials: Materials | null; slots: SlotState[]; sources: Source[] };

export type LayoutCard = Layout & { own: boolean };
export type Config = { layouts: LayoutCard[]; learning: { id: string; name: string; status: string }[];
  /** 整理素材: its start in credits and what the page needs to price a product by its images (plan-price.ts). */
  planCredits: number; planCostMicro: number; planMultiplierMilli: number; imageCredits: number; multiCredits: number; layoutCredits: number; exempt: boolean };
export type LearnState = { id: string; name: string; status: string; error: string | null; layout: Layout | null; refs: string[]; samples: string[] };

/**
 * One change on the 画板, redrawing only `box` of the version `base` (the rest of the image is kept
 * pixel for pixel): a cell gets another point, way of drawing or caption; a line of words is
 * rewritten; a box the user drew is redrawn as asked; or a zone moves to `to` and the place it
 * left is filled with background.
 */
export type CanvasEdit = {
  slot: string; base: string; mode: 'cell' | 'text' | 'free' | 'move'; zone?: string; box: Box; to?: Box;
  point?: string; proof?: string; caption?: string; text?: string; request?: string;
};
