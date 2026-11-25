import type { ApiClient } from "@your-move/api-client";

import type { Me } from "../auth-api.js";
import { Link } from "../router.js";
import { GameList } from "./GameList.js";
import { Page } from "./Page.js";

interface HomeProps {
  readonly api: ApiClient;
  readonly appName: string;
  readonly me: Me;
  /** The session is gone (401). */
  readonly onSessionLost: () => void;
}

/** The signed-in home screen: the game list and the way to a new game (07 §1). */
export function Home({ api, appName, me, onSessionLost }: HomeProps) {
  return (
    <Page appName={appName} nav={<Link to="/settings">Settings</Link>}>
      <h1 tabIndex={-1}>Hi, {me.displayName}</h1>
      <Link to="/new" className="button">
        New game
      </Link>
      <GameList api={api} onSessionLost={onSessionLost} />
    </Page>
  );
}
