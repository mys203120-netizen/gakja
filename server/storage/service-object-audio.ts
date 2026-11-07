import type { AuthenticatedRequestContext, RequestIdentityBoundary } from '../auth/request-identity';
import type { AudioAccessBinding, ServiceRequestResources } from '../request-realtime-server';
import type { PrivateObjectService } from './private-object-service';

/** Only the service audio read method changes. Session/status composition and
 * metadata discovery remain explicit dependencies; local AudioRepository.read
 * and publish are not cast, replaced or reported as successful writes. */
export function withPrivateObjectAudio(resources: ServiceRequestResources, objects: PrivateObjectService, identity: RequestIdentityBoundary): ServiceRequestResources {
  return Object.freeze({
    ...resources,
    async audioBinding(context: AuthenticatedRequestContext, id: string) {
      const found = await resources.audioBinding(context, id);
      if (!found) return null;
      identity.assertResource(context, found);
      const selected = identity.selectScope(context, found);
      const metadata = await objects.audioMetadata(selected, id);
      return metadata ? { ...found, ...metadata } : null;
    },
    async readAudio(context: AuthenticatedRequestContext, binding: AudioAccessBinding) {
      return objects.readAudio(context, binding.resourceId);
    },
  });
}
