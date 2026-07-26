(function() {
  'use strict';

  if (typeof window.mutateState !== 'function' || window.mutateState.__syncV3MutationGuard) return;

  var originalMutateState = window.mutateState;

  function guardedMutateState(actionType, metadata) {
    var originalIdbPutAppState = window.idbPutAppState;
    if (typeof originalIdbPutAppState !== 'function') {
      return originalMutateState.call(this, actionType, metadata);
    }

    // The legacy saveStateToLocalStorage() call inside sync-v3 mutateState writes
    // localStorage synchronously and starts an unawaited IndexedDB write. Suppress
    // only that redundant legacy IDB write so the mutation queue can still read
    // the true pre-mutation baseline. sync-v3 then commits state + outbox together
    // in its own awaited IndexedDB transaction.
    window.idbPutAppState = function() { return Promise.resolve(); };
    try {
      return originalMutateState.call(this, actionType, metadata);
    } finally {
      window.idbPutAppState = originalIdbPutAppState;
    }
  }

  guardedMutateState.__syncV3MutationGuard = true;
  guardedMutateState.__originalMutateState = originalMutateState;
  window.mutateState = guardedMutateState;
})();
