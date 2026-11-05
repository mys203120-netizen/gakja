'use client';

import { createContext, useContext } from 'react';
import type { W0Model, W0Target } from '@/lib/w0/view-model';

export type W0ContextValue = {
  model: W0Model;
  target: W0Target | null;
  selectedTargetId: string;
  setSelectedTargetId: (id: string) => void;
  preview: boolean;
  scenario: string;
  viewHref: (path: string) => string;
};

export const W0Context = createContext<W0ContextValue | null>(null);
export function useW0() {
  const context = useContext(W0Context);
  if (!context) throw new Error('W0 components require the isolated shell.');
  return context;
}
