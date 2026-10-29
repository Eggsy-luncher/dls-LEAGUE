# DLS 26 Arena

Independent DLS 26 tournaments, player accounts, scheduled match fixtures, result submissions, and standings. This app has its own server, SQLite database, user accounts, and sign-in; it does not depend on Orbit Community.

## Run locally

Use Node.js 22.x:

```powershell
npm install
Copy-Item .env.example .env
```

Set a long random `JWT_SECRET` and your SMTP provider settings in `.env`, then run:

```powershell
npm start
```

Open `http://localhost:3000`. New players create an Arena account, register their DLS in-game name, and join leagues by invitation from the organizer.

The organizer email defaults to `ossommordecai@gmail.com`. It becomes an administrator only after opening the verification link delivered to that mailbox. Set `DLS_ADMIN_EMAIL` to choose another organizer.

Configure `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_FROM`, and (when required by the provider) both `SMTP_USER` and `SMTP_PASS`. Set `PUBLIC_URL` to the app's public HTTPS origin in production. For local testing, use a test SMTP inbox such as Mailpit; do not commit provider credentials. Until SMTP is configured, signup returns an explicit setup error.

Signup creates a pending account and emails a single-use link that expires after 30 minutes. The player must press **Verify email address** on the confirmation page before the account is activated. Sign-in is blocked for unverified accounts; the sign-in form can resend a fresh link when the email and password are provided. Resending invalidates the previous link. Existing accounts are also required to verify ownership before they can sign in.

## League formats, end time, and rewards

Organizers can create single or double round-robin leagues, single-elimination knockout brackets, and group-stage-plus-knockout leagues. Fixtures are scheduled manually. For round-robin formats, duplicate pairings are prevented (the double round-robin's second match must reverse home and away). In knockout formats, organizers set each match's stage and round, and enter the winners in the next round.

Each league has an end time, a configurable automatic champion reward (100 virtual Arena points by default), and an optional manual prize description. At the end time, the league finishes only after all fixtures have organizer-approved results. If results are still pending, it remains open until they are resolved. Round-robin champions are determined by points, goal difference, goals scored, then DLS name. Knockout champions are the winner of the sole match in the highest-numbered knockout round. The champion points are credited once when the league closes; an organizer can separately mark the described manual prize as fulfilled.

For group-plus-knockout leagues, assign each player a group when adding them and schedule each same-group pairing once. Once every group match is approved, the top two from each group advance (points, goal difference, goals scored, then DLS name); the total qualifiers must form a power-of-two bracket. Schedule knockout matches manually. Each player can appear once per round, only previous-round winners can advance, and knockout draws must be rejected and replayed. The app checks bracket progression before awarding the final champion.

## Match tracking and verification

Dream League Soccer currently launches inside BlueStacks. The provided ZIP contains Android split-install APK files; it is an install bundle, not an official live-score API, web feed, or integration SDK. This app does not install, scrape, or modify the game. After a match, either player submits the score shown in DLS Live Tracker together with a screenshot. The organizer reviews and approves the submission; approval records the result and recalculates both standings. Players can flag an incorrect pending score for organizer review.

Organizers schedule a kick-off and submission deadline in their own local time; times are saved as UTC and shown in each viewer's local timezone. The site gives match countdowns and can send 24-hour and 1-hour browser notifications while it is open and notifications are enabled. Missed matches require organizer rescheduling or an organizer-entered outcome; the site never forfeits a player automatically.

Automatic results without screenshot submission and organizer approval require an official DLS tracker API or feed. No such integration was supplied with the BlueStacks shortcut.

## Arena points

Prediction points are virtual and free. Each account starts with 1,000 non-transferable points. Points have no cash value and cannot be purchased, withdrawn, or exchanged. Correct predictions receive their stake plus a proportional share of other predictions on the same match; a draw refunds stakes. Only submit predictions when they are available before a fixture begins.

## Deploy

Set `NODE_ENV=production`, `JWT_SECRET`, `DLS_ADMIN_EMAIL`, SMTP settings, `PUBLIC_URL` (HTTPS), and `DATA_DIR` to a persistent server volume. Serve the site over HTTPS. Back up `data/dls26.db` and `data/uploads/`.

The site is not affiliated with or endorsed by First Touch Games.
