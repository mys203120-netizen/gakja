'use client';

import { useEffect } from 'react';
import { installNestedScrollBehavior } from '@/lib/client/nested-scroll';

export function ScrollBehavior() {
  useEffect(() => installNestedScrollBehavior(document), []);
  return null;
}
