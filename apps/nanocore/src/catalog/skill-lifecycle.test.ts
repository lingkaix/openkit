import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digestOpenKitTree, hashOpenKitTreeEntries } from '@openkit/config-schema';
import { describe, expect, it } from 'vitest';
import {
  projectWorkspaceCatalogExport,
  reconstructImportedWorkspaceCatalog,
  writeImportedWorkspaceCatalog,
} from './catalog-portability.js';
import {
  CatalogConflictError,
  CatalogContentUnavailableError,
  CatalogForbiddenError,
  CatalogInputError,
  CatalogIntegrityError,
  CatalogNotFoundError,
  CatalogRetentionError,
  catalogDocumentPath,
  decideWorkspaceSkillCandidate,
  importWorkspaceSkill,
  loadWorkspaceResourceCatalog,
  purgeWorkspaceSkillVersion,
  removeWorkspaceSkill,
  selectWorkspaceSkillDefault,
  setWorkspaceSkillPin,
  skillSnapshotPath,
  submitWorkspaceSkillCandidate,
  validateCatalogTree,
} from './resource-catalog.js';
import {
  diffWorkspaceSkillVersions,
  readWorkspaceSkillContent,
  readWorkspaceSkillVersion,
} from './skill-inspection.js';

/** Disposable retained Skill authority with exact real bytes. */
function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-skill-lifecycle-'));
  const input = {
    createdAt: '2026-10-16T00:00:00.000Z',
    dataRoot,
    producer: { id: 'user_local', kind: 'user' as const },
    workspaceId: 'ws_demo',
  };
  const imported = importWorkspaceSkill({
    ...input,
    activate: true,
    displayName: 'Alpha',
    expectedRevision: 0,
    tree: tree('# Original'),
  });
  return { ...input, imported };
}

/** Complete submitted tree whose bytes define the version. */
function tree(text: string) {
  return [
    {
      kind: 'file' as const,
      path: 'SKILL.md',
      contentBase64: Buffer.from(
        `---\nname: alpha\ndescription: Exercise the Skill lifecycle.\n---\n${text}`
      ).toString('base64'),
    },
  ];
}

