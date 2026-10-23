export function draftProposalError(input:{baseline:string;current:string;proposal:string;confirmed:boolean;maxLength:number}){
 if(input.current!==input.baseline)return '답변이 바뀌었어요. 최신 초안에서 제안을 다시 열어 주세요.';
 if(!input.proposal.trim())return '적용할 문장을 먼저 확인해 주세요.';
 if(input.proposal.length>input.maxLength)return `${input.maxLength.toLocaleString('ko-KR')}자 안으로 줄여 주세요.`;
 if(!input.confirmed)return '내가 한 일과 사실이 맞는지 확인해 주세요.';
 return null;
}
