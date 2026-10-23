/* Local-only MediaPipe worker. No frames, landmarks, or audio leave this worker. */
/* global Vision */
importScripts('/nonverbal/vendor/vision_bundle.js');
let face,pose,hands;
const valid=p=>p&&Number.isFinite(p.x)&&Number.isFinite(p.y)&&p.x>=0&&p.x<=1&&p.y>=0&&p.y<=1;
const round=n=>Math.round(n*10000)/10000;
function signals(atMs,f,p,h){
  const out={atMs,v:[null,null,null,null],q:['not_detected','not_detected','not_detected','not_detected']};
  if(f.faceLandmarks.length>1||p.landmarks.length>1){out.q.fill('multiple_people');return out;}
  const fl=f.faceLandmarks[0],matrix=f.facialTransformationMatrixes[0]?.data;
  if(fl){
    const selected=[1,33,263,234,454].map(i=>fl[i]);
    if(!selected.every(valid)||Math.abs(fl[234].x-fl[454].x)<.08)out.q[0]='out_of_frame';
    else if(matrix?.length===16&&matrix.every(Number.isFinite)){
      // Rotation around the vertical face axis; not eye position or gaze direction.
      const yaw=Math.atan2(-matrix[2],Math.hypot(matrix[0],matrix[1]))*180/Math.PI;
      if(Math.abs(yaw)<=90){out.v[0]=[round(yaw),0];out.q[0]='observed';}
      else out.q[0]='low_confidence';
    }else out.q[0]='low_confidence';
  }
  const pl=p.landmarks[0];if(!pl)return out;
  const shoulders=[pl[11],pl[12]],confident=points=>points.every(point=>valid(point)&&(point.visibility??0)>=.75);
  if(!shoulders.every(valid)){out.q[1]='out_of_frame';return out;}
  if(!confident(shoulders)){out.q[1]='low_confidence';return out;}
  const center=[(pl[11].x+pl[12].x)/2,(pl[11].y+pl[12].y)/2],width=Math.hypot(pl[11].x-pl[12].x,pl[11].y-pl[12].y);
  if(width<.08){out.q[1]='low_confidence';return out;}
  out.v[1]=center.map(round);out.q[1]='observed';
  // Associate each detected hand with one visible pose wrist. A handedness score is not detection confidence.
  const assigned=new Map();
  for(const landmarks of h.landmarks){
    if(![0,5,9,13,17].every(i=>valid(landmarks[i])))continue;
    const wrist=landmarks[0],matches=[15,16].map((idx,i)=>({i,dist:Math.hypot(wrist.x-pl[idx].x,wrist.y-pl[idx].y),point:pl[idx]})).filter(x=>confident([x.point])&&x.dist<width*.35).sort((a,b)=>a.dist-b.dist);
    if(!matches.length||matches.length>1&&matches[1].dist-matches[0].dist<width*.1)continue;
    const c=matches[0].i+2;
    if(assigned.has(c)){assigned.set(c,null);continue;}
    assigned.set(c,[(wrist.x-center[0])/width,(wrist.y-center[1])/width]);
  }
  for(const [c,value] of assigned){if(value&&value.every(n=>Number.isFinite(n)&&Math.abs(n)<=8)){out.v[c]=value.map(round);out.q[c]='observed';}else out.q[c]='low_confidence';}
  for(const c of [2,3])if(out.q[c]==='not_detected'&&pl[c===2?15:16]?.visibility<.75)out.q[c]='low_confidence';
  return out;
}
self.onmessage=async event=>{
  const {id,type,bitmap,atMs}=event.data;
  try{
    if(type==='init'){
      const files=await Vision.FilesetResolver.forVisionTasks('/nonverbal/vendor/wasm');
      const base={delegate:'CPU'};
      face=await Vision.FaceLandmarker.createFromOptions(files,{baseOptions:{...base,modelAssetPath:'/nonverbal/models/face_landmarker.task'},runningMode:'VIDEO',numFaces:2,minFaceDetectionConfidence:.75,minFacePresenceConfidence:.75,minTrackingConfidence:.75,outputFaceBlendshapes:false,outputFacialTransformationMatrixes:true});
      pose=await Vision.PoseLandmarker.createFromOptions(files,{baseOptions:{...base,modelAssetPath:'/nonverbal/models/pose_landmarker_lite.task'},runningMode:'VIDEO',numPoses:2,minPoseDetectionConfidence:.75,minPosePresenceConfidence:.75,minTrackingConfidence:.75,outputSegmentationMasks:false});
      hands=await Vision.HandLandmarker.createFromOptions(files,{baseOptions:{...base,modelAssetPath:'/nonverbal/models/hand_landmarker.task'},runningMode:'VIDEO',numHands:2,minHandDetectionConfidence:.75,minHandPresenceConfidence:.75,minTrackingConfidence:.75});
      self.postMessage({id,ready:true});
    }else if(type==='frame'){
      if(!face||!pose||!hands)throw Error('모델을 준비하지 못했어요.');
      const f=face.detectForVideo(bitmap,atMs+1),p=pose.detectForVideo(bitmap,atMs+1),h=hands.detectForVideo(bitmap,atMs+1);
      self.postMessage({id,frame:signals(atMs,f,p,h)});
    }
  }catch(error){self.postMessage({id,error:type==='init'?'이 브라우저에서 로컬 영상 모델을 준비하지 못했어요. 최신 Chrome 또는 Edge에서 다시 시도해 주세요.':'영상 프레임 추적을 완료하지 못했어요. 원본 영상은 보존돼요.'});}
  finally{bitmap?.close();}
};
