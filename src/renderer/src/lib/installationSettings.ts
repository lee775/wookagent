import type { DeepPartial } from '../../../shared/ipc';
import type { Settings } from '../../../shared/domain';

/** Pick every installation leaf explicitly. Never send an operations setting with this patch. */
export function installationPatch(settings: Settings): DeepPartial<Settings> {
  return {
    account: { googleClientId: settings.account.googleClientId, authMode: settings.account.authMode },
    cli: settings.cli,
    policy: settings.policy,
    logs: { retentionDays: settings.logs.retentionDays },
    general: {
      backup: { enabled: settings.general.backup.enabled },
      launchAtLogin: settings.general.launchAtLogin,
    },
  };
}
