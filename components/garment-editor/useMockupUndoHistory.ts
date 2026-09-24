'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import type { CustomizationState } from '@/lib/garment-editor/mockup-types';

const MAX_HISTORY = 50;
const DEBOUNCE_MS = 300;

type Patch = Record<string, unknown>;
export type MockupStateUpdate =
  | Partial<CustomizationState>
  | ((previousState: CustomizationState) => Partial<CustomizationState>);

function capturePatch(state: CustomizationState, keys: readonly string[]): Patch {
  const patch: Patch = {};
  for (const key of keys) {
    patch[key] = state[key as keyof CustomizationState];
  }
  return patch;
}

export function useUndoHistory(initialState: CustomizationState) {
  const [state, setState] = useState<CustomizationState>(initialState);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  const stateRef = useRef(initialState);
  const pastRef = useRef<Patch[]>([]);
  const futureRef = useRef<Patch[]>([]);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingInverseRef = useRef<Patch | null>(null);

  const clearHistoryRefs = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    pastRef.current = [];
    futureRef.current = [];
    pendingInverseRef.current = null;
  }, []);

  const resetHistory = useCallback(() => {
    clearHistoryRefs();
    setCanUndo(false);
    setCanRedo(false);
  }, [clearHistoryRefs]);

  const flushHistory = useCallback(() => {
    if (pendingInverseRef.current) {
      pastRef.current.push(pendingInverseRef.current);
      if (pastRef.current.length > MAX_HISTORY) {
        pastRef.current.shift();
      }
      futureRef.current = [];
      pendingInverseRef.current = null;
      debounceTimerRef.current = null;
      setCanUndo(true);
      setCanRedo(false);
    }
  }, []);

  const updateState = useCallback((update: MockupStateUpdate) => {
    const previousState = stateRef.current;
    const updates = typeof update === 'function' ? update(previousState) : update;
    const keys = Object.keys(updates);
    if (keys.length === 0) return;

    const inverse = capturePatch(previousState, keys);
    futureRef.current = [];
    setCanRedo(false);

    // Merge into pending inverse (keep the OLDEST value for each key)
    if (!pendingInverseRef.current) {
      pendingInverseRef.current = inverse;
    } else {
      for (const key of keys) {
        if (!(key in pendingInverseRef.current)) {
          pendingInverseRef.current[key] = inverse[key];
        }
      }
    }

    // Debounce: reset timer on each call, only push after pause
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(flushHistory, DEBOUNCE_MS);

    const nextState = { ...previousState, ...updates };
    stateRef.current = nextState;
    setState(nextState);
  }, [flushHistory]);

  const replaceState = useCallback((nextState: CustomizationState) => {
    resetHistory();
    stateRef.current = nextState;
    setState(nextState);
  }, [resetHistory]);

  const getState = useCallback(() => stateRef.current, []);

  const undo = useCallback(() => {
    // Flush any pending entry first
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    if (pendingInverseRef.current) {
      pastRef.current.push(pendingInverseRef.current);
      if (pastRef.current.length > MAX_HISTORY) {
        pastRef.current.shift();
      }
      pendingInverseRef.current = null;
    }

    const inverse = pastRef.current.pop();
    if (!inverse) return;

    const previousState = stateRef.current;
    const keys = Object.keys(inverse);
    const redoEntry = capturePatch(previousState, keys);
    futureRef.current.push(redoEntry);

    setCanUndo(pastRef.current.length > 0);
    setCanRedo(true);

    const nextState = { ...previousState, ...inverse } as CustomizationState;
    stateRef.current = nextState;
    setState(nextState);
  }, []);

  const redo = useCallback(() => {
    const redoEntry = futureRef.current.pop();
    if (!redoEntry) return;

    const previousState = stateRef.current;
    const keys = Object.keys(redoEntry);
    const pastEntry = capturePatch(previousState, keys);
    pastRef.current.push(pastEntry);

    setCanUndo(true);
    setCanRedo(futureRef.current.length > 0);

    const nextState = { ...previousState, ...redoEntry } as CustomizationState;
    stateRef.current = nextState;
    setState(nextState);
  }, []);

  useEffect(() => {
    return clearHistoryRefs;
  }, [clearHistoryRefs]);

  return {
    state,
    updateState,
    replaceState,
    getState,
    resetHistory,
    undo,
    redo,
    canUndo,
    canRedo,
  };
}
