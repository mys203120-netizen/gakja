'use client';
import { useCallback, useEffect, useId, useReducer, useRef, type CSSProperties } from 'react';
import { Mic, MicOff, Video, VideoOff, Volume2, VolumeX, ChevronUp, PhoneOff, Check } from 'lucide-react';
import type { AudioDevices } from '@/hooks/useAudioDevices';
import { DEVICE_MENU_EXIT_MS, deviceMenuInteraction, deviceMenuIsActive, deviceMenuItemIndex, deviceMenuPresenceReducer, initialDeviceMenuPresence } from '@/lib/interview/device-menu-presence';
import { deviceMenuOptions } from '@/lib/interview/device-menu-options';
import styles from './DeviceControls.module.css';
const itemProps = (index: number) => ({ className: styles.item, style: { '--item-index': deviceMenuItemIndex(index) } as CSSProperties, 'data-menu-item': index });
export function DeviceControls({ media, onEnd, canEnd }: { media: AudioDevices; onEnd: () => void; canEnd: boolean }) {
  const [presence, dispatchPresence] = useReducer(deviceMenuPresenceReducer, initialDeviceMenuPresence);
  const popover = deviceMenuIsActive(presence) ? presence.menu : null;
  const interaction = deviceMenuInteraction(presence);
  const activePopover = useRef(popover);
  activePopover.current = popover;
  const closePopover = useCallback(() => dispatchPresence({ type: 'close' }), []);
  const groups = useRef<Record<'mic' | 'camera' | 'speaker', HTMLDivElement | null>>({ mic: null, camera: null, speaker: null });
  const menuId = useId();
  useEffect(() => {
    if (presence.phase !== 'entering') return;
    const revision = presence.revision;
    let frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => dispatchPresence({ type: 'finish_enter', revision })); });
    return () => cancelAnimationFrame(frame);
  }, [presence.phase, presence.revision]);
  useEffect(() => {
    if (presence.phase !== 'closing') return;
    const revision = presence.revision;
    const timer = setTimeout(() => dispatchPresence({ type: 'finish_exit', revision }), DEVICE_MENU_EXIT_MS);
    return () => clearTimeout(timer);
  }, [presence.phase, presence.revision]);
  useEffect(() => {
    if (!popover) return;
    const dismissOutside = (event: PointerEvent) => { const active = activePopover.current; if (!active) return; const group = groups.current[active]; if (group && !event.composedPath().includes(group)) closePopover(); };
    const dismissEscape = (event: KeyboardEvent) => { const active = activePopover.current; if (active && event.key === 'Escape') { event.stopPropagation(); closePopover(); groups.current[active]?.querySelector<HTMLButtonElement>('.device-selector')?.focus(); } };
    document.addEventListener('pointerdown', dismissOutside, true);
    document.addEventListener('keydown', dismissEscape, true);
    return () => { document.removeEventListener('pointerdown', dismissOutside, true); document.removeEventListener('keydown', dismissEscape, true); };
  }, [closePopover, popover]);
  const deviceList = (kind: MediaDeviceKind) => deviceMenuOptions(media.devices, kind);
  const selectedMic = media.selectedMicId;
  const selectedCamera = media.cameraStream?.getVideoTracks()[0]?.getSettings().deviceId;
  const title = (id: string | undefined, kind: MediaDeviceKind, fallback: string) => media.devices.find(d => d.deviceId === id && d.kind === kind)?.label || fallback;
  const micLabel = media.selectedMicLabel || title(selectedMic, 'audioinput', '마이크');
  const speakerLabel = title(media.outputId, 'audiooutput', '기본 출력');
  const cameraLabel = title(selectedCamera, 'videoinput', '카메라');
  return <div className="device-bar" aria-label="면접 장치 설정">
    <div className="device-group" ref={element => { groups.current.mic = element; }} onPointerEnter={event => dispatchPresence({ type: 'hover_enter', menu: 'mic', pointerType: event.pointerType })} onPointerLeave={event => dispatchPresence({ type: 'hover_leave', menu: 'mic', pointerType: event.pointerType })}><button className={`device-toggle ${media.micEnabled ? '' : 'is-off'}`} aria-label={media.micEnabled ? '마이크 끄기' : '마이크 켜기'} onClick={() => void media.toggleMic().catch(() => {})}>{media.micEnabled ? <Mic size={18} /> : <MicOff size={18} />}</button><button className="device-selector" onClick={() => dispatchPresence({ type: 'toggle', menu: 'mic' })} aria-label={`마이크 선택: ${micLabel}`} aria-haspopup="dialog" aria-controls={popover === 'mic' ? `${menuId}-mic` : undefined} aria-expanded={popover === 'mic'}><span>{micLabel}</span><ChevronUp size={14} /></button>
      {presence.menu === 'mic' && <div className={`device-popover ${styles.menu}`} data-presence={presence.phase} {...interaction} id={`${menuId}-mic`} role="dialog" aria-label="마이크 선택"><h3 {...itemProps(0)}>마이크</h3>{deviceList('audioinput').length ? deviceList('audioinput').map(({ device: d, key }, i) => <button key={key} {...itemProps(i + 1)} onClick={() => { void media.requestMic(d.deviceId).catch(() => {}); closePopover(); }}><span>{d.label || `마이크 ${i + 1}`}</span>{selectedMic === d.deviceId && <Check size={14} />}</button>) : <p {...itemProps(1)}>마이크 권한을 허용하면 연결된 장치가 표시됩니다.</p>}</div>}
    </div>
    <div className="device-group" ref={element => { groups.current.speaker = element; }} onPointerEnter={event => dispatchPresence({ type: 'hover_enter', menu: 'speaker', pointerType: event.pointerType })} onPointerLeave={event => dispatchPresence({ type: 'hover_leave', menu: 'speaker', pointerType: event.pointerType })}><button className="device-toggle" aria-label={media.volume ? '스피커 음소거' : '스피커 음소거 해제'} onClick={() => media.setVolume(media.volume ? 0 : .85)}>{media.volume ? <Volume2 size={18} /> : <VolumeX size={18} />}</button><button className="device-selector" onClick={() => dispatchPresence({ type: 'toggle', menu: 'speaker' })} aria-label={`스피커 선택 및 음량: ${speakerLabel}`} aria-haspopup="dialog" aria-controls={popover === 'speaker' ? `${menuId}-speaker` : undefined} aria-expanded={popover === 'speaker'}><span>스피커</span><ChevronUp size={14} /></button>
      {presence.menu === 'speaker' && <div className={`device-popover ${styles.menu}`} data-presence={presence.phase} {...interaction} id={`${menuId}-speaker`} role="dialog" aria-label="스피커 선택 및 음량"><h3 {...itemProps(0)}>스피커</h3><label {...itemProps(1)} className={`volume-control ${styles.item}`}>음량 <input type="range" min="0" max="1" step=".01" value={media.volume} onChange={e => media.setVolume(Number(e.target.value))} aria-label="스피커 음량" /></label>{media.canSetSinkId ? <><button {...itemProps(2)} onClick={() => void media.selectOutput('')}><span>기본 출력</span>{!media.outputId && <Check size={14} />}</button>{deviceList('audiooutput').filter(({ device }) => device.deviceId !== 'default').map(({ device: d, key }, i) => <button key={key} {...itemProps(i + 3)} onClick={() => { void media.selectOutput(d.deviceId); closePopover(); }}><span>{d.label || `스피커 ${i + 1}`}</span>{media.outputId === d.deviceId && <Check size={14} />}</button>)}</> : <p {...itemProps(2)}>이 브라우저에서는 시스템 기본 출력을 사용합니다.</p>}</div>}
    </div>
    <div className="device-group" ref={element => { groups.current.camera = element; }} onPointerEnter={event => dispatchPresence({ type: 'hover_enter', menu: 'camera', pointerType: event.pointerType })} onPointerLeave={event => dispatchPresence({ type: 'hover_leave', menu: 'camera', pointerType: event.pointerType })}><button className={`device-toggle ${media.cameraEnabled ? '' : 'is-off'}`} aria-label={media.cameraEnabled ? '카메라 끄기' : '카메라 켜기'} onClick={() => void media.toggleCamera().catch(() => {})}>{media.cameraEnabled ? <Video size={18} /> : <VideoOff size={18} />}</button><button className="device-selector" onClick={() => dispatchPresence({ type: 'toggle', menu: 'camera' })} aria-label={`카메라 선택: ${cameraLabel}`} aria-haspopup="dialog" aria-controls={popover === 'camera' ? `${menuId}-camera` : undefined} aria-expanded={popover === 'camera'}><span>{cameraLabel}</span><ChevronUp size={14} /></button>
      {presence.menu === 'camera' && <div className={`device-popover ${styles.menu}`} data-presence={presence.phase} {...interaction} id={`${menuId}-camera`} role="dialog" aria-label="카메라 선택"><h3 {...itemProps(0)}>카메라</h3>{deviceList('videoinput').length ? deviceList('videoinput').map(({ device: d, key }, i) => <button key={key} {...itemProps(i + 1)} onClick={() => { void media.requestCamera(d.deviceId).catch(() => {}); closePopover(); }}><span>{d.label || `카메라 ${i + 1}`}</span>{selectedCamera === d.deviceId && <Check size={14} />}</button>) : <p {...itemProps(1)}>카메라 권한을 허용하면 연결된 장치가 표시됩니다.</p>}</div>}
    </div>
    <span className="device-divider" /><button className="end-button" onClick={onEnd} disabled={!canEnd} aria-label="면접 종료"><PhoneOff size={19} /></button>
  </div>;
}
