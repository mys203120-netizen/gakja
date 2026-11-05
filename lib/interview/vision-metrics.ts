export function summarizeVisionRecords(records: Record<string, unknown>[]) {
  const answering = records.filter(record => record.phase === 'listening');
  const sum = (key: string) => answering.reduce((total, record) => {
    const value = record[key];
    return total + (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0);
  },0);
  const gazeFrames=sum('gazeValidFrameCount'), gazeDuration=sum('gazeValidDurationMs');
  const smileFrames=sum('smileValidFrameCount'), browFrames=sum('browDownValidFrameCount'), totalDuration=sum('durationMs');
  return {
    answerRecordCount:answering.length,
    gazeOffFrameRatio:gazeFrames?sum('gazeOffFrameCount')/gazeFrames:null,
    gazeOffTimeRatio:gazeDuration?sum('gazeOffDurationMs')/gazeDuration:null,
    gazeEpisodeCount:sum('gazeEpisodeStarts'),
    smileObservedFrameRatio:smileFrames?sum('smileFrameCount')/smileFrames:null,
    browDownObservedFrameRatio:browFrames?sum('browDownFrameCount')/browFrames:null,
    measuredGazeDurationMs:gazeDuration,
    unavailableRatio:totalDuration?Math.max(0,1-gazeDuration/totalDuration):null
  };
}
