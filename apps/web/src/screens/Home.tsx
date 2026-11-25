import type { Me } from "../auth-api.js";
import { Link } from "../router.js";
import { Page } from "./Page.js";

interface HomeProps {
  readonly appName: string;
  readonly me: Me;
}

/**
 * The signed-in home screen. The game list arrives with the game shell (alpha slice A4, 07 §1);
 * the "Your games" section is its slot.
 */
export function Home({ appName, me }: HomeProps) {
  return (
    <Page appName={appName} nav={<Link to="/settings">Settings</Link>}>
      <h1 tabIndex={-1}>Hi, {me.displayName}</h1>
      <section className="card" aria-labelledby="games-heading" data-slot="game-list">
        <h2 id="games-heading">Your games</h2>
        <p>Your games will appear here.</p>
      </section>
    </Page>
  );
}
