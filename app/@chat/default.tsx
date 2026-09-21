/**
 * Nothing in the drawer slot by default.
 *
 * Required by parallel routes: without it, a hard load of any route that does
 * not match this slot errors rather than simply rendering no drawer.
 */
export default function Default() {
  return null;
}
