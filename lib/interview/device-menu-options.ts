type DeviceIdentity = Pick<MediaDeviceInfo, 'kind' | 'deviceId' | 'groupId'>;

/** Device IDs may be blank before permission or repeated by virtual devices. */
export function deviceMenuOptions<T extends DeviceIdentity>(devices: readonly T[], kind: MediaDeviceKind) {
  const occurrences = new Map<string, number>();
  return devices.filter(device => device.kind === kind).map(device => {
    const identity = JSON.stringify([device.kind, device.deviceId, device.groupId]);
    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);
    return { device, key: `${identity}:${occurrence}` };
  });
}
