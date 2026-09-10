export function productionFileId(url: string): string | null {
  return /^\/api\/production-files\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/u.exec(url)?.[1] ?? null;
}
export const productionFileUrl = (id: string) => `/api/production-files/${id}`;

/** Display only: never put this derivative URL into source/production snapshots. */
export const productionThumbnailUrl = (url: string) => productionFileId(url) ? `${url}?size=thumb` : url;
