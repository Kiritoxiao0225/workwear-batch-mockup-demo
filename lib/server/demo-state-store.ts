import 'server-only';

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { assertDemoState } from '@/lib/state-validation';
import type { DemoState } from '@/lib/types';

const STATE_FILE = path.join(process.cwd(), 'data', 'demo-state.json');

function emptyDemoState(): DemoState {
  return {
    version: 1,
    tasks: [],
    updatedAt: new Date().toISOString(),
  };
}

export async function readDemoState(): Promise<DemoState> {
  let source: string;
  try {
    source = await readFile(STATE_FILE, 'utf8');
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    const state = emptyDemoState();
    await mkdir(path.dirname(STATE_FILE), { recursive: true });
    await writeFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    return state;
  }
  const parsed: unknown = JSON.parse(source);
  assertDemoState(parsed);
  return parsed;
}

export async function writeDemoState(value: unknown): Promise<DemoState> {
  assertDemoState(value);
  const state: DemoState = {
    ...value,
    updatedAt: new Date().toISOString(),
  };
  const temporaryFile = `${STATE_FILE}.${randomUUID()}.tmp`;
  await writeFile(temporaryFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await rename(temporaryFile, STATE_FILE);
  return state;
}
