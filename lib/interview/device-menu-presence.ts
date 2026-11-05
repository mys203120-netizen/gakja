export type DeviceMenu = 'mic' | 'speaker' | 'camera';
export type DeviceMenuPresence = { menu: DeviceMenu | null; phase: 'closed' | 'entering' | 'open' | 'closing'; activation: 'hover' | 'pinned' | null; entered: boolean; revision: number };
export type DeviceMenuPresenceAction = { type: 'toggle'; menu: DeviceMenu } | { type: 'close' } | { type: 'finish_enter'; revision: number } | { type: 'finish_exit'; revision: number } | { type: 'hover_enter' | 'hover_leave'; menu: DeviceMenu; pointerType: string };
export const DEVICE_MENU_EXIT_MS = 550;
export const initialDeviceMenuPresence: DeviceMenuPresence = { menu: null, phase: 'closed', activation: null, entered: false, revision: 0 };

export function deviceMenuItemIndex(index: number) {
  return Number.isFinite(index) ? Math.min(3, Math.max(0, Math.floor(index))) : 0;
}

export function deviceMenuInteraction(state: DeviceMenuPresence) {
  const inactive = !deviceMenuIsActive(state);
  return { inert: inactive, 'aria-hidden': inactive };
}

export function deviceMenuIsActive(state: DeviceMenuPresence) { return state.phase === 'entering' || state.phase === 'open'; }

function openMenu(state: DeviceMenuPresence, menu: DeviceMenu, activation: 'hover' | 'pinned'): DeviceMenuPresence {
  // The same closing DOM can reverse its transition; a newly mounted panel needs a painted entry frame.
  const reversePaintedExit = state.menu === menu && state.phase === 'closing' && state.entered;
  return { menu, phase: reversePaintedExit ? 'open' : 'entering', activation, entered: reversePaintedExit, revision: state.revision + 1 };
}
function closeMenu(state: DeviceMenuPresence): DeviceMenuPresence {
  return deviceMenuIsActive(state) ? { ...state, phase: 'closing', activation: null, revision: state.revision + 1 } : state;
}

/** A completion token belongs only to its own entry/exit, even after hover switches or click pins. */
export function deviceMenuPresenceReducer(state: DeviceMenuPresence, action: DeviceMenuPresenceAction): DeviceMenuPresence {
  if (action.type === 'finish_enter') return state.phase === 'entering' && action.revision === state.revision ? { ...state, phase: 'open', entered: true } : state;
  if (action.type === 'finish_exit') return state.phase === 'closing' && action.revision === state.revision ? { menu: null, phase: 'closed', activation: null, entered: false, revision: state.revision } : state;
  if (action.type === 'close') return closeMenu(state);
  if (action.type === 'hover_enter') {
    if (action.pointerType !== 'mouse' || (deviceMenuIsActive(state) && state.menu === action.menu)) return state;
    return openMenu(state, action.menu, 'hover');
  }
  if (action.type === 'hover_leave') return action.pointerType === 'mouse' && state.menu === action.menu && state.activation === 'hover' ? closeMenu(state) : state;
  if (deviceMenuIsActive(state) && state.menu === action.menu) {
    // A first click pins a hover-open menu; another click explicitly closes it.
    return state.activation === 'hover' ? { ...state, activation: 'pinned' } : closeMenu(state);
  }
  return openMenu(state, action.menu, 'pinned');
}
