'use client';

import { assertDemoState } from '@/lib/state-validation';
import type { DemoState } from '@/lib/types';

const DATABASE_NAME = 'workwear-mockup-demo';
const DATABASE_VERSION = 1;
const STORE_NAME = 'demo';
const STATE_KEY = 'state';

export function storageModeForHostname(hostname: string) {
  return hostname === 'localhost' || hostname === '127.0.0.1'
    ? 'project-files'
    : 'browser';
}

export function usesBrowserStorage() {
  return storageModeForHostname(window.location.hostname) === 'browser';
}

function openDemoDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onerror = () => reject(request.error ?? new Error('浏览器无法打开 Demo 存储'));
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

export async function readBrowserDemoState(): Promise<DemoState> {
  const database = await openDemoDatabase();
  try {
    const stored = await new Promise<unknown>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readonly');
      const request = transaction.objectStore(STORE_NAME).get(STATE_KEY);
      request.onerror = () => reject(request.error ?? new Error('浏览器无法读取 Demo 状态'));
      request.onsuccess = () => resolve(request.result);
    });
    if (stored === undefined) {
      return {
        version: 1,
        tasks: [],
        updatedAt: new Date().toISOString(),
      };
    }
    assertDemoState(stored);
    return stored;
  } finally {
    database.close();
  }
}

export async function writeBrowserDemoState(state: DemoState) {
  assertDemoState(state);
  const database = await openDemoDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      transaction.onerror = () => reject(transaction.error ?? new Error('浏览器无法保存 Demo 状态'));
      transaction.oncomplete = () => resolve();
      transaction.objectStore(STORE_NAME).put(state, STATE_KEY);
    });
  } finally {
    database.close();
  }
  return state;
}