describe('Skill catalog lifecycle', () => {
  it.each([
    [
      'descriptive nested metadata',
      '---\nname: alpha\ndescription: Keep ecosystem metadata.\nmetadata:\n  internal: true\n  revision: 2\n  tags: [one, two]\n---\n# Exact body\n',
    ],
    [
      'ecosystem display name',
      '---\nname: "Release Notes Helper"\ndescription: Keep the authored display name.\n---\n# Exact body\n',
    ],
    [
      'BOM and CRLF',
      '\ufeff---\r\nname: alpha\r\ndescription: Keep exact bytes.\r\n---\r\n# Exact body\r\n',
    ],
  ])('imports unchanged %s without treating metadata as authority', (_label, content) => {
    const f = fixture();
    try {
      const submitted = [
        {
          kind: 'file' as const,
          path: 'SKILL.md',
          contentBase64: Buffer.from(content).toString('base64'),
        },
      ];
      const admitted = importWorkspaceSkill({
        ...f,
        activate: false,
        displayName: 'Ecosystem Skill',
        id: f.imported.version.entryId,
        expectedRevision: f.imported.catalog.revision,
        tree: submitted,
      });
      expect(admitted.version.digest).toBe(validateCatalogTree(submitted).digest);
      expect(
        readWorkspaceSkillContent({
          ...f,
          entryId: admitted.version.entryId,
          digest: admitted.version.digest,
          path: 'SKILL.md',
        }).contentBase64
      ).toBe(submitted[0]!.contentBase64);
      expect(admitted.catalog.skills.entries[0]?.currentDigest).toBe(f.imported.version.digest);
      expect(admitted.catalog.skills.candidates).toEqual([]);
    } finally {
      rmSync(f.dataRoot, { recursive: true, force: true });
    }
  });

  it.each([
    '???',
    'Zg',
    'Zg===',
    'Zg==\n',
    'Zh==',
    'Zm9=',
    '-w==',
    '_w==',
  ])('rejects noncanonical transport base64 %j instead of changing its bytes', (contentBase64) => {
    expect(() =>
      validateCatalogTree([{ kind: 'file', path: 'source.bin', contentBase64 }])
    ).toThrow(CatalogInputError);
  });

  it.each([
    { contentBase64: 'eA==' },
    { contentBase64: '' },
    { executable: true },
  ])('rejects contradictory transport directory fields %j instead of dropping them', (fields) => {
    expect(() => validateCatalogTree([{ kind: 'directory', path: 'assets', ...fields }])).toThrow(
      CatalogInputError
    );
  });

  it('preserves canonical binary and empty transport bytes and non-executable directories', () => {
    const result = validateCatalogTree([
      { kind: 'file', path: 'source.bin', contentBase64: 'AP/+' },
      { kind: 'file', path: 'empty.bin', contentBase64: '' },
      { kind: 'file', path: 'padded.bin', contentBase64: 'AQ==' },
      { kind: 'directory', path: 'assets', executable: false },
    ]);
    expect(result.entries).toEqual([
      { kind: 1, path: 'source.bin', content: Buffer.from([0, 255, 254]) },
      { kind: 1, path: 'empty.bin', content: Buffer.alloc(0) },
      { kind: 1, path: 'padded.bin', content: Buffer.from([1]) },
      { kind: 0, path: 'assets' },
    ]);
  });

  it('validates transport trees through the shared bounded hash without filesystem effects', () => {
    const source = [
      { kind: 'file' as const, path: 'references/source.bin', contentBase64: 'AAEC' },
      { kind: 'directory' as const, path: 'empty' },
    ];
    const result = validateCatalogTree(source);
    expect(result.entries).toEqual([
      { kind: 1, path: 'references/source.bin', content: Buffer.from([0, 1, 2]) },
      { kind: 0, path: 'empty' },
      { kind: 0, path: 'references' },
    ]);
    expect(result.digest).toBe(hashOpenKitTreeEntries(result.entries));
    expect(source).toHaveLength(2);
    expect(() => validateCatalogTree([...source, source[0]!])).toThrow(/duplicate path/);
    expect(() => validateCatalogTree([{ kind: 'file', path: '.git/config' }])).toThrow(
      /must not contain a .git path segment/
    );
  });

  it('gives implicit and explicit ancestors the exact installed tree identity', () => {
    const f = fixture();
    try {
      const input = {
        ...f,
        activate: false,
        displayName: 'Alpha',
        id: f.imported.version.entryId,
        expectedRevision: f.imported.catalog.revision,
        tree: [
          ...tree('# With references'),
          {
            kind: 'file' as const,
            path: 'references/guide.md',
            contentBase64: Buffer.from('Exact reference bytes.').toString('base64'),
          },
        ],
      };
      const imported = importWorkspaceSkill(input);
      const actual = digestOpenKitTree(
        skillSnapshotPath(f.dataRoot, f.workspaceId, input.id, imported.version.digest)
      );
      expect(actual.digest).toBe(imported.version.digest);
      expect(imported.version.inventory.find((entry) => entry.path === 'references')).toEqual({
        executable: false,
        kind: 'directory',
        path: 'references',
        sha256: null,
        size: 0,
      });
      expect(
        readWorkspaceSkillContent({
          ...f,
          entryId: input.id,
          digest: imported.version.digest,
          path: 'references/guide.md',
        }).contentBase64
      ).toBe(Buffer.from('Exact reference bytes.').toString('base64'));
      const repeated = importWorkspaceSkill({
        ...input,
        expectedRevision: imported.catalog.revision,
        tree: [...input.tree, { kind: 'directory', path: 'references' }],
      });
      expect(repeated.version).toEqual(imported.version);
      expect(repeated.catalog.skills.versions).toEqual(imported.catalog.skills.versions);
    } finally {
      rmSync(f.dataRoot, { recursive: true, force: true });
    }
  });

  it.each([
    [
      'missing root',
      [
        {
          kind: 'file' as const,
          path: 'notes.md',
          contentBase64: Buffer.from('# Notes').toString('base64'),
        },
      ],
    ],
    ['directory root', [{ kind: 'directory' as const, path: 'SKILL.md' }]],
    [
      'invalid UTF-8',
      [
        {
          kind: 'file' as const,
          path: 'SKILL.md',
          contentBase64: Buffer.from([255]).toString('base64'),
        },
      ],
    ],
    ...[
      '# Missing frontmatter',
      '---\nname: [broken\n---\n# Broken',
      '---\ndescription: Missing name.\n---\n# Missing',
      '---\nname: Uppercase\ndescription: Invalid name.\n---\n# Invalid',
      '---\nname: alpha\n---\n# Missing description',
      '---\nname: alpha\ndescription: A valid description.\nallowed-tools: [invalid]\n---\n# Invalid tools',
    ].map(
      (content) =>
        [
          'invalid metadata',
          [
            {
              kind: 'file' as const,
              path: 'SKILL.md',
              contentBase64: Buffer.from(content).toString('base64'),
            },
          ],
        ] as const
    ),
  ])('refuses %s before changing catalog authority', (_reason, invalidTree) => {
    const f = fixture();
    try {
      const path = catalogDocumentPath(f.dataRoot, f.workspaceId);
      const before = readFileSync(path, 'utf8');
      expect(() =>
        importWorkspaceSkill({
          ...f,
          activate: false,
          displayName: 'Invalid',
          expectedRevision: f.imported.catalog.revision,
          tree: invalidTree,
        })
      ).toThrow(CatalogInputError);
      expect(readFileSync(path, 'utf8')).toBe(before);
    } finally {
      rmSync(f.dataRoot, { recursive: true, force: true });
    }
  });

  it('reads exact retained content and reports binary inventory differences after reload', () => {
    const f = fixture();
    try {
      const second = importWorkspaceSkill({
        ...f,
        activate: false,
        displayName: 'Alpha',
        expectedRevision: f.imported.catalog.revision,
        id: f.imported.version.entryId,
        tree: [
          ...tree('# Revised'),
          {
            kind: 'file' as const,
            path: 'asset.bin',
            contentBase64: Buffer.from([0, 255, 1]).toString('base64'),
          },
        ],
      });
      const base = { ...f, entryId: f.imported.version.entryId, digest: f.imported.version.digest };
      expect(readWorkspaceSkillVersion(base)).toEqual(f.imported.version);
      expect(readWorkspaceSkillContent({ ...base, path: 'SKILL.md' })).toEqual({
        contentBase64: tree('# Original')[0]!.contentBase64,
        digest: f.imported.version.digest,
        entryId: f.imported.version.entryId,
        path: 'SKILL.md',
      });
      const difference = diffWorkspaceSkillVersions({
        ...base,
        baseDigest: base.digest,
        candidateDigest: second.version.digest,
      });
      expect(difference.changes.map((change) => change.path)).toEqual(['SKILL.md', 'asset.bin']);
      expect(difference.changes[1]).toEqual({
        after: second.version.inventory.find((item) => item.path === 'asset.bin'),
        before: null,
        path: 'asset.bin',
      });
      expect(() => readWorkspaceSkillContent({ ...base, path: '../catalog.json' })).toThrow(
        CatalogNotFoundError
      );
      expect(loadWorkspaceResourceCatalog(f.dataRoot, f.workspaceId)).toEqual(second.catalog);
    } finally {
      rmSync(f.dataRoot, { recursive: true, force: true });
    }
  });

  it('publishes candidate content and lineage in one revision and rejects unknown bases before effects', () => {
    const f = fixture();
    try {
      const candidateInput = {
        ...f,
        baseDigest: `sha256:${'a'.repeat(64)}`,
        entryId: f.imported.version.entryId,
        expectedRevision: f.imported.catalog.revision,
        summary: 'Improve instructions.',
        tree: tree('# Improved'),
      };
      const before = readFileSync(catalogDocumentPath(f.dataRoot, f.workspaceId), 'utf8');
      expect(() => submitWorkspaceSkillCandidate(candidateInput)).toThrow(CatalogNotFoundError);
      expect(readFileSync(catalogDocumentPath(f.dataRoot, f.workspaceId), 'utf8')).toBe(before);
      const submitted = submitWorkspaceSkillCandidate({
        ...candidateInput,
        baseDigest: f.imported.version.digest,
      });
      expect(submitted.catalog.revision).toBe(f.imported.catalog.revision + 1);
      expect(submitted.catalog.skills.entries).toEqual(f.imported.catalog.skills.entries);
      expect(submitted.catalog.skills.pins).toEqual([]);
      expect(loadWorkspaceResourceCatalog(f.dataRoot, f.workspaceId)).toEqual(submitted.catalog);
    } finally {
      rmSync(f.dataRoot, { recursive: true, force: true });
    }
  });

  it('refuses tampered retained versions for selection and pins without moving authority', () => {
    const f = fixture();
    try {
      writeFileSync(
        join(
          skillSnapshotPath(
            f.dataRoot,
            f.workspaceId,
            f.imported.version.entryId,
            f.imported.version.digest
          ),
          'SKILL.md'
        ),
        '# Tampered'
      );
      const input = {
        ...f,
        digest: f.imported.version.digest,
        entryId: f.imported.version.entryId,
        expectedRevision: f.imported.catalog.revision,
      };
      expect(() => selectWorkspaceSkillDefault(input)).toThrow(CatalogIntegrityError);
      expect(() => setWorkspaceSkillPin(input)).toThrow(CatalogIntegrityError);
      expect(loadWorkspaceResourceCatalog(f.dataRoot, f.workspaceId)).toEqual(f.imported.catalog);
    } finally {
      rmSync(f.dataRoot, { recursive: true, force: true });
    }
  });

  it('blocks future default selection and pins for removed entries while retaining history', () => {
    const f = fixture();
    try {
      const removed = removeWorkspaceSkill({
        ...f,
        entryId: f.imported.version.entryId,
        expectedRevision: f.imported.catalog.revision,
      });
      const input = {
        ...f,
        digest: f.imported.version.digest,
        entryId: f.imported.version.entryId,
        expectedRevision: removed.revision,
      };
      expect(() => selectWorkspaceSkillDefault(input)).toThrow(CatalogNotFoundError);
      expect(() => setWorkspaceSkillPin(input)).toThrow(CatalogNotFoundError);
      expect(loadWorkspaceResourceCatalog(f.dataRoot, f.workspaceId)).toEqual(removed);
    } finally {
      rmSync(f.dataRoot, { recursive: true, force: true });
    }
  });

  it('retains exact decision context, applies promotion once, and keeps pins fixed across rollback', () => {
    const f = fixture();
    try {
      const pin = setWorkspaceSkillPin({
        ...f,
        digest: f.imported.version.digest,
        entryId: f.imported.version.entryId,
        expectedPinDigest: null,
        expectedRevision: f.imported.catalog.revision,
      });
      const submitted = submitWorkspaceSkillCandidate({
        ...f,
        entryId: f.imported.version.entryId,
        baseDigest: f.imported.version.digest,
        expectedRevision: pin.revision,
        summary: 'Improve.',
        tree: tree('# Improved'),
      });
      const decisionContext = {
        actor: f.producer,
        auditRef: 'audit_fixture_decision',
        decidedAt: '2026-10-16T00:01:00.000Z',
      };
      const decision = {
        ...f,
        candidateId: submitted.candidate.id,
        decision: 'promoted' as const,
        decisionContext,
        expectedCurrentDigest: f.imported.version.digest,
        expectedRevision: submitted.catalog.revision,
      };
      expect(() =>
        decideWorkspaceSkillCandidate({ ...decision, expectedCurrentDigest: null })
      ).toThrow(CatalogConflictError);
      const promoted = decideWorkspaceSkillCandidate(decision);
      expect(promoted.skills.candidates[0]?.decision).toEqual(decisionContext);
      expect(promoted.skills.entries[0]?.currentDigest).toBe(submitted.candidate.candidateDigest);
      expect(promoted.skills.pins).toEqual(pin.skills.pins);
      expect(() =>
        decideWorkspaceSkillCandidate({ ...decision, expectedRevision: promoted.revision })
      ).toThrow(CatalogNotFoundError);
      const restored = selectWorkspaceSkillDefault({
        ...f,
        entryId: f.imported.version.entryId,
        digest: f.imported.version.digest,
        expectedCurrentDigest: submitted.candidate.candidateDigest,
        expectedRevision: promoted.revision,
      });
      expect(restored.skills.entries[0]?.currentDigest).toBe(f.imported.version.digest);
      expect(restored.skills.pins).toEqual(pin.skills.pins);
      expect(loadWorkspaceResourceCatalog(f.dataRoot, f.workspaceId)).toEqual(restored);
    } finally {
      rmSync(f.dataRoot, { recursive: true, force: true });
    }
  });

  it('enforces candidate withdrawal attribution and retains withdrawn history', () => {
    const f = fixture();
    try {
      const submitted = submitWorkspaceSkillCandidate({
        ...f,
        entryId: f.imported.version.entryId,
        baseDigest: f.imported.version.digest,
        expectedRevision: f.imported.catalog.revision,
        summary: 'Improve.',
        tree: tree('# Improved'),
      });
      const input = {
        ...f,
        candidateId: submitted.candidate.id,
        decision: 'withdrawn' as const,
        decisionContext: {
          actor: { id: 'another_user', kind: 'user' as const },
          auditRef: 'audit_fixture_withdrawal',
          decidedAt: '2026-10-16T00:01:00.000Z',
        },
        expectedRevision: submitted.catalog.revision,
      };
      expect(() => decideWorkspaceSkillCandidate(input)).toThrow(CatalogForbiddenError);
      const withdrawn = decideWorkspaceSkillCandidate({
        ...input,
        decisionContext: { ...input.decisionContext, actor: f.producer },
      });
      expect(withdrawn.skills.entries).toEqual(f.imported.catalog.skills.entries);
      expect(withdrawn.skills.candidates[0]?.disposition).toBe('withdrawn');
      expect(() =>
        decideWorkspaceSkillCandidate({
          ...input,
          configurationOwner: true,
          expectedRevision: withdrawn.revision,
        })
      ).toThrow(CatalogNotFoundError);
    } finally {
      rmSync(f.dataRoot, { recursive: true, force: true });
    }
  });

  it('retains original producer and source references separately from the authenticated submitter', () => {
    const f = fixture();
    try {
      const producer = { id: 'agent_origin', kind: 'agent' as const };
      const sourceRef = 'artifact:fixture/exact-version';
      // Access and exact Artifact resolution belong to the caller; this test covers native retention.
      const submitted = submitWorkspaceSkillCandidate({
        ...f,
        producer,
        submitter: f.producer,
        entryId: f.imported.version.entryId,
        baseDigest: f.imported.version.digest,
        expectedRevision: f.imported.catalog.revision,
        summary: 'Retain source lineage.',
        tree: tree('# Produced by the agent'),
        evidenceRefs: [sourceRef, 'turn:fixture'],
        uploadedSourceId: sourceRef,
      });
      expect(submitted.candidate).toMatchObject({
        producer,
        submitter: f.producer,
        evidenceRefs: [sourceRef, 'turn:fixture'],
      });
      expect(
        submitted.catalog.skills.versions.find(
          (version) => version.digest === submitted.candidate.candidateDigest
        )
      ).toMatchObject({
        producer,
        provenance: { uploadedSourceId: sourceRef, baseDigest: f.imported.version.digest },
      });
      const withdrawn = decideWorkspaceSkillCandidate({
        ...f,
        candidateId: submitted.candidate.id,
        decision: 'withdrawn',
        decisionContext: {
          actor: f.producer,
          auditRef: 'audit_fixture_source_withdrawal',
          decidedAt: '2026-10-16T00:01:00.000Z',
        },
        expectedRevision: submitted.catalog.revision,
      });
      expect(withdrawn.skills.candidates[0]?.disposition).toBe('withdrawn');
    } finally {
      rmSync(f.dataRoot, { recursive: true, force: true });
    }
  });

  it('keeps missing historical submitter facts inspectable without granting withdrawal authority', () => {
    const f = fixture();
    try {
      const submitted = submitWorkspaceSkillCandidate({
        ...f,
        entryId: f.imported.version.entryId,
        baseDigest: f.imported.version.digest,
        expectedRevision: f.imported.catalog.revision,
        summary: 'A retained proposal.',
        tree: tree('# Proposed'),
      });
      const path = catalogDocumentPath(f.dataRoot, f.workspaceId);
      const historical = JSON.parse(readFileSync(path, 'utf8'));
      delete historical.skills.candidates[0].submitter;
      writeFileSync(path, JSON.stringify(historical));
      expect(
        loadWorkspaceResourceCatalog(f.dataRoot, f.workspaceId).skills.candidates[0]?.submitter
      ).toBeNull();
      const input = {
        ...f,
        candidateId: submitted.candidate.id,
        decision: 'withdrawn' as const,
        decisionContext: {
          actor: f.producer,
          auditRef: 'audit_fixture_historical_withdrawal',
          decidedAt: '2026-10-16T00:01:00.000Z',
        },
        expectedRevision: submitted.catalog.revision,
      };
      expect(() => decideWorkspaceSkillCandidate(input)).toThrow(CatalogForbiddenError);
      expect(
        decideWorkspaceSkillCandidate({ ...input, configurationOwner: true }).skills.candidates[0]
          ?.disposition
      ).toBe('withdrawn');
    } finally {
      rmSync(f.dataRoot, { recursive: true, force: true });
    }
  });

  it('compares the prior pin on set and clear without changing default selection', () => {
    const f = fixture();
    try {
      const input = {
        ...f,
        digest: f.imported.version.digest,
        entryId: f.imported.version.entryId,
        expectedPinDigest: null,
        expectedRevision: f.imported.catalog.revision,
      };
      const pinned = setWorkspaceSkillPin(input);
      expect(() =>
        setWorkspaceSkillPin({ ...input, digest: null, expectedRevision: pinned.revision })
      ).toThrow(CatalogConflictError);
      expect(loadWorkspaceResourceCatalog(f.dataRoot, f.workspaceId)).toEqual(pinned);
      const cleared = setWorkspaceSkillPin({
        ...input,
        digest: null,
        expectedPinDigest: f.imported.version.digest,
        expectedRevision: pinned.revision,
      });
      expect(cleared.skills.pins).toEqual([]);
      expect(cleared.skills.entries).toEqual(f.imported.catalog.skills.entries);
    } finally {
      rmSync(f.dataRoot, { recursive: true, force: true });
    }
  });

  it('refuses stale candidate promotion and retains an exact terminal rejection decision', () => {
    const f = fixture();
    try {
      const submitted = submitWorkspaceSkillCandidate({
        ...f,
        entryId: f.imported.version.entryId,
        baseDigest: f.imported.version.digest,
        expectedRevision: f.imported.catalog.revision,
        summary: 'Improve.',
        tree: tree('# Improved'),
      });
      const current = importWorkspaceSkill({
        ...f,
        activate: true,
        displayName: 'Alpha',
        id: f.imported.version.entryId,
        expectedRevision: submitted.catalog.revision,
        tree: tree('# A different revision'),
      });
      const decisionContext = {
        actor: f.producer,
        auditRef: 'audit_fixture_rejection',
        decidedAt: '2026-10-16T00:01:00.000Z',
      };
      const input = {
        ...f,
        candidateId: submitted.candidate.id,
        decision: 'promoted' as const,
        decisionContext,
        expectedCurrentDigest: current.version.digest,
        expectedRevision: current.catalog.revision,
      };
      expect(() => decideWorkspaceSkillCandidate(input)).toThrow(CatalogConflictError);
      expect(loadWorkspaceResourceCatalog(f.dataRoot, f.workspaceId)).toEqual(current.catalog);
      const rejected = decideWorkspaceSkillCandidate({ ...input, decision: 'rejected' });
      expect(rejected.skills.entries).toEqual(current.catalog.skills.entries);
      expect(rejected.skills.candidates[0]).toMatchObject({
        disposition: 'rejected',
        decision: decisionContext,
        baseDigest: f.imported.version.digest,
      });
      expect(() =>
        decideWorkspaceSkillCandidate({ ...input, expectedRevision: rejected.revision })
      ).toThrow(CatalogNotFoundError);
    } finally {
      rmSync(f.dataRoot, { recursive: true, force: true });
    }
  });

  it('admits a new-entry candidate with null base and no active selection', () => {
    const f = fixture();
    try {
      const submitted = submitWorkspaceSkillCandidate({
        ...f,
        entryId: 'beta',
        baseDigest: null,
        expectedRevision: f.imported.catalog.revision,
        summary: 'Create a new Skill.',
        tree: tree('# New Skill'),
      });
      expect(submitted.catalog.skills.entries.find((entry) => entry.id === 'beta')).toMatchObject({
        availability: 'available',
        currentDigest: null,
      });
      expect(
        submitted.catalog.skills.versions.find((version) => version.entryId === 'beta')?.provenance
          .baseDigest
      ).toBeNull();
      expect(submitted.catalog.skills.entries[0]).toEqual(f.imported.catalog.skills.entries[0]);
      expect(() =>
        submitWorkspaceSkillCandidate({
          ...f,
          entryId: 'beta',
          baseDigest: null,
          expectedRevision: submitted.catalog.revision,
          summary: 'Repeat without a base.',
          tree: tree('# Different'),
        })
      ).toThrow(CatalogInputError);
    } finally {
      rmSync(f.dataRoot, { recursive: true, force: true });
    }
  });

  it('requires complete external retention admission before purging only unreferenced bytes', () => {
    const f = fixture();
    try {
      const input = {
        ...f,
        digest: f.imported.version.digest,
        entryId: f.imported.version.entryId,
        expectedRevision: f.imported.catalog.revision,
        retainedReferences: null,
      };
      expect(() => purgeWorkspaceSkillVersion(input)).toThrow(CatalogRetentionError);
      try {
        purgeWorkspaceSkillVersion(input);
      } catch (error) {
        expect((error as CatalogRetentionError).references).toEqual([
          'retention_authority_unavailable',
          'skill_default:alpha',
        ]);
      }
      const second = importWorkspaceSkill({
        ...f,
        activate: true,
        displayName: 'Alpha',
        id: input.entryId,
        expectedRevision: input.expectedRevision,
        tree: tree('# New current'),
      });
      expect(() =>
        purgeWorkspaceSkillVersion({
          ...input,
          expectedRevision: second.catalog.revision,
          retainedReferences: ['aep:fixture_retained'],
        })
      ).toThrow(CatalogRetentionError);
      const purged = purgeWorkspaceSkillVersion({
        ...input,
        expectedRevision: second.catalog.revision,
        retainedReferences: [],
      });
      expect(readWorkspaceSkillVersion(input)).toEqual({
        ...f.imported.version,
        contentState: 'purged',
      });
      expect(() => readWorkspaceSkillContent({ ...input, path: 'SKILL.md' })).toThrow(
        CatalogContentUnavailableError
      );
      expect(purged.skills.versions).toEqual(
        second.catalog.skills.versions.map((version) =>
          version.digest === input.digest ? { ...version, contentState: 'purged' } : version
        )
      );
      expect(purged.skills.entries).toEqual(second.catalog.skills.entries);
      const exported = projectWorkspaceCatalogExport(f.dataRoot, f.workspaceId);
      expect(exported.payloads).toHaveLength(1);
      expect(exported.payloads[0]?.payload.digest).toBe(second.version.digest);
      expect(exported.catalog.skills.versions).toEqual(purged.skills.versions);
      const imported = reconstructImportedWorkspaceCatalog(
        exported.catalog,
        new Map(exported.payloads.map((payload) => [payload.path, payload.payload]))
      );
      writeImportedWorkspaceCatalog(
        join(f.dataRoot, 'workspaces', 'ws_imported'),
        imported,
        exported.payloads.map((payload) => payload.payload)
      );
      expect(loadWorkspaceResourceCatalog(f.dataRoot, 'ws_imported').skills.versions).toEqual(
        purged.skills.versions
      );
      expect(() =>
        readWorkspaceSkillContent({ ...input, workspaceId: 'ws_imported', path: 'SKILL.md' })
      ).toThrow(CatalogContentUnavailableError);
      const restored = importWorkspaceSkill({
        ...f,
        activate: false,
        id: input.entryId,
        displayName: 'Alpha',
        expectedRevision: purged.revision,
        createdAt: '2026-10-16T00:02:00.000Z',
        producer: { id: 'user_restore', kind: 'user' },
        tree: tree('# Original'),
      });
      expect(restored.version).toEqual(f.imported.version);
      expect(restored.catalog.skills.entries).toEqual(purged.skills.entries);
      expect(readWorkspaceSkillContent({ ...input, path: 'SKILL.md' }).contentBase64).toBe(
        tree('# Original')[0]!.contentBase64
      );
      rmSync(skillSnapshotPath(f.dataRoot, f.workspaceId, input.entryId, second.version.digest), {
        recursive: true,
        force: true,
      });
      expect(() => projectWorkspaceCatalogExport(f.dataRoot, f.workspaceId)).toThrow(
        CatalogContentUnavailableError
      );
      expect(
        loadWorkspaceResourceCatalog(f.dataRoot, f.workspaceId).skills.versions.find(
          (version) => version.digest === second.version.digest
        )?.contentState
      ).toBe('retained');
    } finally {
      rmSync(f.dataRoot, { recursive: true, force: true });
    }
  });

  it('refuses a linked snapshot parent before reading or deleting outside the owned root', () => {
    const f = fixture();
    try {
      const second = importWorkspaceSkill({
        ...f,
        activate: true,
        displayName: 'Alpha',
        id: f.imported.version.entryId,
        expectedRevision: f.imported.catalog.revision,
        tree: tree('# Current'),
      });
      const snapshot = skillSnapshotPath(
        f.dataRoot,
        f.workspaceId,
        f.imported.version.entryId,
        f.imported.version.digest
      );
      const parent = join(snapshot, '..');
      const outside = join(f.dataRoot, 'outside-snapshots');
      renameSync(parent, outside);
      symlinkSync(outside, parent, 'dir');
      const input = {
        ...f,
        digest: f.imported.version.digest,
        entryId: f.imported.version.entryId,
        expectedRevision: second.catalog.revision,
        retainedReferences: [],
      };
      expect(() => readWorkspaceSkillContent({ ...input, path: 'SKILL.md' })).toThrow(
        CatalogIntegrityError
      );
      expect(() => purgeWorkspaceSkillVersion(input)).toThrow(CatalogIntegrityError);
      const retained = join(outside, f.imported.version.digest.slice('sha256:'.length), 'SKILL.md');
      expect(existsSync(retained)).toBe(true);
      expect(readFileSync(retained).toString('base64')).toBe(tree('# Original')[0]!.contentBase64);
      const proposed = tree('# Another version');
      const proposedDigest = hashOpenKitTreeEntries(
        proposed.map((entry) => ({
          content: Buffer.from(entry.contentBase64, 'base64'),
          kind: 1 as const,
          path: entry.path,
        }))
      );
      const outsideStaging = join(outside, `${proposedDigest.slice('sha256:'.length)}.staging`);
      mkdirSync(outsideStaging);
      writeFileSync(join(outsideStaging, 'sentinel'), 'Outside staging bytes.');
      expect(() =>
        importWorkspaceSkill({
          ...f,
          activate: false,
          displayName: 'Alpha',
          expectedRevision: second.catalog.revision,
          id: f.imported.version.entryId,
          tree: proposed,
        })
      ).toThrow();
      expect(existsSync(join(outsideStaging, 'sentinel'))).toBe(true);
      expect(readFileSync(join(outsideStaging, 'sentinel'), 'utf8')).toBe('Outside staging bytes.');
      expect(loadWorkspaceResourceCatalog(f.dataRoot, f.workspaceId)).toEqual(second.catalog);
    } finally {
      rmSync(f.dataRoot, { recursive: true, force: true });
    }
  });
});
