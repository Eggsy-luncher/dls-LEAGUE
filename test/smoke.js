const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const port = 32300 + Math.floor(Math.random() * 300);
const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dls26-test-'));
let server;
let serverOutput = '';
const sentEmails = [];
const smtpServer = net.createServer(socket => {
  let buffer = '';
  let message = '';
  let readingMessage = false;
  socket.write('220 test-smtp ESMTP\r\n');
  socket.on('data', chunk => {
    buffer += chunk.toString('utf8');
    let lineEnd;
    while ((lineEnd = buffer.indexOf('\r\n')) !== -1) {
      const line = buffer.slice(0, lineEnd);
      buffer = buffer.slice(lineEnd + 2);
      if (readingMessage) {
        if (line === '.') {
          readingMessage = false;
          sentEmails.push(message);
          message = '';
          socket.write('250 Message accepted\r\n');
        } else message += `${line}\r\n`;
      } else if (/^(EHLO|HELO)\b/i.test(line)) socket.write('250-test-smtp\r\n250 SIZE 10485760\r\n');
      else if (/^(MAIL FROM|RCPT TO|RSET)\b/i.test(line)) socket.write('250 OK\r\n');
      else if (/^DATA\b/i.test(line)) {
        readingMessage = true;
        socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
      } else if (/^QUIT\b/i.test(line)) {
        socket.write('221 Bye\r\n');
        socket.end();
      } else socket.write('250 OK\r\n');
    }
  });
});

const baseUrl = `http://127.0.0.1:${port}`;
const screenshotBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/AAAAAElFTkSuQmCC',
  'base64'
);

async function request(route, { method = 'GET', cookie, body, headers = {} } = {}) {
  const response = await fetch(baseUrl + route, {
    method,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body
  });
  const cookies = response.headers.getSetCookie().map(value => value.split(';')[0]);
  return {
    status: response.status,
    cookie: cookies[0],
    contentType: response.headers.get('content-type'),
    data: response.status === 204 ? {} : await response.json().catch(() => ({}))
  };
}

async function beginRegistration(email, displayName, gamerTag) {
  const response = await request('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, displayName, gamerTag, password: 'strong-test-password' })
  });
  assert.equal(response.status, 202, JSON.stringify(response.data));
  assert.equal(response.data.verificationRequired, true);
}

function latestVerificationToken() {
  const message = sentEmails.at(-1)?.replace(/=\r?\n/g, '').replace(/=([a-f0-9]{2})/gi, (_match, hex) => String.fromCharCode(parseInt(hex, 16)));
  const token = message?.match(/[?&]verify=([a-f0-9]{64})/i)?.[1];
  assert.ok(token, `The verification email should contain a confirmation link. Captured ${sentEmails.length} email(s): ${sentEmails.at(-1)?.slice(-1000) || 'none'}`);
  return token;
}

async function verify(token) {
  return request('/api/auth/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token })
  });
}

async function register(email, displayName, gamerTag) {
  await beginRegistration(email, displayName, gamerTag);
  const response = await verify(latestVerificationToken());
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.ok(response.cookie?.startsWith('dls26_session='));
  return { cookie: response.cookie, user: response.data.user };
}

async function waitForServer() {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (server.exitCode !== null) throw new Error(`The server exited early: ${serverOutput}`);
    try {
      if ((await fetch(`${baseUrl}/api/health`)).ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`The server did not start: ${serverOutput}`);
}

async function submitScore(matchId, cookie, homeScore, awayScore) {
  const form = new FormData();
  form.append('homeScore', String(homeScore));
  form.append('awayScore', String(awayScore));
  form.append('screenshot', new Blob([screenshotBytes], { type: 'image/png' }), 'tracker.png');
  return request(`/api/matches/${matchId}/submit`, { method: 'POST', cookie, body: form });
}

async function createLeague(cookie, name, format, endsAt = new Date(Date.now() + 86400000)) {
  const result = await request('/api/tournaments', {
    method: 'POST',
    cookie,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name, format, endsAt: endsAt.toISOString(), rewardPoints: 100, prizeDescription: ''
    })
  });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  return result.data.tournamentId;
}

async function addPlayer(cookie, tournamentId, identity, groupKey = '') {
  return request(`/api/tournaments/${tournamentId}/players`, {
    method: 'POST',
    cookie,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identity, groupKey })
  });
}

