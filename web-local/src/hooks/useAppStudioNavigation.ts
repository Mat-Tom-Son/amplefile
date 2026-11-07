import { useEffect, useRef } from "react";

/** Navigation is a one-time selection hint, not authority to prepare or activate an update. */
export function useAppStudioNavigation({ active, loading, instances, navigation, registeredConnectedFolderIds, selectId, onSelect, onError }: {
  active: boolean;
  loading: boolean;
  instances: readonly { runtimeInstanceId: string; connectedFolderId: string }[] | undefined;
  navigation: { id: string; runtimeInstanceId: string } | null;
  registeredConnectedFolderIds: ReadonlySet<string>;
  selectId: string;
  onSelect: (connectedFolderId: string) => void;
  onError: (message: string) => void;
}) {
  const applied = useRef<string | null>(null);
  useEffect(() => {
    if (!active || loading || !instances || !navigation || applied.current === navigation.id) return;
    applied.current = navigation.id;
    const instance = instances.find((item) => item.runtimeInstanceId === navigation.runtimeInstanceId);
    if (!instance || !registeredConnectedFolderIds.has(instance.connectedFolderId)) {
      onSelect("");
      onError("That app installation is no longer available.");
      return;
    }
    onSelect(instance.connectedFolderId);
    document.getElementById(selectId)?.focus();
  }, [active, loading, instances, navigation, registeredConnectedFolderIds, selectId, onSelect, onError]);
}
