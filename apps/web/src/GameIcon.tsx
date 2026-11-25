/**
 * A game type's icon (02 §7.2). The catalog's icon is sanitised SVG markup, shown only as an
 * image from a `data:` URL, never inlined into the page: an image can't run script or reach the
 * page's DOM (08).
 */
export function GameIcon({ icon }: { readonly icon: string | undefined }) {
  if (icon === undefined || icon === "") return <span className="game-icon" aria-hidden="true" />;
  return (
    <img
      className="game-icon"
      alt=""
      width={40}
      height={40}
      src={`data:image/svg+xml,${encodeURIComponent(icon)}`}
    />
  );
}
