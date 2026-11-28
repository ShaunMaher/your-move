/**
 * The privacy page (07 §1, 08 §5): what the instance keeps and who sees it, its minimum age and
 * that children play through a parent's or carer's account, the email provider's copies and the
 * operator's own retention statement (`PRIVACY_RETENTION`, 09 §1), and how to reach the operator.
 * Anyone may read it, signed in or not. Every statement here must stay true of what is built:
 * Turnstile, for one, isn't mentioned until its widget ships (startup refuses its keys today).
 */
import type { ClientConfig } from "../auth-api.js";
import { Link } from "../router.js";
import { Page } from "./Page.js";

interface PrivacyProps {
  readonly config: ClientConfig;
  /** Where Back goes: the screen the person came from in the sign-in flow, or home. */
  readonly back: string;
}

export function Privacy({ config, back }: PrivacyProps) {
  const { appName, operatorContact } = config;
  const age = String(config.minAge);
  return (
    <Page appName={appName} nav={<Link to={back}>Back</Link>}>
      <h1 tabIndex={-1}>Privacy</h1>

      <section className="stack" aria-labelledby="privacy-age">
        <h2 id="privacy-age">Who can use {appName}</h2>
        <p>
          {appName} is for people aged {age} or older. Everyone confirms this when they set up their
          account. We don&apos;t ask for a date of birth; we keep only when you confirmed and the
          minimum age at that time.
        </p>
        <p>
          Children under {age} can play only through a parent&apos;s or carer&apos;s account, with
          the parent or carer signed in. If someone says they are under {age} while setting up a new
          account, that account is deleted straight away and invitations stop being emailed to its
          address.
        </p>
      </section>

      <section className="stack" aria-labelledby="privacy-keep">
        <h2 id="privacy-keep">What we keep</h2>
        <ul>
          <li>Your email address, to send you codes and the emails you ask for.</li>
          <li>Your display name, and your settings.</li>
          <li>When you confirmed your age, and the minimum age at that time.</li>
          <li>Your games: who played, the moves and the results.</li>
          <li>
            Your sign-in sessions: when each started and was last used, and the browser&apos;s
            description of the device.
          </li>
          <li>
            Security records of sign-ins and account changes. These hold a scrambled form of your
            network (IP) address, never the address itself.
          </li>
          <li>
            If you turn on notifications: the address your browser gives us to send them to this
            device. They travel through your browser maker&apos;s push service, encrypted so that
            service can&apos;t read them.
          </li>
          <li>
            If you invite someone by email: the address you typed, until they accept or the
            invitation ends, and a scrambled form of it used to limit how many invitations an
            address gets.
          </li>
          <li>
            A scrambled form of an address that asked us to stop sending it invitations, or whose
            new account was deleted for being under the minimum age, kept so we don&apos;t email it
            invitations again.
          </li>
        </ul>
      </section>

      <section className="stack" aria-labelledby="privacy-see">
        <h2 id="privacy-see">Who sees what</h2>
        <p>
          Other players see your display name and the games you play with them. They never see your
          email address, with two exceptions: if you invite someone who doesn&apos;t have an account
          yet by email, the invitation email we send them shows your address; and someone who
          invited you by typing your address sees it until you accept.
        </p>
        <p>
          The app loads nothing from other companies: no adverts, analytics, tracking, or outside
          fonts or scripts.
        </p>
        <p>
          The operator&apos;s hosting and network providers handle your connection, including your
          network address, to deliver it.
        </p>
      </section>

      <section className="stack" aria-labelledby="privacy-email">
        <h2 id="privacy-email">Emails and how long things are kept</h2>
        <p>
          We email one-time codes (to sign in, or to delete your account), invitations, a
          confirmation when an account is deleted, and, if you turn them on, emails when you&apos;re
          invited or it&apos;s your turn. The email service that sends them keeps copies of the
          messages it sends.
        </p>
        <p>
          {config.privacyRetention ??
            `The operator of this instance hasn't said how long server logs, backups and the email service's copies of sent messages are kept. You can ask them at ${operatorContact}.`}
        </p>
      </section>

      <section className="stack" aria-labelledby="privacy-contact">
        <h2 id="privacy-contact">Questions and deleting your account</h2>
        <p>
          To ask about your data, or to have your account deleted, contact the operator of this
          instance at {operatorContact}. When an account is deleted, the games it played stay for
          the other players, without its name or email address. If it had been invited by email to a
          game that hadn&apos;t started, the person who typed the address still sees it there until
          that game starts or ends.
        </p>
      </section>
    </Page>
  );
}
