import type { ArtworkDraft } from './artwork-editor';
import { artworkLayers } from './artwork-layers';

export function artworkPixelFingerprint(draft: ArtworkDraft) {
  return JSON.stringify({ renderer: 'canvas-export-2x-v1', canvas: draft.canvas,
    layers: artworkLayers(draft).filter(layer => layer.value.visible !== false).map(layer => {
      const value: Record<string, unknown> = { ...layer.value };
      for (const key of ['id', 'label', 'role', 'textValue', 'visible']) delete value[key];
      return { kind: layer.kind, value };
    }) });
}
