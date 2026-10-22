import Link from 'next/link';
import {BookOpen,Newspaper} from 'lucide-react';
import {ownedClassName} from './owned-class-name';
import styles from './learning-discovery.module.css';

/** Keep these resources visible alongside practice, without adding another tab. */
export function LearningDiscovery({targetId}:{targetId?:string}){
 const knowledgeHref='/knowledge'+(targetId?'?targetId='+encodeURIComponent(targetId):'');
 return <nav className={ownedClassName(styles.entries,true)} aria-label="개념과 시사">
  <Link className={ownedClassName(styles.entry)} href={knowledgeHref}><BookOpen size={20} aria-hidden="true"/><strong className={ownedClassName(undefined,true)}>지식한입</strong><span className={ownedClassName(undefined,true)}>학과·활동 개념</span></Link>
  <Link className={ownedClassName(styles.entry)} href="/materials/briefings"><Newspaper size={20} aria-hidden="true"/><strong className={ownedClassName(undefined,true)}>시사 브리핑</strong><span className={ownedClassName(undefined,true)}>전공 관련 이슈</span></Link>
 </nav>;
}
