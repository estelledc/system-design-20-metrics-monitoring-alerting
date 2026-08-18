import assert from 'node:assert/strict';
import test from 'node:test';
import { assertRuleState, transitionRuleState } from '../../src/model.js';

test('two true slots create one firing transition and repeated truth stays in the episode', () => {
  let state = { status: 'inactive', consecutiveTrue: 0 };
  state = transitionRuleState(state, 'true', 2);
  assert.deepEqual(state, { status: 'pending', consecutiveTrue: 1, transition: null });
  state = transitionRuleState(state, 'true', 2);
  assert.deepEqual(state, { status: 'firing', consecutiveTrue: 2, transition: 'firing' });
  state = transitionRuleState(state, 'true', 2);
  assert.deepEqual(state, { status: 'firing', consecutiveTrue: 2, transition: null });
  state = transitionRuleState(state, 'false', 2);
  assert.deepEqual(state, { status: 'inactive', consecutiveTrue: 0, transition: 'resolved' });
});

test('unknown resets pending continuity but keeps a firing episode open', () => {
  assert.deepEqual(
    transitionRuleState({ status: 'pending', consecutiveTrue: 1 }, 'unknown', 2),
    { status: 'inactive', consecutiveTrue: 0, transition: null },
  );
  assert.deepEqual(
    transitionRuleState({ status: 'firing', consecutiveTrue: 2 }, 'unknown', 2),
    { status: 'firing', consecutiveTrue: 2, transition: null },
  );
});

test('generated outcome traces preserve rule-state invariants', () => {
  const outcomes = ['true', 'false', 'unknown'];
  for (let seed = 0; seed < 200; seed += 1) {
    let state = { status: 'inactive', consecutiveTrue: 0 };
    for (let step = 0; step < 100; step += 1) {
      const outcome = outcomes[(seed * 17 + step * 31) % outcomes.length];
      const { transition: ignored, ...next } = transitionRuleState(state, outcome, 3);
      assertRuleState(next, 3);
      state = next;
    }
  }
});

test('invalid state and outcomes fail closed', () => {
  assert.throws(() => transitionRuleState({ status: 'other', consecutiveTrue: 0 }, 'true', 2), {
    code: 'invalid_request',
  });
  assert.throws(() => transitionRuleState({ status: 'inactive', consecutiveTrue: 0 }, 'maybe', 2), {
    code: 'invalid_request',
  });
});
