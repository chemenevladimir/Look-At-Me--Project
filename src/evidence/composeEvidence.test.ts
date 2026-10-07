import { describe, expect, it } from 'vitest';
import { calculateEvidenceLayout } from './composeEvidence';

describe('composite evidence layout', () => {
  it('keeps a readable camera inset inside a normal test-page screenshot', () => {
    const layout = calculateEvidenceLayout(1280, 900, 960, 540);
    expect(layout.canvasWidth).toBe(1280);
    expect(layout.canvasHeight).toBe(900);
    expect(layout.cameraWidth).toBeGreaterThanOrEqual(220);
    expect(layout.cameraX + layout.cameraWidth).toBeLessThanOrEqual(layout.canvasWidth);
    expect(layout.cameraY + layout.cameraHeight + layout.labelHeight).toBeLessThanOrEqual(layout.canvasHeight);
  });

  it('downscales very wide pages to bound PNG size', () => {
    const layout = calculateEvidenceLayout(3840, 2160, 1280, 720);
    expect(layout.canvasWidth).toBe(1600);
    expect(layout.canvasHeight).toBe(900);
  });
});
