import type { NextRequest } from 'next/server';
type BatchContext = { params: Promise<{ path: string[] }> };
export function GET(request: NextRequest, context: BatchContext): Promise<Response>;
export function POST(request: NextRequest, context: BatchContext): Promise<Response>;
