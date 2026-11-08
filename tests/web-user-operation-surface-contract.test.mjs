import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { OPERATION_DEFINITIONS } from '@openkit/app-api-schemas';

describe('public credential operation contracts', () => {
  it('keeps generic credential lifecycle on the unified Vault and authorized agent boundary', () => {
    for (const id of ['vault.binding-deliver', 'vault.binding-replace', 'vault.binding-revoke']) {
      const definition = OPERATION_DEFINITIONS[id];
      assert.ok(definition, 'Vault lifecycle operation is absent');
      assert.equal(definition.binding, 'json');
      assert.equal(definition.returnsOneTimeSecret, false);
      assert.equal(definition.mutating, true);
      assert.equal(definition.policyOperation, 'vault.use');
      assert.ok(definition.credentials.includes('worker-package'));
      assert.ok(definition.credentials.includes('coordinator'));
    }
  });
});
