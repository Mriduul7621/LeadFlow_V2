import { DropdownOption } from '../../shared/types';
import { localDb } from '../../../services/localDb';
import { metadataService } from '../../metadata/services/metadataService';

/**
 * settingsService is a thin backward-compatible wrapper around
 * metadataService (the Metadata Engine). New code should prefer calling
 * metadataService directly.
 *
 * Writes are API-first: the localDb cache is only updated after the
 * server confirms persistence; failures throw so the UI never reports a
 * saved option that the database does not have.
 */
export const settingsService = {
  async getOptionsByType(type: string): Promise<string[]> {
    return metadataService.getActiveValues(type);
  },

  async addOption(type: string, value: string, meta?: Record<string, any>, label?: string): Promise<DropdownOption> {
    const saved = await metadataService.addValue(type, value, meta, label);
    localDb.addOption(type, saved.value || value);
    return saved;
  },

  async deleteOption(type: string, value: string): Promise<void> {
    await metadataService.deleteValue(type, value);
    localDb.deleteOption(type, value);
  },
};
