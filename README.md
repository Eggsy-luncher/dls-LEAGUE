# DLS 26 Arena

Independent DLS 26 tournaments, player accounts, scheduled match fixtures, result submissions, and standings. Local development uses SQLite; production uses PostgreSQL and private S3-compatible object storage. The app has its own user accounts and sign-in and does not depend on Orbit Community.

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

## Production deployment on Vercel

Vercel runs the Express app as a Node.js serverless function. Production startup requires PostgreSQL (`DATABASE_URL`) and private S3-compatible object storage. Local development continues to use SQLite and local uploads when those production variables are absent.

### Provision services

1. Create a PostgreSQL database with a pooled connection string (Neon is supported). Use the provider's SSL connection URL as `DATABASE_URL`.
2. Create a **private** S3-compatible bucket (Cloudflare R2 is supported). Create a scoped access key that can list/read/write/delete only this bucket.
3. Configure an SMTP provider for verification email.
4. Import this repository into Vercel and add the environment variables from `.env.production.example` to the Vercel project. Set `PUBLIC_URL` to the final HTTPS origin and `DLS_ADMIN_EMAIL` to the organizer's mailbox.
5. Deploy. The database schema is created automatically at cold start. Keep Vercel's Node.js version on 22.

Required Vercel variables:

- `NODE_ENV=production`
- `JWT_SECRET` (unique, high-entropy secret)
- `DLS_ADMIN_EMAIL`
- `PUBLIC_URL` (HTTPS)
- `DATABASE_URL` (pooled PostgreSQL URL with SSL)
- `PG_POOL_MAX=1` (recommended for serverless connection limits)
- `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_FROM`, and paired `SMTP_USER`/`SMTP_PASS` when required

Screenshots are uploaded to the private bucket and served only through the authenticated app route; do not make the bucket public or enable public object URLs. Database and bucket credentials belong in the Vercel project settings, never in the repository.

To transfer an existing local SQLite installation, first stop writes to the old site, then set the destination PostgreSQL and S3 variables locally and run `npm run migrate:sqlite`. By default the script reads `./data/dls26.db` and `./data/uploads`; override these with `SQLITE_SOURCE` and `SQLITE_DATA_DIR`. It upgrades the legacy SQLite schema as needed, refuses to write into a non-empty PostgreSQL database, and removes uploaded objects if the database transaction fails. Keep a backup of the SQLite database and uploads until the new deployment has been verified.

### Docker / persistent Node host

The same PostgreSQL and private object-storage environment variables are required when running in production mode. For local development, leave `NODE_ENV=development` and `DATABASE_URL` unset to use SQLite and local files. The Docker files remain available for hosts that support containers.

The site is not affiliated with or endorsed by First Touch Games.
