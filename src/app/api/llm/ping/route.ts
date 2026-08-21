// LLM proxy health check.

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { LLMClient } from '@/lib/llm';
import { LLM_API_KEY } from '@/lib/env';

export async function POST(req: NextRequest) {
  if (!(await requireAuth())) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { proxy_url, api_key, model } = await req.json();
  if (!proxy_url) return NextResponse.json({ error: 'proxy_url required' }, { status: 400 });
  const result = await LLMClient.ping(proxy_url, api_key || LLM_API_KEY, model);
  return NextResponse.json(result);
}
