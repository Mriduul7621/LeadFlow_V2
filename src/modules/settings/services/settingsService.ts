import { DropdownOption } from '../../shared/types';
import { localDb } from '../../../services/localDb';
import { metadataService } from '../../metadata/services/metadataService';

// NOTE: settingsService is now a thin backward-compatible wrapper around
// metadataService (the Metadata Engine). New code should prefer calling
// metadataService directly, since it also exposes types, ordering,
// per-value meta, and reordering - none of which fit this old shape.
export const settingsService = {
  async getOptionsByType(type: string): Promise<string[]> {
    return metadataService.getActiveValues(type);
  },

  async addOption(type: string, value: string) {
    localDb.addOption(type, value);
    try {
      await metadataService.addValue(type, value);
    } catch (error) {
      console.warn('Cloud add option failed, kept in local cache only:', error);
    }
  },

  async deleteOption(type: string, value: string) {
    localDb.deleteOption(type, value);
    try {
      await metadataService.deleteValue(type, value);
    } catch (error) {
      console.warn('Cloud delete option failed, removed from local cache only:', error);
    }
  },
};

