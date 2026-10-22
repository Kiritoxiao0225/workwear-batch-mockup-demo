/**
 * 整理素材 is priced by the images uploaded (10-22): the price list's 读商品与策划 is where it starts,
 * and every image adds PLAN_IMAGE_COST_MICRO of cost at the same multiplier. Measured on 15 jackets:
 * about ¥1.9 a product (the colours, the reading and the liner check) plus ¥0.009 an image (sorted 40 to a call).
 * The page and the hold use this one formula, so what the page says is what is held.
 */
export const PLAN_IMAGE_COST_MICRO = 750;
/** 1 credit = 1 cent = 1000 micro-cents (credits.ts). */
export const planUserMicro = (baseCostMicro: number, multiplierMilli: number, images: number) =>
  Math.ceil(((baseCostMicro + Math.max(0, images) * PLAN_IMAGE_COST_MICRO) * multiplierMilli) / 1000);
export const planCredits = (baseCostMicro: number, multiplierMilli: number, images: number) => Math.ceil(planUserMicro(baseCostMicro, multiplierMilli, images) / 1000);
