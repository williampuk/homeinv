(function() {
  'use strict';

  if (typeof window.fetch !== 'function' || window.fetch.__syncV3EndpointGuard) return;
  var nativeFetch = window.fetch.bind(window);

  function requestUrl(input) {
    if (typeof input === 'string') return input;
    if (input && typeof input.url === 'string') return input.url;
    return '';
  }

  function guardedFetch(input, init) {
    var configuredAtStart = String(localStorage.getItem('sys_gas_url') || '');
    var url = requestUrl(input);
    var isCloudRequest = !!configuredAtStart && url === configuredAtStart;
    return nativeFetch(input, init).then(function(response) {
      if (!isCloudRequest || String(localStorage.getItem('sys_gas_url') || '') === configuredAtStart) return response;
      return new Response(JSON.stringify({
        success: false,
        errorCode: 'ENDPOINT_CHANGED',
        message: 'The cloud endpoint changed while this request was in progress. Retry on the intended endpoint.',
        retryable: true
      }), {
        status: 409,
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      });
    });
  }

  guardedFetch.__syncV3EndpointGuard = true;
  guardedFetch.__nativeFetch = nativeFetch;
  window.fetch = guardedFetch;
})();
