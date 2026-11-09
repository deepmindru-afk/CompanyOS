/**
 * The body of a My Kortix platform card on mobile: the rows it found, the
 * settings it changed, and its sign-in links. Every field is the card's, which
 * the tool writes for the person; `data`, `error.message` and the raw JSON are
 * the model's and never render. In-app paths are web routes, so only absolute
 * `https://` links show, as buttons that open in the in-app browser.
 */

import type { KortixToolCard } from '@kortix/sdk';
import { View } from 'react-native';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { openExternalLink } from '@/lib/utils/open-link';
import { TURN_SPACE, TURN_TYPE, useTurnPalette } from '../shared/styles';

export function hasPlatformCardBody(card: KortixToolCard): boolean {
  return card.rows.length > 0 || card.changes.length > 0 || card.links.some((link) => link.external);
}

export function PlatformCardBody({ card }: { card: KortixToolCard }) {
  const palette = useTurnPalette();
  const external = card.links.filter((link) => link.external);
  const line = (key: string, main: string, rest: string) => (
    <Text key={key} numberOfLines={1} style={[TURN_TYPE.xs, { color: palette.foreground80 }]}>
      {main}
      {rest ? <Text style={[TURN_TYPE.xs, { color: palette.mutedForeground }]}>{`  ${rest}`}</Text> : null}
    </Text>
  );
  return (
    <View style={{ rowGap: TURN_SPACE.gap1_5, marginTop: TURN_SPACE.gap1_5 }}>
      {card.rows.map((row, index) => line(`row-${index}`, row.title, [row.detail, row.badge].filter(Boolean).join(' · ')))}
      {card.changes.map((change, index) =>
        line(`change-${index}`, change.field, change.before === null ? `${change.after} (new)` : change.after === null ? `${change.before} (removed)` : `${change.before} → ${change.after}`),
      )}
      {external.length > 0 ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: TURN_SPACE.gap1_5 }}>
          {external.map((link) => (
            <Button key={link.href} variant="secondary" size="sm" onPress={() => openExternalLink(link.href)} accessibilityHint="Opens in the browser">
              <Text>{link.label}</Text>
            </Button>
          ))}
        </View>
      ) : null}
    </View>
  );
}
