import { exactKeys, normalizeClaim } from './contracts.js';
import { unavailable } from './errors.js';

function maybeCrash(name) {
  if (process.env[name] === '1') process.kill(process.pid, 'SIGKILL');
}

function providerReceipt(value, claim) {
  exactKeys(value, ['phase', 'notificationId', 'providerAttempt', 'replayed'], 'provider receipt');
  if (
    value.phase !== 'provider_accepted'
    || value.notificationId !== claim.notificationId
    || value.providerAttempt !== claim.attempt
    || typeof value.replayed !== 'boolean'
  ) throw unavailable('synthetic provider returned an invalid receipt');
  return value;
}

export class NotificationWorker {
  constructor(repository, { providerUrl, providerToken, logger = () => {}, fetchImpl = fetch }) {
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(providerUrl)) {
      throw new Error('MON_PROVIDER_URL must be a loopback HTTP origin');
    }
    if (typeof providerToken !== 'string' || providerToken.length < 16) {
      throw new Error('MON_PROVIDER_TOKEN must contain at least 16 characters');
    }
    this.repository = repository;
    this.providerUrl = providerUrl;
    this.providerToken = providerToken;
    this.logger = logger;
    this.fetch = fetchImpl;
  }

  async runOnce(input) {
    const claimInput = normalizeClaim(input);
    const claim = await this.repository.claimNotification(claimInput);
    if (claim.phase === 'no_notification_work') {
      this.logger({ event: 'notification_no_work' });
      return claim;
    }
    this.logger({ event: 'notification_claimed', attempt: claim.attempt });
    let response;
    try {
      response = await this.fetch(`${this.providerUrl}/v1/accept`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.providerToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          notificationId: claim.notificationId,
          transitionKind: claim.transitionKind,
          attempt: claim.attempt,
        }),
      });
    } catch {
      throw unavailable('synthetic provider request outcome is unknown');
    }
    if (response.status !== 202) throw unavailable('synthetic provider did not accept the request');
    let parsed;
    try {
      parsed = await response.json();
    } catch {
      throw unavailable('synthetic provider receipt was not JSON');
    }
    const receipt = providerReceipt(parsed, claim);
    this.logger({ event: 'provider_acceptance_observed', replayed: receipt.replayed });
    maybeCrash('MON_CRASH_AFTER_PROVIDER_ACCEPTED');
    const completed = await this.repository.completeNotification({
      workerId: claim.workerId,
      workerEpoch: claim.workerEpoch,
      notificationId: claim.notificationId,
      attempt: claim.attempt,
      providerReceipt: receipt,
    });
    this.logger({ event: 'notification_provider_accepted', replayed: completed.replayed });
    return completed;
  }
}
