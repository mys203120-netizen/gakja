'use client';

import {createContext,useContext,type ReactNode} from 'react';

// AppShell supplies the authenticated bootstrap preference before showing pages.
// A server-backed value avoids a flash of help from another account on this device.
const HelpPreferences=createContext(true);

export function HelpPreferencesProvider({enabled,children}:{enabled:boolean;children:ReactNode}) {
  return <HelpPreferences.Provider value={enabled}>{children}</HelpPreferences.Provider>;
}

export function useHelpEnabled() { return useContext(HelpPreferences); }
