import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

// SandBandHero reads the demo-dialog opener from its provider. The hero never
// renders inside it in this test, so the collaborator is stubbed.
mock.module('@/features/contact/request-demo-provider', () => ({
  useRequestDemo: () => () => {},
}));

const { SandBandHero } = await import('./sand-band-hero');

// The four trait labels the hero used to render above the headline
// (KRTX-4560: removed on request, no replacement).
const TRAIT_LABELS = ['Open Source', 'Extensible', 'Multiplayer', 'Sovereign'];

describe('SandBandHero characterization', () => {
  test('renders the headline and subcopy without a trait block', () => {
    const html = renderToStaticMarkup(<SandBandHero />);
    expect(html).toContain('id="hero"');
    expect(html).toContain('The CompanyOS');
    expect(html).toContain('The cloud-native agent harness for companies.');
  });

  test('the removed trait labels and their icon list are gone', () => {
    const html = renderToStaticMarkup(<SandBandHero />);
    for (const label of TRAIT_LABELS) {
      expect(html).not.toContain(label);
    }
  });

  test('the hero keeps its CTAs and the band with the session window', () => {
    const html = renderToStaticMarkup(<SandBandHero />);
    expect(html).toContain('Talk to sales');
    expect(html).toContain('Start for free');
    expect(html).toContain('id="demo"');
  });
});
