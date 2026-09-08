import { ArtworkWorkQueue } from '@/lib/artwork-work-queue';

// Share the image cap across requests and dev hot reloads in this server process.
const shared = globalThis as typeof globalThis & { wpsArtworkImageQueue?: ArtworkWorkQueue };
export const artworkGenerationQueue = shared.wpsArtworkImageQueue ??= new ArtworkWorkQueue();