(async () => {
  try {
    await new Promise(resolve => smtpServer.listen(0, '127.0.0.1', resolve));
    const smtpPort = smtpServer.address().port;
    server = spawn(process.execPath, ['server.js'], {
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env,
        PORT: String(port),
        DATA_DIR: dataDirectory,
        JWT_SECRET: 'standalone-test-secret-0123456789-abcdefghijklmnopqrst',
        DLS_ADMIN_EMAIL: 'admin@arena.test',
        SMTP_HOST: '127.0.0.1',
        SMTP_PORT: String(smtpPort),
        SMTP_SECURE: 'false',
        SMTP_FROM: 'DLS Arena <arena@example.test>',
        SMTP_USER: '',
        SMTP_PASS: '',
        PUBLIC_URL: `http://127.0.0.1:${port}`
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    server.stdout.on('data', chunk => { serverOutput += chunk; });
    server.stderr.on('data', chunk => { serverOutput += chunk; });
    await waitForServer();
    const page = await fetch(`${baseUrl}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /DLS 26 Arena/);

    const config = await request('/api/auth/config');
    assert.equal(config.data.emailConfigured, true);
    await beginRegistration('admin@arena.test', 'Cup Admin', 'ArenaAdmin');
    const unverifiedAdminLogin = await request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@arena.test', password: 'strong-test-password' })
    });
    assert.equal(unverifiedAdminLogin.status, 403);
    const originalLink = latestVerificationToken();
    const resent = await request('/api/auth/resend-verification', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@arena.test', password: 'strong-test-password' })
    });
    assert.equal(resent.status, 200);
    const replacementLink = latestVerificationToken();
    assert.notEqual(replacementLink, originalLink);
    assert.equal((await verify(originalLink)).status, 400);
    const verifiedAdmin = await verify(replacementLink);
    assert.equal(verifiedAdmin.data.user.role, 'admin');
    assert.equal((await verify(replacementLink)).status, 400);
    const admin = { cookie: verifiedAdmin.cookie, user: verifiedAdmin.data.user };
    const adminLogin = await request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@arena.test', password: 'strong-test-password' })
    });
    assert.equal(adminLogin.status, 200);
    assert.equal(adminLogin.data.user.role, 'admin');
    const home = await register('home@arena.test', 'Home Player', 'HomeStriker');
    const away = await register('away@arena.test', 'Away Player', 'AwayKeeper');
    const fan = await register('fan@arena.test', 'Match Fan', 'ArenaFan');
    const other = await register('other@arena.test', 'Another Fan', 'AnotherFan');
    assert.equal(admin.user.id, 1);
    const emptyOverview = await request('/api/overview', { cookie: admin.cookie });
    assert.equal(emptyOverview.status, 200);
    assert.deepEqual(emptyOverview.data.submissions, []);
    assert.equal(emptyOverview.data.balance, 1000);
    assert.equal(emptyOverview.data.isAdmin, true);
    assert.equal((await request('/api/auth/me', { cookie: home.cookie })).data.user.gamerTag, 'HomeStriker');

    const forbidden = await request('/api/tournaments', {
      method: 'POST',
      cookie: home.cookie,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Unauthorized Cup' })
    });
    assert.equal(forbidden.status, 403);

    const tournament = await request('/api/tournaments', {
      method: 'POST',
      cookie: admin.cookie,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Screenshot Cup',
        format: 'single_round_robin',
        startsAt: new Date().toISOString(),
        endsAt: new Date(Date.now() + 1000).toISOString(),
        rewardPoints: 100,
        prizeDescription: 'Winner trophy'
      })
    });
    assert.equal(tournament.status, 201, JSON.stringify(tournament.data));
    for (const identity of ['HomeStriker', 'away@arena.test']) {
      const added = await request(`/api/tournaments/${tournament.data.tournamentId}/players`, {
        method: 'POST',
        cookie: admin.cookie,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identity })
      });
      assert.equal(added.status, 201);
    }

    const scheduledAt = new Date(Date.now() + 7000);
    const deadlineAt = new Date(Date.now() + 120000);
    const fixture = await request(`/api/tournaments/${tournament.data.tournamentId}/matches`, {
      method: 'POST',
      cookie: admin.cookie,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        homeUserId: home.user.id,
        awayUserId: away.user.id,
        stage: 'league',
        scheduledAt: scheduledAt.toISOString(),
        deadlineAt: deadlineAt.toISOString()
      })
    });
    assert.equal(fixture.status, 201);
    const matchId = fixture.data.matchId;

    const unprivilegedSchedule = await request(`/api/matches/${matchId}/schedule`, {
      method: 'PUT',
      cookie: home.cookie,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scheduledAt: scheduledAt.toISOString(), deadlineAt: deadlineAt.toISOString() })
    });
    assert.equal(unprivilegedSchedule.status, 403);
    const rescheduledAt = new Date(Date.now() + 8000);
    const rescheduledDeadline = new Date(Date.now() + 125000);
    const reschedule = await request(`/api/matches/${matchId}/schedule`, {
      method: 'PUT',
      cookie: admin.cookie,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scheduledAt: rescheduledAt.toISOString(), deadlineAt: rescheduledDeadline.toISOString() })
    });
    assert.equal(reschedule.status, 200);

    const tooEarly = await submitScore(matchId, home.cookie, 3, 1);
    assert.equal(tooEarly.status, 409);

    for (const [cookie, pick, stake] of [[fan.cookie, home.user.id, 40], [other.cookie, away.user.id, 20]]) {
      const prediction = await request(`/api/matches/${matchId}/predictions`, {
        method: 'POST',
        cookie,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pickedUserId: pick, stake })
      });
      assert.equal(prediction.status, 201);
    }

    await new Promise(resolve => setTimeout(resolve, Math.max(0, rescheduledAt.getTime() - Date.now() + 100)));
    const submitted = await submitScore(matchId, home.cookie, 3, 1);
    assert.equal(submitted.status, 201, JSON.stringify(submitted.data));

    let overview = await request(`/api/overview?tournamentId=${tournament.data.tournamentId}`, { cookie: fan.cookie });
    assert.equal(overview.data.matches[0].status, 'pending_review');
    assert.equal(overview.data.matches[0].pendingHomeScore, 3);
    assert.equal(overview.data.leaderboard.find(player => player.userId === home.user.id).points, 0);

    const screenshot = await request(`/api/submissions/${submitted.data.submissionId}/screenshot`, { cookie: admin.cookie });
    assert.equal(screenshot.status, 200);
    assert.match(screenshot.contentType, /image\/png/);
    const privateScreenshot = await request(`/api/submissions/${submitted.data.submissionId}/screenshot`, { cookie: other.cookie });
    assert.equal(privateScreenshot.status, 403);

    const unprivilegedReview = await request(`/api/submissions/${submitted.data.submissionId}/verify`, {
      method: 'POST',
      cookie: home.cookie,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approved' })
    });
    assert.equal(unprivilegedReview.status, 403);

    const approval = await request(`/api/submissions/${submitted.data.submissionId}/verify`, {
      method: 'POST',
      cookie: admin.cookie,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approved', note: 'Verified in Live Tracker' })
    });
    assert.equal(approval.status, 200);

    overview = await request(`/api/overview?tournamentId=${tournament.data.tournamentId}`, { cookie: fan.cookie });
    assert.equal(overview.data.matches[0].status, 'completed');
    assert.equal(overview.data.tournament.status, 'finished');
    assert.equal(overview.data.tournament.championId, home.user.id);
    assert.equal(overview.data.tournament.championTag, 'HomeStriker');
    assert.equal(overview.data.tournament.rewardPoints, 100);
    assert.equal(overview.data.matches[0].homeScore, 3);
    assert.equal(overview.data.leaderboard.find(player => player.userId === home.user.id).points, 3);
    assert.equal(overview.data.leaderboard.find(player => player.userId === home.user.id).played, 1);
    assert.equal((await request('/api/auth/me', { cookie: home.cookie })).data.user.points, 1100);
    const awardedPrize = await request(`/api/tournaments/${tournament.data.tournamentId}/prize/award`, {
      method: 'POST', cookie: admin.cookie
    });
    assert.equal(awardedPrize.status, 200);
    assert.equal((await request(`/api/overview?tournamentId=${tournament.data.tournamentId}`, { cookie: admin.cookie })).data.tournament.prizeAwarded, 1);
    assert.equal((await request(`/api/tournaments/${tournament.data.tournamentId}/prize/award`, {
      method: 'POST', cookie: admin.cookie
    })).status, 409);

    const doubleLeague = await createLeague(admin.cookie, 'Double Leg Cup', 'double_round_robin');
    assert.equal((await addPlayer(admin.cookie, doubleLeague, 'HomeStriker')).status, 201);
    assert.equal((await addPlayer(admin.cookie, doubleLeague, 'AwayKeeper')).status, 201);
    const legStart = new Date(Date.now() + 60000).toISOString();
    const legDeadline = new Date(Date.now() + 120000).toISOString();
    const leg = orientation => request(`/api/tournaments/${doubleLeague}/matches`, {
      method: 'POST',
      cookie: admin.cookie,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        homeUserId: orientation === 'home' ? home.user.id : away.user.id,
        awayUserId: orientation === 'home' ? away.user.id : home.user.id,
        scheduledAt: legStart, deadlineAt: legDeadline, stage: 'league'
      })
    });
    assert.equal((await leg('home')).status, 201);
    assert.equal((await leg('home')).status, 409);
    assert.equal((await leg('away')).status, 201);

    const groupLeague = await createLeague(admin.cookie, 'Group Cup', 'groups_knockout');
    assert.equal((await addPlayer(admin.cookie, groupLeague, 'HomeStriker', 'A')).status, 201);
    assert.equal((await addPlayer(admin.cookie, groupLeague, 'AwayKeeper', 'B')).status, 201);
    const groupFixture = await request(`/api/tournaments/${groupLeague}/matches`, {
      method: 'POST',
      cookie: admin.cookie,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        homeUserId: home.user.id, awayUserId: away.user.id,
        scheduledAt: legStart, deadlineAt: legDeadline, stage: 'group', roundNumber: 1
      })
    });
    assert.equal(groupFixture.status, 400);

    const knockoutEnd = new Date(Date.now() + 50);
    const knockoutLeague = await createLeague(admin.cookie, 'Knockout Cup', 'knockout', knockoutEnd);
    assert.equal((await addPlayer(admin.cookie, knockoutLeague, 'HomeStriker')).status, 201);
    assert.equal((await addPlayer(admin.cookie, knockoutLeague, 'AwayKeeper')).status, 201);
    const knockoutStart = new Date(Date.now() + 350);
    const knockoutDeadline = new Date(Date.now() + 60000);
    const knockoutFixture = await request(`/api/tournaments/${knockoutLeague}/matches`, {
      method: 'POST',
      cookie: admin.cookie,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        homeUserId: home.user.id, awayUserId: away.user.id,
        scheduledAt: knockoutStart.toISOString(), deadlineAt: knockoutDeadline.toISOString(),
        stage: 'knockout', roundNumber: 1
      })
    });
    assert.equal(knockoutFixture.status, 201);
    await new Promise(resolve => setTimeout(resolve, Math.max(0, knockoutStart.getTime() - Date.now() + 100)));
    const drawnProof = await submitScore(knockoutFixture.data.matchId, home.cookie, 1, 1);
    assert.equal(drawnProof.status, 201);
    const drawnApproval = await request(`/api/submissions/${drawnProof.data.submissionId}/verify`, {
      method: 'POST', cookie: admin.cookie,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approved' })
    });
    assert.equal(drawnApproval.status, 400);
    const drawnRejection = await request(`/api/submissions/${drawnProof.data.submissionId}/verify`, {
      method: 'POST', cookie: admin.cookie,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'rejected' })
    });
    assert.equal(drawnRejection.status, 200);
    const replayStart = new Date(Date.now() + 350);
    const replayDeadline = new Date(Date.now() + 60000);
    assert.equal((await request(`/api/matches/${knockoutFixture.data.matchId}/schedule`, {
      method: 'PUT', cookie: admin.cookie,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scheduledAt: replayStart.toISOString(), deadlineAt: replayDeadline.toISOString() })
    })).status, 200);
    await new Promise(resolve => setTimeout(resolve, Math.max(0, replayStart.getTime() - Date.now() + 100)));
    const knockoutProof = await submitScore(knockoutFixture.data.matchId, home.cookie, 2, 1);
    assert.equal(knockoutProof.status, 201);
    assert.equal((await request(`/api/submissions/${knockoutProof.data.submissionId}/verify`, {
      method: 'POST', cookie: admin.cookie,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approved' })
    })).status, 200);
    const knockoutOverview = await request(`/api/overview?tournamentId=${knockoutLeague}`, { cookie: fan.cookie });
    assert.equal(knockoutOverview.data.tournament.status, 'finished');
    assert.equal(knockoutOverview.data.tournament.championId, home.user.id);

    const prize = await request(`/api/matches/${matchId}/claim`, { method: 'POST', cookie: fan.cookie });
    assert.equal(prize.status, 200);
    assert.equal(prize.data.prize, 60);
    assert.equal((await request(`/api/matches/${matchId}/claim`, { method: 'POST', cookie: fan.cookie })).status, 409);
    assert.equal((await request('/api/auth/logout', { method: 'POST', cookie: home.cookie })).status, 204);

    console.log('PASS independent account sessions and admin-only tournament management');
    console.log('PASS email ownership verification, one-time links, resend, and verified admin promotion');
    console.log('PASS player roster, scheduled kick-off, and submission deadline');
    console.log('PASS kick-off enforcement, screenshot uploads, and private result evidence');
    console.log('PASS pending result review and standings refresh after organizer approval');
    console.log('PASS virtual-points prediction settlement and single prize claim');
    console.log('PASS league formats, scheduled completion, champion rewards, and manual prizes');
  } catch (error) {
    console.error(error.stack || error);
    console.error(serverOutput);
    process.exitCode = 1;
  } finally {
    if (server && server.exitCode === null) {
      server.kill();
      await new Promise(resolve => server.once('exit', resolve));
    }
    if (smtpServer.listening) await new Promise(resolve => smtpServer.close(resolve));
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  }
})();
