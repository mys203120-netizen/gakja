'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import {api,type Item} from './shared';

/** Each scope owns its loading/error state. A pending previous school can never render as the current school's empty list. */
export function useRecordPages(kind:string,scope='',enabled=true,owner=''){
 const key=owner+'|'+kind+'?'+scope,sequence=useRef(0),pending=useRef(false);
 const [state,setState]=useState<{key:string;items:Item[];page:Item|null;loading:boolean;error:string}>({key:'',items:[],page:null,loading:false,error:''});
 const load=useCallback(async(cursor?:string)=>{if(!enabled||pending.current)return;pending.current=true;const request=++sequence.current;setState(previous=>({key,items:cursor&&previous.key===key?previous.items:[],page:cursor&&previous.key===key?previous.page:null,loading:true,error:''}));try{const result=await api('/api/student-records?kind='+encodeURIComponent(kind)+(scope?'&'+scope:'')+(cursor?'&cursor='+encodeURIComponent(cursor):''),{cache:'no-store'});if(request!==sequence.current)return;setState(previous=>({key,items:cursor?[...previous.items,...result.items.filter((item:Item)=>!previous.items.some(existing=>existing.id===item.id))]:result.items,page:result.page,loading:false,error:''}));}catch(error){if(request===sequence.current)setState(previous=>({...previous,key,loading:false,error:(error as Error).message}));}finally{if(request===sequence.current)pending.current=false;}},[key,enabled,kind,scope]);
 useEffect(()=>{pending.current=false;void load();return()=>{sequence.current++;pending.current=false;};},[load]);
 const current=enabled&&state.key===key?state:{items:[],page:null,loading:enabled,error:''};
 return {...current,ready:state.key===key&&!state.loading&&!state.error,more:()=>load(state.page?.nextCursor),reload:()=>load()};
}

export function useRecordDetail(kind:string,selection:string,enabled=true,owner=''){
 const key=owner+'|'+kind+'?'+selection,sequence=useRef(0),controller=useRef<AbortController|null>(null);
 const [state,setState]=useState<{key:string;item:Item|null;session?:Item|null;loading:boolean;error:string}>({key:'',item:null,loading:enabled,error:''});
 const reload=useCallback(async()=>{if(!enabled)return;const request=++sequence.current;controller.current?.abort();const current=new AbortController();controller.current=current;setState({key,item:null,loading:true,error:''});try{const result=await api('/api/student-records?kind='+encodeURIComponent(kind)+'&'+selection,{signal:current.signal,cache:'no-store'});if(request===sequence.current)setState({key,item:result.item,session:result.session,loading:false,error:''});}catch(error){if(request===sequence.current)setState({key,item:null,loading:false,error:(error as Error).message});}},[key,kind,selection,enabled]);
 useEffect(()=>{void reload();return()=>{sequence.current++;controller.current?.abort();};},[reload]);
 return enabled&&state.key===key?{...state,reload}:{item:null,session:null,loading:enabled,error:'',reload};
}
