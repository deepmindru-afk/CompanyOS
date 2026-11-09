'use client';

import { cn } from '../lib/utils';

/**
 * A solid right arrow: a straight shaft with a filled head. The right half of
 * the left/right swap glyph, with the viewBox moved down 48 units (the arrow spans y 136–216) so the arrow
 * sits on the vertical centre.
 */
export const SolidRightArrow = ({ className }: { className?: string }) => {
  return (
    <svg
      width="32"
      height="32"
      viewBox="0 48 256 256"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className={cn('size-4', className)}
    >
      <path d="M213.66 170.34l-32-32A8 8 0 0 0 168 144v24H48a8 8 0 0 0 0 16h120v24a8 8 0 0 0 13.66 5.66l32-32a8 8 0 0 0 0-11.32Z" />
    </svg>
  );
};
