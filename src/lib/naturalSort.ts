const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
});

/** "1.jpg" < "2.jpg" < "10.jpg" となる自然順比較 */
export function naturalCompare(a: string, b: string): number {
  return collator.compare(a, b);
}
