export type ClassOwner=Readonly<Record<string,string>>;

/** Add module aliases without changing the DOM hooks used by navigation and motion.
 * Every native element gets zero-specificity primitive anchors, including portals.
 * The bounded cache cannot grow with a student's history or a server's lifetime. */
export function createOwnedClassResolver(owners:readonly ClassOwner[]){
 const byHook=new Map<string,string[]>(),elements:string[]=[];
 for(const owner of owners)for(const [hook,classes] of Object.entries(owner)){
  const aliases=classes.split(/\s+/).filter(Boolean);
  if(hook==='element'){elements.push(...aliases);continue;}
  byHook.set(hook,[...(byHook.get(hook)||[]),...aliases]);
 }
 const cache=new Map<string,string>();
 return function ownedClassName(value?:string|null,native=false):string|undefined{
  if(value==null&&!native)return undefined;
  const key=(native?'native:':'class:')+(value??'');
  const cached=cache.get(key);if(cached!==undefined)return cached;
  const hooks=(value??'').split(/\s+/).filter(Boolean),result=new Set(hooks);
  for(const hook of hooks)for(const alias of byHook.get(hook)||[])result.add(alias);
  if(native)for(const alias of elements)result.add(alias);
  const output=[...result].join(' ');
  if(cache.size>=2048)cache.delete(cache.keys().next().value!);
  cache.set(key,output);return output;
 };
}
