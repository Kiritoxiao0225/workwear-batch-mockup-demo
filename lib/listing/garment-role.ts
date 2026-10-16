/**
 * 电商主图: what a sorted image shows besides its colour, for picking the image a colour is drawn
 * from. Shared by the page and the server; material sorted before 10-16 has no `role` and no
 * `colorsSeen`, and reads as a main garment of one colour.
 */
export const GARMENT_ROLES = ['主体', '内胆', '配件', '组合', '不确定'] as const;
export type GarmentRole = (typeof GARMENT_ROLES)[number];
type Seen = { role?: string; detail?: string; person?: string; color?: string; colorsSeen?: string[] };

/**
 * A liner or an accessory photographed on its own is not the garment a colour sells (10-15: the black
 * and lilac fleece liners of a 3-in-1 jacket, clean still lifes, were picked over the jackets' model
 * photos and drawn as the jackets).
 */
export const isComponent = (image: Seen | undefined) =>
  !!image && (image.role === '内胆' || image.role === '配件' || /^(抓绒|摇粒绒)?内胆$/.test(image.detail ?? ''));

/** A photo with several garments on it: several people, or several colours seen. */
export const isGroup = (image: Seen | undefined) =>
  !!image && (image.person === '男女' || image.person === '多人' || (image.colorsSeen?.length ?? 0) > 1);
