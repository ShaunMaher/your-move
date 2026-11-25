import type { ReactNode } from "react";

interface PageProps {
  readonly appName: string;
  /** Shown to the right of the name, e.g. navigation. */
  readonly nav?: ReactNode;
  readonly children: ReactNode;
}

/** The shell's frame: the instance's name, optional navigation and the screen's own content. */
export function Page({ appName, nav, children }: PageProps) {
  return (
    <div className="shell">
      <header className="bar">
        <p className="brand">{appName}</p>
        {nav}
      </header>
      <main className="stack">{children}</main>
    </div>
  );
}
