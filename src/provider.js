import { createServer } from 'node:http';
import { normalizeProviderRequest } from './contracts.js';
import { authorize, readJson, writeError, writeJson } from './http.js';
import { notFound } from './errors.js';

export function createProviderServer({ repository, providerToken, logger = () => {} }) {
  if (typeof providerToken !== 'string' || providerToken.length < 16) {
    throw new Error('MON_PROVIDER_TOKEN must contain at least 16 characters');
  }
  return createServer(async (request, response) => {
    const started = performance.now();
    try {
      const url = new URL(request.url, 'http://provider.invalid');
      if (request.method === 'GET' && url.pathname === '/health') {
        writeJson(response, 200, { status: 'ok' });
        return;
      }
      authorize(request, providerToken, 'synthetic-notifier');
      if (request.method === 'POST' && url.pathname === '/v1/accept') {
        const input = normalizeProviderRequest(await readJson(request));
        const result = await repository.acceptProvider(input);
        logger({ event: 'provider_accepted', replayed: result.replayed });
        writeJson(response, 202, result);
        return;
      }
      throw notFound();
    } catch (error) {
      writeError(response, error, logger);
    } finally {
      logger({ event: 'provider_request_finished', durationMs: Math.round((performance.now() - started) * 1000) / 1000 });
    }
  });
}
