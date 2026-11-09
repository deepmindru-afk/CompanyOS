import { describe, expect, test } from 'bun:test';

import { settingsQueryAfterDroppedWrite, settingsQueryWriteStillValid, withSettingsQuery } from './workspace-settings-sidebar-nav';

describe('withSettingsQuery', () => {
  test('adds the query to a plain path', () => {
    expect(withSettingsQuery('/workspaces/w1/settings/general', 'en')).toBe(
      '/workspaces/w1/settings/general?settings_q=en',
    );
  });

  test('keeps the existing params and the hash', () => {
    expect(withSettingsQuery('/s/security?tab=keys#rules', 'key')).toBe(
      '/s/security?tab=keys&settings_q=key#rules',
    );
  });

  test('replaces an older query', () => {
    expect(withSettingsQuery('/s/general?settings_q=old', 'new')).toBe('/s/general?settings_q=new');
  });

  test('an empty query removes the param and leaves no bare "?"', () => {
    expect(withSettingsQuery('/s/general?settings_q=en', '')).toBe('/s/general');
    expect(withSettingsQuery('/s/general?tab=a&settings_q=en', '  ')).toBe('/s/general?tab=a');
  });
});

describe('settingsQueryWriteStillValid', () => {
  test('a write fires when the page has not moved since it started', () => {
    expect(settingsQueryWriteStillValid('/s/api-keys?settings_q=key', '/s/api-keys?settings_q=key')).toBe(true);
  });

  test('Back before the debounce fires: the restored page wins, even with the same query', () => {
    // Typed "git" on api-keys?settings_q=key, Back to general?settings_q=key within 250 ms.
    expect(settingsQueryWriteStillValid('/s/general?settings_q=key', '/s/api-keys?settings_q=key')).toBe(false);
    expect(settingsQueryWriteStillValid('/s/general?settings_q=old', '/s/general?settings_q=key')).toBe(false);
  });

  test('a result opened mid-debounce already carries the newer query: the write is dropped', () => {
    expect(settingsQueryWriteStillValid('/s/security?settings_q=keys', '/s/general?settings_q=ke')).toBe(false);
  });
});

describe('settingsQueryAfterDroppedWrite', () => {
  test('Back to an entry with the same path and query but another param: the field takes the URL query', () => {
    // Typed "git" on general?tab=b&settings_q=key, Back to general?tab=a&settings_q=key within 250 ms.
    expect(settingsQueryWriteStillValid('/s/general?tab=a&settings_q=key', '/s/general?tab=b&settings_q=key')).toBe(false);
    expect(settingsQueryAfterDroppedWrite('?tab=a&settings_q=key')).toBe('key');
  });

  test('no param: the field empties', () => {
    expect(settingsQueryAfterDroppedWrite('?tab=a')).toBe('');
  });
});
