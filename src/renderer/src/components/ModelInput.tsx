import { useEffect, useId, useState } from 'react';
import type { AiKind, Settings } from '../../../shared/domain';
import { call } from '../api/store';

interface ModelInputProps {
  kind: AiKind;
  catalog?: Settings['team']['modelCatalog'];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

export function ModelInput({ kind, catalog, value, onChange, placeholder }: ModelInputProps) {
  const listId = useId();
  const [loadedCatalog, setLoadedCatalog] = useState<Settings['team']['modelCatalog']>();
  useEffect(() => {
    if (!catalog)
      void call('settings.get')
        .then((settings) => setLoadedCatalog(settings.team.modelCatalog))
        .catch(() => undefined);
  }, [catalog]);
  return (
    <>
      <input list={listId} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />
      <datalist id={listId}>
        {((catalog ?? loadedCatalog)?.[kind] ?? []).map((option) => (
          <option key={option.id} value={option.id} label={`${option.label} · ${option.note}`} />
        ))}
      </datalist>
    </>
  );
}
