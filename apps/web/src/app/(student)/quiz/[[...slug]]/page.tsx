import { QuizPages } from '@/components/practice';
export default async function Page({params}:{params:Promise<{slug?:string[]}>}) {
  const {slug}=await params;return <QuizPages key={slug?.join('/')||'root'} slug={slug}/>;
}
