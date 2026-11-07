import { AsyncLocalStorage } from 'node:async_hooks';
interface ProviderModels {question:string;realtime:string;review:string;evaluation:string}
const models=new AsyncLocalStorage<Readonly<ProviderModels>>();
/** Session pins are authority for an existing service session; local/offline
 * callers keep their existing environment/default model selection. */
export function withPinnedProviderModels<T>(value:unknown,operation:()=>Promise<T>):Promise<T>{
 if(!value||typeof value!=='object'||!['question','realtime','review','evaluation'].every(key=>typeof Reflect.get(value,key)==='string'&&Reflect.get(value,key).trim().length))throw new Error('SERVICE_PINNED_MODELS_REQUIRED');
 return models.run(Object.freeze({...value})as Readonly<ProviderModels>,operation);
}
export const pinnedProviderModels=()=>models.getStore();
