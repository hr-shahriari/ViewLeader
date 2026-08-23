import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const EXPECTED_SHA256 = 'b347a2c8aa8fff6db896a4417a9c50c22ac0ccd7c5cfc22b99b8d29336c606ed';

describe('official Duplex IFC example asset', () => {
  it('matches the pinned buildingSMART LFS object and carries attribution', async () => {
    const model = await readFile(new URL(
      '../demo/public/models/Duplex_A_20110907.ifc',
      import.meta.url,
    ));
    expect(model.byteLength).toBe(2_380_763);
    expect(createHash('sha256').update(model).digest('hex')).toBe(EXPECTED_SHA256);
    expect(model.subarray(0, 12).toString('ascii')).toBe('ISO-10303-21');

    const notice = await readFile(new URL(
      '../demo/public/models/NOTICE.md',
      import.meta.url,
    ), 'utf8');
    expect(notice).toContain(EXPECTED_SHA256);
    expect(notice).toContain('Creative Commons Attribution 4.0');
    expect(notice).toContain('7ddf57a201f88a0c213d5322b02ed15e94a60a40');
  });
});

