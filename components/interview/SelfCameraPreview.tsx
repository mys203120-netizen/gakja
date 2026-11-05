'use client';
import { useEffect, type RefObject } from 'react';
import { VideoOff, ScanFace } from 'lucide-react';
export function SelfCameraPreview({ stream, enabled, videoRef, onEnable, faceStatus, calibrate, showCalibration }: { stream: MediaStream | null; enabled: boolean; videoRef: RefObject<HTMLVideoElement | null>; onEnable: () => void; faceStatus: string; calibrate: () => void; showCalibration: boolean }) {
  useEffect(() => { if (videoRef.current) videoRef.current.srcObject = stream; }, [stream, videoRef]);
  return <div className="self-camera">
    <video ref={videoRef} autoPlay playsInline muted className={enabled ? '' : 'camera-hidden'} aria-label="내 카메라 미리보기" />
    {!enabled && <div className="camera-empty"><VideoOff size={25} strokeWidth={1.3} /><span>카메라가 꺼져 있어요</span><button onClick={onEnable}>카메라 켜기</button></div>}
    <span className="camera-label">윤지우 · 나</span>
    {enabled && showCalibration && <button className="calibration-button" onClick={calibrate} disabled={faceStatus === 'loading' || faceStatus === 'unavailable' || faceStatus === 'calibrating'}><ScanFace size={13} />{faceStatus === 'calibrated' ? '기준점 다시 잡기' : faceStatus === 'calibrating' ? '카메라를 바라봐 주세요' : faceStatus === 'unavailable' ? '시선 관찰 사용 불가' : '카메라 보고 기준점 잡기'}</button>}
  </div>;
}
