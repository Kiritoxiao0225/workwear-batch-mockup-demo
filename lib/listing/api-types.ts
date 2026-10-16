/**
 * 电商主图: what the page and /api/listing exchange. The page was built against these first (on the
 * local demo data in ./demo); the server answers in the same shapes.
 */
import type { Task } from './category';
import type { Check, Draft, SortedPoint } from './draft';
import type { PlaceId, Sell } from './scene';
import type { Box, Layout, ZoneKind } from './templates';

/** square: round one is made (white-background, cast, SKU and 1:1 images); the 3:4 and 2:3 images wait for 「出竖版」. */
export type Status = 'uploading' | 'planning' | 'materials' | 'writing' | 'generating' | 'square' | 'done' | 'failed';
export type Summary = {
  id: string; name: string; layout: string; status: Status; error: string | null; images: number; cover: string | null;
  slots: number; made: number; broken: number; created_at: string; updated_at: string;
  /** Rounds started: 1 after 「开始出图」, 2 after 「出竖版」. */
  round: 0 | 1 | 2;
};
export type Sorted = { id: string; kind: string; color: string; front: boolean; detail: string; text: boolean; logo: boolean; same: string;
  /** Who is in the picture (男 / 女 / 男女 / 多人) and whether a face is clear enough to draw from; missing on material sorted before 10-11. */
  person?: string; face?: boolean;
  /** 主体 / 内胆 / 配件 / 组合 / 不确定, and the colours of the garments on it; missing on material sorted before 10-16. */
  role?: string; colorsSeen?: string[] };
export type Materials = {
  /** The AI's call on the category and why; its look at the kinds of point the material does not mention; its headings for each kind of image. */
  category: string; categoryWhy?: string; checks?: Check[]; titles?: Partial<Record<Task, string[]>>;
  /** The AI's grouping of the points into themes (material sorted 2026-10-12 only); no longer used. */
  themes?: unknown[];
  /** The AI's pick of the master, where the cover is shot and the point it acts out, with why (none on material sorted before 2026-10-12). */
  look?: { master: string; place?: PlaceId; sell?: Sell; why: string } | null;
  sorted: { images: Sorted[]; colors: { name: string; hex: string; from: string[] }[]; points: SortedPoint[]; notes: string[] };
  chosen: { colors: { name: string; hex: string; pick: string | null; candidates: string[] }[]; parts: { part: string; pick: string | null; candidates: string[] }[] };
  duplicates: [string, string][]; images: { label: string; assetId: string }[];
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
  /**
   * The latest 「点图修改」 on this image: the model redraws the current image as asked (and after a
   * reference image, if any). The result joins the history without replacing the image; 「采用」
   * makes it current through `current`.
   */
  redraw?: { job: string; status: 'running' | 'succeeded' | 'failed'; error: string | null };
};
export type Detail = Omit<Summary, "slots"> & { plan: Draft | null; materials: Materials | null; slots: SlotState[]; sources: Source[] };

export type LayoutCard = Layout & { own: boolean };
export type Config = { layouts: LayoutCard[]; learning: { id: string; name: string; status: string }[]; planCredits: number; imageCredits: number; multiCredits: number; layoutCredits: number; exempt: boolean };
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
