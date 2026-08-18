export class MonitorError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = 'MonitorError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export const invalid = (message = 'request contract is invalid') => new MonitorError('invalid_request', message, 400);
export const unauthorized = () => new MonitorError('unauthorized', 'authentication is required', 401);
export const notFound = () => new MonitorError('not_found', 'resource was not found', 404);
export const conflict = (message = 'stable identity is bound to a different intent') => (
  new MonitorError('conflict', message, 409)
);
export const fenced = (scope, current) => new MonitorError('fenced', `${scope} is stale`, 409, { current });
export const outOfOrder = (scope, expected) => new MonitorError(
  'out_of_order',
  `${scope} is not the next expected value`,
  409,
  { expected },
);
export const cardinalityLimit = (limit) => new MonitorError(
  'cardinality_limit',
  'active series budget would be exceeded',
  429,
  { limit },
);
export const precondition = (message = 'the expected revision changed') => (
  new MonitorError('precondition_failed', message, 412)
);
export const unavailable = (message = 'required durable state is unavailable') => (
  new MonitorError('unavailable', message, 503)
);
