(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const state = { user: null, data: null, tournamentId: null, emailConfigured: false, verificationToken: '', authMode: 'login', view: 'overview', toastTimer: null, refreshInProgress: false };

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
  }
  async function api(url, options = {}) {
    const headers = { ...(options.body && !(options.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) };
    const response = await fetch(url, { ...options, headers, credentials: 'same-origin' });
    const result = response.status === 204 ? {} : await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'Something went wrong. Please try again.');
    return result;
  }
  function toast(message, error = false) {
    const element = $('#toast');
    element.textContent = message;
    element.classList.toggle('error', error);
    element.classList.add('show');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => element.classList.remove('show'), 3400);
  }
  function formatDate(value, options = { weekday: 'short', month: 'short', day: 'numeric' }) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'TBC' : new Intl.DateTimeFormat(undefined, options).format(date);
  }
  function formatTime(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'TBC' : new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date);
  }
  function localInput(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  }
  function isoFromLocal(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString();
  }
  function initials(value) {
    const parts = String(value || '?').trim().split(/\s+/);
    return (parts.length > 1 ? parts[0][0] + parts[1][0] : parts[0].slice(0, 2)).toUpperCase();
  }
  function emptyMessage(title, text) {
    return `<div class="empty-message"><strong>${escapeHtml(title)}</strong>${escapeHtml(text)}</div>`;
  }
  async function refresh(tournamentId = state.tournamentId) {
    const query = tournamentId ? `?tournamentId=${encodeURIComponent(tournamentId)}` : '';
    state.data = await api(`/api/overview${query}`);
    state.tournamentId = state.data.tournament?.id || null;
    render();
  }
  function setView(view) {
    state.view = view;
    render();
    const target = view === 'fixtures' ? $('#fixtureSection') : view === 'table' ? $('#tableSection') : $('.hero');
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function render() {
    const data = state.data;
    if (!state.user || !data) return;
    const submissions = Array.isArray(data.submissions) ? data.submissions : [];
    $('#authView').classList.add('hidden');
    $('#appView').classList.remove('hidden');
    $('#userGamerTag').textContent = state.user.gamerTag;
    $('#userEmail').textContent = state.user.email;
    $('#userAvatar').textContent = initials(state.user.gamerTag);
    $('#walletBalance').textContent = Number(data.balance || 0).toLocaleString();
    $('#timezoneLabel').textContent = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Local';
    const select = $('#tournamentSelect');
    select.innerHTML = data.tournaments.length
      ? data.tournaments.map(tournament => `<option value="${tournament.id}" ${tournament.id === data.tournament?.id ? 'selected' : ''}>${escapeHtml(tournament.name)}${tournament.status === 'finished' ? ' · complete' : ''}</option>`).join('')
      : '<option value="">No tournaments</option>';
    $('#fixtureNavCount').textContent = data.matches.length;
    $('#organizerPanel').classList.toggle('hidden', !data.isAdmin);
    const completed = data.matches.filter(match => match.status === 'completed').length;
    $('#statPlayers').textContent = data.players.length;
    $('#statPlayed').innerHTML = `${completed} <i>/ ${data.matches.length}</i>`;
    $('#statLeader').textContent = data.leaderboard[0]?.gamerTag || '—';
    const next = data.matches.filter(match => match.status === 'scheduled' && Date.parse(match.scheduledAt) > Date.now())
      .sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt))[0];
    $('#statNext').textContent = next ? formatDate(next.scheduledAt, { month: 'short', day: 'numeric' }) : '—';
    $('#heroStatus').textContent = data.tournament
      ? `${data.tournament.name} · ${data.tournament.status === 'open' ? 'Fixtures are live' : 'Tournament complete'}`
      : 'Waiting for tournament fixtures';
    $('#heroSubtitle').textContent = data.tournament
      ? `${data.tournament.name} · ${formatDate(data.tournament.endsAt, { month: 'short', day: 'numeric', year: 'numeric' })} league end. Fixtures need approved results before the champion is awarded.`
      : 'Know your kick-off. Play in the time window. Upload a Live Tracker result for the organizer to verify.';
    $('#reviewLabel').textContent = `${submissions.filter(submission => submission.status === 'pending' || submission.status === 'disputed').length} pending`;
    $('#matchSummary').textContent = data.tournament ? `${data.tournament.name} · Times in your local timezone` : 'All times shown in your local timezone';
    $('#pageLabel').textContent = state.view === 'fixtures' ? 'My fixtures' : state.view === 'table' ? 'Leaderboard' : 'Overview';
    $('#sectionTitle').textContent = state.view === 'fixtures' ? 'My fixtures' : state.view === 'table' ? 'Full standings' : 'My matchday';
    const completion = $('#tournamentCompletion');
    if (data.tournament?.status === 'finished') {
      completion.classList.remove('hidden');
      completion.innerHTML = `<div class="panel-heading"><div><span class="panel-kicker">LEAGUE COMPLETE</span><h3>${escapeHtml(data.tournament.name)}</h3></div><span class="submission-status approved">Champion</span></div>
        <p><strong>${escapeHtml(data.tournament.championTag || 'Champion')}</strong> leads the final standings and received ${Number(data.tournament.rewardPoints).toLocaleString()} Arena points.</p>
        ${data.tournament.prizeDescription ? `<p>Prize: ${escapeHtml(data.tournament.prizeDescription)} · ${data.tournament.prizeAwarded ? 'marked awarded' : 'awaiting organizer fulfillment'}</p>` : ''}
        ${data.isAdmin && data.tournament.prizeDescription && !data.tournament.prizeAwarded ? `<button class="button button-outline" data-award-prize="${data.tournament.id}">Mark manual prize awarded</button>` : ''}`;
    } else {
      completion.classList.add('hidden');
      completion.innerHTML = '';
    }
    document.querySelectorAll('.nav-link').forEach(button => button.classList.toggle('active', button.dataset.view === state.view));
    renderMatches(data.matches, data.isAdmin);
    renderLeaderboard(data.leaderboard);
    renderSubmissions(submissions, data.isAdmin);
    renderAdminForms(data);
    checkReminders(data.matches);
  }
  function renderLeaderboard(players) {
    $('#leaderboardBody').innerHTML = players.length ? players.map((player, index) => {
      const difference = player.goalsFor - player.goalsAgainst;
      return `<tr class="${index === 0 ? 'leader-row' : ''}">
        <td class="rank-cell">${String(index + 1).padStart(2, '0')}</td>
        <td><span class="player-cell"><span class="mini-avatar">${escapeHtml(initials(player.gamerTag))}</span>${escapeHtml(player.gamerTag)}</span></td>
        <td>${player.played}</td><td>${difference > 0 ? '+' : ''}${difference}</td><td class="points-cell">${player.points}</td>
      </tr>`;
    }).join('') : `<tr><td colspan="5">${emptyMessage('The table is open.', 'The organizer will add players when the tournament is set up.')}</td></tr>`;
  }
  function renderMatches(matches, isAdmin) {
    const visible = state.view === 'fixtures' ? matches : matches.slice(0, 5);
    $('#matchList').innerHTML = visible.length ? visible.map(match => {
      const completed = match.status === 'completed';
      const pending = match.status === 'pending_review';
      const score = match.homeScore === null ? null : `${match.homeScore} – ${match.awayScore}`;
      const stateLabel = completed ? 'Verified' : pending ? 'Review' : 'Scheduled';
      const stageLabel = match.stage === 'knockout' ? `Knockout · Round ${match.roundNumber}` : match.stage === 'group' ? 'Group stage' : '';
      const isPlayer = match.homeUserId === state.user.id || match.awayUserId === state.user.id;
      const kickOff = Date.parse(match.scheduledAt);
      const deadline = Date.parse(match.deadlineAt);
      const kickOffRemaining = kickOff - Date.now();
      const deadlineRemaining = deadline - Date.now();
      const timeLeft = milliseconds => {
        const totalMinutes = Math.max(0, Math.floor(milliseconds / 60000));
        const days = Math.floor(totalMinutes / 1440);
        const hours = Math.floor((totalMinutes % 1440) / 60);
        const minutes = totalMinutes % 60;
        return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes}m` : `${minutes}m`;
      };
      const deadlineClass = deadlineRemaining < 0 ? 'overdue' : deadlineRemaining < 3 * 60 * 60 * 1000 ? 'urgent' : '';
      let action = '';
      if (isPlayer && !completed && !pending && deadlineRemaining >= 0) {
        action = `<form class="submission-form" data-submit-result="${match.id}" enctype="multipart/form-data">
          <label class="sr-only" for="home-score-${match.id}">${escapeHtml(match.homeTag)} goals</label><input id="home-score-${match.id}" name="homeScore" type="number" min="0" max="99" placeholder="Home" required>
          <span>–</span>
          <label class="sr-only" for="away-score-${match.id}">${escapeHtml(match.awayTag)} goals</label><input id="away-score-${match.id}" name="awayScore" type="number" min="0" max="99" placeholder="Away" required>
          <label class="sr-only" for="screenshot-${match.id}">Live Tracker screenshot</label><input id="screenshot-${match.id}" name="screenshot" type="file" accept="image/jpeg,image/png,image/webp" required>
          <button type="submit">Submit tracker result</button>
        </form>`;
      } else if (pending) {
        action = `<span class="match-note">Tracker screenshot submitted · standings update after organizer approval.</span>
          ${isPlayer && match.pendingSubmissionId && match.pendingSubmittedBy !== state.user.id ? `<button class="dispute-button" data-dispute="${match.pendingSubmissionId}">Flag result</button>` : ''}`;
      } else if (!completed && deadlineRemaining < 0) {
        action = '<span class="match-note">Play-by deadline passed. Contact the organizer to reschedule.</span>';
      } else if (completed) {
        action = '<span class="match-note">Verified result · leaderboard updated.</span>';
      }
      const reschedule = isAdmin && !completed && !pending ? `<form class="reschedule-form" data-reschedule="${match.id}">
        <label>New kick-off<input name="scheduledAt" type="datetime-local" value="${escapeHtml(localInput(match.scheduledAt))}" required></label>
        <label>New deadline<input name="deadlineAt" type="datetime-local" value="${escapeHtml(localInput(match.deadlineAt))}" required></label>
        <button type="submit">Update time</button>
      </form>` : '';
      const picked = match.myPick === null || match.myPick === undefined ? null : Number(match.myPick);
      const prediction = !completed && !pending && kickOffRemaining > 0 && !picked && !isPlayer
        ? `<form class="prediction-form" data-prediction="${match.id}">
            <select name="pickedUserId" aria-label="Pick the winning team"><option value="${match.homeUserId}">${escapeHtml(match.homeTag)}</option><option value="${match.awayUserId}">${escapeHtml(match.awayTag)}</option></select>
            <input name="stake" type="number" min="1" max="10000" placeholder="Points" aria-label="Points to stake" required><button type="submit">Back your pick</button>
          </form>`
        : picked ? `<span class="prediction-note">Your pick: ${escapeHtml(picked === match.homeUserId ? match.homeTag : match.awayTag)}</span>`
          : match.myPrize > 0 && !match.prizeClaimed
            ? `<button class="claim-button" data-claim="${match.id}">Claim ${Number(match.myPrize).toLocaleString()} pts</button>`
            : match.prizeClaimed && match.myPrize > 0 ? '<span class="prediction-note">Prize claimed ✓</span>' : '';
      const deadlineText = completed
        ? `Played · ${escapeHtml(formatDate(match.scheduledAt))}`
        : `Kick-off ${escapeHtml(formatDate(match.scheduledAt))} · ${escapeHtml(formatTime(match.scheduledAt))}${kickOffRemaining > 0 ? ` · ${escapeHtml(timeLeft(kickOffRemaining))} to go` : ''} · Submit by ${escapeHtml(formatDate(match.deadlineAt))} ${escapeHtml(formatTime(match.deadlineAt))}${deadlineRemaining >= 0 ? ` · ${escapeHtml(timeLeft(deadlineRemaining))} left` : ' · Deadline passed'}`;
      return `<article class="match-card">
        <div class="match-time"><strong>${escapeHtml(formatTime(match.scheduledAt))}</strong><small>${escapeHtml(formatDate(match.scheduledAt))}</small>${stageLabel ? `<small>${escapeHtml(stageLabel)}</small>` : ''}</div>
        <div class="match-team"><span class="team-badge">${escapeHtml(initials(match.homeTag))}</span><span class="team-name">${escapeHtml(match.homeTag)}</span></div>
        <div class="score-box ${score ? '' : pending ? 'score-pending' : 'pending'}">${score ? escapeHtml(score) : pending ? `${match.pendingHomeScore} – ${match.pendingAwayScore}` : 'VS'}</div>
        <div class="match-team away"><span class="team-name">${escapeHtml(match.awayTag)}</span><span class="team-badge">${escapeHtml(initials(match.awayTag))}</span></div>
        <span class="match-state ${match.status}">${stateLabel}</span>
        <div class="match-extras"><div class="match-deadline ${deadlineClass}">${deadlineText}</div>${action}${prediction}${reschedule}</div>
      </article>`;
    }).join('') : emptyMessage('The pitch is waiting.', state.data.tournament ? 'No fixtures have been scheduled for this tournament yet.' : 'The organizer has not created a tournament yet.');
  }
  function renderSubmissions(submissions, isAdmin) {
    $('#submissionList').innerHTML = submissions.length ? submissions.map(submission => {
      const match = state.data.matches.find(item => item.id === submission.matchId);
      const fixtureName = match ? `${match.homeTag} vs ${match.awayTag}` : 'Tournament fixture';
      const when = new Date(submission.createdAt);
      const note = submission.adminNote ? `<small>Organizer: ${escapeHtml(submission.adminNote)}</small>` : '';
      const review = isAdmin && (submission.status === 'pending' || submission.status === 'disputed')
        ? `<form class="review-actions" data-review="${submission.id}">
            <input name="note" maxlength="240" placeholder="Optional note / rejection reason">
            <button class="approve" name="decision" value="approved" type="submit">Approve</button>
            <button class="reject" name="decision" value="rejected" type="submit">Reject</button>
          </form>` : '';
      return `<article class="submission-card">
        <div class="submission-copy"><strong>${escapeHtml(fixtureName)} · ${submission.homeScore}–${submission.awayScore}</strong>
          <small>${escapeHtml(submission.submittedByTag)} · ${escapeHtml(formatDate(when, { month: 'short', day: 'numeric' }))} ${escapeHtml(formatTime(when))}</small>${note}</div>
        <div class="submission-actions"><a class="proof-link" href="${escapeHtml(submission.screenshotUrl)}" target="_blank" rel="noopener">View Live Tracker screenshot ↗</a><span class="submission-status ${submission.status}">${escapeHtml(submission.status.replace('_', ' '))}</span></div>
        ${review}</article>`;
    }).join('') : emptyMessage('No scorecards to review.', 'When a player submits a Live Tracker screenshot, the result will appear here.');
  }
  function renderAdminForms(data) {
    const active = Boolean(data.tournament && data.tournament.status === 'open');
    $('#playerForm').classList.toggle('hidden', !active);
    $('#fixtureForm').classList.toggle('hidden', !active);
    const options = data.players.map(player => `<option value="${player.userId}">${escapeHtml(player.gamerTag)}${player.groupKey ? ` · Group ${escapeHtml(player.groupKey)}` : ''}</option>`).join('');
    $('select[name="homeUserId"]').innerHTML = `<option value="">Choose player</option>${options}`;
    $('select[name="awayUserId"]').innerHTML = `<option value="">Choose player</option>${options}`;
    const format = data.tournament?.format;
    const groups = format === 'groups_knockout';
    $('#groupField').classList.toggle('hidden', !groups);
    $('#groupField select').required = groups;
    $('#stageField').classList.toggle('hidden', !['knockout', 'groups_knockout'].includes(format));
    const stage = $('select[name="stage"]');
    stage.innerHTML = format === 'groups_knockout'
      ? '<option value="group">Group stage</option><option value="knockout">Knockout</option>'
      : format === 'knockout' ? '<option value="knockout">Knockout</option>' : '<option value="league">League</option>';
    $('#roundField').classList.toggle('hidden', !['knockout', 'groups_knockout'].includes(format));
    $('input[name="roundNumber"]').required = ['knockout', 'groups_knockout'].includes(format);
    const start = $('input[name="startsAt"]', $('#tournamentForm'));
    if (!start.value) start.value = localInput(new Date(Date.now() + 86400000));
    const end = $('input[name="endsAt"]', $('#tournamentForm'));
    if (!end.value) end.value = localInput(new Date(Date.now() + 7 * 86400000));
    const scheduled = $('input[name="scheduledAt"]', $('#fixtureForm'));
    const deadline = $('input[name="deadlineAt"]', $('#fixtureForm'));
    if (!scheduled.value) scheduled.value = localInput(new Date(Date.now() + 3600000));
    if (!deadline.value) deadline.value = localInput(new Date(Date.now() + 2 * 3600000));
    $('button[type="submit"]', $('#fixtureForm')).disabled = data.players.length < 2;
  }
  function checkReminders(matches) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const keys = JSON.parse(localStorage.getItem('dls26-reminders') || '{}');
    const now = Date.now();
    for (const match of matches) {
      if (match.status !== 'scheduled') continue;
      for (const [label, timeValue, description] of [
        ['kickoff', match.scheduledAt, `${match.homeTag} vs ${match.awayTag}`],
        ['deadline', match.deadlineAt, `Submit the ${match.homeTag} vs ${match.awayTag} tracker result`]
      ]) {
        const remaining = Date.parse(timeValue) - now;
        const windowName = remaining <= 60 * 60 * 1000 ? '1h' : remaining <= 24 * 60 * 60 * 1000 ? '24h' : null;
        if (windowName && remaining > 0) {
          const key = `${match.id}:${label}:${windowName}`;
          if (!keys[key]) {
            new Notification(windowName === '1h' ? 'DLS Arena · 1 hour' : 'DLS Arena · 24 hours', { body: description });
            keys[key] = now;
          }
        }
      }
    }
    localStorage.setItem('dls26-reminders', JSON.stringify(keys));
  }
  function showFormError(error) {
    toast(error.message || 'Something went wrong. Please try again.', true);
  }
  function resetAuth() {
    state.user = null;
    state.data = null;
    $('#appView').classList.add('hidden');
    $('#authView').classList.remove('hidden');
  }
  async function initialize() {
    try {
      const config = await api('/api/auth/config');
      state.emailConfigured = config.emailConfigured;
      $('#resendVerification').classList.toggle('hidden', !state.emailConfigured);
      if (!state.emailConfigured) {
        $('#authIntro').textContent = 'Email verification is not configured yet. The organizer must add SMTP settings before new accounts can sign up.';
      }
      const verificationToken = new URLSearchParams(location.search).get('verify');
      if (verificationToken) {
        state.verificationToken = verificationToken;
        $('#authHeading').innerHTML = 'Confirm your email.<br><em>Join the arena.</em>';
        $('#authIntro').textContent = 'Press the button to verify ownership of this email address and activate your Arena account.';
        $('#authForm').classList.add('hidden');
        $('#authToggle').classList.add('hidden');
        $('#completeVerification').classList.remove('hidden');
        return;
      }
      const result = await api('/api/auth/me');
      state.user = result.user;
      await refresh(null);
    } catch (error) {
      resetAuth();
      const verificationToken = new URLSearchParams(location.search).get('verify');
      if (verificationToken) $('#authIntro').textContent = error.message || 'This verification link is invalid or expired. Request a new email.';
    }
  }

  $('#completeVerification').addEventListener('click', async () => {
    try {
      const verified = await api('/api/auth/verify', {
        method: 'POST',
        body: JSON.stringify({ token: state.verificationToken })
      });
      history.replaceState(null, '', '/');
      state.user = verified.user;
      state.view = 'overview';
      await refresh(null);
      toast('Email verified. Your Arena account is ready.');
    } catch (error) {
      $('#authIntro').textContent = error.message || 'This verification link is invalid or expired. Sign in and request a new email.';
      showFormError(error);
    }
  });

  $('#authToggle').addEventListener('click', () => {
    state.authMode = state.authMode === 'login' ? 'register' : 'login';
    const registering = state.authMode === 'register';
    $('#resendVerification').classList.toggle('hidden', registering || !state.emailConfigured);
    $('#authHeading').innerHTML = registering ? 'A new season.<br><em>A fresh start.</em>' : 'Your club.<br><em>Your moment.</em>';
    $('#authIntro').textContent = registering
      ? state.emailConfigured ? 'Create an Arena account. We will email you a verification link before activating it.' : 'Email verification is not configured. The organizer must add SMTP settings before signup is available.'
      : 'Sign in to see your tournament fixtures, match deadlines and place a friendly points prediction.';
    $('#displayNameField').classList.toggle('hidden', !registering);
    $('#gamerTagField').classList.toggle('hidden', !registering);
    $('#displayName').required = registering;
    $('#displayName').disabled = !registering;
    $('#gamerTag').disabled = !registering;
    $('#gamerTag').required = registering;
    $('#authSubmit').innerHTML = registering ? 'Create Arena account <span>↗</span>' : 'Sign in <span>↗</span>';
    $('#authSubmit').disabled = registering && !state.emailConfigured;
    $('#authToggle').textContent = registering ? 'Already registered? Sign in' : 'New here? Create an Arena account';
  });
  $('#authForm').addEventListener('submit', async event => {
    event.preventDefault();
    const registering = state.authMode === 'register';
    const body = { email: $('#email').value.trim(), password: $('#password').value };
    if (registering) {
      body.displayName = $('#displayName').value.trim();
      body.gamerTag = $('#gamerTag').value.trim();
    }
    try {
      const result = await api(registering ? '/api/auth/register' : '/api/auth/login', { method: 'POST', body: JSON.stringify(body) });
      if (registering && result.verificationRequired) {
        state.authMode = 'login';
        $('#authHeading').innerHTML = 'Check your email.<br><em>One last step.</em>';
        $('#authIntro').textContent = `We sent a verification link to ${body.email}. Open it to activate your account, then sign in.`;
        $('#displayNameField').classList.add('hidden');
        $('#gamerTagField').classList.add('hidden');
        $('#displayName').required = false;
        $('#gamerTag').required = false;
        $('#displayName').disabled = true;
        $('#gamerTag').disabled = true;
        $('#authSubmit').textContent = 'Sign in';
        $('#authSubmit').disabled = false;
        $('#resendVerification').classList.remove('hidden');
        $('#authToggle').textContent = 'New here? Create an Arena account';
        return;
      }
      state.user = result.user;
      state.view = 'overview';
      await refresh(null);
    } catch (error) {
      if (!registering && error.message.includes('Verify your email address')) $('#resendVerification').classList.remove('hidden');
      showFormError(error);
    }
  });
  $('#resendVerification').addEventListener('click', async () => {
    try {
      await api('/api/auth/resend-verification', { method: 'POST', body: JSON.stringify({
        email: $('#email').value.trim(), password: $('#password').value
      }) });
      toast('If that account needs verification, a fresh link has been emailed.');
    } catch (error) { showFormError(error); }
  });
  $('#signOut').addEventListener('click', async () => {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch (error) { showFormError(error); return; }
    resetAuth();
  });
  $('#reminderButton').addEventListener('click', async () => {
    if (!('Notification' in window)) {
      toast('This browser does not support desktop notifications. Leave the schedule open to see countdowns.', true);
      return;
    }
    const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
    if (permission === 'granted') {
      $('#reminderButton').textContent = 'Reminders on ✓';
      toast('Kick-off and play-by deadline reminders enabled while this page is open.');
      if (state.data) checkReminders(state.data.matches);
    } else toast('Notifications were not enabled. Your local match schedule and countdowns remain available.', true);
  });
  $('#tournamentSelect').addEventListener('change', async event => {
    state.view = 'overview';
    try { await refresh(Number(event.target.value)); } catch (error) { showFormError(error); }
  });
  $('#tournamentForm').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const body = {
      name: form.elements.name.value.trim(),
      format: form.elements.format.value,
      endsAt: isoFromLocal(form.elements.endsAt.value),
      rewardPoints: Number(form.elements.rewardPoints.value),
      prizeDescription: form.elements.prizeDescription.value.trim()
    };
    if (form.elements.startsAt.value) body.startsAt = isoFromLocal(form.elements.startsAt.value);
    try {
      const result = await api('/api/tournaments', { method: 'POST', body: JSON.stringify(body) });
      form.reset();
      await refresh(result.tournamentId);
      toast('League created. Add players and schedule its fixtures.');
    } catch (error) { showFormError(error); }
  });
  $('#playerForm').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      await api(`/api/tournaments/${state.tournamentId}/players`, { method: 'POST', body: JSON.stringify({
        identity: form.elements.identity.value.trim(), groupKey: form.elements.groupKey.value
      }) });
      form.reset();
      await refresh();
      toast('Player added to the tournament.');
    } catch (error) { showFormError(error); }
  });
  $('#fixtureForm').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const body = {
      homeUserId: Number(form.elements.homeUserId.value),
      awayUserId: Number(form.elements.awayUserId.value),
      stage: form.elements.stage.value,
      roundNumber: Number(form.elements.roundNumber.value || 1),
      scheduledAt: isoFromLocal(form.elements.scheduledAt.value),
      deadlineAt: isoFromLocal(form.elements.deadlineAt.value)
    };
    try {
      await api(`/api/tournaments/${state.tournamentId}/matches`, { method: 'POST', body: JSON.stringify(body) });
      form.elements.homeUserId.value = '';
      form.elements.awayUserId.value = '';
      form.elements.scheduledAt.value = '';
      form.elements.deadlineAt.value = '';
      await refresh();
      toast('Fixture published with a kick-off and play-by deadline.');
    } catch (error) { showFormError(error); }
  });
  $('#matchList').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.target;
    try {
      if (form.matches('[data-submit-result]')) {
        const body = new FormData(form);
        await api(`/api/matches/${form.dataset.submitResult}/submit`, { method: 'POST', body });
        await refresh();
        toast('Tracker screenshot submitted. Standings update after organizer review.');
      } else if (form.matches('[data-prediction]')) {
        await api(`/api/matches/${form.dataset.prediction}/predictions`, { method: 'POST', body: JSON.stringify({
          pickedUserId: Number(form.elements.pickedUserId.value), stake: Number(form.elements.stake.value)
        }) });
        await refresh();
        toast('Your points prediction is saved.');
      } else if (form.matches('[data-reschedule]')) {
        await api(`/api/matches/${form.dataset.reschedule}/schedule`, { method: 'PUT', body: JSON.stringify({
          scheduledAt: isoFromLocal(form.elements.scheduledAt.value),
          deadlineAt: isoFromLocal(form.elements.deadlineAt.value)
        }) });
        await refresh();
        toast('Match kick-off and submission deadline updated.');
      }
    } catch (error) { showFormError(error); }
  });
  $('#matchList').addEventListener('click', async event => {
    const claim = event.target.closest('[data-claim]');
    const dispute = event.target.closest('[data-dispute]');
    try {
      if (claim) {
        const result = await api(`/api/matches/${claim.dataset.claim}/claim`, { method: 'POST' });
        await refresh();
        toast(`${Number(result.prize).toLocaleString()} free points claimed.`);
      } else if (dispute) {
        await api(`/api/submissions/${dispute.dataset.dispute}/dispute`, { method: 'POST' });
        await refresh();
        toast('The organizer has been notified that the score is disputed.');
      }
    } catch (error) { showFormError(error); }
  });
  $('#submissionList').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.target.closest('[data-review]');
    if (!form) return;
    const submitter = event.submitter;
    try {
      await api(`/api/submissions/${form.dataset.review}/verify`, { method: 'POST', body: JSON.stringify({
        decision: submitter.value, note: form.elements.note.value.trim()
      }) });
      await refresh();
      toast(submitter.value === 'approved' ? 'Verified result saved. Standings updated.' : 'Score submission rejected; fixture is open for a new submission.');
    } catch (error) { showFormError(error); }
  });
  $('#tournamentCompletion').addEventListener('click', async event => {
    const button = event.target.closest('[data-award-prize]');
    if (!button) return;
    try {
      await api(`/api/tournaments/${button.dataset.awardPrize}/prize/award`, { method: 'POST' });
      await refresh();
      toast('Manual league prize marked as awarded.');
    } catch (error) { showFormError(error); }
  });
  document.addEventListener('click', event => {
    const jump = event.target.closest('[data-jump]');
    if (jump) { setView(jump.dataset.jump); return; }
    const nav = event.target.closest('[data-view]');
    if (nav) setView(nav.dataset.view);
  });

  const fixtureStart = new Date(Date.now() + 60 * 60 * 1000);
  const fixtureDeadline = new Date(Date.now() + 2 * 60 * 60 * 1000);
  $('#displayName').disabled = true;
  $('#gamerTag').disabled = true;
  $('input[name="scheduledAt"]', $('#fixtureForm')).value = localInput(fixtureStart);
  $('input[name="deadlineAt"]', $('#fixtureForm')).value = localInput(fixtureDeadline);
  initialize();
  window.setInterval(() => {
    if (!state.data || state.refreshInProgress) return;
    state.refreshInProgress = true;
    refresh().catch(showFormError).finally(() => { state.refreshInProgress = false; });
  }, 60000);
})();
