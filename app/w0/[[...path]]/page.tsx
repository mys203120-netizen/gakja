import { notFound } from 'next/navigation';
import { W0App } from '@/components/w0/W0App';
import { createDisconnectedModel } from '@/lib/w0/view-model';
import { getW0Route } from '@/lib/w0/navigation';

export default async function W0Page({ params, searchParams }: {
  params: Promise<{ path?: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const route = getW0Route((await params).path);
  if (!route || (route.preview && process.env.NODE_ENV !== 'development')) notFound();
  const query = await searchParams;
  const scenario = typeof query.scenario === 'string' ? query.scenario : 'ready';
  let model = createDisconnectedModel();
  if (route.preview) {
    // Guard first; synthetic data never enters ordinary page props or client imports.
    const { createDevelopmentFixture } = await import('@/lib/w0/development-fixtures');
    const fixture = createDevelopmentFixture(scenario, process.env.NODE_ENV);
    if (!fixture) notFound();
    model = fixture;
  }
  return <W0App model={model} screen={route.screen} detailId={route.id} preview={route.preview} scenario={scenario} initialTargetId={typeof query.target === 'string' ? query.target : ''} />;
}
