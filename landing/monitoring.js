/*
 * Error tracking (Sentry) and analytics (PostHog) for this static site.
 *
 * Keys are not in the repo. scripts/write-monitoring-config.mjs writes
 * monitoring-config.js from env vars at build time:
 *   SENTRY_DSN, POSTHOG_KEY, POSTHOG_HOST (optional, EU cloud by default)
 * With no keys (or no config file) this does nothing.
 *
 * No autocapture, no cookies, no session recording (POPIA).
 * ?monitoring-test on a netlify.app preview sends one Sentry test event.
 */
(function () {
  var cfg = window.__MONITORING__ || {};
  var host = window.location.hostname;
  var isPreview = /\.netlify\.app$/.test(host);

  if (cfg.sentryDsn) {
    var s = document.createElement('script');
    s.src = 'https://browser.sentry-cdn.com/11.5.0/bundle.min.js';
    s.integrity = 'sha384-hz6acjqDJyH+W4e5eBe7yycs+gVPltrjQnZ05EYDSYGV2fVFkqg3bR2tFiOq8DjQ';
    s.crossOrigin = 'anonymous';
    s.onload = function () {
      window.Sentry.init({ dsn: cfg.sentryDsn, environment: isPreview ? 'preview' : 'production' });
      if (isPreview && /[?&]monitoring-test(=|&|$)/.test(window.location.search)) {
        window.Sentry.captureMessage('Monitoring test from ' + host);
      }
    };
    document.head.appendChild(s);
  }

  if (cfg.posthogKey) {
    // Official PostHog snippet (loads posthog-js from the PostHog CDN)
    !function(t,e){var o,n,p,r;e.__SV||(window.posthog&&window.posthog.__loaded)||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="capture identify alias people.set people.set_once set_config register register_once unregister opt_out_capturing has_opted_out_capturing opt_in_capturing reset isFeatureEnabled onFeatureFlags getFeatureFlag getFeatureFlagPayload reloadFeatureFlags group".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);
    window.posthog.init(cfg.posthogKey, {
      api_host: cfg.posthogHost || 'https://eu.i.posthog.com',
      capture_pageview: true,
      autocapture: false,
      persistence: 'memory',
      disable_session_recording: true,
    });
  }
})();
