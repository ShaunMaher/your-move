/**
 * Where a form shows what went wrong. The live region is always in the page, so a screen reader
 * announces the message when it is filled in; fields point at it with `aria-describedby`.
 */
export function Problem({ id, message }: { readonly id: string; readonly message: string | null }) {
  return (
    <div role="alert" id={id} className={message === null ? undefined : "problem"}>
      {message}
    </div>
  );
}
