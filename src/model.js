import { invalid } from './errors.js';

const states = new Set(['inactive', 'pending', 'firing']);
const outcomes = new Set(['true', 'false', 'unknown']);

export function transitionRuleState(current, outcome, requiredTrueSlots) {
  if (!current || !states.has(current.status) || !Number.isSafeInteger(current.consecutiveTrue)) {
    throw invalid('current rule state is invalid');
  }
  if (!outcomes.has(outcome)) throw invalid('evaluation outcome is invalid');
  if (!Number.isSafeInteger(requiredTrueSlots) || requiredTrueSlots < 1) {
    throw invalid('required true slots is invalid');
  }

  if (outcome === 'unknown') {
    if (current.status === 'pending') {
      return { status: 'inactive', consecutiveTrue: 0, transition: null };
    }
    return { ...current, transition: null };
  }

  if (outcome === 'false') {
    return {
      status: 'inactive',
      consecutiveTrue: 0,
      transition: current.status === 'firing' ? 'resolved' : null,
    };
  }

  if (current.status === 'firing') return { ...current, transition: null };
  const consecutiveTrue = current.consecutiveTrue + 1;
  if (consecutiveTrue >= requiredTrueSlots) {
    return { status: 'firing', consecutiveTrue, transition: 'firing' };
  }
  return { status: 'pending', consecutiveTrue, transition: null };
}

export function assertRuleState(state, requiredTrueSlots) {
  if (!states.has(state.status)) throw new Error('rule state is unknown');
  if (!Number.isSafeInteger(state.consecutiveTrue) || state.consecutiveTrue < 0) {
    throw new Error('consecutive true count is invalid');
  }
  if (state.status === 'inactive' && state.consecutiveTrue !== 0) {
    throw new Error('inactive rule retains pending continuity');
  }
  if (state.status === 'pending' && !(state.consecutiveTrue > 0 && state.consecutiveTrue < requiredTrueSlots)) {
    throw new Error('pending rule count is outside its contract');
  }
  if (state.status === 'firing' && state.consecutiveTrue < requiredTrueSlots) {
    throw new Error('firing rule has insufficient true slots');
  }
}
